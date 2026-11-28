// What the connection sections of the settings share (connectors, data sources, access, usage): a
// titled block, its loading and failed states, the latch that keeps an action from starting twice, the
// rule for answers that say the thing is gone or no longer the person's to see, and the options every
// call that carries a secret uses. The server decides every change; the role here only hides controls.

import { useQueryClient } from "@tanstack/react-query";
import type { MethodName } from "@vanr/client";
import { isApiError } from "@vanr/client";
import { prefixKey, useVanrClient } from "@vanr/client/react";
import { Button, ErrorState, Skeleton } from "@vanr/ui";
import { type FocusEvent, type ReactNode, useCallback, useEffect, useRef, useState } from "react";
import { useErrorMessage } from "../../../app/screens.tsx";
import { useMessages } from "../../../i18n/react.tsx";
import { href, type SettingsSection } from "../../../routes.ts";

/**
 * Options for a mutation whose arguments hold a key, a password or a connection string: the cache
 * forgets the call (and so what was typed) as soon as nothing on screen watches it.
 */
export const SECRET = { gcTime: 0 } as const;

// The server's limits for a key and an address (routes/connectors.ts, keyInput and customInput).
export const KEY_MIN = 8;
export const KEY_MAX = 2000;
export const ADDRESS_MAX = 500;

/** A port as typed: a whole number from 1 to 65535, or null. */
export function portOf(text: string): number | null {
  const typed = text.trim();
  if (!/^\d{1,5}$/.test(typed)) return null;
  const port = Number(typed);
  return port >= 1 && port <= 65_535 ? port : null;
}

/** Where a sign-in on another site sends the person back: a section of this workspace's settings. */
export const comeBackTo = (workspaceId: string, section: SettingsSection) =>
  href("settings", { workspaceId, section });

/** Leaves the app for a sign-in or an install on another site. */
export function leaveFor(url: string): void {
  window.location.assign(url);
}

/** One part of a section, under its own heading. */
export function Block({
  title,
  lead,
  action,
  children,
}: {
  title: string;
  lead?: ReactNode;
  action?: ReactNode;
  children: ReactNode;
}) {
  return (
    <section className="wire-block" aria-label={title}>
      <header className="wire-block__head">
        <div className="wire-block__title">
          <h3 className="page__heading" tabIndex={-1}>
            {title}
          </h3>
          {lead !== undefined && <p className="page__muted">{lead}</p>}
        </div>
        {action}
      </header>
      {children}
    </section>
  );
}

export function PartLoading() {
  const common = useMessages("common");
  return (
    <div className="page__loading" aria-busy="true">
      <span className="vr-visually-hidden" role="status">
        {common("state.loading")}
      </span>
      <Skeleton shape="block" />
      <Skeleton />
    </div>
  );
}

export function PartError({ title, error, onRetry }: { title: string; error: unknown; onRetry: () => void }) {
  const common = useMessages("common");
  const describe = useErrorMessage("control");
  return (
    <ErrorState
      title={title}
      description={describe(error)}
      action={<Button onClick={onRetry}>{common("action.retry")}</Button>}
    />
  );
}

/**
 * A latch for an action that must start once: a second press before the screen redraws (when the
 * pending flag would disable the button) is dropped. The work runs to its end, then the latch opens.
 */
export function useLatch(): (work: () => Promise<unknown>) => void {
  const held = useRef(false);
  return useCallback((work) => {
    if (held.current) return;
    held.current = true;
    void work()
      .catch(() => {})
      .finally(() => {
        held.current = false;
      });
  }, []);
}

/**
 * One change at a time, from the fresh read it starts with to its write. `busy` holds the whole way
 * (the controls disable on it), a second start meanwhile is dropped, and at the end the control the
 * person used gets the focus back: a browser drops the focus to the page from a control it disables.
 * `onFocusCapture` goes on the element that holds the controls. The work handles its own failures.
 */
export function useOneChange() {
  const latch = useLatch();
  const [busy, setBusy] = useState(false);
  // The last control focused inside the controls (not a menu they opened elsewhere on the page).
  const lastFocused = useRef<HTMLElement | null>(null);
  const giveBack = useRef<HTMLElement | null>(null);
  useEffect(() => {
    if (busy) return;
    const control = giveBack.current;
    giveBack.current = null;
    // Only when the focus fell to the page: a person who moved on keeps the focus where they put it.
    const fell = document.activeElement === null || document.activeElement === document.body;
    if (fell && control?.isConnected === true && !control.hasAttribute("disabled")) control.focus();
  }, [busy]);
  const run = useCallback(
    (work: () => Promise<unknown>) =>
      latch(() => {
        giveBack.current = lastFocused.current;
        setBusy(true);
        return work().finally(() => setBusy(false));
      }),
    [latch],
  );
  const onFocusCapture = useCallback((event: FocusEvent<HTMLElement>) => {
    if (event.target instanceof HTMLElement && event.currentTarget.contains(event.target))
      lastFocused.current = event.target;
  }, []);
  return { busy, run, onFocusCapture };
}

/** The thing is gone (404), or the person may no longer see it (403). */
export const isLost = (error: unknown) => isApiError(error) && (error.status === 404 || error.status === 403);

/**
 * When an answer says the thing is gone or not the person's any more, what the screen kept of these
 * reads is dropped: the ones on screen load again from the server, the others are removed.
 */
export function useForgetOnLoss(workspaceId: string, methods: readonly MethodName[]) {
  const client = useVanrClient();
  const queryClient = useQueryClient();
  return useCallback(
    (error: unknown) => {
      if (!isLost(error)) return;
      for (const method of methods) {
        const queryKey = prefixKey(client, { method, args: { workspaceId } });
        queryClient.removeQueries({ queryKey, type: "inactive" });
        void queryClient.resetQueries({ queryKey, type: "active" });
      }
    },
    [client, queryClient, workspaceId, methods],
  );
}

/**
 * A read that answers 404 or 403: whatever else the screen kept of these reads, and is not showing now,
 * is removed. The read itself shows its error and no stale data; nothing is fetched again by itself, so
 * a refusal can't turn into a loop.
 */
export function useForgetReadOnLoss(workspaceId: string, methods: readonly MethodName[], error: unknown) {
  const client = useVanrClient();
  const queryClient = useQueryClient();
  const lost = isLost(error);
  useEffect(() => {
    if (!lost) return;
    for (const method of methods) {
      queryClient.removeQueries({
        queryKey: prefixKey(client, { method, args: { workspaceId } }),
        type: "inactive",
      });
    }
  }, [lost, client, queryClient, workspaceId, methods]);
}

/**
 * The control that opened a dialog gets the focus back when the dialog closes. When it is gone by then
 * (its row was removed) or can't take it (it is disabled), the heading of its block does, so the
 * focus never falls back to the page itself.
 */
export function useReturnFocus(
  /** The block's title, whose heading takes the focus when nothing opened the dialog (it opened by itself). */
  block?: string,
) {
  const opener = useRef<HTMLElement | null>(null);
  const heading = useRef<HTMLElement | null>(null);
  const remember = useCallback(() => {
    const active = document.activeElement;
    opener.current = active instanceof HTMLElement && active !== document.body ? active : null;
    heading.current = opener.current?.closest(".wire-block")?.querySelector<HTMLElement>("h3") ?? null;
  }, []);
  const back = useCallback(() => {
    const target = opener.current;
    if (target?.isConnected === true && !target.hasAttribute("disabled")) target.focus();
    else if (heading.current?.isConnected === true) heading.current.focus();
    else if (block !== undefined)
      document
        .querySelector<HTMLElement>(`section.wire-block[aria-label="${CSS.escape(block)}"] h3`)
        ?.focus();
  }, [block]);
  /** For a dialog's `onCloseAutoFocus`. */
  const onCloseAutoFocus = useCallback(
    (event: Event) => {
      event.preventDefault();
      back();
    },
    [back],
  );
  return { remember, back, onCloseAutoFocus };
}
