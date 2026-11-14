// The session for components: who is signed in, signing out, and drafts.

import { useQuery } from "@tanstack/react-query";
import type { Me } from "@vanr/contract";
import { useCallback, useState } from "react";
import { useApi } from "../api/index.ts";
import { useRuntime } from "../app/context.tsx";
import { useGo } from "../app/navigation.tsx";

/** The signed-in person: undefined while unknown, null when nobody is signed in. */
export function useSession(): {
  me: Me | null | undefined;
  isLoading: boolean;
  failed: boolean;
  retry: () => void;
} {
  const { session } = useRuntime();
  const query = useQuery(session.options);
  return {
    me: query.data,
    isLoading: query.isPending,
    failed: query.isError,
    retry: () => void query.refetch(),
  };
}

/**
 * Finishes a sign-in: asks the server who is signed in now and drops what was cached for whoever
 * was here before. Returns the person, or null when the server still sees nobody.
 */
export function useCompleteSignIn(): () => Promise<Me | null> {
  const { session } = useRuntime();
  return useCallback(async () => {
    session.dropCachedData();
    return session.load(true);
  }, [session]);
}

/**
 * Signs out and opens the sign-in screen. Drafts are dropped: leaving was a choice. `search` is
 * what the sign-in screen receives; without it, the "you signed out" notice.
 */
export function useSignOut(): (search?: Record<string, string>) => Promise<void> {
  const api = useApi();
  const { session, gate } = useRuntime();
  const go = useGo();
  return useCallback(
    async (search?: Record<string, string>) => {
      try {
        await api.signOut();
      } catch {
        // Without an answer the cookie may live on; the screens still forget the person.
      }
      gate.leftOnPurpose();
      session.forget();
      await go("login", {}, { search: search ?? { reason: "signed_out" } });
    },
    [api, session, gate, go],
  );
}

/**
 * Text that survives being sent to sign in. Returns the text, a setter and a function that drops
 * the draft (call it once the form was sent). Never use it for a password or a secret.
 */
export function useDraft(id: string): [text: string, setText: (text: string) => void, discard: () => void] {
  const { drafts } = useRuntime();
  const [text, setCurrent] = useState(() => drafts.read(id) ?? "");
  const setText = useCallback(
    (next: string) => {
      drafts.write(id, next);
      setCurrent(next);
    },
    [drafts, id],
  );
  const discard = useCallback(() => drafts.remove(id), [drafts, id]);
  return [text, setText, discard];
}
