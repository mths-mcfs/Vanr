// The agents' secrets in this environment. Nothing stays in plain text in store.json: each value (and
// each private key of an open request) is encrypted with AES-256-GCM
// using the key the server sends in `welcome`. The key only exists in the runner's memory while
// it is connected, and the server never sees the values (only the sealed box, which it does not open).
// A file secret becomes a file only while a command runs, and goes away at the end.
import { existsSync, readdirSync, readFileSync, rmSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { SecretBrowserBinding } from "@vanr/contract";
import {
  createRecipient,
  exportRecipient,
  importRecipient,
  openSecret,
  type SealedBox,
} from "@vanr/contract";
import { secretBrowserBinding } from "@vanr/engine/browser-policy";
import type { AgentRef, StoredSecretInfo } from "@vanr/engine/runner-protocol";
import { z } from "zod";
import { RunnerError } from "./access";
import { reservedSecretName } from "./cli";
import { ensureDir, writePrivate } from "./config";

interface StoredEntry {
  name: string;
  target: string;
  /** Sites and field where the browser may type it. It is part of the authenticated data: changing it on disk breaks the opening. */
  browser?: SecretBrowserBinding;
  iv: string;
  ct: string;
  updatedAt: string;
}

interface StoreFile {
  v: 1;
  entries: StoredEntry[];
}

/** A value sealed with the store key (an entry, or the private key of an open request). */
const sealedValue = z.object({ iv: z.string(), ct: z.string() });

const storeFile = z.object({
  v: z.literal(1),
  entries: z.array(
    sealedValue.extend({
      name: z.string(),
      target: z.string(),
      browser: secretBrowserBinding.optional(),
      updatedAt: z.string(),
    }),
  ),
}) satisfies z.ZodType<StoreFile>;

const enc = new TextEncoder();
const dec = new TextDecoder();
const b64 = (b: ArrayBuffer | Uint8Array) =>
  Buffer.from(b instanceof Uint8Array ? b : new Uint8Array(b)).toString("base64");
const unb64 = (s: string) => new Uint8Array(Buffer.from(s, "base64"));
/** An open request lasts 24 h; after that the private key goes away. */
const PENDING_TTL_MS = 24 * 3600_000;
/** Shorter values are not masked in command output: a short number shows up by chance. */
export const MIN_MASK = 4;

export interface SecretValue {
  name: string;
  target: string;
  browser: SecretBrowserBinding | null;
  value: string;
}

/** Each value of 4 characters or more becomes `[secret:NAME]`, longest first. */
const masksOf = (values: readonly SecretValue[]): [string, string][] =>
  values
    .filter((v) => v.value.length >= MIN_MASK)
    .sort((a, b) => b.value.length - a.value.length)
    .map((v) => [v.value, `[secret:${v.name}]`]);

export class SecretStore {
  private key: CryptoKey | null = null;
  private runnerId = "";
  /** How many commands use each secret file right now (the file goes away when it reaches zero). */
  private readonly materialized = new Map<string, number>();

  constructor(private readonly home: string) {}

  async unlock(storeKeyB64: string, runnerId: string): Promise<void> {
    const raw = unb64(storeKeyB64);
    if (raw.byteLength !== 32) throw new Error("Bad store key");
    this.key = await crypto.subtle.importKey("raw", raw, "AES-GCM", false, ["encrypt", "decrypt"]);
    this.runnerId = runnerId;
    this.purgePending();
  }

  /** No store key: the secrets cannot be read (before the welcome, between connections). */
  get locked(): boolean {
    return this.key === null;
  }

  lock(): void {
    this.key = null;
  }

  private requireKey(): CryptoKey {
    if (!this.key) throw new RunnerError("internal", "Secrets are locked until the server connects");
    return this.key;
  }

  private dirOf(agent: AgentRef) {
    return join(this.home, "secrets", `${agent.handle}-${agent.id.slice(-8)}`);
  }

  private storePath(agent: AgentRef) {
    return join(this.dirOf(agent), "store.json");
  }

  private pendingPath(requestId: string) {
    if (!/^[A-Za-z0-9_-]{1,64}$/.test(requestId)) throw new RunnerError("bad_request", "Bad request id");
    return join(this.home, "secrets", "pending", `${requestId}.json`);
  }

  private async seal(plain: string, aad: string): Promise<{ iv: string; ct: string }> {
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const ct = await crypto.subtle.encrypt(
      { name: "AES-GCM", iv, additionalData: enc.encode(aad) },
      this.requireKey(),
      enc.encode(plain),
    );
    return { iv: b64(iv), ct: b64(ct) };
  }

  private async unseal(box: { iv: string; ct: string }, aad: string): Promise<string> {
    const plain = await crypto.subtle.decrypt(
      { name: "AES-GCM", iv: unb64(box.iv), additionalData: enc.encode(aad) },
      this.requireKey(),
      unb64(box.ct),
    );
    return dec.decode(plain);
  }

  private read(agent: AgentRef): StoreFile {
    const path = this.storePath(agent);
    if (!existsSync(path)) return { v: 1, entries: [] };
    const parsed = storeFile.safeParse(JSON.parse(readFileSync(path, "utf8")));
    if (!parsed.success) throw new RunnerError("internal", `${path} is not a valid secret store`);
    return parsed.data;
  }

  private write(agent: AgentRef, file: StoreFile) {
    ensureDir(this.dirOf(agent));
    writePrivate(this.storePath(agent), `${JSON.stringify(file)}\n`);
  }

  private aad(agent: AgentRef, name: string, browser?: SecretBrowserBinding | null) {
    const base = `${this.runnerId}|${agent.id}|${name}`;
    return browser ? `${base}|${JSON.stringify([browser.sites, browser.field])}` : base;
  }

  /** Generates the request's key pair: the public one goes to the server, the private one stays encrypted until the value arrives. */
  async prepare(requestId: string, signal?: AbortSignal): Promise<{ publicKey: string }> {
    const r = await createRecipient();
    const sealed = await this.seal(await exportRecipient(r.privateKey), `pending|${requestId}`);
    if (signal?.aborted) throw new RunnerError("canceled", "Canceled");
    ensureDir(join(this.home, "secrets", "pending"));
    writePrivate(this.pendingPath(requestId), JSON.stringify({ ...sealed, createdAt: Date.now() }));
    return { publicKey: r.publicKey };
  }

  /** Opens the browser's box and stores the value encrypted with the server's key. */
  async store(
    agent: AgentRef,
    input: {
      requestId: string;
      workspaceId: string;
      name: string;
      target: string;
      box: SealedBox;
      browser?: SecretBrowserBinding | null;
    },
    signal?: AbortSignal,
  ): Promise<{ stored: true }> {
    // An API key as a variable secret would make Claude Code/Codex bill the API instead of the plan.
    if (input.target === "env" && reservedSecretName(input.name))
      throw new RunnerError("bad_request", `${input.name} is reserved in this environment`);
    const path = this.pendingPath(input.requestId);
    if (!existsSync(path))
      throw new RunnerError("not_found", "This request expired in this environment; ask again");
    const pending = sealedValue.parse(JSON.parse(readFileSync(path, "utf8")));
    const pkcs8 = await this.unseal(pending, `pending|${input.requestId}`);
    let value: string;
    try {
      value = await openSecret(await importRecipient(pkcs8), input.box, {
        requestId: input.requestId,
        workspaceId: input.workspaceId,
        name: input.name,
        target: input.target,
        browser: input.browser ?? null,
      });
    } catch {
      throw new RunnerError("bad_request", "The sealed value does not match this request");
    }
    const file = this.read(agent);
    const entry: StoredEntry = {
      name: input.name,
      target: input.target,
      ...(input.browser ? { browser: input.browser } : {}),
      ...(await this.seal(value, this.aad(agent, input.name, input.browser))),
      updatedAt: new Date().toISOString(),
    };
    file.entries = [...file.entries.filter((e) => e.name !== input.name), entry];
    // Aborted while the value was opened and sealed: the store does not change.
    if (signal?.aborted) throw new RunnerError("canceled", "Canceled");
    this.write(agent, file);
    unlinkSync(path);
    return { stored: true };
  }

  list(agent: AgentRef): StoredSecretInfo[] {
    return this.read(agent).entries.map((e) => ({
      name: e.name,
      target: e.target === "env" ? "env" : "file",
      updatedAt: e.updatedAt,
    }));
  }

  remove(agent: AgentRef, name: string): { removed: boolean } {
    const file = this.read(agent);
    const next = file.entries.filter((e) => e.name !== name);
    if (next.length === file.entries.length) return { removed: false };
    this.write(agent, { v: 1, entries: next });
    return { removed: true };
  }

  /** Opened values for a command: environment variables and files (path relative to the agent's folder). */
  async values(agent: AgentRef): Promise<SecretValue[]> {
    const out: SecretValue[] = [];
    for (const e of this.read(agent).entries) {
      out.push({
        name: e.name,
        target: e.target,
        browser: e.browser ?? null,
        value: await this.unseal(e, this.aad(agent, e.name, e.browser)),
      });
    }
    return out;
  }

  /** The command's environment and the secret files created for it (they go away with `release`). */
  /** The masks of what goes to the server, without writing any secret file; none while locked. */
  async masks(agent: AgentRef): Promise<[string, string][]> {
    if (!this.key) return [];
    return masksOf(await this.values(agent));
  }

  async materialize(
    agent: AgentRef,
    root: string,
    signal?: AbortSignal,
  ): Promise<{ env: Record<string, string>; masks: [string, string][]; release: () => void }> {
    if (!this.key) return { env: {}, masks: [], release: () => {} };
    const values = await this.values(agent);
    // Aborted while the values were read: nothing is written.
    if (signal?.aborted) throw new RunnerError("canceled", "Canceled");
    const env: Record<string, string> = {};
    const files: string[] = [];
    for (const v of values) {
      // A browser secret only goes to the field of its site: in a command, the agent would read the value and
      // could type it into any other site.
      if (v.browser) continue;
      if (v.target === "env") {
        if (!reservedSecretName(v.name)) env[v.name] = v.value;
      } else {
        const rel = v.target.slice("file:".length);
        const path = join(root, rel);
        if (!path.startsWith(`${root}/`)) continue;
        ensureDir(dirname(path));
        const n = this.materialized.get(path) ?? 0;
        // Invariant: the release undoes only what was written here. A file this store did not write (the
        // person's own, or a link) is left as it is and not removed; one another command is using is shared
        // by the use count. `wx` creates the file only if nothing is at the path, without following a link.
        if (n === 0) {
          try {
            writeFileSync(path, v.value, { mode: 0o600, flag: "wx" });
          } catch (err) {
            if (err instanceof Error && "code" in err && err.code === "EEXIST") continue;
            throw err;
          }
        }
        this.materialized.set(path, n + 1);
        files.push(path);
      }
    }
    const masks = masksOf(values);
    let released = false;
    return {
      env,
      masks,
      release: () => {
        if (released) return;
        released = true;
        for (const path of files) {
          const n = (this.materialized.get(path) ?? 1) - 1;
          if (n <= 0) {
            this.materialized.delete(path);
            rmSync(path, { force: true });
          } else this.materialized.set(path, n);
        }
      },
    };
  }

  /** Paths of the agent's secret files (the agent neither reads nor writes them through the ops). */
  secretFiles(agent: AgentRef, root: string): string[] {
    return this.read(agent)
      .entries.filter((e) => e.target.startsWith("file:"))
      .map((e) => join(root, e.target.slice("file:".length)));
  }

  private purgePending() {
    const dir = join(this.home, "secrets", "pending");
    if (!existsSync(dir)) return;
    for (const f of readdirSync(dir)) {
      const p = join(dir, f);
      if (Date.now() - statSync(p).mtimeMs > PENDING_TTL_MS) rmSync(p, { force: true });
    }
  }
}

/**
 * The text forms of each secret the masks look for, under its label: the value itself; its escaped form inside
 * a JSON string (the middle of `JSON.stringify(value)`), for a JSON line cut midway; and, for a value with line
 * breaks, the same two with `\r\n` (what a terminal sends back). Any other transformation (another escape, a
 * base64 the command makes itself) stays out on purpose: the mask is against accidental leaks.
 */
export function secretTextForms(value: string): string[] {
  const forms = new Set([value, JSON.stringify(value).slice(1, -1)]);
  if (value.includes("\n")) {
    const crlf = value.replace(/\r?\n/g, "\r\n");
    forms.add(crlf);
    forms.add(JSON.stringify(crlf).slice(1, -1));
  }
  return [...forms].filter((f) => f.length > 0);
}

function prepare(masks: readonly [string, string][]): [string, string][] {
  return masks.flatMap(([v, label]) => secretTextForms(v).map((f): [string, string] => [f, label]));
}

/**
 * One pass over `text`: at each position, the longest secret that starts there is replaced by its label and
 * the scan goes on after it (leftmost match, no overlap). Not `final`: the scan stops at the first position
 * where a secret could still start with more input, and returns the rest to be held.
 */
function scan(
  text: string,
  masks: readonly [string, string][],
  final: boolean,
): { out: string; rest: string } {
  let out = "";
  let plain = 0;
  let i = 0;
  while (i < text.length) {
    let match: [string, string] | null = null;
    let open = false;
    for (const m of masks) {
      const [v] = m;
      if (text.startsWith(v, i)) {
        if (!match || v.length > match[0].length) match = m;
      } else if (!final && text.length - i < v.length && v.startsWith(text.slice(i))) open = true;
    }
    // A longer secret could still match here: wait for the next piece before deciding.
    if (open) break;
    if (match) {
      out += text.slice(plain, i) + match[1];
      i += match[0].length;
      plain = i;
    } else i++;
  }
  return { out: out + text.slice(plain, i), rest: text.slice(i) };
}

/** Replaces each secret (in all its forms) with its label: leftmost match first, the longest one there, no overlap. */
export function maskSecrets(text: string, masks: [string, string][]): string {
  const prepared = prepare(masks);
  return prepared.length ? scan(text, prepared, true).out : text;
}

/**
 * Mask for output that arrives in pieces (the stream of a command, the capture that cuts it). What it
 * returns, concatenated, is `maskSecrets` of the whole output. It holds only the end of the text where a
 * secret could still start, so at most the longest form of a secret minus one character; `end` releases it.
 */
export class StreamMasker {
  private held = "";
  private source: [string, string][] | null = null;
  private prepared: [string, string][] = [];

  /**
   * `masks`: the list, or a function that gives the current one. With a function the list is read again at
   * each piece: a secret that appears in the middle of a flow masks what comes after, and what is still held
   * is scanned with the new list before it goes. What already went out before the secret existed stays out.
   */
  constructor(private readonly masks: [string, string][] | (() => [string, string][])) {}

  private current(): [string, string][] {
    const list = typeof this.masks === "function" ? this.masks() : this.masks;
    const same =
      list === this.source ||
      (this.source !== null &&
        list.length === this.source.length &&
        list.every((m, i) => m === this.source?.[i]));
    if (!same) {
      this.source = list;
      this.prepared = prepare(list);
    }
    return this.prepared;
  }

  push(chunk: string): string {
    const masks = this.current();
    if (!masks.length) {
      const out = this.held + chunk;
      this.held = "";
      return out;
    }
    const { out, rest } = scan(this.held + chunk, masks, false);
    this.held = rest;
    return out;
  }

  end(): string {
    const masks = this.current();
    const rest = masks.length ? scan(this.held, masks, true).out : this.held;
    this.held = "";
    return rest;
  }
}

const latin1 = (b: Uint8Array) => Buffer.from(b).toString("latin1");
const utf16be = (s: string) => Buffer.from(s, "utf16le").swap16();

/**
 * The byte forms of each secret, as one latin1 character per byte, with the label in the same encoding: the
 * UTF-8 of each text form, and the value in UTF-16LE, UTF-16BE and, when every character fits, Latin-1 (a
 * legacy file).
 */
function byteForms(masks: readonly [string, string][]): [string, string][] {
  const out: [string, string][] = [];
  for (const [value, label] of masks) {
    for (const f of secretTextForms(value))
      out.push([latin1(Buffer.from(f, "utf8")), latin1(Buffer.from(label, "utf8"))]);
    const plain = [value, ...(value.includes("\n") ? [value.replace(/\r?\n/g, "\r\n")] : [])];
    for (const f of plain) {
      out.push([latin1(Buffer.from(f, "utf16le")), latin1(Buffer.from(label, "utf16le"))]);
      out.push([latin1(utf16be(f)), latin1(utf16be(label))]);
      if ([...f].every((c) => c.charCodeAt(0) <= 0xff))
        out.push([latin1(Buffer.from(f, "latin1")), latin1(Buffer.from(label, "latin1"))]);
    }
  }
  const seen = new Set<string>();
  return out.filter(([v]) => v.length > 0 && !seen.has(v) && seen.add(v) !== undefined);
}

/** `maskSecrets` over bytes: each byte form of a secret becomes the bytes of its label in that encoding. */
export function maskBytes(data: Uint8Array, masks: [string, string][]): Buffer {
  const forms = byteForms(masks);
  if (!forms.length) return Buffer.from(data);
  return Buffer.from(scan(latin1(data), forms, true).out, "latin1");
}

/**
 * The first `max` bytes of `maskBytes(data)`, without masking all of a large file: it masks a growing window
 * that stops where a secret could still go on, which is always a prefix of the mask of the whole file.
 */
export function maskBytesPrefix(
  data: Uint8Array,
  masks: [string, string][],
  max: number,
): { bytes: Buffer; truncated: boolean } {
  const forms = byteForms(masks);
  const text = latin1(data);
  if (!forms.length)
    return { bytes: Buffer.from(text.slice(0, max), "latin1"), truncated: text.length > max };
  const longest = Math.max(...forms.map(([v]) => v.length));
  for (let end = Math.min(text.length, max + longest); ; end = Math.min(text.length, end * 2)) {
    if (end >= text.length) {
      const out = scan(text, forms, true).out;
      return { bytes: Buffer.from(out.slice(0, max), "latin1"), truncated: out.length > max };
    }
    const { out } = scan(text.slice(0, end), forms, false);
    if (out.length >= max) return { bytes: Buffer.from(out.slice(0, max), "latin1"), truncated: true };
  }
}

const escapeRe = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * Forms in which a typed value comes back: as is, with the spaces collapsed (page text) and
 * encoded as in a URL (GET form, the page's JavaScript in the query, the path or the fragment).
 */
function secretForms(value: string): string[] {
  const forms = new Set([
    value,
    value.trim().replace(/\s+/g, " "),
    encodeURIComponent(value),
    new URLSearchParams({ v: value }).toString().slice(2),
  ]);
  for (const [prefix, part] of [
    ["?", "search"],
    ["", "pathname"],
    ["#", "hash"],
  ] as const) {
    try {
      forms.add(new URL(`https://x.invalid/${prefix}${value}`)[part].slice(1));
    } catch {}
  }
  return [...forms].filter(Boolean);
}

/** What the model reads from the browser, without secrets: `text` for text and title, `url` for addresses. */
export interface BrowserMasker {
  text(text: string): string;
  url(url: string): string;
}

/**
 * Masks of what the model reads from the browser. A value of 4 characters or more goes away in any form
 * (`secretForms`), and so does its start right before a cut (the "…" of the read or of the page), so
 * the read does not hand over half a key. A short value (a CVV) goes away only as a URL parameter or
 * segment: in the text, a short number shows up by chance, and replacing each one with the secret's name
 * would be a clue and would spoil the text. The URL is also checked decoded (an encoding no form foresaw).
 */
export function browserMasker(values: readonly SecretValue[]): BrowserMasker {
  const long: [string, string][] = [];
  const short: [RegExp, string][] = [];
  for (const v of values) {
    const label = `[secret:${v.name}]`;
    for (const form of secretForms(v.value)) {
      if (form.length >= MIN_MASK) long.push([form, label]);
      else short.push([new RegExp(`(?<=[=/#])${escapeRe(form)}(?=$|[&#/;?])`, "g"), label]);
    }
  }
  long.sort((a, b) => b[0].length - a[0].length);
  const cutTails = (text: string): string => {
    let out = "";
    let last = 0;
    for (const m of text.matchAll(/…|\.\.\./g)) {
      const at = m.index ?? 0;
      let head = text.slice(last, at);
      for (const [form, label] of long) {
        const window = head.slice(-form.length);
        const start = form.slice(0, MIN_MASK);
        for (let i = window.indexOf(start); i >= 0; i = window.indexOf(start, i + 1)) {
          if (!form.startsWith(window.slice(i))) continue;
          head = head.slice(0, head.length - (window.length - i)) + label;
          break;
        }
      }
      out += head + m[0];
      last = at + m[0].length;
    }
    return out + text.slice(last);
  };
  const text = (t: string) => (long.length ? cutTails(maskSecrets(t, long)) : t);
  const url = (u: string): string => {
    let out = text(u);
    for (const [re, label] of short) out = out.replace(re, label);
    let decoded = out;
    try {
      decoded = decodeURIComponent(out);
    } catch {}
    if (decoded === out) return out;
    const again = url(decoded);
    return again === decoded ? out : again;
  };
  return { text, url };
}
