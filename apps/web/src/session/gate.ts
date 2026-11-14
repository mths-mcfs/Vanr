// The one place that decides a session is over. The API layer reports a 401 here, real time
// reports its 4401 close here, and nothing else in the web handles either.
import type { DraftStore } from "./drafts.ts";

export type SessionGate = {
  /** A session was confirmed for this person (the server answered who they are). */
  established: (userId: string) => void;
  /** The server said the session is gone. Reported once per session, however many calls fail. */
  ended: () => void;
  /** The person signed out on purpose. */
  leftOnPurpose: () => void;
  /** The person the open session belongs to, or null. */
  userId: () => string | null;
};

export function createSessionGate(deps: {
  drafts: DraftStore;
  /** Sends the person to sign in, keeping where they were. */
  onEnded: () => void;
  /**
   * Ends the session generation: cancels every call in flight and drops everything cached, so
   * nothing asked for by one person is answered to, or shown to, the next.
   */
  renew: () => void;
}): SessionGate {
  let current: string | null = null;
  return {
    established(userId) {
      const replaced = current !== null && current !== userId;
      // Whatever the last person was typing is not this person's to see.
      deps.drafts.claim(userId);
      current = userId;
      // Someone else signed in while this page was open (in another tab, for one).
      if (replaced) deps.renew();
    },
    ended() {
      // No session was open on this page: a visitor's 401 is for the route guard, not for this.
      if (current === null) return;
      current = null;
      deps.renew();
      deps.onEnded();
    },
    leftOnPurpose() {
      current = null;
      deps.drafts.clear();
      deps.renew();
    },
    userId: () => current,
  };
}
