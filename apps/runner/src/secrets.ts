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
const MIN_MASK = 4;

export interface SecretValue {
  name: string;
  target: string;
  browser: SecretBrowserBinding | null;
  value: string;
}

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
  async prepare(requestId: string): Promise<{ publicKey: string }> {
    const r = await createRecipient();
    const sealed = await this.seal(await exportRecipient(r.privateKey), `pending|${requestId}`);
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
  async materialize(
    agent: AgentRef,
    root: string,
  ): Promise<{ env: Record<string, string>; masks: [string, string][]; release: () => void }> {
    if (!this.key) return { env: {}, masks: [], release: () => {} };
    const values = await this.values(agent);
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
        if (n === 0) writeFileSync(path, v.value, { mode: 0o600 });
        this.materialized.set(path, n + 1);
        files.push(path);
      }
    }
    const masks = values
      .filter((v) => v.value.length >= MIN_MASK)
      .sort((a, b) => b.value.length - a.value.length)
      .map((v) => [v.value, `[secret:${v.name}]`] as [string, string]);
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

/** Replaces each secret value with its name (longest first). */
export function maskSecrets(text: string, masks: [string, string][]): string {
  let out = text;
  for (const [value, label] of masks) out = out.split(value).join(label);
  return out;
}

/**
 * Mask for output that arrives in pieces (the stream of a command, the capture that cuts it). A piece can end
 * in the middle of a secret, so the end of each piece (the longest secret minus one) is held until the next one,
 * and an occurrence that crosses that point is held whole. A secret with line breaks is also masked in its
 * `\r\n` form (what a terminal sends back). `end` releases what is held, masked.
 */
export class StreamMasker {
  private held = "";
  private readonly masks: [string, string][];
  private readonly keep: number;

  constructor(masks: [string, string][]) {
    const crlf = masks
      .filter(([v]) => v.includes("\n"))
      .map(([v, label]): [string, string] => [v.replace(/\r?\n/g, "\r\n"), label]);
    this.masks = [...masks, ...crlf].filter(([v]) => v.length > 0).sort((a, b) => b[0].length - a[0].length);
    this.keep = Math.max(0, ...this.masks.map(([v]) => v.length - 1));
  }

  push(chunk: string): string {
    const text = this.held + chunk;
    let cut = Math.max(0, text.length - this.keep);
    // A whole occurrence that crosses the cut moves the cut back to its start.
    for (let moved = true; moved && cut > 0; ) {
      moved = false;
      for (const [v] of this.masks) {
        const from = Math.max(0, cut - v.length + 1);
        const at = text.indexOf(v, from);
        if (at >= 0 && at < cut && at + v.length > cut) {
          cut = at;
          moved = true;
        }
      }
    }
    this.held = text.slice(cut);
    return maskSecrets(text.slice(0, cut), this.masks);
  }

  end(): string {
    const rest = maskSecrets(this.held, this.masks);
    this.held = "";
    return rest;
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
