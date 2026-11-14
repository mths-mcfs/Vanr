// Parts of one chunked upload arriving at the same time. Each request's body is a stream the test drives:
// the server asks for the next piece only after it handled the last one (the stream's `pull`), so every
// interleaving is reached without timers. The property: whatever the order (the same offset twice,
// different offsets, a part that pauses in the middle, a part that drops), the stored file is exactly the
// concatenation of the parts the server accepted, and its recorded hash is that file's.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { schema } from "@vanr/engine/db";
import { eq } from "drizzle-orm";
import { createApp } from "../src/app";
import type { RunningServer } from "../src/server";
import { FirstUserPlace } from "../src/signup-queue";
import { body, signedIn, startTestServer } from "./harness";
import { type Person, seedWorkspace } from "./seed";

let server: RunningServer;
let app: ReturnType<typeof createApp>;
let ana: Person;
let base: string;
beforeAll(async () => {
  server = await startTestServer();
  // The same routes and dependencies as the running server, called in this process: the request body
  // reaches the handler as the very stream the test controls. This app only serves the upload routes; the
  // sign-up above went through the running server, so its first-user place here is never used.
  app = createApp(server.deps, { firstUser: new FirstUserPlace() });
  ana = await signedIn(server, "Ana", "ana@drive-upload-race.test");
  const { workspaceId } = await seedWorkspace(server, ana, "Race");
  base = `${server.url}/api/v1/workspaces/${workspaceId}/files/uploads`;
});
afterAll(() => server.stop());

const cookie = () => [...ana.browser.cookies].map(([k, v]) => `${k}=${v}`).join("; ");
const call = async (path: string, init: RequestInit & { duplex?: "half" }): Promise<Response> => {
  const headers = new Headers(init.headers);
  headers.set("origin", server.url);
  headers.set("cookie", cookie());
  return app.fetch(new Request(`${base}${path}`, { ...init, headers }));
};
const json = (path: string, method: string, data: unknown = {}) =>
  call(path, { method, headers: { "content-type": "application/json" }, body: JSON.stringify(data) });

/** A part whose body the test releases piece by piece. */
class DrivenPart {
  private controller!: ReadableStreamDefaultController<Uint8Array>;
  private wanted: (() => void) | null = null;
  private resume: (() => void) | null = null;
  response: Promise<Response> | null = null;
  status: number | null = null;
  readonly stream: ReadableStream<Uint8Array>;

  constructor(
    readonly offset: number,
    readonly pieces: Uint8Array[],
    readonly dropAfter: number | null,
  ) {
    this.stream = new ReadableStream<Uint8Array>(
      {
        start: (c) => {
          this.controller = c;
        },
        pull: () =>
          new Promise<void>((resolve) => {
            this.resume = resolve;
            this.wanted?.();
          }),
      },
      { highWaterMark: 0 },
    );
  }

  get bytes(): Uint8Array {
    return concat(this.pieces);
  }

  /** Waits until the server asks for more of this body or answers. */
  private settle(): Promise<void> {
    const asked = new Promise<void>((resolve) => {
      this.wanted = resolve;
      if (this.resume) resolve();
    });
    const answered = (this.response as Promise<Response>).then((res) => {
      this.status = res.status;
    });
    return Promise.race([asked, answered]);
  }

  start(sessionId: string): Promise<void> {
    this.response = call(`/${sessionId}?offset=${this.offset}`, {
      method: "PUT",
      headers: { "content-type": "application/octet-stream" },
      body: this.stream,
      duplex: "half",
    });
    return this.settle();
  }

  sent = 0;
  get finished() {
    return this.status !== null;
  }

  /** The next step of this request: a piece, the end of the body or the drop. */
  async step(): Promise<void> {
    const resume = this.resume;
    this.resume = null;
    if (this.dropAfter !== null && this.sent >= this.dropAfter)
      this.controller.error(new Error("connection dropped"));
    else if (this.sent >= this.pieces.length) this.controller.close();
    else this.controller.enqueue(this.pieces[this.sent++] as Uint8Array);
    resume?.();
    await this.settle();
  }
}

const concat = (parts: Uint8Array[]) => {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
};
const sha = (b: Uint8Array) => new Bun.CryptoHasher("sha256").update(b).digest("hex");

/** A small deterministic generator (mulberry32), so a failing case can be replayed by its seed. */
function rng(seed: number) {
  let a = seed;
  return (n: number) => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return Math.floor((((t ^ (t >>> 14)) >>> 0) / 4294967296) * n);
  };
}

async function runCase(seed: number) {
  const pick = rng(seed);
  const size = 2 + pick(6);
  const session = await body(await json("", "POST", { fileName: `race-${seed}.bin`, size }));
  const count = 2 + pick(3);
  const parts: DrivenPart[] = [];
  for (let i = 0; i < count; i++) {
    // Mostly offset 0 (the race on the first part), sometimes another offset inside the file.
    const offset = pick(3) === 0 ? pick(size) : 0;
    const length = 1 + pick(size - offset);
    const data = new Uint8Array(length).map(() => 65 + i * 3 + pick(3));
    const pieces: Uint8Array[] = [];
    for (let at = 0; at < length; ) {
      const step = 1 + pick(length - at);
      pieces.push(data.subarray(at, at + step));
      at += step;
    }
    const dropAfter = pick(4) === 0 ? pick(pieces.length + 1) : null;
    parts.push(new DrivenPart(offset, pieces, dropAfter));
  }
  const started = new Set<DrivenPart>();
  for (;;) {
    const live = parts.filter((p) => !p.finished);
    if (!live.length) break;
    const p = live[pick(live.length)] as DrivenPart;
    if (!started.has(p)) {
      started.add(p);
      await p.start(session.id);
    } else await p.step();
  }
  const accepted = parts.filter((p) => p.status === 200).sort((a, b) => a.offset - b.offset);
  // The accepted parts are contiguous from 0: each one started where the one before ended.
  let end = 0;
  for (const p of accepted) {
    expect([seed, p.offset]).toEqual([seed, end]);
    end += p.bytes.length;
  }
  const status = await body(await call(`/${session.id}`, { method: "GET" }));
  expect([seed, status.offset]).toEqual([seed, end]);
  // The rest of the file in one last part, then complete.
  const rest = new Uint8Array(size - end).fill(122);
  if (rest.length) {
    const res = await call(`/${session.id}?offset=${end}`, {
      method: "PUT",
      headers: { "content-type": "application/octet-stream" },
      body: rest,
    });
    expect([seed, res.status]).toEqual([seed, 200]);
  }
  const done = await json(`/${session.id}/complete`, "POST");
  expect([seed, done.status]).toEqual([seed, 200]);
  const file = await body(done);
  const expected = concat([...accepted.map((p) => p.bytes), rest]);
  const stored = new Uint8Array(
    await (await ana.browser.fetch(`${base.replace(/\/uploads$/, "")}/${file.id}/blob`)).arrayBuffer(),
  );
  expect([seed, new TextDecoder().decode(stored)]).toEqual([seed, new TextDecoder().decode(expected)]);
  const [version] = await server.deps.db
    .select({ sha256: schema.fileVersions.sha256 })
    .from(schema.fileVersions)
    .where(eq(schema.fileVersions.fileId, file.id));
  expect([seed, version?.sha256]).toEqual([seed, sha(expected)]);
  return { accepted: accepted.length, rejected: parts.length - accepted.length };
}

describe("concurrent parts of one upload", () => {
  test("any interleaving: the stored file is exactly the accepted parts, and its hash matches", async () => {
    const CASES = 150;
    let accepted = 0;
    let rejected = 0;
    for (let seed = 1; seed <= CASES; seed++) {
      const r = await runCase(seed);
      accepted += r.accepted;
      rejected += r.rejected;
    }
    // The cases reach both outcomes many times (not only the easy, sequential one).
    expect(rejected).toBeGreaterThan(CASES / 2);
    expect(accepted).toBeGreaterThan(CASES / 2);
    console.log(`interleavings: ${CASES} cases, ${accepted} parts accepted, ${rejected} rejected or dropped`);
  }, 120_000);

  test("the reviewer's case: A sends `a` and pauses, B sends `bb` and wins, A ends with `c` and loses", async () => {
    const session = await body(await json("", "POST", { fileName: "ab.txt", size: 2 }));
    const a = new DrivenPart(0, [new TextEncoder().encode("a"), new TextEncoder().encode("c")], null);
    await a.start(session.id);
    await a.step();
    const b = new DrivenPart(0, [new TextEncoder().encode("bb")], null);
    await b.start(session.id);
    await b.step();
    await b.step();
    expect(b.status).toBe(200);
    await a.step();
    await a.step();
    expect(a.status).toBe(409);
    const file = await body(await json(`/${session.id}/complete`, "POST"));
    const blob = await ana.browser.fetch(`${base.replace(/\/uploads$/, "")}/${file.id}/blob`);
    expect(await blob.text()).toBe("bb");
  });

  test("complete while a part is still arriving waits for nothing it shouldn't: 409, and the part then lands", async () => {
    const session = await body(await json("", "POST", { fileName: "late.txt", size: 3 }));
    const part = new DrivenPart(0, [new TextEncoder().encode("xy"), new TextEncoder().encode("z")], null);
    await part.start(session.id);
    await part.step();
    const early = await json(`/${session.id}/complete`, "POST");
    expect(early.status).toBe(409);
    expect((await body(early)).error.code).toBe("upload.incomplete");
    await part.step();
    await part.step();
    expect(part.status).toBe(200);
    const done = await body(await json(`/${session.id}/complete`, "POST"));
    const blob = await ana.browser.fetch(`${base.replace(/\/uploads$/, "")}/${done.id}/blob`);
    expect(await blob.text()).toBe("xyz");
  });

  test("two completes at once make one file", async () => {
    const session = await body(await json("", "POST", { fileName: "twice.txt", size: 2 }));
    await call(`/${session.id}?offset=0`, {
      method: "PUT",
      headers: { "content-type": "application/octet-stream" },
      body: "ok",
    });
    const before = await server.deps.db.select({ id: schema.files.id }).from(schema.files);
    const answers = await Promise.all([
      json(`/${session.id}/complete`, "POST"),
      json(`/${session.id}/complete`, "POST"),
    ]);
    const statuses = answers.map((r) => r.status).sort();
    expect(statuses[0]).toBe(200);
    expect([200, 409]).toContain(statuses[1] as number);
    const after = await server.deps.db.select({ id: schema.files.id }).from(schema.files);
    expect(after.length - before.length).toBe(1);
    const again = await body(await json(`/${session.id}/complete`, "POST"));
    expect(after.map((f) => f.id)).toContain(again.id);
  });
});
