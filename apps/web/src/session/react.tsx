// The session for components: who is signed in, signing out, and drafts.

import { useQuery } from "@tanstack/react-query";
import { useVanrClient } from "@vanr/client/react";
import type { Me } from "@vanr/contract";
import { useCallback, useState } from "react";
import { useAuth } from "../api/index.ts";
import { useRuntime } from "../app/context.tsx";
import { href } from "../routes.ts";

/** The signed-in person: undefined while unknown, null when nobody is signed in. */
export function useSession(): {
  me: Me | null | undefined;
  isLoading: boolean;
  failed: boolean;
  error: unknown;
  retry: () => void;
} {
  const { session } = useRuntime();
  // The options follow the session generation; reading the client re-renders this when it changes.
  useVanrClient();
  const query = useQuery(session.options);
  return {
    me: query.data,
    isLoading: query.isPending,
    failed: query.isError,
    error: query.error,
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
  const auth = useAuth();
  const { session, gate, router } = useRuntime();
  return useCallback(
    async (search?: Record<string, string>) => {
      await auth.signOut();
      gate.leftOnPurpose();
      session.forget();
      // Straight through the router, not through the screen: wherever the person went meanwhile,
      // they are signed out, and no screen behind a session may stay open.
      await router.navigate({ to: href("login", {}), search: search ?? { reason: "signed_out" } });
    },
    [auth, session, gate, router],
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
