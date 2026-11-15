// Text someone was typing, kept across the end of a session. A form that should survive being
// sent to sign in keeps its text here; the drafts belong to one person and are dropped as soon as
// someone else signs in. Never put a password or a secret in a draft.
import { z } from "zod";
import { type KeyValueStore, readStored, STORAGE_KEYS, writeStored } from "../platform/storage.ts";

const StoredDrafts = z.object({
  owner: z.string().nullable(),
  values: z.record(z.string(), z.string()),
});
type StoredDrafts = z.infer<typeof StoredDrafts>;

export type DraftStore = {
  read: (id: string) => string | undefined;
  /** An empty text removes the draft. */
  write: (id: string, text: string) => void;
  remove: (id: string) => void;
  /** Drops every draft and forgets the owner: an explicit sign-out. */
  clear: () => void;
  /** Someone signed in. Drafts written by anyone else are dropped. */
  claim: (userId: string) => void;
};

export function createDraftStore(store: KeyValueStore): DraftStore {
  const load = (): StoredDrafts =>
    readStored(store, STORAGE_KEYS.drafts, StoredDrafts) ?? { owner: null, values: {} };
  const save = (drafts: StoredDrafts) => writeStored(store, STORAGE_KEYS.drafts, drafts);
  return {
    read: (id) => load().values[id],
    write(id, text) {
      const drafts = load();
      const { [id]: _previous, ...others } = drafts.values;
      save({ owner: drafts.owner, values: text === "" ? others : { ...others, [id]: text } });
    },
    remove(id) {
      const drafts = load();
      const { [id]: _removed, ...others } = drafts.values;
      save({ owner: drafts.owner, values: others });
    },
    clear: () => save({ owner: null, values: {} }),
    claim(userId) {
      const drafts = load();
      if (drafts.owner === userId) return;
      save({ owner: userId, values: {} });
    },
  };
}
