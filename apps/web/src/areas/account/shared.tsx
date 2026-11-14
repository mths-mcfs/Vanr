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

/** The seconds a failed call was told to wait (the sign-in calls carry a Retry-After this way). */
function retryAfterOf(error: unknown): number | undefined {
  const seconds = isApiError(error) ? error.params?.retryAfterSeconds : undefined;
  return typeof seconds === "number" ? seconds : undefined;
}

/**
 * What the server said about a failed submit. A busy server (503 with Retry-After) shows the wait
 * counting down and offers the retry when it is over; anything else shows the error's text.
 */
export function ServerProblem({
  error,
  failureTime,
  onRetry,
}: {
  /** What the submit rejected with, or null when it did not fail. */
  error: unknown;
  /** The clock time of the failure, to count the server's wait from. */
  failureTime: number | undefined;
  onRetry: () => void;
}) {
  const t = useMessages("account");
  const common = useMessages("common");
  const describe = useErrorMessage();
  const wait = retryAfterOf(error);
  const busy = isApiError(error) && error.status === 503 && wait !== undefined;
  const seconds = useSecondsUntil(busy && failureTime !== undefined ? failureTime + wait * 1000 : undefined);
  if (error === null) return null;
  if (busy) {
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
 * Runs a form's submit: one at a time, with the busy state and the failure (and when it happened,
 * for a server that asks for a wait).
 */
export function useSubmit(action: () => Promise<void>) {
  const clock = useClock();
  const [state, setState] = useState<{ busy: boolean; error: unknown; failureTime: number | undefined }>({
    busy: false,
    error: null,
    failureTime: undefined,
  });
  const running = useRef(false);
  const run = async () => {
    if (running.current) return;
    running.current = true;
    setState({ busy: true, error: null, failureTime: undefined });
    try {
      await action();
      setState({ busy: false, error: null, failureTime: undefined });
    } catch (cause) {
      setState({ busy: false, error: cause ?? new Error("failed"), failureTime: clock.now() });
    } finally {
      running.current = false;
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
