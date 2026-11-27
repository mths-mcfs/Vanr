// Where the workspace keeps its files: on this server, or in an S3-compatible bucket of its own.
// The bucket can be tested before it is saved (the server tests it again on save), and the files
// already on the server can be copied to it. Only someone who may configure the workspace opens
// this section; the settings frame shows the others why they can't.
import { isApiError } from "@vanr/client";
import { useApiMutation, useApiQuery } from "@vanr/client/react";
import type { S3Input, StorageConfig, StorageTestResult } from "@vanr/contract";
import { Button, Callout, Checkbox, Field, Input, Radio, RadioGroup, StatusBadge, Surface } from "@vanr/ui";
import { Upload } from "lucide-react";
import { useState } from "react";
import { z } from "zod";
import { useErrorMessage } from "../../../app/screens.tsx";
import { useMessages } from "../../../i18n/react.tsx";
import { SectionError, SectionLoading, useOutcome, useWorkspaceAccess } from "./shared.tsx";

// The server's limits (routes/integrations.ts, s3Input).
const LIMIT = { endpoint: 500, region: 64, bucketMin: 3, bucketMax: 63, prefix: 200, key: 200 } as const;
/** How often the copy to the bucket is checked while it runs. */
const MIGRATION_POLL_MS = 1500;

type Kind = StorageConfig["kind"];
type Form = Required<Pick<S3Input, "endpoint" | "region" | "bucket" | "pathAddressing">> & {
  prefix: string;
  accessKeyId: string;
  secretAccessKey: string;
};

/**
 * Whether the keys the form holds are enough. Without saved keys both are needed; with saved keys
 * both may stay empty (the saved pair is kept), but one alone is refused, since the server would
 * silently keep the old pair.
 */
function keysState(saved: boolean, form: Pick<Form, "accessKeyId" | "secretAccessKey">) {
  const key = form.accessKeyId.trim() !== "";
  const secret = form.secretAccessKey.trim() !== "";
  const half = key !== secret;
  return { half, missing: saved ? half : !key || !secret };
}

const StepFailures = z.object({
  steps: z.array(z.object({ step: z.string(), ok: z.boolean(), error: z.string().optional() })),
});

export function StorageSection() {
  const t = useMessages("settings");
  const { workspaceId } = useWorkspaceAccess();
  const storage = useApiQuery(
    "getStorage",
    { workspaceId },
    {
      refetchInterval: (query) =>
        query.state.data?.transfer?.status === "running" ? MIGRATION_POLL_MS : false,
    },
  );
  if (storage.isPending) return <SectionLoading />;
  if (storage.isError) {
    return (
      <SectionError
        title={t("storage.failed")}
        error={storage.error}
        onRetry={() => void storage.refetch()}
      />
    );
  }
  return <StorageForm workspaceId={workspaceId} current={storage.data} />;
}

function StorageForm({ workspaceId, current }: { workspaceId: string; current: StorageConfig }) {
  const t = useMessages("settings");
  const outcome = useOutcome();
  const describe = useErrorMessage("settings");
  const [kind, setKind] = useState<Kind | null>(null);
  const [draft, setDraft] = useState<Form | null>(null);
  const [test, setTest] = useState<StorageTestResult | null>(null);
  const refresh = () => [{ method: "getStorage" as const, args: { workspaceId } }];
  const runTest = useApiMutation("testStorage");
  const save = useApiMutation("setStorage", { invalidates: refresh });
  const migrate = useApiMutation("migrateStorage", { invalidates: refresh });

  const chosen = kind ?? current.kind;
  const form: Form = draft ?? {
    endpoint: current.s3?.endpoint ?? "",
    region: current.s3?.region ?? "",
    bucket: current.s3?.bucket ?? "",
    prefix: current.s3?.prefix ?? "",
    pathAddressing: current.s3?.pathAddressing ?? false,
    accessKeyId: "",
    secretAccessKey: "",
  };
  const set = (patch: Partial<Form>) => {
    setDraft({ ...form, ...patch });
    // A changed form makes the last test say nothing about it.
    setTest(null);
    runTest.reset();
    save.reset();
  };
  const bucketLength = form.bucket.trim().length;
  const bucketError =
    bucketLength > 0 && bucketLength < LIMIT.bucketMin
      ? t("storage.bucketInvalid", { min: LIMIT.bucketMin, max: LIMIT.bucketMax })
      : undefined;
  const endpointError =
    draft !== null && form.endpoint.trim() === "" ? t("storage.endpointRequired") : undefined;
  const keys = keysState(current.s3 !== null, form);
  const ready = form.endpoint.trim() !== "" && bucketLength >= LIMIT.bucketMin && !keys.missing;
  const input = (): S3Input => ({
    endpoint: form.endpoint.trim(),
    region: form.region.trim(),
    bucket: form.bucket.trim(),
    prefix: form.prefix.trim() === "" ? null : form.prefix.trim(),
    pathAddressing: form.pathAddressing,
    ...(form.accessKeyId.trim() !== "" && { accessKeyId: form.accessKeyId.trim() }),
    ...(form.secretAccessKey.trim() !== "" && { secretAccessKey: form.secretAccessKey.trim() }),
  });
  // A save the bucket refused carries the steps of the server's own test.
  const refusedSteps =
    isApiError(save.error) && save.error.rawCode === "storage.bucket_check_failed"
      ? StepFailures.safeParse(save.error.params).data?.steps
      : undefined;
  const shownTest: StorageTestResult | null =
    test ?? (refusedSteps === undefined ? null : { ok: false, steps: refusedSteps.map(stepOf) });
  const unchanged = chosen === current.kind && (chosen === "builtin" || draft === null);

  return (
    <>
      <Surface variant="card" className="section-card">
        <p className="page__muted">{t("storage.lead")}</p>
        <Field label={t("storage.where")}>
          <RadioGroup
            value={chosen}
            onValueChange={(value) => {
              setKind(value === "s3" ? "s3" : "builtin");
              save.reset();
            }}
          >
            <Radio value="builtin" label={t("storage.kind.builtin")} hint={t("storage.kind.builtinHint")} />
            <Radio value="s3" label={t("storage.kind.s3")} hint={t("storage.kind.s3Hint")} />
          </RadioGroup>
        </Field>
        {chosen === "s3" && (
          <div className="storage-grid">
            <Field label={t("storage.endpoint")} error={endpointError} required>
              <Input
                value={form.endpoint}
                maxLength={LIMIT.endpoint}
                placeholder="https://s3.us-east-1.amazonaws.com"
                autoComplete="off"
                spellCheck={false}
                onChange={(event) => set({ endpoint: event.target.value })}
              />
            </Field>
            <Field label={t("storage.region")}>
              <Input
                value={form.region}
                maxLength={LIMIT.region}
                autoComplete="off"
                onChange={(event) => set({ region: event.target.value })}
              />
            </Field>
            <Field label={t("storage.bucket")} error={bucketError} required>
              <Input
                value={form.bucket}
                maxLength={LIMIT.bucketMax}
                autoComplete="off"
                spellCheck={false}
                onChange={(event) => set({ bucket: event.target.value })}
              />
            </Field>
            <Field label={t("storage.prefix")} hint={t("storage.prefixHint")}>
              <Input
                value={form.prefix}
                maxLength={LIMIT.prefix}
                autoComplete="off"
                spellCheck={false}
                onChange={(event) => set({ prefix: event.target.value })}
              />
            </Field>
            <Field label={t("storage.accessKeyId")}>
              <Input
                mono
                value={form.accessKeyId}
                maxLength={LIMIT.key}
                autoComplete="off"
                spellCheck={false}
                placeholder={current.s3?.accessKeyIdPreview}
                onChange={(event) => set({ accessKeyId: event.target.value })}
              />
            </Field>
            <Field label={t("storage.secretAccessKey")}>
              <Input
                mono
                type="password"
                value={form.secretAccessKey}
                maxLength={LIMIT.key}
                autoComplete="off"
                placeholder={current.s3?.secretPreview}
                onChange={(event) => set({ secretAccessKey: event.target.value })}
              />
            </Field>
            <p className="page__muted storage-grid__wide">
              {current.s3 === null
                ? t("storage.keysNeeded")
                : keys.half
                  ? t("storage.keysBoth")
                  : t("storage.keysSaved", {
                      key: current.s3.accessKeyIdPreview,
                      secret: current.s3.secretPreview,
                    })}
            </p>
            <div className="storage-grid__wide">
              <Checkbox
                label={t("storage.pathAddressing")}
                hint={t("storage.pathAddressingHint")}
                checked={form.pathAddressing}
                onCheckedChange={(checked) => set({ pathAddressing: checked === true })}
              />
            </div>
          </div>
        )}
        {shownTest !== null && <TestReport result={shownTest} />}
        {save.isError && refusedSteps === undefined && (
          <Callout tone="danger" role="alert" title={t("storage.saveFailed")}>
            {describe(save.error)}
          </Callout>
        )}
        {runTest.isError && (
          <Callout tone="danger" role="alert" title={t("storage.testError")}>
            {describe(runTest.error)}
          </Callout>
        )}
        <div className="section-form__actions">
          {chosen === "s3" && (
            <Button
              loading={runTest.isPending}
              disabled={!ready}
              onClick={() =>
                runTest.mutate({ workspaceId, body: input() }, { onSuccess: (result) => setTest(result) })
              }
            >
              {t("storage.test")}
            </Button>
          )}
          <Button
            variant="primary"
            loading={save.isPending}
            disabled={chosen === "s3" ? !ready : unchanged}
            onClick={() =>
              save.mutate(
                { workspaceId, body: chosen === "s3" ? { kind: "s3", s3: input() } : { kind: "builtin" } },
                {
                  onSuccess: () => {
                    setDraft(null);
                    setKind(null);
                    setTest(null);
                    outcome.done(t(chosen === "s3" ? "storage.savedBucket" : "storage.savedBuiltin"));
                  },
                },
              )
            }
          >
            {t("action.save")}
          </Button>
        </div>
      </Surface>
      {current.kind === "s3" && (
        <Surface variant="card" className="section-card" aria-labelledby="storage-copy">
          <h3 className="page__heading" id="storage-copy">
            {t("storage.copyTitle")}
          </h3>
          <p className="page__muted">{t("storage.copyLead")}</p>
          <MigrationStatus transfer={current.transfer} />
          {migrate.isError && (
            <Callout tone="danger" role="alert" title={t("storage.copyError")}>
              {describe(migrate.error)}
            </Callout>
          )}
          <div>
            <Button
              icon={<Upload aria-hidden="true" />}
              loading={migrate.isPending}
              disabled={current.transfer?.status === "running"}
              onClick={() =>
                migrate.mutate({ workspaceId }, { onSuccess: () => outcome.done(t("storage.copyStarted")) })
              }
            >
              {t(current.transfer?.status === "failed" ? "storage.copyAgain" : "storage.copy")}
            </Button>
          </div>
        </Surface>
      )}
    </>
  );
}

const STEPS = ["write", "read", "list", "delete"] as const;
const stepOf = (raw: { step: string; ok: boolean; error?: string | undefined }) => ({
  step: STEPS.find((step) => step === raw.step) ?? "write",
  ok: raw.ok,
  ...(raw.error !== undefined && { error: raw.error }),
});

function TestReport({ result }: { result: StorageTestResult }) {
  const t = useMessages("settings");
  return (
    <Callout
      tone={result.ok ? "success" : "danger"}
      role="status"
      title={t(result.ok ? "storage.testPassed" : "storage.testFailed")}
    >
      <ul className="storage-steps" aria-label={t("storage.steps")}>
        {result.steps.map((step) => (
          <li key={step.step}>
            <StatusBadge
              status={step.ok ? "done" : "failed"}
              label={t(step.ok ? "storage.stepPassed" : "storage.stepFailed", {
                step: t(`storage.step.${step.step}`),
              })}
            />
            {/* The provider's own words, in its own language: shown as a detail. */}
            {step.error !== undefined && <code className="storage-steps__detail">{step.error}</code>}
          </li>
        ))}
      </ul>
    </Callout>
  );
}

function MigrationStatus({ transfer }: { transfer: StorageConfig["transfer"] }) {
  const t = useMessages("settings");
  if (transfer === null) return null;
  const counts = { copied: transfer.copied, total: transfer.total };
  return (
    <div role="status" className="storage-copy">
      <p>{t(`storage.copy.${transfer.status}`, counts)}</p>
      {transfer.status === "running" && (
        <progress
          max={Math.max(transfer.total, 1)}
          value={transfer.copied}
          aria-label={t("storage.copyProgress")}
        />
      )}
      {transfer.status === "failed" && transfer.error !== null && (
        <p className="page__muted">
          {t("storage.copyDetail")} <code>{transfer.error}</code>
        </p>
      )}
    </div>
  );
}
