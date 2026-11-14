// Search, the command palette and ask mode.

export type SearchKind = "db_row" | "debate" | "event" | "file" | "issue" | "message" | "wiki";

export interface SearchHit {
  /** Who wrote it: `user:<id>` or `agent:<id>`. */
  authorId?: string | null;
  channelIds: string[];
  createdAt: string;
  kind: SearchKind;
  /** Page of the file the snippet came from (PDF, slide, sheet). */
  page?: number | null;
  /** Fusion score (RRF): only orders results, not comparable across searches. */
  score?: number;
  snippet: string;
  sourceId: string;
  threadId: string | null;
  title: string | null;
  /** Path in the app that opens the source. */
  url?: string;
}

/** Cmd+K: what the palette finds on the server, in groups. */
export interface PaletteResult {
  agents: { id: string; handle: string; name: string }[];
  channels: { id: string; kind: "channel" | "dm"; name: string; visibility: "private" | "public" }[];
  hits: SearchHit[];
  people: { handle: string; name: string; userId: string }[];
}

/** A numbered source of an "ask" mode answer. */
export interface AskSource extends SearchHit {
  n: number;
}

export interface AskAnswer {
  /** Pieces of the answer; each with the numbers of the sources that support it. */
  blocks: { sources: number[]; text: string }[];
  sources: AskSource[];
  /** Answered by the test model (no key). */
  testModel: boolean;
}
