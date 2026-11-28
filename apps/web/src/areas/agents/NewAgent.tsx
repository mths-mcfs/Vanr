// The guided creation of an agent, for whoever manages agents: a role (or a draft written from a
// description), a name and handle with an appearance, instructions, the channels it joins, the model,
// owner and audience, then a review before anything is saved. The handle follows the name until it is
// typed by hand. A handle the server refuses (one an archived agent keeps, or one taken a moment ago)
// sends the person back to the name step, which stays blocked until it changes.
import { isApiError } from "@vanr/client";
import { useApiMutation, useApiQuery, useVanrClient } from "@vanr/client/react";
import type { Agent, AgentAppearance, AgentAudience, AgentDraft, AgentRole } from "@vanr/contract";
import {
  AgentSigil,
  Button,
  Callout,
  Checkbox,
  EmptyState,
  Field,
  Input,
  Select,
  SelectItem,
  Surface,
  Textarea,
} from "@vanr/ui";
import { ChevronLeft, Sparkles } from "lucide-react";
import { type FormEvent, useState } from "react";
import { AppLink, useGo, useRouteParams } from "../../app/navigation.tsx";
import { useDocumentTitle, useErrorMessage } from "../../app/screens.tsx";
import { useMessages } from "../../i18n/react.tsx";
import { useSession } from "../../session/react.tsx";
import { AppearanceFields, AudienceFields } from "./fields.tsx";
import {
  DESCRIPTION_MAX,
  HANDLE_MAX,
  HANDLE_RE,
  handleFromName,
  INSTRUCTIONS_MAX,
  NAME_MAX,
  PartError,
  PartLoading,
  ROLES,
  randomAppearance,
  useAgentRights,
} from "./shared.tsx";

const STEPS = ["role", "identity", "instructions", "channels", "options", "review"] as const;
type Step = (typeof STEPS)[number];

export function NewAgentScreen() {
  const t = useMessages("agents");
  const { workspaceId } = useRouteParams("agentNew");
  const rights = useAgentRights(workspaceId);
  const [created, setCreated] = useState<Agent | null>(null);
  useDocumentTitle(t("new.title"));
  if (!rights.manage) {
    return (
      <div className="page">
        <EmptyState className="page__narrow" title={t("new.denied")} description={t("new.deniedBody")} />
      </div>
    );
  }
  if (created !== null) return <Created agent={created} workspaceId={workspaceId} />;
  return <Wizard workspaceId={workspaceId} onCreated={setCreated} />;
}

function Wizard({ workspaceId, onCreated }: { workspaceId: string; onCreated: (agent: Agent) => void }) {
  const t = useMessages("agents");
  const common = useMessages("common");
  const describe = useErrorMessage("agents");
  const { me } = useSession();
  const { api } = useVanrClient();
  const channels = useApiQuery("listChannels", { workspaceId });
  const models = useApiQuery("listModels", {});
  const members = useApiQuery("listMembers", { workspaceId });
  const agents = useApiQuery("listAgents", { workspaceId });
  const create = useApiMutation("createAgent", {
    invalidates: () => [
      { method: "listAgents", args: { workspaceId } },
      { method: "getTeam", args: { workspaceId } },
    ],
  });

  const [step, setStep] = useState<Step>("role");
  const [role, setRole] = useState<AgentRole>("assistant");
  const [name, setName] = useState("");
  const [typedHandle, setTypedHandle] = useState<string | null>(null);
  const [appearance, setAppearance] = useState<AgentAppearance>(() => randomAppearance());
  const [instructions, setInstructions] = useState("");
  const [channelIds, setChannelIds] = useState<string[] | null>(null);
  const [model, setModel] = useState<string | null>(null);
  const [owner, setOwner] = useState<string | null>(null);
  const [audience, setAudience] = useState<AgentAudience>({ mode: "everyone", userIds: [] });
  const [refused, setRefused] = useState<string[]>([]);
  const [draftSkills, setDraftSkills] = useState<string[]>([]);
  const [drafted, setDrafted] = useState<AgentDraft | null>(null);
  const [failure, setFailure] = useState<string | null>(null);

  const handle = typedHandle ?? handleFromName(name);
  const taken = new Set([
    ...(agents.data ?? []).map((agent) => agent.handle),
    ...(members.data ?? []).map((member) => member.handle),
    ...refused,
  ]);
  const handleError =
    handle !== "" && !HANDLE_RE.test(handle)
      ? t("new.handleInvalid")
      : taken.has(handle)
        ? t("error.agent.handle_taken")
        : undefined;
  const rooms = (channels.data ?? []).filter((channel) => channel.isMember);
  const general = rooms.find((channel) => channel.isGeneral);
  const chosen = channelIds ?? (general === undefined ? [] : [general.id]);
  // A model picked (or drafted) that the list does not offer gives way to the default.
  const offered = models.data?.models.some((option) => option.id === model) === true;
  const modelId = (offered ? model : null) ?? models.data?.defaultModel ?? "";
  const ownerId = owner ?? me?.user.id ?? "";
  const valid: Record<Step, boolean> = {
    role: true,
    identity: name.trim() !== "" && handle !== "" && handleError === undefined,
    instructions: instructions.length <= INSTRUCTIONS_MAX,
    channels: channels.isSuccess,
    options: modelId !== "" && ownerId !== "" && (audience.mode !== "people" || audience.userIds.length > 0),
    review: true,
  };
  const index = STEPS.indexOf(step);
  const move = (delta: number) => {
    const next = STEPS[index + delta];
    if (next !== undefined) setStep(next);
  };

  const save = () => {
    setFailure(null);
    create.mutate(
      {
        workspaceId,
        body: {
          name: name.trim(),
          handle,
          role,
          instructions,
          model: modelId,
          ownerUserId: ownerId,
          audience,
          appearance,
          channelIds: chosen,
        },
      },
      {
        onSuccess: async (agent) => {
          // The skills the draft suggested are turned on once the agent exists; a failure here is not
          // worth losing the agent over, so the profile is where they are fixed.
          if (draftSkills.length > 0) {
            await api
              .setAgentSkills({
                workspaceId,
                agentId: agent.id,
                body: { skills: draftSkills.map((id) => ({ id, enabled: true })) },
              })
              .catch(() => undefined);
          }
          onCreated(agent);
        },
        onError: (error) => {
          if (isApiError(error) && error.rawCode === "agent.handle_taken") {
            setRefused((list) => [...list, handle]);
            setStep("identity");
            return;
          }
          setFailure(describe(error));
        },
      },
    );
  };

  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (!valid[step]) return;
    if (step === "review") save();
    else move(1);
  };

  const applyDraft = (draft: AgentDraft) => {
    setDrafted(draft);
    setRole(draft.role);
    setName(draft.name.slice(0, NAME_MAX));
    setTypedHandle(draft.handle);
    setInstructions(draft.instructions.slice(0, INSTRUCTIONS_MAX));
    setModel(draft.model);
    setDraftSkills(draft.skillIds);
    setStep("identity");
  };

  return (
    <div className="page">
      <header className="agents-head">
        <div>
          <h1 className="page__title">{t("new.title")}</h1>
          <p className="page__muted">{t("new.lead")}</p>
        </div>
        <AppLink className="app-link" route="agents" params={{ workspaceId }}>
          {common("action.cancel")}
        </AppLink>
      </header>
      <ol className="wizard-steps" aria-label={t("new.steps")}>
        {STEPS.map((name, at) => (
          <li
            key={name}
            className={at === index ? "wizard-steps__on" : at < index ? "wizard-steps__done" : undefined}
            aria-current={at === index ? "step" : undefined}
          >
            {t(`new.step.${name}`)}
          </li>
        ))}
      </ol>
      <form
        className="section-form"
        aria-label={t("new.stepOf", { at: index + 1, total: STEPS.length, step: t(`new.step.${step}`) })}
        onSubmit={submit}
      >
        <Surface variant="card" className="wizard-card">
          {drafted !== null && step !== "role" && step !== "review" && (
            <Callout tone="info">{t(drafted.testModel ? "new.draftedTest" : "new.drafted")}</Callout>
          )}
          {step === "role" && (
            <>
              <Describe workspaceId={workspaceId} onDraft={applyDraft} />
              <fieldset className="agent-fieldset">
                <legend className="page__heading">{t("new.roleQuestion")}</legend>
                <div className="role-grid">
                  {ROLES.map((option) => (
                    <button
                      key={option}
                      type="button"
                      className="role-grid__item"
                      aria-pressed={role === option}
                      onClick={() => setRole(option)}
                    >
                      <strong>{t(`role.${option}`)}</strong>
                      <span>{t(`roleHint.${option}`)}</span>
                    </button>
                  ))}
                </div>
              </fieldset>
            </>
          )}
          {step === "identity" && (
            <>
              <Field label={t("field.name")} hint={t("field.nameHint", { max: NAME_MAX })}>
                <Input value={name} maxLength={NAME_MAX} onChange={(event) => setName(event.target.value)} />
              </Field>
              <Field label={t("field.handle")} hint={t("field.handleHint")} error={handleError}>
                <Input
                  value={handle}
                  mono
                  maxLength={HANDLE_MAX}
                  spellCheck={false}
                  autoComplete="off"
                  onChange={(event) => setTypedHandle(event.target.value.trim().toLowerCase())}
                />
              </Field>
              <AppearanceFields value={appearance} onChange={setAppearance} />
            </>
          )}
          {step === "instructions" && (
            <Field
              label={t("field.instructions")}
              hint={t("field.count", { count: instructions.length, max: INSTRUCTIONS_MAX })}
            >
              <Textarea
                rows={12}
                value={instructions}
                maxLength={INSTRUCTIONS_MAX}
                placeholder={t("field.instructionsPlaceholder", { role: t(`role.${role}`) })}
                onChange={(event) => setInstructions(event.target.value)}
              />
            </Field>
          )}
          {step === "channels" && (
            <fieldset className="agent-fieldset">
              <legend className="page__heading">{t("new.channelsQuestion")}</legend>
              <p className="page__muted">{t("new.channelsHint")}</p>
              {channels.isPending ? (
                <PartLoading />
              ) : channels.isError ? (
                <PartError
                  title={t("new.channelsFailed")}
                  error={channels.error}
                  onRetry={() => void channels.refetch()}
                />
              ) : rooms.length === 0 ? (
                <p className="page__muted">{t("new.noRooms")}</p>
              ) : (
                <ul className="agent-picks" aria-label={t("new.channelsQuestion")}>
                  {rooms.map((channel) => (
                    <li key={channel.id}>
                      <Checkbox
                        label={`#${channel.name}`}
                        checked={chosen.includes(channel.id)}
                        onCheckedChange={(on) =>
                          setChannelIds(
                            on === true ? [...chosen, channel.id] : chosen.filter((id) => id !== channel.id),
                          )
                        }
                      />
                    </li>
                  ))}
                </ul>
              )}
            </fieldset>
          )}
          {step === "options" && (
            <>
              {models.isError ? (
                <PartError
                  title={t("new.modelsFailed")}
                  error={models.error}
                  onRetry={() => void models.refetch()}
                />
              ) : (
                <Field label={t("field.model")} hint={t("field.modelHint")}>
                  <Select value={modelId} disabled={models.isPending} onValueChange={setModel}>
                    {(models.data?.models ?? []).map((option) => (
                      <SelectItem key={option.id} value={option.id}>
                        {option.label}
                      </SelectItem>
                    ))}
                  </Select>
                </Field>
              )}
              {members.isError ? (
                <PartError
                  title={t("new.membersFailed")}
                  error={members.error}
                  onRetry={() => void members.refetch()}
                />
              ) : (
                <>
                  <Field label={t("field.owner")} hint={t("field.ownerHint")}>
                    <Select value={ownerId} disabled={members.isPending} onValueChange={setOwner}>
                      {(members.data ?? []).map((member) => (
                        <SelectItem key={member.userId} value={member.userId}>
                          {member.name}
                        </SelectItem>
                      ))}
                    </Select>
                  </Field>
                  <AudienceFields value={audience} onChange={setAudience} people={members.data ?? []} />
                </>
              )}
            </>
          )}
          {step === "review" && (
            <div className="agent-review">
              <AgentSigil agentId={handle} name="" aria-hidden="true" size="lg" />
              <dl className="agent-facts" aria-label={t("new.summary")}>
                <dt>{t("field.name")}</dt>
                <dd>
                  {name.trim()} <span className="listing__handle">@{handle}</span>
                </dd>
                <dt>{t("card.role")}</dt>
                <dd>{t(`role.${role}`)}</dd>
                <dt>{t("new.channels")}</dt>
                <dd>
                  {chosen.length === 0
                    ? t("new.noChannels")
                    : rooms
                        .filter((channel) => chosen.includes(channel.id))
                        .map((channel) => `#${channel.name}`)
                        .join(", ")}
                </dd>
                <dt>{t("field.model")}</dt>
                <dd>{models.data?.models.find((option) => option.id === modelId)?.label ?? modelId}</dd>
                <dt>{t("field.owner")}</dt>
                <dd>{members.data?.find((member) => member.userId === ownerId)?.name ?? ""}</dd>
                <dt>{t("audience.title")}</dt>
                <dd>{t(`audience.${audience.mode}`)}</dd>
              </dl>
            </div>
          )}
          {failure !== null && (
            <Callout tone="danger" role="alert">
              {failure}
            </Callout>
          )}
        </Surface>
        <div className="section-form__actions">
          {index > 0 && (
            <Button variant="ghost" icon={<ChevronLeft size={16} />} onClick={() => move(-1)}>
              {t("new.back")}
            </Button>
          )}
          <Button type="submit" variant="primary" disabled={!valid[step]} loading={create.isPending}>
            {step === "review" ? t("new.create") : t("new.next")}
          </Button>
        </div>
      </form>
    </div>
  );
}

/** "Describe it and I'll draft it": fills the wizard from a description; nothing is saved until the end. */
function Describe({ workspaceId, onDraft }: { workspaceId: string; onDraft: (draft: AgentDraft) => void }) {
  const t = useMessages("agents");
  const describe = useErrorMessage("agents");
  const [text, setText] = useState("");
  const draft = useApiMutation("createAgentDraft");
  return (
    <section className="agent-describe">
      <Field
        label={t("describe.title")}
        hint={t("field.count", { count: text.length, max: DESCRIPTION_MAX })}
      >
        <Textarea
          rows={3}
          value={text}
          maxLength={DESCRIPTION_MAX}
          placeholder={t("describe.placeholder")}
          onChange={(event) => setText(event.target.value)}
        />
      </Field>
      <div>
        <Button
          icon={<Sparkles size={16} />}
          disabled={text.trim() === ""}
          loading={draft.isPending}
          onClick={() =>
            draft.mutate({ workspaceId, body: { description: text.trim() } }, { onSuccess: onDraft })
          }
        >
          {t(draft.isPending ? "describe.drafting" : "describe.action")}
        </Button>
      </div>
      {draft.isError && (
        <Callout tone="danger" role="alert">
          {describe(draft.error)}
        </Callout>
      )}
    </section>
  );
}

function Created({ agent, workspaceId }: { agent: Agent; workspaceId: string }) {
  const t = useMessages("agents");
  const go = useGo();
  return (
    <div className="page">
      <Surface variant="card" className="wizard-card wizard-card--done" role="status">
        <AgentSigil agentId={agent.id} name="" aria-hidden="true" size="lg" />
        <h1 className="page__title">{t("new.created", { name: agent.name })}</h1>
        <p className="page__muted">{t("new.createdBody", { handle: agent.handle })}</p>
        <div className="section-form__actions">
          <Button variant="secondary" onClick={() => void go("agent", { workspaceId, agentId: agent.id })}>
            {t("card.profile")}
          </Button>
          <Button variant="primary" onClick={() => void go("dmAgent", { workspaceId, agentId: agent.id })}>
            {t("card.message", { name: agent.name })}
          </Button>
        </div>
      </Surface>
    </div>
  );
}
