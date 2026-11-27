// Runtime dos agentes: roteia mensagens de pessoas, roda no máximo um run por agente e conversa,
// transmite o trabalho pelo WebSocket do canal, grava os passos e posta a resposta final.
//
// Conversa = (agente, canal, thread). Mensagem nova numa conversa com run ativo entra nele
// (`agent.run.steered`); "pare" sozinho para o run.
//
// Controle: cada chamada de ferramenta passa pelo gate (costura 1) com as flags A/B/C do run; o que ele
// pede põe o run em `waiting_approval` até a decisão (ou 24 h); `ask_user` põe em `waiting_input` até a
// resposta de quem foi perguntado, pelo cartão ou por uma mensagem na conversa. Ao subir, o servidor
// cancela aprovações e perguntas de runs que não existem mais.
//
// Custo: toda chamada ao modelo pela API reserva o pior caso no teto do agente antes (costura 2) e
// grava o custo real no razão depois; sem saldo para a reserva, a chamada não sai.

import type { ActiveRun, HandledStatus, Message, MessageMeta, RunStatus } from "@vanr/contract";
import { actionCredential, type CredentialRef } from "@vanr/engine/action-credential";
import { schema } from "@vanr/engine/db";
import { breakerOpen, type GateDecision, RiskTracker } from "@vanr/engine/effects";
import { newId } from "@vanr/engine/ids";
import { ADVISOR_MAX_TOKENS, advisorPairOk, DEFAULT_MODEL } from "@vanr/engine/models/catalog";
import { PRICES } from "@vanr/engine/models/prices";
import {
  type AdvisorSpec,
  addUsage,
  emptyUsage,
  ModelError,
  type ModelMessage,
  type ModelProvider,
  type Usage,
} from "@vanr/engine/models/types";
import { parseMentions } from "@vanr/engine/text";
import {
  type BudgetScope,
  estimateUsd,
  type Reservation,
  type UsageSource,
  utf8Bytes,
} from "@vanr/engine/usage";
import { PRODUCT } from "@vanr/product";
import { and, asc, desc, eq, inArray, isNotNull, isNull, lte, or, sql } from "drizzle-orm";
import { failInterruptedAgentJobs } from "../agent-lab";
import { memoryPrompt } from "../agent-memory";
import { type AgentRow, agentBudgetScope, agentNames, monthKey, workspaceBudgetDefaults } from "../agents";
import { type ChannelRow, channelBudgetScope, channelSpendScope } from "../channels";
import type { AppDeps, CompleteInput, CompleteResult, RuntimePort } from "../context";
import {
  type ApprovalRow,
  DECISION_TTL_MS,
  publishActions,
  publishApproval,
  publishQuestion,
  type QuestionRow,
  toQuestion,
  trailEntry,
  UNDO_WINDOW_MS,
} from "../control";
import { debateDeadlines, resumeDebates } from "../debates";
import { pollEmailRoutines } from "../integrations/mail-trigger";
import { resumeStorageMigrations } from "../integrations/storage";
import { toolsFor } from "../integrations/tools";
import { settleIssueWork } from "../issues";
import { log } from "../logger";
import type { RunnerRow } from "../runners/runners";
import {
  canUsePlan,
  EXECUTOR_NAME,
  PERSONAL_PLAN_TEXT,
  runHarnessFor,
  withPlanOwner,
  withPlanOwners,
} from "../runners/plans";
import { expireRunnerRequests } from "../runners/requests";
import { type MessageRow, postMessage } from "../messages";
import { assignmentOfRun } from "../assignments/budget";
import { publishAssignment } from "../assignments/core";
import { assignmentPrompt, assignmentRouting } from "../assignments/tools";
import { closeNotifications, notificationTick } from "../notifications";
import { deliverDue } from "../outbox";
import { drainQueues, dueRoutines } from "../routines";
import { matchRule } from "../standing-rules";
import { purgeReservations } from "../usage-ledger";
import { BackgroundWork } from "./background";
import { HarnessError, harnessNotice, remoteProvider, type ToolInvoker } from "./remote-harness";
import {
  personSaid,
  REVIEWER_MAX_TOKENS,
  REVIEWER_MODEL,
  REVIEWER_SYSTEM,
  recentVerdicts,
  reviewPrompt,
  verdictOf,
} from "./reviewer";
import { type BlockReason, isStopRequest, type RouteAgent, route } from "./route";
import { pinnedTools, withLoading } from "./tool-loading";
import {
  type ApprovalOutcome,
  type ApprovalRequest,
  cut,
  type DecisionBy,
  type ReviewRequest,
  runTool,
  type ToolContext,
  toolSpecs,
} from "./tools";

const { agents, runs, runEvents, messages, channelMemberships, channels, messageDispatches, skills, skillGrants } =
  schema;
const {
  members,
  workspaces,
  users,
  reminders,
  delegations,
  approvals,
  questions,
  reversibleActions,
  assignments,
  assignmentCommands,
  gateDecisions,
} = schema;

type Answer = { answer: string; actorUserId: string } | null;

const ACTIVE_STATUSES = ["queued", "running", "paused_for_input", "paused_for_approval"] as const;
const MAX_TURNS = 12;
const MAX_TOKENS = 16_000;
const HISTORY_LIMIT = 30;
const HEARTBEAT_MS = 15_000;
/** O servidor desiste da consulta em 15 min (o cliente mostra até 20). */
const CONSULT_TIMEOUT_MS = 15 * 60_000;
const CONSULT_MAX_TOKENS = 4000;
const BUDGET_WARNING_RATIO = 0.8;
/** Avisos do teto do canal (F2-3.5-P1-01): um de cada por mês, mais o de "acabou". */
const CHANNEL_WARNINGS = [0.75, 0.9] as const;

/** Só a org e a credencial decidem o provedor (o "descreva e eu monto" pede antes de o agente existir). */
export type ProviderLookup = (
  agent: Pick<AgentRow, "workspaceId" | "credentialId">,
) => Promise<ModelProvider | ProviderUnavailable>;

/** Why there is no provider for the agent; it becomes the run's `errorCode`. */
export type ProviderUnavailable = { error: "no_credential" | "unsupported_provider" };

export interface RuntimeOptions {
  providerFor: ProviderLookup;
  /** Intervalo da varredura de lembretes; 0 desliga o timer (os testes chamam tick()). */
  tickEveryMs?: number;
}

class RunCanceled extends Error {
  constructor() {
    super("Run canceled");
    this.name = "RunCanceled";
  }
}

/** O teto do mês (do agente ou do canal) ou o da execução (`routine_run`) não comporta a próxima chamada: a reserva foi recusada. */
class BudgetExhausted extends Error {
  constructor(readonly scope: BudgetScope["kind"] = "agent") {
    super(
      scope === "assignment"
        ? "Assignment budget exhausted"
        : scope === "channel"
          ? "Channel monthly budget exhausted"
          : scope === "routine_run"
            ? "Routine run spending cap reached"
            : "Monthly budget exhausted",
    );
    this.name = "BudgetExhausted";
  }
}

/** Fim de um run, para quem acompanha (o motor das missões acorda a missão da thread). */
export interface RunEnd {
  runId: string;
  workspaceId: string;
  agentId: string;
  channelId: string;
  threadId: string | null;
  status: "done" | "failed" | "canceled";
  errorCode: string | null;
}

/** O run passou do número de voltas do modelo que o chamador permitiu (`RunLimits.maxTurns`). */
class StepLimit extends Error {
  constructor(turns: number) {
    super(`Stopped after ${turns} model turns (step limit)`);
    this.name = "StepLimit";
  }
}

/** O run passou do tempo que o chamador permitiu (`RunLimits.timeoutMs`). */
class TimeLimit extends Error {
  constructor(ms: number) {
    super(`Stopped after ${Math.round(ms / 60_000)} min (time limit)`);
    this.name = "TimeLimit";
  }
}

/**
 * Teto duro de um run que ninguém acompanha (execução de rotina): tetos de gasto além do mês do
 * agente, voltas do modelo e tempo. Passou de qualquer um, o run para com `budget_exhausted`
 * (`routine_budget` se foi o teto da execução), `step_limit` ou `time_limit`.
 */
export interface RunLimits {
  scopes: readonly BudgetScope[];
  maxTurns: number;
  timeoutMs: number;
  /**
   * Chave da execução (a mesma em todas as tentativas): efeito para fora (K2/K3 ou destino externo)
   * com a mesma chave e o mesmo payload não roda de novo na retentativa.
   */
  effectKey?: string;
}

interface Live {
  runId: string;
  workspaceId: string;
  agent: AgentRow;
  channel: ChannelRow;
  threadId: string | null;
  key: string;
  trigger: MessageRow;
  /** Mensagens que chegaram durante o run e ainda não entraram no contexto. */
  inbox: MessageRow[];
  /** Mensagens que este run ainda vai atender (gatilho e as que entraram depois). */
  handles: string[];
  /**
   * O run já decidiu a resposta final (ou falhou) e está fechando: mensagem nova não entra mais
   * nele. Ela espera aqui e abre um run novo assim que este terminar.
   */
  closing: boolean;
  after: MessageRow[];
  controller: AbortController;
  canceledBy: string | null;
  status: RunStatus;
  startedAt: Date;
  lastPingAt: Date;
  done: Promise<void>;
  /** Pergunta aberta deste run: a próxima mensagem de quem foi perguntado a responde. */
  waitingQuestion: { id: string; askedUserId: string | null } | null;
  /** Flags A/B/C do run (costura 1): o gate lê antes de cada ferramenta. */
  risk: RiskTracker;
  /** Meta extra nas respostas deste run (ex.: `viaRoutine`). */
  replyMeta?: MessageMeta;
  /**
   * Computador cujo plano (Claude Code/Codex) este run usa. Mensagem de quem não pode usar o plano
   * não entra no run: espera e abre o próprio run depois.
   */
  plan: RunnerRow | null;
  /** O agente usou o navegador neste run e não o fechou: quem reabre a conversa vê o cartão (`activeRuns`). */
  browser: boolean;
  /** Thread de missão do agente: as chamadas reservam também no teto dela e saem como `mission` no razão. */
  assignment: { assignmentId: string; scope: BudgetScope | null } | null;
  /** Código do fim (falha), para o aviso de fim de run. */
  errorCode: string | null;
  /**
   * Loja `/memories/you` do run: a pessoa que pediu, enquanto só ela falou nele (`id`), e se o run
   * já abriu a loja dela (`pinned`). Outra pessoa que fala antes da loja abrir tira a loja do run;
   * depois de aberta, a mensagem dela espera o próprio run, porque o contexto já tem dados da dona.
   */
  person: { id: string | null; pinned: boolean };
  /** Teto duro do run (rotina); sem ele valem o mês do agente e `MAX_TURNS`. */
  limits?: RunLimits;
}

const personOf = (row: Pick<MessageRow, "authorKind" | "authorId">) =>
  row.authorKind === "person" ? row.authorId : null;
/**
 * Quem pediu o run agora: a pessoa da mensagem-gatilho. A rotina (agenda, evento, e-mail) posta
 * com o criador dela como autor, mas ninguém está esperando; aí é null.
 */
export const requesterOf = (row: Pick<MessageRow, "authorKind" | "authorId" | "meta">) =>
  row.meta.routine ? null : personOf(row);
/**
 * O orçamento é da API. Agente que pensa no computador (plano, sem custo aqui) não é barrado antes do
 * run; se o run cair no modelo pela API, o próprio run confere o orçamento antes de chamar.
 */
const apiBudgetGates = (agent: AgentRow) => agent.harnessKind === "model";

/** Conselheiro do agente como vai no pedido, ou nada (desligado ou par que deixou de valer). */
function advisorOf(agent: AgentRow): AdvisorSpec | undefined {
  if (!agent.advisorModel || !advisorPairOk(agent.model, agent.advisorModel)) return undefined;
  return { model: agent.advisorModel, maxUses: agent.advisorMaxUses, maxTokens: ADVISOR_MAX_TOKENS };
}

export class AgentRuntime implements RuntimePort {
  private readonly live = new Map<string, Live>();
  private readonly byKey = new Map<string, string>();
  private timer: ReturnType<typeof setInterval> | null = null;
  /** Timers das entregas da fila de envio (um por prazo), além da varredura do tick. */
  private readonly wakes = new Set<ReturnType<typeof setTimeout>>();
  private ticking = false;
  private stopped = false;
  private readonly approvalWaiters = new Map<string, (o: ApprovalOutcome) => void>();
  /** Edição pela pessoa de uma aprovação esperando: revalida e planeja de novo no run. */
  private readonly approvalRevisers = new Map<string, ApprovalRequest["revise"]>();
  private readonly questionWaiters = new Map<string, (a: Answer) => void>();
  private readonly background = new BackgroundWork();
  private readonly runEndListeners: ((end: RunEnd) => void)[] = [];

  constructor(
    private readonly getDeps: () => AppDeps,
    private readonly opts: RuntimeOptions,
  ) {}

  private get deps(): AppDeps {
    return this.getDeps();
  }

  /**
   * Runs que estavam ativos quando o servidor caiu não voltam: viram `failed` com `interrupted`, as
   * aprovações e perguntas que eles esperavam são canceladas (ninguém mais vai usar a decisão) e a
   * tarefa pedida a eles fica bloqueada.
   */
  async start(): Promise<void> {
    const at = this.deps.now();
    const { db } = this.deps;
    const dead = await db
      .update(runs)
      .set({ status: "failed", errorCode: "interrupted", error: "Server restarted", finishedAt: at })
      .where(inArray(runs.status, [...ACTIVE_STATUSES]))
      .returning({ id: runs.id, workspaceId: runs.workspaceId });
    await this.closeWaits(null);
    // Tarefa que esperava um desses runs ("Pedir a um agente") fica bloqueada, não trabalhando para sempre.
    for (const run of dead) {
      const claimed = await db
        .select({ messageId: messageDispatches.messageId })
        .from(messageDispatches)
        .where(and(eq(messageDispatches.runId, run.id), eq(messageDispatches.state, "claimed")));
      await settleIssueWork(
        db,
        run.workspaceId,
        claimed.map((r) => r.messageId),
        { state: "blocked", reason: "interrupted", runId: run.id },
      );
    }
    // Fórum aberto no meio de uma rodada volta a andar (as vezes rodam em memória).
    await resumeDebates(this.deps);
    // Migração do Drive para o S3 que o reinício interrompeu.
    await resumeStorageMigrations(this.deps);
    // Avaliação de casos e consolidação da memória que o reinício cortou viram `failed`.
    await failInterruptedAgentJobs(this.deps.db);
    const every = this.opts.tickEveryMs ?? 15_000;
    if (every > 0) {
      this.timer = setInterval(() => {
        void this.tick().catch((err) => log.error("runtime.tick_failed", { err }));
      }, every);
    }
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    for (const t of this.wakes) clearTimeout(t);
    this.wakes.clear();
    for (const l of this.live.values()) l.controller.abort(new RunCanceled());
    await this.settle();
  }

  /** Espera todos os runs e o trabalho em segundo plano terminarem (testes e desligamento). */
  async settle(): Promise<void> {
    do {
      await Promise.allSettled([...this.live.values()].map((l) => l.done));
      await this.background.settle();
    } while (this.live.size > 0);
  }

  /** Avisa o fim de cada run (depois de gravar o status). */
  onRunEnd(listener: (end: RunEnd) => void): void {
    this.runEndListeners.push(listener);
  }

  /**
   * Entrega a fila de envio em `at` (outbox.ts), sem esperar a próxima varredura. Sem timers
   * (`tickEveryMs: 0`, os testes), só o tick() entrega.
   */
  wakeAt(at: Date): void {
    if ((this.opts.tickEveryMs ?? 15_000) <= 0 || this.stopped) return;
    const t = setTimeout(
      () => {
        this.wakes.delete(t);
        this.track(deliverDue(this.deps), "outbox");
      },
      Math.max(0, at.getTime() - Date.now()) + 50,
    );
    this.wakes.add(t);
  }

  /** Trabalho em segundo plano (rodadas do fórum, rotinas) que o settle também espera. */
  track(work: Promise<unknown>, what: string): void {
    this.background.track(work, what);
  }

  /**
   * The port with every method bound to this runtime, as a plain object: a test can spread it and replace one
   * method (`StartOptions.runtime`).
   */
  port(): RuntimePort {
    const bind = <K extends keyof RuntimePort>(k: K): RuntimePort[K] => {
      const method: unknown = this[k];
      if (typeof method !== "function") throw new Error(`runtime.${k} is not a method`);
      return method.bind(this);
    };
    return {
      track: bind("track"),
      settle: bind("settle"),
      complete: bind("complete"),
      runFor: bind("runFor"),
      activeRun: bind("activeRun"),
      activeRuns: bind("activeRuns"),
      liveRun: bind("liveRun"),
      liveInfo: bind("liveInfo"),
      cancel: bind("cancel"),
      onRunEnd: bind("onRunEnd"),
      onPersonMessage: bind("onPersonMessage"),
      providerForWorkspace: bind("providerForWorkspace"),
      isBusy: bind("isBusy"),
      busyAgents: bind("busyAgents"),
      awaitsApproval: bind("awaitsApproval"),
      resolveApproval: bind("resolveApproval"),
      reviseApproval: bind("reviseApproval"),
      answerQuestion: bind("answerQuestion"),
      wakeAt: bind("wakeAt"),
    };
  }

  /**
   * Pede um texto a um agente fora de uma conversa (vez no fórum, síntese, rotina que gera arquivo).
   * Reserva no teto do agente no mês (e nos escopos que o chamador passar: rotina, tópico, missão)
   * antes de chamar; sem saldo, nem chama o modelo.
   */
  async complete(input: CompleteInput): Promise<CompleteResult> {
    const { db } = this.deps;
    const { agent } = input;
    const planOwner = (await withPlanOwner(db, agent)).planOwnerUserId;
    if (planOwner !== null && planOwner !== input.initiatedBy)
      return { ok: false, code: "personal_plan", error: `${agent.name} ${PERSONAL_PLAN_TEXT}` };
    const at = this.deps.now();
    const maxTokens = input.maxTokens ?? 4000;
    const model = input.model ?? agent.model;
    const channelId = input.channelId ?? null;
    const held = await this.reserveCall({
      agent,
      model,
      channelId,
      scopes: input.scopes,
      promptBytes: utf8Bytes(input.system) + utf8Bytes(input.prompt),
      maxTokens,
    });
    if (!held.ok) {
      const scope = held.scope.kind;
      if (scope === "channel" && channelId) {
        await this.channelBudgetCheck(channelId, input.initiatedBy, true);
        return { ok: false, code: "budget", scope, error: "This channel is out of budget this month" };
      }
      if (scope === "routine_run")
        return {
          ok: false,
          code: "routine_budget",
          scope,
          error: "The routine run spending cap does not fit this call",
        };
      // Só o teto do mês do agente avisa o dono; o do tópico é de quem abriu.
      if (scope === "agent") {
        await this.budgetCheck(agent, true);
        return { ok: false, code: "budget", scope, error: `${agent.name} is out of budget this month` };
      }
      return { ok: false, code: "budget", scope, error: `${agent.name} hit the ${scope} budget cap` };
    }
    const reservation = held.reservation;
    const provider = await this.opts.providerFor(agent);
    if ("error" in provider) {
      await this.deps.ledger.release(reservation);
      return { ok: false, code: "failed", error: provider.error };
    }
    const runId = newId("run");
    await db.insert(runs).values({
      id: runId,
      workspaceId: agent.workspaceId,
      agentId: agent.id,
      sourceChannelId: input.sourceChannelId ?? null,
      debateId: input.debateId ?? null,
      status: "running",
      what: whatOf(input.what),
      model,
      createdAt: at,
      startedAt: at,
    });
    let usage = emptyUsage();
    try {
      let text = "";
      let turned = false;
      for await (const ev of provider.stream({
        model,
        system: input.system,
        messages: [{ role: "user", content: [{ type: "text", text: input.prompt }] }],
        tools: [],
        maxTokens,
        signal: AbortSignal.timeout(input.timeoutMs ?? CONSULT_TIMEOUT_MS),
      })) {
        if (ev.type === "turn") {
          turned = true;
          usage = ev.usage;
          text = ev.content.flatMap((c) => (c.type === "text" ? [c.text] : [])).join("");
        }
      }
      if (!turned) throw new ModelError("network", "Stream ended without a turn");
      const cost = await this.settleCall(reservation, {
        agent,
        model,
        userId: input.initiatedBy,
        runId,
        channelId,
        source: input.source,
        usage,
        assignmentId: input.assignmentId ?? null,
      });
      await db
        .update(runs)
        .set({
          status: "done",
          finishedAt: this.deps.now(),
          inputTokens: usage.inputTokens + usage.cacheWriteTokens,
          cachedTokens: usage.cachedTokens,
          outputTokens: usage.outputTokens,
          costUsd: cost,
        })
        .where(eq(runs.id, runId));
      await this.budgetCheck(agent);
      if (channelId) await this.channelBudgetCheck(channelId, input.initiatedBy);
      return { ok: true, text: text.trim(), runId };
    } catch (err) {
      await this.deps.ledger.release(reservation);
      const error = err instanceof Error ? err.message : String(err);
      await db
        .update(runs)
        .set({ status: "failed", finishedAt: this.deps.now(), errorCode: "failed", error })
        .where(eq(runs.id, runId));
      return { ok: false, code: "failed", error };
    }
  }

  /** Provedor da org (credencial padrão ou plataforma), para pedir antes de o agente existir. */
  providerForWorkspace(workspaceId: string): Promise<ModelProvider | ProviderUnavailable> {
    return this.opts.providerFor({ workspaceId, credentialId: null });
  }

  isBusy(agentId: string): boolean {
    for (const l of this.live.values()) if (l.agent.id === agentId) return true;
    return false;
  }

  busyAgents(): Set<string> {
    return new Set([...this.live.values()].map((l) => l.agent.id));
  }

  activeRuns(filter: { workspaceId: string; channelId?: string }): ActiveRun[] {
    return [...this.live.values()]
      .filter((l) => l.workspaceId === filter.workspaceId && (!filter.channelId || l.channel.id === filter.channelId))
      .map((l) => ({
        runId: l.runId,
        status: l.status,
        agentId: l.agent.id,
        channelId: l.channel.id,
        threadId: l.threadId,
        startedAt: l.startedAt.toISOString(),
        lastPingAt: l.lastPingAt.toISOString(),
        sourceMessageId: l.trigger.id,
        initiatedBy: requesterOf(l.trigger),
        browser: l.browser,
      }));
  }

  liveRun(runId: string): { workspaceId: string; channelId: string } | null {
    const l = this.live.get(runId);
    return l ? { workspaceId: l.workspaceId, channelId: l.channel.id } : null;
  }

  /** Quem pode parar: quem disparou, o responsável pelo agente (o resto a rota decide). */
  liveInfo(runId: string): { triggerAuthorId: string; ownerUserId: string } | null {
    const l = this.live.get(runId);
    return l ? { triggerAuthorId: l.trigger.authorId, ownerUserId: l.agent.ownerUserId } : null;
  }

  // ---- controle ----

  /** Há um run esperando esta aprovação? */
  awaitsApproval(approvalId: string): boolean {
    return this.approvalWaiters.has(approvalId);
  }

  /** A rota decidiu: acorda o run que espera. false = nenhum run esperando. */
  resolveApproval(approvalId: string, outcome: ApprovalOutcome): boolean {
    const wake = this.approvalWaiters.get(approvalId);
    if (!wake) return false;
    wake(outcome);
    return true;
  }

  /**
   * A pessoa editou os campos editáveis antes de aprovar: o run valida e devolve o efeito novo (prévia
   * e hash). null = nenhum run esperando esta aprovação.
   */
  async reviseApproval(
    approvalId: string,
    edits: Record<string, unknown>,
  ): Promise<Awaited<ReturnType<ApprovalRequest["revise"]>> | null> {
    const revise = this.approvalRevisers.get(approvalId);
    return revise ? revise(edits) : null;
  }

  /**
   * Responde uma pergunta aberta (pelo cartão ou por mensagem na conversa) e acorda o run.
   * null = a pergunta não estava mais aberta.
   */
  async answerQuestion(questionId: string, answer: string, actorUserId: string): Promise<QuestionRow | null> {
    const [row] = await this.deps.db
      .update(questions)
      .set({ status: "answered", answer, responderUserId: actorUserId, answeredAt: this.deps.now() })
      .where(and(eq(questions.id, questionId), eq(questions.status, "open")))
      .returning();
    if (!row) return null;
    await publishQuestion(this.deps, row, "question.closed");
    this.questionWaiters.get(questionId)?.({ answer, actorUserId });
    return row;
  }

  private wait<T>(map: Map<string, (v: T) => void>, id: string, signal: AbortSignal): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const onAbort = () => {
        map.delete(id);
        reject(signal.reason ?? new RunCanceled());
      };
      if (signal.aborted) {
        onAbort();
        return;
      }
      signal.addEventListener("abort", onAbort, { once: true });
      map.set(id, (v) => {
        signal.removeEventListener("abort", onAbort);
        map.delete(id);
        resolve(v);
      });
    });
  }

  private async setStatus(live: Live, status: RunStatus) {
    live.status = status;
    await this.deps.db.update(runs).set({ status }).where(eq(runs.id, live.runId));
  }

  /**
   * Fecha o que um run deixou esperando: aprovações pendentes viram `canceled` e perguntas abertas
   * `expired`. Sem runId, fecha tudo (o servidor acabou de subir e não há run vivo).
   */
  private async closeWaits(runId: string | null) {
    const { db } = this.deps;
    const at = this.deps.now();
    const entry = trailEntry(at, "canceled", "The work stopped before a decision");
    const canceled = await db
      .update(approvals)
      .set({
        status: "canceled",
        decidedAt: at,
        trail: sql`${approvals.trail} || ${JSON.stringify([entry])}::jsonb`,
      })
      .where(and(eq(approvals.status, "pending"), runId ? eq(approvals.runId, runId) : undefined))
      .returning();
    for (const row of canceled) await publishApproval(this.deps, row, "approval.resolved");
    const expired = await db
      .update(questions)
      .set({ status: "expired" })
      .where(and(eq(questions.status, "open"), runId ? eq(questions.runId, runId) : undefined))
      .returning();
    for (const row of expired) await publishQuestion(this.deps, row, "question.closed");
    // Comando de missão que o run esperava. O de tarefa no computador (`taskId`) não depende do run:
    // "liberar e tentar de novo" retoma a tarefa.
    const commands = await db
      .update(assignmentCommands)
      .set({ state: "expired" })
      .where(
        and(
          eq(assignmentCommands.state, "pending"),
          isNull(assignmentCommands.jobId),
          runId ? eq(assignmentCommands.runId, runId) : isNotNull(assignmentCommands.runId),
        ),
      )
      .returning({ assignmentId: assignmentCommands.assignmentId, messageId: assignmentCommands.messageId });
    const touched = [...new Set(commands.map((c) => c.assignmentId))];
    if (touched.length) {
      for (const row of await db.select().from(assignments).where(inArray(assignments.id, touched))) {
        // O pedido acabou: o aviso "esperando você" do comando fecha junto.
        for (const c of commands)
          if (c.assignmentId === row.id && c.messageId)
            await closeNotifications(this.deps, row.workspaceId, `assignment:${row.id}:approval:${c.messageId}`);
        publishAssignment(this.deps, row, "command");
      }
    }
  }

  /** Aprovações e perguntas sem resposta há 24 h expiram; o run que esperava segue sem elas. */
  private async expireWaits() {
    const { db } = this.deps;
    const at = this.deps.now();
    const due = await db
      .select({ id: approvals.id })
      .from(approvals)
      .where(and(eq(approvals.status, "pending"), lte(approvals.expiresAt, at)));
    for (const { id } of due) {
      const entry = trailEntry(at, "expired", "Nobody decided in 24 hours");
      const [row] = await db
        .update(approvals)
        .set({
          status: "expired",
          decidedAt: at,
          trail: sql`${approvals.trail} || ${JSON.stringify([entry])}::jsonb`,
        })
        .where(and(eq(approvals.id, id), eq(approvals.status, "pending")))
        .returning();
      if (!row) continue;
      await publishApproval(this.deps, row, "approval.resolved");
      this.resolveApproval(id, { id, decision: "expired", reason: null, byName: null });
    }
    const old = new Date(at.getTime() - DECISION_TTL_MS);
    const stale = await db
      .update(questions)
      .set({ status: "expired" })
      .where(and(eq(questions.status, "open"), lte(questions.createdAt, old)))
      .returning();
    for (const row of stale) {
      await publishQuestion(this.deps, row, "question.closed");
      this.questionWaiters.get(row.id)?.(null);
    }
  }

  /** Run ativo do agente nessa conversa (para parar uma missão). */
  activeRun(agentId: string, channelId: string, threadId: string | null): string | null {
    return this.byKey.get(`${agentId}:${channelId}:${threadId ?? "-"}`) ?? null;
  }

  /** Para o run. Devolve false se ele já tinha terminado. */
  cancel(runId: string, actorUserId: string | null): boolean {
    const l = this.live.get(runId);
    if (!l) return false;
    l.canceledBy = actorUserId;
    l.controller.abort(new RunCanceled());
    return true;
  }

  // ---- roteamento ----

  /** Chamado depois que uma pessoa posta. Não espera os runs. */
  async onPersonMessage(input: { workspaceId: string; channel: ChannelRow; message: Message }): Promise<void> {
    const { db, hub } = this.deps;
    const { workspaceId, channel, message } = input;
    if (message.author.type !== "person" || message.meta.feedback) return;
    const [row] = await db.select().from(messages).where(eq(messages.id, message.id));
    if (!row) return;
    // Thread de missão: sugestão de quem não decide e missão pausada não chegam ao agente.
    if (!(await assignmentRouting(this.deps, row))) return;

    const handles = parseMentions(row.body);
    const mentioned = handles.length
      ? await db
          .select()
          .from(agents)
          .where(and(eq(agents.workspaceId, workspaceId), inArray(agents.handle, handles), isNull(agents.archivedAt)))
      : [];
    // Na ordem em que aparecem no texto.
    mentioned.sort((a, b) => handles.indexOf(a.handle) - handles.indexOf(b.handle));
    const inChannel = await db
      .select({ agent: agents, autoAnswer: channelMemberships.autoAnswer })
      .from(channelMemberships)
      .innerJoin(agents, eq(agents.id, channelMemberships.memberId))
      .where(
        and(
          eq(channelMemberships.channelId, channel.id),
          eq(channelMemberships.memberType, "agent"),
          isNull(agents.archivedAt),
        ),
      );
    let threadAgentIds: string[] = [];
    if (row.threadId) {
      const spoke = await db
        .selectDistinct({ id: messages.authorId })
        .from(messages)
        .where(
          and(
            eq(messages.authorKind, "agent"),
            or(eq(messages.threadId, row.threadId), eq(messages.id, row.threadId)),
          ),
        );
      threadAgentIds = spoke.map((s) => s.id);
    }
    const byId = new Map<string, AgentRow>(
      [...mentioned, ...inChannel.map((m) => m.agent)].map((a) => [a.id, a]),
    );
    // Quem pareou o computador de cada agente que pensa pelo plano: só essa pessoa fala com ele.
    const talkers = new Map((await withPlanOwners(db, [...byId.values()])).map((a) => [a.id, a]));
    const talker = (a: AgentRow) => talkers.get(a.id) ?? { ...a, planOwnerUserId: null };
    const routed = route({
      authorUserId: message.author.id,
      mentioned: mentioned.map(talker),
      inChannel: inChannel.map((m) => ({ agent: talker(m.agent), autoAnswer: m.autoAnswer })),
      isDm: channel.kind === "dm",
      threadAgentIds,
    });

    // Sem orçamento no mês também bloqueia (run em andamento continua recebendo a mensagem).
    const threadId = row.threadId ?? (row.meta.spawnsThread ? row.id : null);
    const blocked: { agent: RouteAgent; reason: BlockReason | "budget" }[] = [...routed.blocked];
    const plan: { agent: AgentRow; key: string; live: Live | undefined }[] = [];
    for (const target of routed.targets) {
      const agent = byId.get(target.id);
      if (!agent) continue;
      const key = `${agent.id}:${channel.id}:${threadId ?? "-"}`;
      const running = this.byKey.get(key);
      const live = running ? this.live.get(running) : undefined;
      if (!live && apiBudgetGates(agent) && (await this.budgetCheck(agent)) === "exhausted") {
        blocked.push({ agent: talker(agent), reason: "budget" });
        continue;
      }
      plan.push({ agent, key, live });
    }
    if (plan.length === 0 && blocked.length === 0) return;
    for (const b of blocked) await this.block(row, channel, b.agent, b.reason);
    if (plan.length) {
      await db
        .insert(messageDispatches)
        .values(plan.map((p) => ({ messageId: row.id, agentId: p.agent.id, state: "routed" as const })))
        .onConflictDoNothing();
    }
    // seenBy: quem a mensagem alcançou; pickedBy: quem vai responder; blocked: quem não pode.
    hub.toChannel(channel.id, {
      type: "message.routed",
      messageId: row.id,
      viewedBy: [...plan.map((p) => p.agent.id), ...blocked.map((b) => b.agent.id)],
      claimedBy: plan.map((p) => p.agent.id),
      blocked: blocked.map((b) => ({ agentId: b.agent.id, reason: b.reason })),
    });
    // Ninguém chamou (sem menção, fora de DM e de thread com o agente): quem responde entrou sozinho.
    const volunteered = mentioned.length === 0 && channel.kind !== "dm" && threadAgentIds.length === 0;
    for (const p of plan) {
      // Olha de novo: entre o plano e aqui houve await, e o run pode ter acabado.
      const runId = this.byKey.get(p.key);
      const live = runId ? this.live.get(runId) : undefined;
      if (live) await this.steer(live, row);
      else
        await this.startRun({
          agent: p.agent,
          channel,
          threadId,
          key: p.key,
          trigger: row,
          replyMeta: volunteered ? { joined: true } : undefined,
        });
    }
  }

  /**
   * Roda o agente para uma mensagem específica, sem depender de menção (rotina agendada). Se ele já
   * está num run nessa conversa, a mensagem entra nele. Devolve o run para acompanhar o fim.
   */
  async runFor(input: {
    agent: AgentRow;
    channel: ChannelRow;
    trigger: MessageRow;
    replyMeta?: MessageMeta;
    /** Teto duro do run. Com ele, a mensagem não entra num run que já está vivo na conversa (`busy`). */
    limits?: RunLimits;
  }): Promise<
    | { ok: true; runId: string; done: Promise<void> }
    | { ok: false; code: "budget" | "personal_plan" | "busy" }
  > {
    const { agent, channel, trigger } = input;
    // Sem roteamento, a trava do plano pessoal é aqui: só quem pareou aciona o agente (nem entra num run vivo).
    const planOwner = (await withPlanOwner(this.deps.db, agent)).planOwnerUserId;
    if (planOwner !== null && planOwner !== personOf(trigger)) return { ok: false, code: "personal_plan" };
    const threadId = trigger.threadId ?? (trigger.meta.spawnsThread ? trigger.id : null);
    const key = `${agent.id}:${channel.id}:${threadId ?? "-"}`;
    const runningId = this.byKey.get(key);
    const running = runningId ? this.live.get(runningId) : undefined;
    if (running) {
      // O run vivo não tem o teto deste pedido: em vez de entrar nele, quem chamou tenta depois.
      if (input.limits) return { ok: false, code: "busy" };
      await this.steer(running, trigger);
      return { ok: true, runId: running.runId, done: running.done };
    }
    if (apiBudgetGates(agent) && (await this.budgetCheck(agent)) === "exhausted")
      return { ok: false, code: "budget" };
    await this.startRun({
      agent,
      channel,
      threadId,
      key,
      trigger,
      replyMeta: input.replyMeta,
      limits: input.limits,
    });
    const runId = this.byKey.get(key) ?? "";
    return { ok: true, runId, done: this.live.get(runId)?.done ?? Promise.resolve() };
  }

  private async block(
    row: MessageRow,
    channel: ChannelRow,
    agent: RouteAgent,
    reason: BlockReason | "budget",
  ) {
    const { db, hub } = this.deps;
    await settleIssueWork(db, channel.workspaceId, [row.id], { state: "blocked", reason, runId: null });
    await db
      .insert(messageDispatches)
      .values({ messageId: row.id, agentId: agent.id, state: "blocked", status: "blocked", reason })
      .onConflictDoUpdate({
        target: [messageDispatches.messageId, messageDispatches.agentId],
        set: { state: "blocked", status: "blocked", reason },
      });
    const names = await agentNames(db, [agent.id]);
    const name = names.get(agent.id)?.name ?? "";
    const text =
      reason === "audience"
        ? `${name} doesn't answer you here.`
        : reason === "personal_plan"
          ? `${name} thinks with the personal plan of whoever paired its runner and only answers that person.`
          : reason === "budget"
            ? `${name} is out of budget this month.`
            : `${name} isn't in this conversation.`;
    hub.toUser(channel.workspaceId, row.authorId, {
      type: "run.agent_unavailable",
      agentId: agent.id,
      channelId: channel.id,
      threadId: row.threadId,
      messageId: row.id,
      reason,
      text,
    });
  }

  private async steer(live: Live, row: MessageRow) {
    const { db, hub } = this.deps;
    const stop = isStopRequest(row.body);
    if (live.closing) {
      // "pare" para um run que já está acabando não muda nada; o resto vira o próximo run.
      if (!stop) live.after.push(row);
      return;
    }
    // Nem o "pare" de outra pessoa mexe num run no plano de quem pareou.
    if (live.plan && !canUsePlan(personOf(row), live.plan)) {
      live.after.push(row);
      return;
    }
    const who = personOf(row);
    if (who !== null && who !== live.person.id) {
      if (live.person.pinned) {
        live.after.push(row);
        return;
      }
      live.person.id = null;
    }
    await db
      .insert(messageDispatches)
      .values({ messageId: row.id, agentId: live.agent.id, state: "claimed", runId: live.runId })
      .onConflictDoUpdate({
        target: [messageDispatches.messageId, messageDispatches.agentId],
        set: { state: "claimed", runId: live.runId },
      });
    hub.toChannel(live.channel.id, {
      type: "run.steered",
      runId: live.runId,
      agentId: live.agent.id,
      threadId: live.threadId,
      messageId: row.id,
      ...(stop ? { stop: true } : {}),
    });
    live.handles.push(row.id);
    if (stop) {
      live.canceledBy = row.authorId;
      live.controller.abort(new RunCanceled());
      return;
    }
    // O agente perguntou e está esperando: a mensagem de quem foi perguntado é a resposta, não um
    // pedido novo. Mensagem de outra pessoa entra no run como mensagem comum.
    const q = live.waitingQuestion;
    if (q && (q.askedUserId === null || q.askedUserId === row.authorId)) {
      const text = row.body.replace(/@[a-z0-9][a-z0-9_-]{1,31}/gi, "").trim() || row.body;
      if (await this.answerQuestion(q.id, text, row.authorId)) return;
    }
    live.inbox.push(row);
  }

  // ---- execução ----

  private async startRun(input: {
    agent: AgentRow;
    channel: ChannelRow;
    threadId: string | null;
    key: string;
    trigger: MessageRow;
    replyMeta?: MessageMeta;
    limits?: RunLimits;
  }) {
    const { db, hub } = this.deps;
    const { agent, channel, trigger } = input;
    const runId = newId("run");
    const at = this.deps.now();
    await db.insert(runs).values({
      id: runId,
      workspaceId: channel.workspaceId,
      agentId: agent.id,
      channelId: channel.id,
      threadId: input.threadId,
      sourceMessageId: trigger.id,
      status: "queued",
      what: whatOf(trigger.body),
      model: agent.model,
      createdAt: at,
    });
    await db
      .insert(messageDispatches)
      .values({ messageId: trigger.id, agentId: agent.id, state: "claimed", runId })
      .onConflictDoUpdate({
        target: [messageDispatches.messageId, messageDispatches.agentId],
        set: { state: "claimed", runId },
      });
    hub.toChannel(channel.id, { type: "message.claimed", messageId: trigger.id, agentId: agent.id, runId });
    const live: Live = {
      runId,
      workspaceId: channel.workspaceId,
      agent,
      channel,
      threadId: input.threadId,
      key: input.key,
      trigger,
      person: { id: requesterOf(trigger), pinned: false },
      inbox: [],
      handles: [trigger.id],
      closing: false,
      after: [],
      controller: new AbortController(),
      canceledBy: null,
      status: "queued",
      startedAt: at,
      lastPingAt: at,
      done: Promise.resolve(),
      waitingQuestion: null,
      risk: new RiskTracker(),
      replyMeta: input.replyMeta,
      plan: null,
      browser: false,
      assignment: null,
      errorCode: null,
      limits: input.limits,
    };
    this.live.set(runId, live);
    this.byKey.set(input.key, runId);
    live.done = this.execute(live)
      .catch((err) => log.error("runtime.run_crashed", { runId, err }))
      .finally(async () => {
        this.live.delete(runId);
        if (this.byKey.get(live.key) === runId) this.byKey.delete(live.key);
        const end: RunEnd = {
          runId,
          workspaceId: live.workspaceId,
          agentId: agent.id,
          channelId: channel.id,
          threadId: live.threadId,
          status: live.status === "done" || live.status === "canceled" ? live.status : "failed",
          errorCode: live.errorCode ?? null,
        };
        for (const listener of this.runEndListeners) {
          try {
            listener(end);
          } catch (err) {
            log.error("runtime.run_end_listener_failed", { runId, err });
          }
        }
        const [next, ...rest] = live.after;
        if (!next || this.stopped) return;
        try {
          await this.startRun({ ...live, trigger: next, replyMeta: undefined, limits: undefined });
          const nextId = this.byKey.get(live.key);
          const nextLive = nextId ? this.live.get(nextId) : undefined;
          for (const row of rest) if (nextLive) await this.steer(nextLive, row);
        } catch (err) {
          log.error("runtime.followup_failed", { runId, err });
        }
      });
  }

  private emit(live: Live, event: Record<string, unknown> & { type: string }) {
    this.deps.hub.toChannel(live.channel.id, {
      runId: live.runId,
      agentId: live.agent.id,
      channelId: live.channel.id,
      threadId: live.threadId,
      ...event,
    });
  }

  private async execute(live: Live): Promise<void> {
    const { db } = this.deps;
    const at = this.deps.now();
    live.status = "running";
    live.assignment = await assignmentOfRun(this.deps, live.agent.id, live.threadId);
    await db
      .update(runs)
      .set({ status: "running", startedAt: at, lastPingAt: at })
      .where(eq(runs.id, live.runId));
    this.emit(live, {
      type: "run.status_changed",
      status: "running",
      sourceMessageId: live.trigger.id,
      initiatedBy: requesterOf(live.trigger),
      startedAt: at.toISOString(),
    });
    const beat = setInterval(() => {
      live.lastPingAt = this.deps.now();
      void db.update(runs).set({ lastPingAt: live.lastPingAt }).where(eq(runs.id, live.runId));
    }, HEARTBEAT_MS);
    // Teto de tempo: passou, aborta o que estiver rodando (modelo, ferramenta ou espera de aprovação).
    const timeoutMs = live.limits?.timeoutMs;
    const deadline = timeoutMs
      ? setTimeout(() => live.controller.abort(new TimeLimit(timeoutMs)), timeoutMs)
      : null;

    let usage = emptyUsage();
    let cost = 0;
    let stepSeq = 0;
    let deltaSeq = 0;
    let partial = "";
    let posted = 0;
    let delegatedTo: string | null = null;
    let usageModel = live.agent.model;
    let toolSteps = 0;
    // Sem chave, o provedor é o de teste: a resposta diz isso, para a tela não mostrar o modelo do agente.
    let testModel = false;
    const step = async (kind: "text" | "tool_call" | "tool_result", data: Record<string, unknown>) => {
      await db.insert(runEvents).values({ runId: live.runId, seq: stepSeq++, kind, data });
      if (kind === "tool_call") toolSteps++;
    };
    const persistUsage = async () => {
      await db
        .update(runs)
        .set({
          inputTokens: usage.inputTokens + usage.cacheWriteTokens,
          cachedTokens: usage.cachedTokens,
          outputTokens: usage.outputTokens,
          costUsd: cost,
        })
        .where(eq(runs.id, live.runId));
    };
    const post = async (body: string, meta: MessageMeta = {}) => {
      const { message } = await postMessage(this.deps, {
        workspaceId: live.workspaceId,
        channel: live.channel,
        author: { type: "agent", id: live.agent.id },
        body,
        clientId: `${live.runId}:${posted++}`,
        threadId: live.threadId,
        meta: {
          ...live.replyMeta,
          ...meta,
          ...(delegatedTo ? { delegation: { agentId: delegatedTo } } : {}),
          ...(toolSteps > 0 ? { toolSteps } : {}),
          ...(testModel ? { testModel: true } : {}),
        },
        runId: live.runId,
        usage: { model: usageModel, inputTokens: usage.inputTokens, outputTokens: usage.outputTokens },
      });
      // As ações do run até aqui ganham o recibo nesta mensagem.
      const linked = await db
        .update(reversibleActions)
        .set({ messageId: message.id })
        .where(and(eq(reversibleActions.runId, live.runId), isNull(reversibleActions.messageId)))
        .returning({ id: reversibleActions.id });
      if (linked.length > 0) await publishActions(this.deps, message.id);
      return message;
    };
    let cards = 0;
    let currentCall: { toolUseId: string; tool: string; turn: number } | null = null;
    const postCard = async (body: string, meta: MessageMeta) => {
      const { message } = await postMessage(this.deps, {
        workspaceId: live.workspaceId,
        channel: live.channel,
        author: { type: "agent", id: live.agent.id },
        body,
        clientId: `${live.runId}:card:${cards++}`,
        threadId: live.threadId,
        meta,
      });
      return message;
    };

    try {
      const modelProvider = async (): Promise<ModelProvider> => {
        const p = await this.opts.providerFor(live.agent);
        if ("error" in p) throw new ModelError("auth", p.error);
        return p;
      };
      // Claude Code/Codex no computador, com o plano de quem pareou; senão o modelo pela API.
      let harness = await runHarnessFor(this.deps, live.agent, personOf(live.trigger));
      // O fallback cobre o computador fora do ar, não outra pessoa: o agente do plano só atende quem pareou.
      if (harness.kind === "unavailable" && harness.code !== "personal_plan" && live.agent.harnessFallback)
        harness = { kind: "model" };
      if (harness.kind === "unavailable")
        throw new HarnessError(
          harness.code,
          `${EXECUTOR_NAME[harness.executor]} is not available (${harness.code})`,
          harness.executor,
          harness.runner?.id ?? null,
        );
      let remote = harness.kind === "remote" ? harness : null;
      let provider: ModelProvider | null = remote ? null : await modelProvider();
      testModel = provider?.kind === "fake";
      if (remote) {
        const plan = remote.runner;
        live.plan = plan;
        // O que chegou de quem não pode usar o plano antes desta decisão espera o próprio run.
        const others = live.inbox.filter((m) => !canUsePlan(personOf(m), plan));
        if (others.length) {
          const ids = new Set(others.map((m) => m.id));
          live.inbox = live.inbox.filter((m) => !ids.has(m.id));
          live.handles = live.handles.filter((id) => !ids.has(id));
          live.after.push(...others);
        }
        usageModel = remote.model ? `${remote.executor}:${remote.model}` : remote.executor;
        await db.update(runs).set({ model: usageModel }).where(eq(runs.id, live.runId));
      }
      const system = await this.systemPrompt(live);
      // The thread comes from the trigger, a message of this channel (startRun checks it): the assignment
      // tools are picked by thread, so a thread of another channel never reaches toolsFor.
      const tools = await toolsFor(this.deps, live.agent, { channel: live.channel, threadId: live.threadId });
      // Carga sob demanda (F5-3.4-P0-08): pela API, só as fixas vão inteiras quando as definições
      // pesam; o resto vai adiado e a busca da API acha. O cérebro no computador recebe todas.
      const specs =
        !remote && this.deps.config.toolSearch === "auto"
          ? withLoading(toolSpecs(tools), await pinnedTools(db, live.agent.id, this.deps.now()))
          : toolSpecs(tools);
      const history = await this.history(live);
      const toolCtx: ToolContext = {
        deps: this.deps,
        workspaceId: live.workspaceId,
        agent: live.agent,
        channel: live.channel,
        runId: live.runId,
        threadId: live.threadId,
        trigger: {
          id: live.trigger.id,
          authorId: live.trigger.authorId,
          authorName: await this.personName(live),
        },
        personId: requesterOf(live.trigger),
        personStore: () => {
          if (live.person.id) live.person.pinned = true;
          return live.person.id;
        },
        signal: live.controller.signal,
        risk: live.risk,
        ...(live.limits?.effectKey ? { effectKey: live.limits.effectKey } : {}),
        delegate: async (target, question) => {
          delegatedTo = target.id;
          return this.delegate(live, target, question);
        },
        postCard,
        toolOutput: (text) => {
          if (!currentCall) return;
          this.emit(live, {
            type: "run.tool_result",
            toolUseId: currentCall.toolUseId,
            tool: currentCall.tool,
            stream: "stdout",
            text: cut(text),
            isError: false,
            turn: currentCall.turn,
          });
        },
        requestApproval: async (req) => {
          const created = this.deps.now();
          const title = req.card.title ?? req.preview.title;
          const [row] = await db
            .insert(approvals)
            .values({
              id: newId("apv"),
              workspaceId: live.workspaceId,
              agentId: live.agent.id,
              channelId: live.channel.id,
              threadId: live.threadId,
              runId: live.runId,
              tool: req.tool,
              scope: req.card.scope ?? `tool:${req.tool}`,
              title,
              // O texto inteiro do efeito, sem corte (X-F3-O0-3): é o que a pessoa aprova.
              detail: req.preview.body ?? "",
              params: req.card.params ?? {},
              why: req.card.why ?? "",
              issue: req.card.issue ?? null,
              connector: req.card.connector ?? null,
              linkedAccount: req.card.linkedAccount ?? null,
              effect: req.effect,
              gateReason: req.gateReason,
              flags: req.reasons.map((r) => ({ flag: r.flag, source: r.source })),
              preview: req.preview,
              input: req.input,
              payloadHash: req.payloadHash,
              editable: req.editable,
              ruleKey: req.rule?.key ?? null,
              ruleLabel: req.rule?.label ?? null,
              requesterUserId: live.trigger.authorId,
              expiresAt: new Date(created.getTime() + DECISION_TTL_MS),
              trail: [
                trailEntry(created, "requested", `${live.agent.name} asked`, { name: live.agent.name }),
                ...(req.reviewed
                  ? [trailEntry(created, "reviewed", "The reviewer model asked for a person")]
                  : []),
              ],
            })
            .returning();
          if (!row) throw new Error("approval insert returned nothing");
          await this.recordDecision(live, {
            tool: req.tool,
            decision: {
              kind: "ask",
              reason: req.gateReason,
              effect: req.effect,
              flags: req.flags,
              preview: req.preview,
              payloadHash: req.payloadHash,
            },
            approvalId: row.id,
            credential: req.credential,
            ...(req.reviewed ? { by: { kind: "reviewer", verdict: "ask" } as const } : {}),
          });
          const card = await postCard(title, { approvalId: row.id });
          const [withCard] = await db
            .update(approvals)
            .set({ messageId: card.id })
            .where(eq(approvals.id, row.id))
            .returning();
          // Registra a espera antes de avisar: a decisão pode chegar antes do próximo await.
          const waiting = this.wait(this.approvalWaiters, row.id, live.controller.signal);
          waiting.catch(() => {});
          this.approvalRevisers.set(row.id, req.revise);
          // O status vai para o banco antes do aviso: quem buscar a lista de runs depois do
          // evento já vê a espera, e a lista não desfaz a fase que o evento pôs na tela.
          await this.setStatus(live, "paused_for_approval");
          await publishApproval(this.deps, withCard ?? row, "approval.requested");
          const outcome = await waiting.finally(() => this.approvalRevisers.delete(row.id));
          await this.setStatus(live, "running");
          return outcome;
        },
        recordDecision: (d) => this.recordDecision(live, d),
        standingRule: (tool, key) =>
          matchRule(db, { workspaceId: live.workspaceId, agentId: live.agent.id, tool, key, at: this.deps.now() }),
        review: (req) =>
          this.reviewCall({
            agent: live.agent,
            channelId: live.channel.id,
            threadId: live.threadId,
            requesterId: live.trigger.authorKind === "person" ? live.trigger.authorId : null,
            requestAt: live.trigger.createdAt,
            req,
          }),
        settleApproval: async (id, result) => {
          const done = this.deps.now();
          const entry = result.ok
            ? trailEntry(done, "executed", "Done")
            : trailEntry(done, "failed", "Failed", { error: result.text.slice(0, 200) });
          const [row] = await db
            .update(approvals)
            .set({
              appliedAt: done,
              result,
              trail: sql`${approvals.trail} || ${JSON.stringify([entry])}::jsonb`,
            })
            .where(eq(approvals.id, id))
            .returning();
          if (row) await publishApproval(this.deps, row as ApprovalRow, "approval.resolved");
        },
        ask: async (text, choices) => {
          const [row] = await db
            .insert(questions)
            .values({
              id: newId("q"),
              workspaceId: live.workspaceId,
              agentId: live.agent.id,
              channelId: live.channel.id,
              threadId: live.threadId,
              runId: live.runId,
              askedUserId: live.trigger.authorId,
              text,
              choices,
            })
            .returning();
          if (!row) throw new Error("question insert returned nothing");
          const card = await postCard(text, { question: toQuestion(row) });
          const [withCard] = await db
            .update(questions)
            .set({ messageId: card.id })
            .where(eq(questions.id, row.id))
            .returning();
          const waiting = this.wait(this.questionWaiters, row.id, live.controller.signal);
          waiting.catch(() => {});
          live.waitingQuestion = { id: row.id, askedUserId: row.askedUserId };
          await this.setStatus(live, "paused_for_input");
          await publishQuestion(this.deps, withCard ?? row, "question.raised");
          const answer = await waiting.finally(() => {
            live.waitingQuestion = null;
          });
          await this.setStatus(live, "running");
          return answer;
        },
        recordAction: async (action) => {
          const created = this.deps.now();
          await db.insert(reversibleActions).values({
            id: newId("act"),
            workspaceId: live.workspaceId,
            agentId: live.agent.id,
            runId: live.runId,
            requesterUserId: live.trigger.authorId,
            kind: action.kind,
            target: action.target,
            params: action.params ?? {},
            createdAt: created,
            revertibleUntil: action.revertibleUntil ?? new Date(created.getTime() + UNDO_WINDOW_MS),
          });
        },
      };

      let turnNow = 0;
      let turnText = "";
      let typing = false;
      let usedTools = false;
      const callTool = async (
        call: { id: string; name: string; input: unknown },
        turn: number,
        commentary: string | null,
      ) => {
        usedTools = true;
        await step("tool_call", {
          toolUseId: call.id,
          name: call.name,
          input: call.input,
          turn,
          ...(commentary ? { commentary } : {}),
        });
        this.emit(live, {
          type: "run.tool_call",
          toolUseId: call.id,
          tool: call.name,
          input: call.input,
          detail: toolDetail(call.input),
          turn,
        });
        if (call.name.startsWith("browser_") && call.name !== "browser_close") live.browser = true;
        currentCall = { toolUseId: call.id, tool: call.name, turn };
        const out = await runTool(toolCtx, tools, call.name, call.input).finally(() => {
          currentCall = null;
        });
        live.controller.signal.throwIfAborted();
        await step("tool_result", {
          toolUseId: call.id,
          content: out.content,
          isError: out.isError,
          turn,
        });
        this.emit(live, {
          type: "run.tool_result",
          toolUseId: call.id,
          tool: call.name,
          stream: out.isError ? "error" : "result",
          text: cut(out.content),
          isError: out.isError,
          turn,
        });
        if (call.name === "browser_close" && !out.isError) live.browser = false;
        // tool: null fecha a chamada (a linha deixa de mostrar "executando").
        this.emit(live, { type: "run.tool_call", toolUseId: call.id, tool: null, turn });
        return out;
      };
      // Ferramenta pedida pelo Claude Code/Codex no meio do turno: o texto até ali vira narração. O CLI
      // pode pedir várias ao mesmo tempo; elas rodam uma de cada vez, como no caminho do modelo
      // (aprovação, pergunta e a saída ao vivo valem para uma chamada por vez).
      let toolQueue: Promise<unknown> = Promise.resolve();
      const invoke: ToolInvoker = (name, input) => {
        const next = toolQueue.then(async () => {
          live.controller.signal.throwIfAborted();
          const commentary = turnText.trim() || null;
          if (commentary) this.emit(live, { type: "run.commentary", turn: turnNow, text: commentary });
          turnText = "";
          partial = "";
          typing = false;
          const out = await callTool({ id: newId("tu"), name, input }, turnNow, commentary);
          return { content: out.content, isError: out.isError };
        });
        toolQueue = next.catch(() => {});
        return next;
      };
      if (remote)
        provider = remoteProvider(this.deps, {
          runId: live.runId,
          agent: { id: live.agent.id, handle: live.agent.handle },
          harness: remote,
          invoke,
        });

      let finalText = "";
      // Conselheiro só pela API, e só com par válido; fixo durante o run (a API recusa tirar a
      // ferramenta com resultado dele no histórico).
      const advisor = remote ? undefined : advisorOf(live.agent);
      const maxTurns = live.limits?.maxTurns ?? MAX_TURNS;
      let finished = false;
      for (let turn = 0; turn < maxTurns; turn++) {
        turnNow = turn;
        for (const m of live.inbox.splice(0)) history.push(await this.asModelMessage(live, m));
        this.emit(live, { type: "run.thinking", turn });
        turnText = "";
        typing = false;
        let result: { content: ModelMessage["content"]; raw: unknown; stop: string; usage: Usage } | null =
          null;
        partial = "";
        // Pela API, reserva o pior caso desta chamada antes de fazer (o plano do computador não custa aqui).
        const held = remote
          ? null
          : await this.reserveCall({
              agent: live.agent,
              channelId: live.channel.id,
              scopes: [...(live.limits?.scopes ?? []), ...(live.assignment?.scope ? [live.assignment.scope] : [])],
              promptBytes:
                utf8Bytes(system) + utf8Bytes(JSON.stringify(history)) + utf8Bytes(JSON.stringify(specs)),
              maxTokens: MAX_TOKENS,
              advisor,
            });
        if (held && !held.ok) {
          // Teto do canal (F2-3.5-P1-01): para aqui e avisa quem pediu, na thread.
          if (held.scope.kind === "channel") {
            await this.channelBudgetCheck(live.channel.id, personOf(live.trigger), true);
            throw new BudgetExhausted("channel");
          }
          if (held.scope.kind === "agent") await this.budgetCheck(live.agent, true);
          throw new BudgetExhausted(held.scope.kind);
        }
        const reservation = held?.reservation ?? null;
        try {
          for await (const ev of (provider as ModelProvider).stream({
            model: live.agent.model,
            system,
            messages: history,
            tools: specs,
            maxTokens: MAX_TOKENS,
            signal: live.controller.signal,
            ...(advisor ? { advisor } : {}),
          })) {
            if (ev.type === "text") {
              if (!typing) {
                typing = true;
                this.emit(live, { type: "agent.typing", turn });
              }
              turnText += ev.text;
              partial = turnText;
              this.emit(live, { type: "run.text_delta", seq: deltaSeq++, text: ev.text, turn });
            } else if (ev.type === "turn") {
              result = ev;
            }
          }
        } catch (err) {
          if (reservation) await this.deps.ledger.release(reservation);
          // O computador falhou antes de fazer qualquer coisa: com o fallback ligado, responde pela API.
          const untouched = !usedTools && !turnText.trim() && !live.controller.signal.aborted;
          if (err instanceof HarnessError && remote && live.agent.harnessFallback && untouched) {
            remote = null;
            live.plan = null;
            usageModel = live.agent.model;
            provider = await modelProvider();
            testModel = provider.kind === "fake";
            turn--;
            continue;
          }
          throw err;
        }
        if (!result) {
          if (reservation) await this.deps.ledger.release(reservation);
          throw new ModelError("network", "Stream ended without a turn");
        }
        usage = addUsage(usage, result.usage);
        // Uma linha por chamada no razão. O plano do Claude/ChatGPT não é cobrado aqui: a linha do run
        // pelo computador sai com custo 0 e não pesa no teto.
        const call = {
          agent: live.agent,
          userId: personOf(live.trigger),
          runId: live.runId,
          channelId: live.channel.id,
          source: (live.replyMeta?.fromRoutine ? "routine" : live.assignment ? "assignment" : "chat") as UsageSource,
          usage: result.usage,
          assignmentId: live.assignment?.assignmentId ?? null,
        };
        cost += reservation
          ? await this.settleCall(reservation, call)
          : await this.recordPlanCall(call, usageModel);
        await persistUsage();
        const text = result.content
          .flatMap((c) => (c.type === "text" ? [c.text] : []))
          .join("")
          .trim();
        const calls = result.content.filter((c) => c.type === "tool_use");

        if (result.stop === "tool_use" && calls.length > 0) {
          if (text) this.emit(live, { type: "run.commentary", turn, text });
          history.push({ role: "assistant", content: result.content, raw: result.raw });
          const outputs: ModelMessage["content"] = [];
          let first = true;
          for (const call of calls) {
            if (call.type !== "tool_use") continue;
            const out = await callTool(call, turn, first && text ? text : null);
            first = false;
            outputs.push({
              type: "tool_result",
              toolUseId: call.id,
              content: out.content,
              isError: out.isError,
              ...(out.searchResults ? { searchResults: out.searchResults } : {}),
            });
          }
          history.push({ role: "user", content: outputs });
          continue;
        }

        // A API parou no meio da busca de ferramentas dela: devolve o turno como veio e continua.
        if (result.stop === "pause") {
          history.push({ role: "assistant", content: result.content, raw: result.raw });
          continue;
        }

        if (text) await step("text", { text, turn });
        if (live.inbox.length > 0) {
          // Chegou mensagem durante este turno: posta o que já tem e continua com ela. O que veio
          // antes já foi respondido; o fim do run só decide o destino das mensagens novas.
          const fresh = new Set(live.inbox.map((m) => m.id));
          const answered = live.handles.filter((id) => !fresh.has(id));
          if (text) await post(text);
          live.handles = live.handles.filter((id) => fresh.has(id));
          await this.markHandled(live, answered, text ? "answered" : "silent");
          await settleIssueWork(this.deps.db, live.workspaceId, answered, {
            state: "idle",
            reason: null,
            runId: live.runId,
          });
          history.push({ role: "assistant", content: result.content, raw: result.raw });
          continue;
        }
        live.closing = true;
        finalText = text;
        finished = true;
        break;
      }
      // Rotina: acabar as voltas ainda pedindo ferramenta é parar no teto, não terminar o trabalho.
      if (!finished && live.limits) throw new StepLimit(maxTurns);

      clearInterval(beat);
      if (deadline) clearTimeout(deadline);
      const message = finalText ? await post(finalText) : null;
      const status = message || posted > 0 ? "answered" : "silent";
      await this.finish(live, { status: "done", handled: status, messageId: message?.id ?? null });
      await this.budgetCheck(live.agent);
      await this.channelBudgetCheck(live.channel.id, personOf(live.trigger));
    } catch (caught) {
      live.closing = true;
      clearInterval(beat);
      if (deadline) clearTimeout(deadline);
      // O teto de tempo aborta pelo controller: o erro que sobe é o do stream; a causa é o TimeLimit.
      const reason: unknown = live.controller.signal.reason;
      const err = reason instanceof TimeLimit ? reason : caught;
      const canceled =
        !(err instanceof TimeLimit) && (err instanceof RunCanceled || live.controller.signal.aborted);
      if (canceled) {
        if (partial.trim()) await post(partial.trim(), { canceled: true }).catch(() => null);
        await this.finish(live, { status: "canceled", handled: "canceled", messageId: null });
        return;
      }
      if (err instanceof HarnessError) {
        const notice = harnessNotice(live.agent.id, err);
        const message = await post(notice.body, notice.meta).catch(() => null);
        await this.finish(live, {
          status: "failed",
          handled: "failed",
          messageId: message?.id ?? null,
          error: err.message,
          errorCode: `harness.${err.code}`,
        });
        return;
      }
      const budgetOut = err instanceof BudgetExhausted && err.scope !== "routine_run";
      const channelOut = budgetOut && err.scope === "channel";
      const assignmentOut = budgetOut && err.scope === "assignment";
      const code =
        err instanceof BudgetExhausted
          ? err.scope === "assignment"
            ? "assignment_budget_exhausted"
            : err.scope === "routine_run"
              ? "routine_budget"
              : err.scope === "channel"
                ? "channel_budget_exhausted"
                : "budget_exhausted"
          : err instanceof StepLimit
            ? "step_limit"
            : err instanceof TimeLimit
              ? "time_limit"
              : err instanceof ModelError
                ? err.code
                : "internal";
      if (code === "internal") log.error("runtime.run_failed", { runId: live.runId, err });
      await post(
        assignmentOut
          ? "I stopped: this assignment's budget ran out."
          : channelOut
            ? "I stopped: this channel's monthly budget ran out."
            : budgetOut
              ? "I stopped: my monthly budget ran out."
              : `I couldn't finish this (${code}).`,
        {
          bodyTemplate: assignmentOut
            ? "run.assignmentBudgetExhausted"
            : channelOut
              ? "run.channelBudgetExhausted"
              : budgetOut
                ? "run.budgetExhausted"
                : "run.failed",
          templateVars: { code },
        },
      ).catch(() => null);
      await this.finish(live, {
        status: "failed",
        handled: "failed",
        messageId: null,
        error: err instanceof Error ? err.message : String(err),
        errorCode: code,
      });
    }
  }

  private async finish(
    live: Live,
    end: {
      status: "done" | "failed" | "canceled";
      handled: "answered" | "silent" | "failed" | "canceled";
      messageId: string | null;
      error?: string;
      errorCode?: string;
    },
  ) {
    const { db } = this.deps;
    live.status = end.status;
    live.errorCode = end.errorCode ?? null;
    await db
      .update(runs)
      .set({
        status: end.status,
        finishedAt: this.deps.now(),
        error: end.error ?? null,
        errorCode: end.errorCode ?? null,
      })
      .where(eq(runs.id, live.runId));
    if (end.status === "canceled") {
      this.emit(live, { type: "run.stopped", actorUserId: live.canceledBy });
    } else {
      this.emit(live, {
        type: "run.completed",
        status: end.status,
        messageId: end.messageId,
        ...(end.errorCode ? { errorCode: end.errorCode } : {}),
      });
    }
    await this.closeWaits(live.runId);
    await this.markHandled(live, live.handles, end.handled);
    // Cancelado pelo desligamento do servidor (ninguém pediu para parar): o trabalho ficou pela metade,
    // como na queda do `start()`.
    const interrupted = end.status === "canceled" && this.stopped && !live.canceledBy;
    await settleIssueWork(db, live.workspaceId, live.handles, {
      state: end.status === "failed" || interrupted ? "blocked" : "idle",
      reason: interrupted ? "interrupted" : end.status === "failed" ? (end.errorCode ?? "failed") : null,
      runId: live.runId,
    });
    this.emit(live, { type: "run.idle" });
  }

  private async markHandled(live: Live, messageIds: string[], status: HandledStatus) {
    for (const messageId of messageIds) {
      await this.deps.db
        .update(messageDispatches)
        .set({ state: "handled", status, runId: live.runId })
        .where(and(eq(messageDispatches.messageId, messageId), eq(messageDispatches.agentId, live.agent.id)));
      this.emit(live, { type: "message.handled", messageId, status });
    }
  }

  // ---- contexto ----

  private async personName(live: Live): Promise<string> {
    const [row] = await this.deps.db
      .select({ name: users.name })
      .from(users)
      .where(eq(users.id, live.trigger.authorId));
    return row?.name ?? "";
  }

  /** Mensagem com conteúdo de fora (e-mail, webhook) no prompt: o run passa a ter A. */
  private noteUntrusted(live: Live, row: MessageRow) {
    const source = row.meta.untrusted;
    if (typeof source === "string" && source) live.risk.raise({ flag: "A", source });
  }

  private async asModelMessage(live: Live, row: MessageRow): Promise<ModelMessage> {
    this.noteUntrusted(live, row);
    if (row.authorKind === "agent" && row.authorId === live.agent.id) {
      return { role: "assistant", content: [{ type: "text", text: row.body }] };
    }
    const names = await this.authorNames(live.workspaceId, [row]);
    return {
      role: "user",
      content: [{ type: "text", text: `${names.get(row.authorId) ?? "?"}: ${row.body}` }],
    };
  }

  private async authorNames(workspaceId: string, rows: MessageRow[]): Promise<Map<string, string>> {
    const { db } = this.deps;
    const people = [...new Set(rows.filter((r) => r.authorKind === "person").map((r) => r.authorId))];
    const agentIds = [...new Set(rows.filter((r) => r.authorKind === "agent").map((r) => r.authorId))];
    const out = new Map<string, string>();
    if (people.length) {
      const ps = await db
        .select({ id: users.id, name: users.name, handle: members.handle })
        .from(members)
        .innerJoin(users, eq(users.id, members.userId))
        .where(and(eq(members.workspaceId, workspaceId), inArray(members.userId, people)));
      for (const p of ps) out.set(p.id, `${p.name} (@${p.handle})`);
    }
    for (const [id, a] of await agentNames(db, agentIds)) out.set(id, `${a.name} (@${a.handle}, agent)`);
    return out;
  }

  /** Últimas mensagens da conversa até o gatilho, como turnos do modelo. */
  private async history(live: Live): Promise<ModelMessage[]> {
    const { db } = this.deps;
    const where = live.threadId
      ? and(
          eq(messages.channelId, live.channel.id),
          or(eq(messages.threadId, live.threadId), eq(messages.id, live.threadId)),
        )
      : and(eq(messages.channelId, live.channel.id), isNull(messages.threadId));
    const rows = (
      await db
        .select()
        .from(messages)
        .where(and(where, lte(messages.createdAt, live.trigger.createdAt)))
        .orderBy(desc(messages.createdAt), desc(messages.id))
        .limit(HISTORY_LIMIT)
    ).reverse();
    if (!rows.some((r) => r.id === live.trigger.id)) rows.push(live.trigger);
    const names = await this.authorNames(live.workspaceId, rows);
    const out: ModelMessage[] = [];
    for (const r of rows) {
      this.noteUntrusted(live, r);
      if (r.authorKind === "agent" && r.authorId === live.agent.id) {
        if (out.length === 0) continue; // o primeiro turno tem que ser de quem pede
        out.push({ role: "assistant", content: [{ type: "text", text: r.body || "(no text)" }] });
      } else {
        out.push({
          role: "user",
          content: [{ type: "text", text: `${names.get(r.authorId) ?? "?"}: ${r.body}` }],
        });
      }
    }
    return out;
  }

  private async systemPrompt(live: Live): Promise<string> {
    const { db } = this.deps;
    const { agent, channel } = live;
    const workspace = await workspaceBudgetDefaults(db, live.workspaceId);
    const memory = await memoryPrompt(db, this.deps.now(), {
      workspaceId: live.workspaceId,
      agentId: agent.id,
      personId: requesterOf(live.trigger),
    });
    const skillRows = await db
      .select({ name: skills.name, description: skills.description })
      .from(skills)
      .innerJoin(skillGrants, and(eq(skillGrants.skillId, skills.id), eq(skillGrants.agentId, agent.id)))
      .where(eq(skillGrants.enabled, true))
      .orderBy(asc(skills.name));
    let where = `the channel #${channel.name}`;
    if (channel.kind === "dm") where = `a direct message with ${await this.personName(live)}`;
    const parts = [
      `You are ${agent.name} (@${agent.handle}), an AI agent on ${PRODUCT.name}, the team chat of ${workspace.name}.`,
      agent.role !== "custom" ? `Your role on the team: ${agent.role}.` : "",
      `# Instructions\n${agent.instructions.trim() || "No specific instructions yet. Be helpful and brief."}`,
      workspace.context.trim() ? `# About the company\n${workspace.context.trim()}` : "",
      memory,
      skillRows.length
        ? `# Skills (load one with load_skill before following it)\n${skillRows.map((s) => `- ${s.name}: ${s.description}`).join("\n")}`
        : "",
      `# This conversation\nYou are in ${where}. Messages from people arrive as "Name (@handle): text". ` +
        "Answer in the language of the person, in plain chat style and briefly. " +
        "Use your tools when they help; when there is nothing useful to add, end without text.",
      await assignmentPrompt(this.deps, agent.id, live.threadId),
    ];
    return parts.filter(Boolean).join("\n\n");
  }

  // ---- consulta entre agentes ----

  private async delegate(live: Live, target: AgentRow, question: string): Promise<string> {
    const { db } = this.deps;
    const id = newId("cons");
    const at = this.deps.now();
    await db.insert(delegations).values({
      id,
      workspaceId: live.workspaceId,
      requesterAgentId: live.agent.id,
      delegateAgentId: target.id,
      runId: live.runId,
      channelId: live.channel.id,
      question,
      createdAt: at,
    });
    this.emit(live, {
      type: "delegation.started",
      delegationId: id,
      delegateAgentId: target.id,
      question,
      startedAt: at.toISOString(),
    });
    const finish = async (status: "answered" | "expired" | "failed", answer: string | null) => {
      await db
        .update(delegations)
        .set({ status, answer, answeredAt: this.deps.now() })
        .where(eq(delegations.id, id));
      this.emit(live, {
        type: "delegation.completed",
        delegationId: id,
        delegateAgentId: target.id,
        status,
        answer,
      });
    };
    // Agente que pensa no computador de alguém: a consulta (pedida por outro agente) não usa o plano
    // dessa pessoa; vai pela API se o fallback deixar, e só quando quem pediu o run é quem pareou.
    const planOwner = (await withPlanOwner(db, target)).planOwnerUserId;
    if (
      target.harnessKind !== "model" &&
      (!target.harnessFallback || (planOwner !== null && planOwner !== personOf(live.trigger)))
    ) {
      await finish("failed", null);
      return `@${target.handle} thinks with ${EXECUTOR_NAME[target.harnessKind]} on a runner and can't take a delegation now.`;
    }
    const system =
      `You are ${target.name} (@${target.handle}), an AI agent on ${PRODUCT.name}. ` +
      `Another agent, ${live.agent.name} (@${live.agent.handle}), is asking you for help. Answer briefly.\n\n` +
      `# Your instructions\n${target.instructions.trim() || "-"}`;
    // A consulta gasta do alvo (X-F3-O0-4): sem saldo no teto dele, nem chama o modelo.
    // O gasto é do canal de quem pergunta, e o teto do run que pergunta (execução de rotina) também paga.
    const held = await this.reserveCall({
      agent: target,
      channelId: live.channel.id,
      scopes: live.limits?.scopes,
      promptBytes: utf8Bytes(system) + utf8Bytes(question),
      maxTokens: CONSULT_MAX_TOKENS,
    });
    if (!held.ok) {
      await finish("failed", null);
      if (held.scope.kind === "channel") {
        await this.channelBudgetCheck(live.channel.id, personOf(live.trigger), true);
        return `This channel is out of budget this month: @${target.handle} can't take a delegation.`;
      }
      if (held.scope.kind === "routine_run")
        return `@${target.handle} can't take a delegation: this routine run's spending cap doesn't fit the question.`;
      await this.budgetCheck(target, true);
      return `@${target.handle} is out of budget this month and can't take a delegation.`;
    }
    const reserved = held.reservation;
    const provider = await this.opts.providerFor(target);
    if ("error" in provider) {
      await this.deps.ledger.release(reserved);
      await finish("failed", null);
      return `@${target.handle} could not be reached.`;
    }
    const runId = newId("run");
    await db.insert(runs).values({
      id: runId,
      workspaceId: live.workspaceId,
      agentId: target.id,
      // O run não é de um canal, mas a pergunta veio deste: quem não lê o canal não vê a pergunta (X-F3-O0-2).
      sourceChannelId: live.channel.id,
      status: "running",
      what: whatOf(`@${live.agent.handle}: ${question}`),
      model: target.model,
      startedAt: at,
    });
    const timeout = AbortSignal.timeout(CONSULT_TIMEOUT_MS);
    const signal = AbortSignal.any([live.controller.signal, timeout]);
    let usage = emptyUsage();
    try {
      let answer = "";
      let turned = false;
      for await (const ev of provider.stream({
        model: target.model,
        system,
        messages: [{ role: "user", content: [{ type: "text", text: question }] }],
        tools: [],
        maxTokens: CONSULT_MAX_TOKENS,
        signal,
      })) {
        if (ev.type === "turn") {
          turned = true;
          usage = ev.usage;
          answer = ev.content.flatMap((c) => (c.type === "text" ? [c.text] : [])).join("");
        }
      }
      if (!turned) throw new ModelError("network", "Stream ended without a turn");
      const cost = await this.settleCall(reserved, {
        agent: target,
        userId: personOf(live.trigger),
        runId,
        channelId: live.channel.id,
        source: "delegation",
        usage,
      });
      await db
        .update(runs)
        .set({
          status: "done",
          finishedAt: this.deps.now(),
          inputTokens: usage.inputTokens + usage.cacheWriteTokens,
          cachedTokens: usage.cachedTokens,
          outputTokens: usage.outputTokens,
          costUsd: cost,
        })
        .where(eq(runs.id, runId));
      await finish("answered", answer);
      await this.budgetCheck(target);
      await this.channelBudgetCheck(live.channel.id, personOf(live.trigger));
      return answer || "(no answer)";
    } catch (err) {
      await this.deps.ledger.release(reserved);
      const expired = timeout.aborted && !live.controller.signal.aborted;
      await db
        .update(runs)
        .set({ status: "failed", finishedAt: this.deps.now(), errorCode: expired ? "timeout" : "failed" })
        .where(eq(runs.id, runId));
      await finish(expired ? "expired" : "failed", null);
      if (live.controller.signal.aborted) throw err;
      return `@${target.handle} did not answer.`;
    }
  }

  // ---- custo ----

  /** Modelo sem linha na tabela de preços é cobrado como o padrão (como era antes do razão). */
  private billed(model: string, at: Date): string {
    return PRICES.at(model, at) ? model : DEFAULT_MODEL;
  }

  /**
   * Reserva o pior caso da próxima chamada no teto do agente no mês e nos escopos extras, todos ou
   * nenhum (costura 2). null = algum teto não comporta: a chamada não sai.
   */
  private async reserveCall(req: {
    agent: AgentRow;
    /** Sem ele, o modelo do agente. */
    model?: string;
    /** Canal do gasto: a reserva entra no escopo dele, com teto ou só contando (F2-3.5-P1-01). */
    channelId?: string | null;
    scopes?: readonly BudgetScope[];
    promptBytes: number;
    maxTokens: number;
    /** Cada consulta relê a conversa e escreve até `maxTokens` no modelo do conselheiro. */
    advisor?: AdvisorSpec;
  }): Promise<{ ok: true; reservation: Reservation } | { ok: false; scope: BudgetScope }> {
    const at = this.deps.now();
    const channel = req.channelId ? await channelSpendScope(this.deps.db, req.channelId) : null;
    const scopes = [
      await agentBudgetScope(this.deps.db, req.agent),
      ...(channel ? [channel] : []),
      ...(req.scopes ?? []),
    ];
    let estimate = estimateUsd(PRICES, {
      model: this.billed(req.model ?? req.agent.model, at),
      promptBytes: req.promptBytes,
      maxTokens: req.maxTokens,
      at,
    });
    if (req.advisor)
      estimate +=
        req.advisor.maxUses *
        estimateUsd(PRICES, {
          model: this.billed(req.advisor.model, at),
          // Lê o prompt e o que o executor já escreveu (no máximo a saída inteira dele).
          promptBytes: req.promptBytes + req.maxTokens,
          maxTokens: req.advisor.maxTokens,
          at,
        });
    const res = await this.deps.ledger.reserve({ workspaceId: req.agent.workspaceId, scopes, estimateUsd: estimate, at });
    return res.ok ? { ok: true, reservation: res.reservation } : { ok: false, scope: res.scope };
  }

  /** Grava a chamada no razão com o custo real e solta a reserva. Devolve o custo. */
  private async settleCall(
    reservation: Reservation,
    call: {
      agent: AgentRow;
      /** Sem ele, o modelo do agente. */
      model?: string;
      userId: string | null;
      runId: string;
      channelId: string | null;
      source: UsageSource;
      usage: Usage;
      assignmentId?: string | null;
    },
  ): Promise<number> {
    const at = this.deps.now();
    const { costUsd } = await this.deps.ledger.settle(reservation, {
      workspaceId: call.agent.workspaceId,
      agentId: call.agent.id,
      userId: call.userId,
      runId: call.runId,
      channelId: call.channelId,
      assignmentId: call.assignmentId ?? null,
      source: call.source,
      model: this.billed(call.model ?? call.agent.model, at),
      usage: call.usage,
      keySource: call.agent.credentialId ? "workspace" : "platform",
      at,
    });
    return costUsd;
  }

  /** Chamada pelo plano do computador: entra no razão com custo 0 (não pesa no teto). */
  private async recordPlanCall(
    call: Parameters<AgentRuntime["settleCall"]>[1],
    model: string,
  ): Promise<number> {
    const { costUsd } = await this.deps.ledger.record(
      {
        workspaceId: call.agent.workspaceId,
        agentId: call.agent.id,
        userId: call.userId,
        runId: call.runId,
        channelId: call.channelId,
        assignmentId: call.assignmentId ?? null,
        source: call.source,
        model,
        usage: call.usage,
        keySource: "plan",
        at: this.deps.now(),
      },
      [],
    );
    return costUsd;
  }

  /** Telemetria do gate: uma linha por chamada de ferramenta, com a classe e a decisão. */
  private async recordDecision(
    live: Live,
    d: {
      tool: string;
      decision: GateDecision;
      approvalId: string | null;
      credential?: CredentialRef | null;
      by?: DecisionBy;
    },
  ): Promise<void> {
    const { decision, by } = d;
    // Costura 7: quem age é o agente; quem pediu fica só como auditoria; credencial de quem pediu falha aqui.
    const who = actionCredential({
      agentId: live.agent.id,
      requesterId: requesterOf(live.trigger),
      credential: d.credential ?? null,
    });
    // Regra ou revisor resolvem um "ask" do gate: a linha guarda o desfecho e o motivo do gate.
    const outcome = by ? (by.kind === "rule" ? "allow" : by.verdict) : decision.kind;
    await this.deps.db.insert(gateDecisions).values({
      id: newId("tdec"),
      workspaceId: live.workspaceId,
      agentId: live.agent.id,
      runId: live.runId,
      tool: d.tool,
      effect: decision.effect,
      decision: outcome,
      reason: decision.kind === "allow" ? null : decision.reason,
      flags: [...decision.flags].sort(),
      approvalId: d.approvalId,
      initiatedBy: who.actingFor,
      credential: who.credential,
      by: by?.kind ?? null,
      ruleId: by?.kind === "rule" ? by.ruleId : null,
      createdAt: this.deps.now(),
    });
  }

  /**
   * Revisor de modelo (F3-3.2-P1-02, reviewer.ts). null = não decide e a pessoa decide: revisor
   * desligado na org, disjuntor aberto, quem pediu não é pessoa ou não escreveu nada aqui, falha ou
   * sem saldo.
   */
  async reviewCall(input: {
    agent: AgentRow;
    channelId: string;
    threadId: string | null;
    /** Autor do pedido; null quando o run não veio de uma pessoa. */
    requesterId: string | null;
    /** Quando chegou a mensagem que abriu o run: o revisor só lê o que a pessoa escreveu perto dela. */
    requestAt: Date;
    req: ReviewRequest;
  }): Promise<"allow" | "ask" | null> {
    const { db } = this.deps;
    const at = this.deps.now();
    const [workspace] = await db
      .select({ on: workspaces.approvalReviewer })
      .from(workspaces)
      .where(eq(workspaces.id, input.agent.workspaceId));
    if (!workspace?.on || !input.requesterId) return null;
    if (breakerOpen(await recentVerdicts(db, input.agent.id, at))) return null;
    const said = await personSaid(db, {
      channelId: input.channelId,
      threadId: input.threadId,
      requesterId: input.requesterId,
      requestAt: input.requestAt,
      upTo: at,
    });
    if (said.length === 0) return null;
    const res = await this.complete({
      agent: input.agent,
      initiatedBy: input.requesterId,
      system: REVIEWER_SYSTEM,
      prompt: reviewPrompt(said, input.req),
      what: `Review ${input.req.tool}`,
      maxTokens: REVIEWER_MAX_TOKENS,
      source: "review",
      model: REVIEWER_MODEL,
      channelId: input.channelId,
    });
    return res.ok ? verdictOf(res.text) : null;
  }

  /**
   * Gasto do agente no mês contra o teto: avisa o responsável em 80% e no fim (uma vez por mês cada).
   * "exhausted" quando não cabe nem uma resposta no pior caso (a saída inteira de `MAX_TOKENS`), ou
   * quando uma reserva acabou de ser recusada (`refused`).
   */
  private async budgetCheck(agent: AgentRow, rejected = false): Promise<"ok" | "warning" | "exhausted"> {
    const at = this.deps.now();
    const scope = await agentBudgetScope(this.deps.db, agent);
    const spent = await this.deps.ledger.spent(scope, at);
    const floor = estimateUsd(PRICES, {
      model: this.billed(agent.model, at),
      promptBytes: 0,
      maxTokens: MAX_TOKENS,
      at,
    });
    if (rejected || spent + floor > scope.limitUsd) {
      await this.notifyBudget(agent, "exhausted", spent, scope.limitUsd);
      return "exhausted";
    }
    if (spent >= scope.limitUsd * BUDGET_WARNING_RATIO) {
      await this.notifyBudget(agent, "warning", spent, scope.limitUsd);
      return "warning";
    }
    return "ok";
  }

  /** Um aviso de cada tipo por mês, para o responsável pelo agente. */
  private async notifyBudget(agent: AgentRow, kind: "warning" | "exhausted", spent: number, budget: number) {
    const { db, hub } = this.deps;
    const month = monthKey(this.deps.now());
    const [row] = await db
      .select({ notice: agents.budgetNotice })
      .from(agents)
      .where(eq(agents.id, agent.id));
    const notice = row?.notice ?? "";
    if (notice === `${kind}:${month}` || (kind === "warning" && notice === `exhausted:${month}`)) return;
    await db
      .update(agents)
      .set({ budgetNotice: `${kind}:${month}` })
      .where(eq(agents.id, agent.id));
    hub.toUser(agent.workspaceId, agent.ownerUserId, {
      type: kind === "exhausted" ? "budget.cap_reached" : "budget.threshold_reached",
      agentId: agent.id,
      spentUsd: spent,
      budgetUsd: budget,
    });
  }

  /**
   * Gasto do canal no mês contra o teto dele (F2-3.5-P1-01): avisa em 75% e 90% e quando acaba (ou a
   * reserva acabou de ser recusada), um de cada por mês. Recebem quem pediu e quem configura a org
   * (quem pode subir o teto). Canal sem teto: nada.
   */
  private async channelBudgetCheck(channelId: string, requesterId: string | null, rejected = false) {
    const { db, hub } = this.deps;
    const scope = await channelBudgetScope(db, channelId);
    if (!scope) return;
    const at = this.deps.now();
    const spent = await this.deps.ledger.spent(scope, at);
    const crossed = CHANNEL_WARNINGS.filter((r) => spent >= scope.limitUsd * r);
    const level =
      rejected || spent >= scope.limitUsd
        ? "exhausted"
        : crossed.length
          ? String(Math.round((crossed.at(-1) as number) * 100))
          : null;
    if (!level) return;
    const rank = (l: string) => (l === "exhausted" ? 3 : l === "90" ? 2 : l === "75" ? 1 : 0);
    const month = monthKey(at);
    const [row] = await db
      .select({ workspaceId: channels.workspaceId, name: channels.name, notice: channels.budgetNotice })
      .from(channels)
      .where(eq(channels.id, channelId));
    if (!row) return;
    const [lastLevel, lastMonth] = (row.notice ?? "").split(":");
    if (lastMonth === month && rank(lastLevel ?? "") >= rank(level)) return;
    // Quem grava o aviso primeiro avisa: duas checagens ao mesmo tempo não mandam dois.
    const claimed = await db
      .update(channels)
      .set({ budgetNotice: `${level}:${month}` })
      .where(
        and(
          eq(channels.id, channelId),
          row.notice === null ? isNull(channels.budgetNotice) : eq(channels.budgetNotice, row.notice),
        ),
      )
      .returning({ id: channels.id });
    if (claimed.length === 0) return;
    const admins = await db
      .select({ userId: members.userId })
      .from(members)
      .where(and(eq(members.workspaceId, row.workspaceId), inArray(members.role, ["owner", "admin"])));
    const to = new Set([...admins.map((a) => a.userId), ...(requesterId ? [requesterId] : [])]);
    for (const userId of to)
      hub.toUser(row.workspaceId, userId, {
        type: "channel.budget",
        channelId,
        channelName: row.name,
        level,
        spentUsd: spent,
        budgetUsd: scope.limitUsd,
      });
  }

  // ---- lembretes ----

  /** Posta os lembretes vencidos. Cada um é reservado antes (status sent), então dois ticks não duplicam. */
  async tick(): Promise<number> {
    if (this.ticking) return 0;
    this.ticking = true;
    try {
      const { db } = this.deps;
      await this.expireWaits();
      // Caixa: pedido resolvido fecha o aviso, adiado e lembrete voltam, retenção, push e e-mail.
      await notificationTick(this.deps);
      await debateDeadlines(this.deps);
      await dueRoutines(this.deps);
      await drainQueues(this.deps);
      await pollEmailRoutines(this.deps);
      await expireRunnerRequests(this.deps);
      await purgeReservations(db, this.deps.now());
      await deliverDue(this.deps);
      const due = await db
        .select()
        .from(reminders)
        .where(and(eq(reminders.status, "scheduled"), lte(reminders.at, this.deps.now())))
        .orderBy(asc(reminders.at))
        .limit(50);
      let sent = 0;
      for (const r of due) {
        const claimed = await db
          .update(reminders)
          .set({ status: "sent", sentAt: this.deps.now() })
          .where(and(eq(reminders.id, r.id), eq(reminders.status, "scheduled")))
          .returning({ id: reminders.id });
        if (claimed.length === 0) continue;
        const [channel] = await db.select().from(channels).where(eq(channels.id, r.channelId));
        if (!channel || channel.archivedAt) continue;
        const author =
          r.agentId !== null
            ? ({ type: "agent", id: r.agentId } as const)
            : ({ type: "person", id: r.createdById } as const);
        await postMessage(this.deps, {
          workspaceId: r.workspaceId,
          channel,
          author,
          body: r.text,
          clientId: `reminder:${r.id}`,
          threadId: r.threadId,
          meta: { reminder: { reminderId: r.id } },
        });
        sent++;
      }
      return sent;
    } finally {
      this.ticking = false;
    }
  }
}

/** Resumo curto do input para a linha da ferramenta: o primeiro texto que ele tiver. */
export function toolDetail(input: unknown): string | null {
  if (typeof input !== "object" || input === null) return null;
  for (const value of Object.values(input)) {
    if (typeof value === "string" && value.trim()) {
      const v = value.trim().replace(/\s+/g, " ");
      return v.length > 80 ? `${v.slice(0, 79)}…` : v;
    }
  }
  return null;
}

function whatOf(body: string): string {
  const clean = body
    .replace(/\[\[[^\]]*\]\]/g, "")
    .replace(/\s+/g, " ")
    .trim();
  return clean.length > 120 ? `${clean.slice(0, 119)}…` : clean;
}
