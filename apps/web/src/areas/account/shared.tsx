// What the account screens share: the open column, the language and theme controls, the form
// pieces and the rules of each field.
import { isApiError } from "@vanr/client";
import { Button, Callout, ErrorState } from "@vanr/ui";
import { type FormEvent, type ReactNode, useEffect, useRef, useState } from "react";
import { StandalonePage } from "../../app/Standalone.tsx";
import { useErrorMessage } from "../../app/screens.tsx";
import { useMessages } from "../../i18n/react.tsx";
import { useClock, useSecondsUntil } from "../../platform/clock.tsx";

/** The password rule of the sign-in service. */
export const PASSWORD_MIN = 8;
export const PASSWORD_MAX = 128;

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** What is wrong with an email, as a message key; undefined when it will do. */
export function emailProblem(
  value: string,
): "validation.emailRequired" | "validation.emailInvalid" | undefined {
  const text = value.trim();
  if (text === "") return "validation.emailRequired";
  return EMAIL.test(text) ? undefined : "validation.emailInvalid";
}

/** What is wrong with a new password, as a message key; undefined when it will do. */
export function newPasswordProblem(
  value: string,
): "validation.passwordRequired" | "validation.passwordShort" | "validation.passwordLong" | undefined {
  if (value === "") return "validation.passwordRequired";
  if (value.length < PASSWORD_MIN) return "validation.passwordShort";
  return value.length > PASSWORD_MAX ? "validation.passwordLong" : undefined;
}

/** The page of an account screen: the standalone column every screen outside the frame uses. */
export const AccountPage = StandalonePage;

/** A form whose fields are validated by the screen, not by the browser's bubbles. */
export function AccountForm({ onSubmit, children }: { onSubmit: () => void; children: ReactNode }) {
  return (
    <form
      className="acct__form"
      noValidate
      onSubmit={(event: FormEvent) => {
        event.preventDefault();
        onSubmit();
      }}
    >
      {children}
    </form>
  );
}

/** A busy server's wait is never shorter than this, also when it names none or names nonsense. */
export const SERVER_WAIT_MIN_S = 2;
/** Nor longer than this, whatever the server asks for. */
export const SERVER_WAIT_MAX_S = 60;

/**
 * The seconds to wait before sending again after `error`: only a busy server (503) asks for a
 * wait. What it asked for (see `parseRetryAfter`) is kept between the two limits above; a call
 * that carries no such header waits the shortest.
 */
export function serverWaitSeconds(error: unknown): number | undefined {
  if (!isApiError(error) || error.status !== 503) return undefined;
  const asked = error.params?.retryAfterSeconds;
  const seconds = typeof asked === "number" && Number.isFinite(asked) ? asked : SERVER_WAIT_MIN_S;
  return Math.min(SERVER_WAIT_MAX_S, Math.max(SERVER_WAIT_MIN_S, Math.ceil(seconds)));
}

/**
 * What the server said about a failed submit. A busy server (503) shows the wait counting down
 * and offers the retry when it is over; anything else shows the error's text.
 */
export function ServerProblem({
  error,
  waitUntil,
  onRetry,
}: {
  /** What the submit rejected with, or null when it did not fail. */
  error: unknown;
  /** The clock time the server's wait ends at; undefined when it asked for none. */
  waitUntil: number | undefined;
  onRetry: () => void;
}) {
  const t = useMessages("account");
  const common = useMessages("common");
  const describe = useErrorMessage();
  const seconds = useSecondsUntil(waitUntil);
  if (error === null) return null;
  if (waitUntil !== undefined) {
    return (
      <Callout
        tone="warning"
        role="alert"
        title={t("busy.title")}
        actions={
          <Button size="sm" disabled={seconds > 0} onClick={onRetry}>
            {common("action.retry")}
          </Button>
        }
      >
        {describe(error)} {seconds > 0 ? t("busy.wait", { count: seconds }) : t("busy.ready")}
      </Callout>
    );
  }
  return (
    <Callout tone="danger" role="alert">
      {describe(error)}
    </Callout>
  );
}

/**
 * Runs a form's submit. One at a time; nothing is sent while a busy server's wait runs, whichever
 * way the submit was asked for (the form's button, Enter or the retry); and leaving the screen
 * cancels the call, so an answer that arrives later changes nothing. The action receives the
 * signal to pass to its calls.
 */
export function useSubmit(action: (call: { signal: AbortSignal }) => Promise<void>) {
  const clock = useClock();
  const [state, setState] = useState<{ busy: boolean; error: unknown; waitUntil: number | undefined }>({
    busy: false,
    error: null,
    waitUntil: undefined,
  });
  const running = useRef<AbortController | null>(null);
  const waitUntil = useRef<number | undefined>(undefined);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      running.current?.abort();
    };
  }, []);
  const run = async () => {
    if (running.current !== null) return;
    if (waitUntil.current !== undefined && clock.now() < waitUntil.current) return;
    const attempt = new AbortController();
    running.current = attempt;
    waitUntil.current = undefined;
    setState({ busy: true, error: null, waitUntil: undefined });
    try {
      await action({ signal: attempt.signal });
      if (mounted.current) setState({ busy: false, error: null, waitUntil: undefined });
    } catch (cause) {
      // The screen is gone: there is nobody to tell.
      if (!mounted.current) return;
      const wait = serverWaitSeconds(cause);
      waitUntil.current = wait === undefined ? undefined : clock.now() + wait * 1000;
      setState({ busy: false, error: cause ?? new Error("failed"), waitUntil: waitUntil.current });
    } finally {
      if (running.current === attempt) running.current = null;
    }
  };
  return { ...state, run };
}

/** Something an account screen needed did not load: what failed and a retry. */
export function LoadFailed({
  title,
  error,
  onRetry,
}: {
  title?: string;
  error: unknown;
  onRetry: () => void;
}) {
  const common = useMessages("common");
  const describe = useErrorMessage();
  return (
    <ErrorState
      title={title ?? common("screen.failed")}
      description={describe(error)}
      action={<Button onClick={onRetry}>{common("action.retry")}</Button>}
    />
  );
}

/**
 * Runs a call that confirms a link (an email, a place on the waitlist) once per `key` while
 * `enabled`, and reports how it went. Once, even when the screen mounts twice: confirming is a
 * write, and a link is spent by its first use.
 */
export function useOnce(
  key: string,
  enabled: boolean,
  run: () => Promise<unknown>,
): "idle" | "working" | "done" | "failed" {
  const [outcome, setOutcome] = useState<{ key: string; status: "done" | "failed" } | null>(null);
  const started = useRef<string | null>(null);
  const latest = useRef(run);
  latest.current = run;
  useEffect(() => {
    if (!enabled || started.current === key) return;
    started.current = key;
    latest.current().then(
      () => setOutcome({ key, status: "done" }),
      () => setOutcome({ key, status: "failed" }),
    );
  }, [key, enabled]);
  if (!enabled) return "idle";
  return outcome?.key === key ? outcome.status : "working";
}
