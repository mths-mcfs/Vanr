// Pairing a runner by code: the runner prints a code and this address (`/connect?code=…`). The person
// signed in checks which computer asks, picks the workspace it joins (one where they may post) and its
// name, then accepts or declines; the runner learns the answer on its own. A runner paired before keeps
// its workspace. Without a code, or with one that expired, the person types it again.
import { isApiError } from "@vanr/client";
import { useApiMutation, useApiQuery } from "@vanr/client/react";
import { can, type Runner } from "@vanr/contract";
import { Button, Callout, Field, Input, Select, SelectItem } from "@vanr/ui";
import { type FormEvent, useState } from "react";
import { z } from "zod";
import { useGo, useSearch } from "../../app/navigation.tsx";
import { StandalonePage } from "../../app/Standalone.tsx";
import { useErrorMessage } from "../../app/screens.tsx";
import { useMessages } from "../../i18n/react.tsx";
import { useSecondsUntil } from "../../platform/clock.tsx";
import { useSession } from "../../session/react.tsx";
import { RUNNER_NAME_MAX } from "./Runners.tsx";
import { PartError, PartLoading } from "./shared.tsx";

export const CODE_MAX = 12;
const CodeSearch = z.object({ code: z.string().optional() });
const NO_CODE: z.infer<typeof CodeSearch> = {};

/** A code as typed: no spaces around it, uppercase, at most 12 characters. */
export const normalizeCode = (typed: string) => typed.trim().toUpperCase().slice(0, CODE_MAX);

export function PairingScreen() {
  const t = useMessages("agents");
  const go = useGo();
  const code = normalizeCode(useSearch(CodeSearch, NO_CODE).code ?? "");
  const ask = (next: string) => void go("runnerPairing", {}, { search: { code: next } });
  if (code === "") {
    return (
      <StandalonePage title={t("pair.title")} why={t("pair.typeWhy")}>
        <CodeForm onCode={ask} />
      </StandalonePage>
    );
  }
  return <Request key={code} code={code} onCode={ask} />;
}

function CodeForm({ onCode, initial = "" }: { onCode: (code: string) => void; initial?: string }) {
  const t = useMessages("agents");
  const [typed, setTyped] = useState(initial);
  const submit = (event: FormEvent) => {
    event.preventDefault();
    const code = normalizeCode(typed);
    if (code !== "") onCode(code);
  };
  return (
    <form className="section-form" aria-label={t("pair.typeCode")} onSubmit={submit}>
      <Field label={t("pair.code")} hint={t("pair.codeHint")}>
        <Input
          mono
          value={typed}
          maxLength={CODE_MAX}
          autoComplete="off"
          spellCheck={false}
          onChange={(event) => setTyped(event.target.value.toUpperCase())}
        />
      </Field>
      <Button type="submit" variant="primary" disabled={normalizeCode(typed) === ""}>
        {t("pair.check")}
      </Button>
    </form>
  );
}

type Outcome = { kind: "accepted"; runner: Runner; workspaceId: string } | { kind: "declined" };

function Request({ code, onCode }: { code: string; onCode: (code: string) => void }) {
  const t = useMessages("agents");
  const describe = useErrorMessage("agents");
  const go = useGo();
  const { me } = useSession();
  const pairing = useApiQuery("getRunnerPairing", { pairingCode: code });
  const [workspace, setWorkspace] = useState<string | null>(null);
  const [name, setName] = useState<string | null>(null);
  const [outcome, setOutcome] = useState<Outcome | null>(null);
  const confirm = useApiMutation("confirmRunnerPairing");
  const deny = useApiMutation("denyRunnerPairing");
  const seconds = useSecondsUntil(
    pairing.data === undefined ? undefined : Date.parse(pairing.data.expiresAt),
  );

  if (outcome?.kind === "accepted") {
    return (
      <StandalonePage title={t("pair.accepted", { name: outcome.runner.name })} why={t("pair.acceptedWhy")}>
        <Button
          variant="primary"
          onClick={() => void go("runner", { workspaceId: outcome.workspaceId, runnerId: outcome.runner.id })}
        >
          {t("pair.openRunner")}
        </Button>
      </StandalonePage>
    );
  }
  if (outcome?.kind === "declined") {
    return <StandalonePage title={t("pair.declined")} why={t("pair.declinedWhy")} />;
  }
  if (pairing.isPending) {
    return (
      <StandalonePage title={t("pair.title")}>
        <PartLoading />
      </StandalonePage>
    );
  }
  if (pairing.isError) {
    // A code that expired, was used, or is not a code at all: type it again.
    if (isApiError(pairing.error) && (pairing.error.status === 404 || pairing.error.status === 400)) {
      return (
        <StandalonePage title={t("pair.invalid")} why={t("pair.invalidWhy")}>
          {/* The same code typed again asks again: it may have been a moment too early. */}
          <CodeForm
            onCode={(next) => (next === code ? void pairing.refetch() : onCode(next))}
            initial={code}
          />
        </StandalonePage>
      );
    }
    return (
      <StandalonePage title={t("pair.title")}>
        <PartError title={t("pair.failed")} error={pairing.error} onRetry={() => void pairing.refetch()} />
      </StandalonePage>
    );
  }

  const request = pairing.data;
  const eligible = (me?.workspaces ?? []).filter((each) => can(each.role, "post"));
  const fixed = request.reconnect?.workspaceId ?? null;
  const chosen = fixed ?? workspace ?? (eligible.length === 1 ? (eligible[0]?.id ?? null) : null);
  const label = name ?? request.name;
  const busy = confirm.isPending || deny.isPending;
  const failure = confirm.error ?? deny.error;
  const fixedName = me?.workspaces.find((each) => each.id === fixed)?.name;
  return (
    <StandalonePage
      title={t(request.reconnect === null ? "pair.askTitle" : "pair.reconnectTitle", { name: request.name })}
      why={t("pair.askWhy", { count: Math.max(1, Math.ceil(seconds / 60)) })}
    >
      <dl className="agent-facts" aria-label={t("pair.computer")}>
        <dt>{t("pair.code")}</dt>
        <dd>
          <code>{request.userCode}</code>
        </dd>
        <dt>{t("runner.hostname")}</dt>
        <dd>{request.hostname}</dd>
        <dt>{t("pair.system")}</dt>
        <dd>{t("pair.systemValue", { os: request.os, arch: request.arch })}</dd>
      </dl>
      {fixed !== null ? (
        <p>{t("pair.fixedWorkspace", { name: fixedName ?? "" })}</p>
      ) : eligible.length === 0 ? (
        <Callout tone="warning">{t("pair.noWorkspace")}</Callout>
      ) : (
        <Field label={t("pair.workspace")}>
          <Select
            value={chosen ?? ""}
            placeholder={t("pair.pickWorkspace")}
            disabled={busy}
            onValueChange={setWorkspace}
          >
            {eligible.map((each) => (
              <SelectItem key={each.id} value={each.id}>
                {each.name}
              </SelectItem>
            ))}
          </Select>
        </Field>
      )}
      <Field label={t("runner.name")}>
        <Input
          value={label}
          maxLength={RUNNER_NAME_MAX}
          disabled={busy}
          onChange={(event) => setName(event.target.value)}
        />
      </Field>
      {failure !== null && (
        <Callout tone="danger" role="alert">
          {describe(failure)}
        </Callout>
      )}
      <div className="section-form__actions">
        <Button
          variant="ghost"
          // Declining needs the same standing as pairing: a workspace where the person may post.
          disabled={(fixed === null && eligible.length === 0) || (busy && !deny.isPending)}
          loading={deny.isPending}
          onClick={() =>
            deny.mutate({ pairingCode: code }, { onSuccess: () => setOutcome({ kind: "declined" }) })
          }
        >
          {t("pair.deny")}
        </Button>
        <Button
          variant="primary"
          disabled={chosen === null || label.trim() === "" || (busy && !confirm.isPending)}
          loading={confirm.isPending}
          onClick={() => {
            if (chosen === null) return;
            confirm.mutate(
              { workspaceId: chosen, pairingCode: code, body: { name: label.trim() } },
              { onSuccess: (runner) => setOutcome({ kind: "accepted", runner, workspaceId: chosen }) },
            );
          }}
        >
          {t("pair.accept")}
        </Button>
      </div>
    </StandalonePage>
  );
}
