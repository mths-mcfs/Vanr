// The agent's browser on the environment's Chrome/Chromium, through the DevTools protocol (CDP).
// Each agent has its own headless Chrome, with a persistent profile in the runner folder (the login
// the person did through the browser request keeps working). The page elements get numbers in
// `read`; the actions take that number or a CSS selector.
import { type ChildProcess, spawn } from "node:child_process";
import { existsSync, statSync } from "node:fs";
import { join } from "node:path";
import {
  ACTION_NEEDS,
  actionAllowed,
  type BrowserPolicy,
  blockMessage,
  type ElementFacts,
  type SiteVerdict,
  sensitiveCategory,
  siteAccess,
} from "@vanr/engine/browser-policy";
import type {
  AgentRef,
  BlockedLoad,
  BrowserActResult,
  BrowserInspectResult,
  OpArgs,
  RunnerFrame,
  RunnerOp,
} from "@vanr/engine/runner-protocol";
import { z } from "zod";
import { type Access, RunnerError } from "./access";
import type { BrowserDriver } from "./browser";
import { Cdp, sleep, within } from "./cdp-connection";
import { ensureDir } from "./config";
import { FrameGate } from "./frame-gate";
import { type NetBlock, type NetGuard, startNetGuard } from "./net-guard";
import {
  DESCRIBE_FN,
  FRAME_TAGS,
  fingerprintOf,
  KEYS,
  READ_SCRIPT,
  selectorOf,
  TYPE_SECRET_FN,
  WORLD,
} from "./page-scripts";
import { browserMasker, type SecretStore } from "./secrets";

const VIEWPORT = { width: 1280, height: 800 };
/** Chrome only returns the screenshot after drawing a frame; a tab that does not draw does not hang the op. */
const SHOT_TIMEOUT_MS = 5000;

/** Only documents (page and iframes) stop at Fetch: that is where the origin rule applies. */
const DOCUMENTS = [{ urlPattern: "*", resourceType: "Document", requestStage: "Request" }];
const BLOCKED_MAX = 10;
const DIALOGS_MAX = 5;
/** An action that does not come back (a page in a loop, a dialog nobody answered) releases the browser after this. */
const OP_TIMEOUT_MS = 55_000;
/** How long `browser.open` waits for the new document to commit and to finish loading. */
const DOCUMENT_WAIT_MS = 10_000;
const LAUNCH_TIMEOUT_MS = 20_000;

interface Page {
  targetId: string;
  sessionId: string;
  url: string;
  title: string;
  /** The tab already showed a document of its own (a new tab opened by the page starts with none). */
  shown: boolean;
}

/** CDP session of a tab or of a cross-origin iframe, with Fetch on. */
interface Frame {
  targetId: string;
  /** Tab: the main frame has the target id. Iframe: everything in it is a subframe. */
  kind: "page" | "iframe";
}

interface StreamFrame {
  data: string;
  width: number;
  height: number;
}

interface Session {
  agent: AgentRef;
  proc: ChildProcess;
  cdp: Cdp;
  pages: Page[];
  active: number;
  stream: { fps: number; sessionId: string; gate: FrameGate<StreamFrame> } | null;
  send: (frame: RunnerFrame) => boolean;
  lock: Promise<unknown>;
  /**
   * Who drives now, by the server's last notice (`browser.policy`, the stream and the agent's
   * action while it drives). The person's mouse and keyboard only get through with `driver: person` here.
   */
  policy: BrowserPolicy;
  /** Policy of the agent's action in progress: it applies in place of the one above until the action ends (`policyOf`). */
  op: BrowserPolicy | null;
  guard: NetGuard;
  frames: Map<string, Frame>;
  /** What was blocked since the last answer to the agent (including between one action and the next). */
  blocked: BlockedLoad[];
  /** Dialogs the page opened since the last answer to the agent. */
  dialogs: { type: string; message: string }[];
}

/**
 * The rule that applies now. During an agent action, the agent's, even if the person takes over midway:
 * the page the action opened does not start counting as if the person had opened it.
 */
const policyOf = (s: Session): BrowserPolicy => s.op ?? s.policy;

/** The URL of a sensitive site goes to the model with only the origin (path and query may carry the person's data). */
const forModel = (url: string): string => {
  try {
    const u = new URL(url);
    return sensitiveCategory(u.hostname) ? `${u.origin}/` : url;
  } catch {
    return url;
  }
};

const inputEvent = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("mouse"),
    action: z.enum(["move", "down", "up"]),
    x: z.number(),
    y: z.number(),
    button: z.enum(["left", "right", "middle"]).optional(),
    clickCount: z.number().int().min(1).max(3).optional(),
  }),
  z.object({
    type: z.literal("wheel"),
    x: z.number(),
    y: z.number(),
    dx: z.number().default(0),
    dy: z.number(),
  }),
  z.object({
    type: z.literal("key"),
    action: z.enum(["down", "up"]),
    key: z.string().max(40),
    code: z.string().max(40).optional(),
    text: z.string().max(4).optional(),
  }),
  z.object({ type: z.literal("text"), text: z.string().max(2000) }),
  /** Address bar of whoever took over control (it goes through the same origin rule and the proxy). */
  z.object({ type: z.literal("navigate"), url: z.string().max(4000) }),
]);

const hostOf = (url: string) => {
  try {
    return new URL(url).host || url;
  } catch {
    return url;
  }
};

type InspectAction = OpArgs<"browser.inspect">["action"];

const targetInfo = z.object({ targetId: z.string(), type: z.string(), url: z.string(), title: z.string() });
const maybeString = z.string().optional().catch(undefined);

/**
 * The Chrome events the runner reads, with the fields it reads. A frame of the live view is checked as a
 * whole too: `data` is only checked to be a string (the JPEG is not decoded here).
 */
const CDP_EVENTS = {
  "Fetch.requestPaused": z.object({
    requestId: z.string(),
    request: z.object({ url: z.string() }),
    frameId: z.string().optional(),
  }),
  "Page.javascriptDialogOpening": z.object({ type: maybeString, url: maybeString, message: maybeString }),
  "Target.attachedToTarget": z.object({
    sessionId: z.string(),
    targetInfo,
    waitingForDebugger: z.boolean().optional().catch(undefined),
  }),
  "Target.detachedFromTarget": z.object({ sessionId: z.string() }),
  "Target.targetDestroyed": z.object({ targetId: z.string() }),
  "Target.targetInfoChanged": z.object({ targetInfo: targetInfo.omit({ type: true }) }),
  "Page.frameNavigated": z.object({ frame: z.object({ id: z.string(), parentId: z.string().optional() }) }),
  "Page.screencastFrame": z.object({
    sessionId: z.number(),
    data: z.string(),
    metadata: z.object({ deviceWidth: z.number(), deviceHeight: z.number() }),
  }),
} as const;

const personDriving = () => new RunnerError("person_driving", "A person has control of this browser");

export interface CdpBrowserOptions {
  chrome: string;
  home: string;
  access: Access;
  secrets: SecretStore;
  headless?: boolean;
  /** Without Chrome's sandbox. Only by explicit choice (a Linux that blocks namespaces, a container). */
  noSandbox?: boolean;
  /** Tests: name resolver of the proxy, to point test names at local addresses. */
  resolve?: (host: string) => Promise<string[]>;
  /** Tests: accepts the self-signed certificate of the https test pages. */
  insecureTls?: boolean;
  /** Tests: a shorter deadline for an action that does not come back. */
  opTimeoutMs?: number;
  /**
   * Tests: a shorter wait for the new document after `browser.open` (production: 10 s). A navigation whose
   * redirect the origin rule blocked never commits its own loader, so the open waits this long for it.
   */
  documentWaitMs?: number;
}

export class CdpBrowser implements BrowserDriver {
  private readonly sessions = new Map<string, Session>();
  /** Chrome starting: whoever asks for the session meanwhile waits for the same one, instead of opening another on the same profile. */
  private readonly starting = new Map<string, Promise<Session>>();

  constructor(private readonly opts: CdpBrowserOptions) {}

  async handle(
    op: RunnerOp,
    agent: AgentRef,
    args: unknown,
    send: (frame: RunnerFrame) => boolean,
  ): Promise<unknown> {
    switch (op) {
      case "browser.close": {
        // The agent does not close a browser a person took over; the person (without `driver`) closes it.
        const by = (args as OpArgs<"browser.close">).driver;
        if (by === "agent" && this.sessions.get(agent.id)?.policy.driver === "person") throw personDriving();
        await this.closeSession(agent.id, "closed");
        return { closed: true };
      }
      case "live_view.stop": {
        const s = this.sessions.get(agent.id);
        if (s?.stream) await this.stopStream(s, "stopped");
        return { streaming: false };
      }
      case "browser.policy": {
        const s = this.sessions.get(agent.id);
        if (s) s.policy = (args as OpArgs<"browser.policy">).policy;
        return { applied: !!s };
      }
      case "live_view.input":
        return this.input(agent, args as OpArgs<"live_view.input">);
      case "live_view.start": {
        const a = args as OpArgs<"live_view.start">;
        const s = await this.session(agent, send, a.policy);
        s.policy = a.policy;
        return this.startStream(s, a.fps);
      }
      case "browser.inspect": {
        const a = args as OpArgs<"browser.inspect">;
        const s = this.sessions.get(agent.id);
        if (!s) throw new RunnerError("not_found", "Your browser is not open; call browser_open first");
        const run = s.lock.then(async () => {
          if (s.policy.driver === "person") throw personDriving();
          const r = await within(this.inspect(s, a), this.opts.opTimeoutMs ?? OP_TIMEOUT_MS);
          if (!r) throw new RunnerError("timeout", "The page did not answer in time");
          return r;
        });
        s.lock = run.catch(() => {});
        return run;
      }
      case "browser.open":
      case "browser.act": {
        const a = args as OpArgs<"browser.open"> | OpArgs<"browser.act">;
        const policy: BrowserPolicy = { ...a.policy, driver: "agent" };
        const s = await this.session(agent, send, policy);
        const run = s.lock.then(async () => {
          // The person took over after the server checked: the action does not happen (the server waits for them to hand it back).
          if (s.policy.driver === "person") throw personDriving();
          s.policy = policy;
          s.op = policy;
          // What the page tried after the previous answer goes along with this one, marked: it is not from this action.
          s.blocked = s.blocked.map((b) => ({ ...b, before: true }));
          try {
            const work =
              op === "browser.open"
                ? this.open(s, (a as OpArgs<"browser.open">).url)
                : this.act(s, a as OpArgs<"browser.act">);
            const r = await within(work, this.opts.opTimeoutMs ?? OP_TIMEOUT_MS);
            if (!r) throw new RunnerError("timeout", "The page did not answer in time");
            return await this.forAgent(s, await this.withEvidence(s, r));
          } finally {
            s.op = null;
          }
        });
        s.lock = run.catch(() => {});
        return run;
      }
      default:
        throw new RunnerError("bad_request", `Unknown browser op ${op}`);
    }
  }

  async close(): Promise<void> {
    for (const id of [...this.sessions.keys()]) await this.closeSession(id, "closed");
  }

  /**
   * What the model reads: without the value of any secret (neither encoded in the URL, nor with the spaces
   * collapsed by the page text) and, from a sensitive site, only the origin of the URL.
   */
  private async forAgent(s: Session, r: BrowserActResult): Promise<BrowserActResult> {
    const mask = browserMasker(await this.opts.secrets.values(s.agent).catch(() => []));
    const url = (u: string) => mask.url(forModel(u));
    return {
      ...r,
      url: url(r.url),
      title: mask.text(r.title),
      ...(r.text ? { text: mask.text(r.text) } : {}),
      ...(r.blocked ? { blocked: r.blocked.map((b) => ({ ...b, url: url(b.url) })) } : {}),
      ...(r.tabs ? { tabs: r.tabs.map((t) => ({ ...t, url: url(t.url), title: mask.text(t.title) })) } : {}),
      ...(r.dialogs ? { dialogs: r.dialogs.map((d) => ({ ...d, message: mask.text(d.message) })) } : {}),
    };
  }

  /** What was blocked during the action and the page thumbnail for the per-step log. */
  private async withEvidence(s: Session, r: BrowserActResult): Promise<BrowserActResult> {
    // This action's first: the cap cuts what the page tried before, not what the action ran into.
    const blocked = [...s.blocked.filter((b) => !b.before), ...s.blocked.filter((b) => b.before)].slice(
      0,
      BLOCKED_MAX,
    );
    s.blocked = [];
    const dialogs = s.dialogs;
    s.dialogs = [];
    const shot = r.screenshot ? undefined : await this.thumbnail(s).catch(() => undefined);
    return {
      ...r,
      ...(blocked.length ? { blocked } : {}),
      ...(dialogs.length ? { dialogs } : {}),
      ...(shot ? { shot } : {}),
    };
  }

  /** Screen thumbnail (half size). A page the agent may not see (a sensitive site) gets none. */
  private async thumbnail(s: Session): Promise<string | undefined> {
    const p = this.page(s);
    if (siteAccess({ ...policyOf(s), driver: "agent" }, p.url).kind === "blocked") return undefined;
    const shot = await within(
      s.cdp.send<{ data: string }>(
        "Page.captureScreenshot",
        { format: "jpeg", quality: 40, clip: { x: 0, y: 0, ...VIEWPORT, scale: 0.5 } },
        p.sessionId,
      ),
      SHOT_TIMEOUT_MS,
    ).catch(() => undefined);
    return shot?.data;
  }

  // ---- session (one Chrome per agent) ----

  // The agent opens the page and someone starts watching at the same time: both operations arrive
  // before Chrome finishes starting and need the same session.
  private async session(
    agent: AgentRef,
    send: (frame: RunnerFrame) => boolean,
    policy: BrowserPolicy,
  ): Promise<Session> {
    const live = this.sessions.get(agent.id);
    if (live && !live.cdp.closed) {
      live.send = send;
      return live;
    }
    let start = this.starting.get(agent.id);
    if (!start) {
      start = this.launch(agent, send, policy).finally(() => this.starting.delete(agent.id));
      this.starting.set(agent.id, start);
    }
    const s = await start;
    s.send = send;
    return s;
  }

  private async launch(
    agent: AgentRef,
    send: (frame: RunnerFrame) => boolean,
    policy: BrowserPolicy,
  ): Promise<Session> {
    const profile = join(this.opts.home, "browser", `${agent.handle}-${agent.id.slice(-8)}`);
    ensureDir(profile);
    // The proxy reads the session policy on each connection; before the session exists, the one that asked for Chrome.
    let ref: Session | null = null;
    const guard = await startNetGuard({
      ranges: () => (ref ? policyOf(ref) : policy).privateRanges,
      resolve: this.opts.resolve,
      onBlock: (b) => {
        if (ref) this.netBlocked(ref, b);
      },
    });
    const flags = [
      this.opts.headless === false ? "" : "--headless=new",
      "--remote-debugging-port=0",
      `--user-data-dir=${profile}`,
      "--no-first-run",
      "--no-default-browser-check",
      "--disable-dev-shm-usage",
      "--hide-scrollbars",
      "--mute-audio",
      `--window-size=${VIEWPORT.width},${VIEWPORT.height}`,
      // Every connection through the proxy, including localhost (which Chrome skips by default); no name
      // resolved by Chrome (if something escapes the proxy, it does not find the target); WebRTC without direct UDP;
      // no QUIC, which Alt-Svc would open outside the proxy.
      `--proxy-server=http://127.0.0.1:${guard.port}`,
      "--proxy-bypass-list=<-loopback>",
      "--host-resolver-rules=MAP * ~NOTFOUND , EXCLUDE 127.0.0.1",
      "--force-webrtc-ip-handling-policy=disable_non_proxied_udp",
      "--disable-quic",
      ...(this.opts.insecureTls ? ["--ignore-certificate-errors"] : []),
      ...(this.opts.noSandbox || process.getuid?.() === 0 ? ["--no-sandbox"] : []),
      "about:blank",
    ].filter(Boolean);
    const proc = spawn(this.opts.chrome, flags, { stdio: ["ignore", "ignore", "pipe"] });
    let cdp: Cdp | null = null;
    try {
      const url = await new Promise<string>((resolve, reject) => {
        let buf = "";
        const timer = setTimeout(
          () => reject(new RunnerError("browser_unavailable", "The browser did not start")),
          LAUNCH_TIMEOUT_MS,
        );
        proc.stderr?.on("data", (chunk: Buffer) => {
          buf += chunk.toString();
          const m = /DevTools listening on (ws:\/\/\S+)/.exec(buf);
          if (m?.[1]) {
            clearTimeout(timer);
            resolve(m[1]);
          }
        });
        proc.on("exit", () => {
          clearTimeout(timer);
          const fatal = /FATAL:[^\]]*\]\s*([^\n]{0,200})/.exec(buf)?.[1];
          reject(
            new RunnerError(
              "browser_unavailable",
              `The browser closed while starting${fatal ? `: ${fatal}` : ""}`,
            ),
          );
        });
      });
      cdp = await Cdp.connect(url);
      const s: Session = {
        agent,
        proc,
        cdp,
        pages: [],
        active: 0,
        stream: null,
        send,
        lock: Promise.resolve(),
        policy,
        op: null,
        guard,
        frames: new Map(),
        blocked: [],
        dialogs: [],
      };
      ref = s;
      proc.on("exit", () => {
        guard.close();
        if (this.sessions.get(agent.id) !== s) return;
        this.sessions.delete(agent.id);
        const st = s.stream;
        s.stream = null;
        st?.gate.stop();
        if (st) s.send({ type: "live_view.stream_ended", agentId: agent.id, reason: "error" });
      });
      cdp.on((method, params, sessionId) => this.onEvent(s, method, params, sessionId));
      await cdp.send("Target.setDiscoverTargets", { discover: true });
      // A new tab (target=_blank, window.open) and a cross-origin iframe are born paused until Fetch
      // is on in them: the first navigation already goes through the origin rule.
      await cdp.send("Target.setAutoAttach", {
        autoAttach: true,
        waitForDebuggerOnStart: true,
        flatten: true,
        filter: [{ type: "page" }, { exclude: true }],
      });
      await this.firstPage(s);
      // It only enters the list with the tab ready: before that, whoever arrives waits in `starting`.
      this.sessions.set(agent.id, s);
      return s;
    } catch (err) {
      // Started halfway (no DevTools, no tab): outside `sessions` nobody would close this Chrome,
      // and it would hold the profile for the next start.
      cdp?.close();
      guard.close();
      proc.kill("SIGKILL");
      throw err;
    }
  }

  /** Waits for the tab that already exists to arrive through auto-attach; with none, opens one. */
  private async firstPage(s: Session) {
    const ready = async (ms: number) => {
      const end = Date.now() + ms;
      while (Date.now() < end) {
        if (s.pages.length > 0) return true;
        if (s.cdp.closed) throw new RunnerError("browser_unavailable", "The browser closed while starting");
        await sleep(25);
      }
      return false;
    };
    if (await ready(3000)) return;
    await s.cdp.send("Target.createTarget", { url: "about:blank" });
    if (!(await ready(5000))) throw new RunnerError("browser_unavailable", "The browser has no page open");
  }

  /**
   * An attached tab or iframe. Fetch goes on before anything else and only then the target proceeds: one that could not
   * turn Fetch on is closed, instead of navigating without a rule.
   */
  private async attached(s: Session, params: z.output<(typeof CDP_EVENTS)["Target.attachedToTarget"]>) {
    const { sessionId, targetInfo: info } = params;
    const waiting = params.waitingForDebugger === true;
    const kind = info.type === "page" ? "page" : info.type === "iframe" ? "iframe" : null;
    try {
      if (kind) {
        s.frames.set(sessionId, { targetId: info.targetId, kind });
        await s.cdp.send("Fetch.enable", { patterns: DOCUMENTS }, sessionId);
        await s.cdp.send(
          "Target.setAutoAttach",
          {
            autoAttach: true,
            waitForDebuggerOnStart: true,
            flatten: true,
            filter: [{ type: "iframe" }, { exclude: true }],
          },
          sessionId,
        );
      }
      let page: Page | null = null;
      if (kind === "page") {
        await s.cdp.send("Page.enable", {}, sessionId);
        await s.cdp.send(
          "Emulation.setDeviceMetricsOverride",
          { ...VIEWPORT, deviceScaleFactor: 1, mobile: false },
          sessionId,
        );
        page = { targetId: info.targetId, sessionId, url: info.url, title: info.title, shown: false };
        s.pages.push(page);
      }
      if (waiting) await s.cdp.send("Runtime.runIfWaitingForDebugger", {}, sessionId);
      // A new tab opened by the page after startup: it becomes the active one, as in a browser.
      if (page && this.sessions.get(s.agent.id) === s) await this.activate(s, s.pages.indexOf(page));
    } catch {
      s.frames.delete(sessionId);
      await s.cdp.send("Target.closeTarget", { targetId: info.targetId }).catch(() => {});
    }
  }

  private detached(s: Session, sessionId: string) {
    s.frames.delete(sessionId);
    const idx = s.pages.findIndex((p) => p.sessionId === sessionId);
    if (idx < 0) return;
    s.pages.splice(idx, 1);
    if (s.active >= s.pages.length) s.active = Math.max(0, s.pages.length - 1);
  }

  /** Before a document request goes out: the origin rule decides. */
  private paused(
    s: Session,
    params: z.output<(typeof CDP_EVENTS)["Fetch.requestPaused"]>,
    sessionId: string | undefined,
  ) {
    const { requestId } = params;
    const { url } = params.request;
    const frame = sessionId ? s.frames.get(sessionId) : undefined;
    const main = frame?.kind === "page" && params.frameId === frame.targetId;
    const shown = main && s.pages.some((p) => p.sessionId === sessionId && p.shown);
    const site = siteAccess(policyOf(s), url);
    // An iframe of a site outside the list loads (the agent does not act inside it); sensitive, private network and
    // an odd scheme, not even in an iframe.
    const block = site.kind === "blocked" && (main || site.reason !== "not_allowed");
    if (block)
      this.noteBlocked(s, { url, reason: site.reason, ...(site.category ? { detail: site.category } : {}) });
    // A tab that already shows a page: `Aborted` cancels the navigation and it stays where it was. A tab that
    // has not shown anything yet (the page's new tab, Chrome's first one) and an iframe: `BlockedByClient`
    // puts up the error page; a tab with no document does not even draw and its screenshot never comes back.
    void s.cdp
      .send(
        block ? "Fetch.failRequest" : "Fetch.continueRequest",
        block ? { requestId, errorReason: shown ? "Aborted" : "BlockedByClient" } : { requestId },
        sessionId,
      )
      .catch(() => {});
  }

  private netBlocked(s: Session, b: NetBlock) {
    // A name that does not resolve is not a rule block (and Chrome makes background requests all the time).
    if (b.kind === "unresolved") return;
    const host = b.host.includes(":") && !b.host.startsWith("[") ? `[${b.host}]` : b.host;
    this.noteBlocked(s, { url: `${host}:${b.port}`, reason: "private_network", detail: b.kind });
  }

  /**
   * Keeps the block for the op's answer, without repeating (Chrome tries the same target again). What
   * came before the action does not count: the action that runs into the same target has its own block.
   */
  private noteBlocked(s: Session, b: BlockedLoad) {
    const now = s.blocked.filter((o) => !o.before);
    if (now.length >= BLOCKED_MAX) return;
    if (now.some((o) => o.url === b.url && o.reason === b.reason)) return;
    s.blocked.push(b);
  }

  /**
   * A native dialog (alert, confirm, prompt, leave warning): the page stops until someone answers, and
   * with it every following action, even that of the person who took over. The runner answers right away: it accepts the
   * alert and the leave warning, cancels confirm and prompt (the agent does not confirm what it did not see) and tells
   * the agent what the dialog said. From a sensitive site, without the text.
   */
  private dialog(
    s: Session,
    params: z.output<(typeof CDP_EVENTS)["Page.javascriptDialogOpening"]>,
    sessionId: string | undefined,
  ) {
    const type = params.type ?? "alert";
    void s.cdp
      .send("Page.handleJavaScriptDialog", { accept: type === "alert" || type === "beforeunload" }, sessionId)
      .catch(() => {});
    if (s.dialogs.length >= DIALOGS_MAX) return;
    let host = "";
    try {
      host = new URL(params.url ?? "").hostname;
    } catch {}
    const message = sensitiveCategory(host) ? "" : (params.message ?? "").slice(0, 300);
    s.dialogs.push({ type, message });
  }

  private onEvent(
    s: Session,
    method: string,
    params: Record<string, unknown>,
    sessionId: string | undefined,
  ) {
    switch (method) {
      case "Fetch.requestPaused": {
        // An invalid one stays paused: the request never goes out without the origin rule.
        const e = CDP_EVENTS[method].safeParse(params);
        if (e.success) this.paused(s, e.data, sessionId);
        return;
      }
      case "Page.javascriptDialogOpening": {
        const e = CDP_EVENTS[method].safeParse(params);
        if (e.success) this.dialog(s, e.data, sessionId);
        return;
      }
      case "Target.attachedToTarget": {
        const e = CDP_EVENTS[method].safeParse(params);
        if (e.success) void this.attached(s, e.data);
        return;
      }
      case "Target.detachedFromTarget": {
        const e = CDP_EVENTS[method].safeParse(params);
        if (e.success) this.detached(s, e.data.sessionId);
        return;
      }
      case "Target.targetDestroyed": {
        const e = CDP_EVENTS[method].safeParse(params);
        const p = e.success ? s.pages.find((x) => x.targetId === e.data.targetId) : undefined;
        if (p) this.detached(s, p.sessionId);
        return;
      }
      case "Target.targetInfoChanged": {
        const e = CDP_EVENTS[method].safeParse(params);
        if (!e.success) return;
        const info = e.data.targetInfo;
        const p = s.pages.find((x) => x.targetId === info.targetId);
        if (p) {
          p.url = info.url;
          p.title = info.title;
        }
        return;
      }
      case "Page.frameNavigated": {
        const e = CDP_EVENTS[method].safeParse(params);
        if (!e.success) return;
        const { frame } = e.data;
        const p = frame.parentId ? undefined : s.pages.find((x) => x.sessionId === sessionId);
        if (p && frame.id === p.targetId) p.shown = true;
        return;
      }
      case "Page.screencastFrame": {
        if (!s.stream || sessionId !== s.stream.sessionId) return;
        const e = CDP_EVENTS[method].safeParse(params);
        if (!e.success) return;
        const { metadata } = e.data;
        void s.cdp
          .send("Page.screencastFrameAck", { sessionId: e.data.sessionId }, sessionId)
          .catch(() => {});
        s.stream.gate.offer({
          data: e.data.data,
          width: Math.round(metadata.deviceWidth),
          height: Math.round(metadata.deviceHeight),
        });
        return;
      }
    }
  }

  private page(s: Session): Page {
    const p = s.pages[s.active] ?? s.pages[0];
    if (!p) throw new RunnerError("browser_unavailable", "The browser has no page open");
    return p;
  }

  private async activate(s: Session, index: number) {
    const p = s.pages[index];
    if (!p) throw new RunnerError("bad_request", `There is no tab ${index}`);
    const wasStreaming = s.stream;
    if (wasStreaming) await s.cdp.send("Page.stopScreencast", {}, wasStreaming.sessionId).catch(() => {});
    s.active = index;
    await s.cdp.send("Target.activateTarget", { targetId: p.targetId }).catch(() => {});
    if (wasStreaming) await this.startStream(s, wasStreaming.fps, true);
  }

  private async closeSession(agentId: string, reason: "closed" | "error") {
    // Closing while Chrome starts: waits for it to start so it really closes.
    await this.starting.get(agentId)?.catch(() => {});
    const s = this.sessions.get(agentId);
    if (!s) return;
    this.sessions.delete(agentId);
    // Frames that still arrive while Chrome closes no longer go out after ended.
    const st = s.stream;
    s.stream = null;
    st?.gate.stop();
    if (st) s.send({ type: "live_view.stream_ended", agentId, reason });
    await s.cdp.send("Browser.close").catch(() => {});
    s.cdp.close();
    s.guard.close();
    const killer = setTimeout(() => s.proc.kill("SIGKILL"), 2000);
    s.proc.once("exit", () => clearTimeout(killer));
    s.proc.kill("SIGTERM");
  }

  // ---- page ----

  /**
   * Context of the isolated world in the tab's current document. The runner's scripts run there: the page does not
   * swap `querySelector` or `getBoundingClientRect` to divert a click, nor read what goes through there.
   */
  private async world(s: Session, page = this.page(s)): Promise<number> {
    const { executionContextId } = await s.cdp.send<{ executionContextId: number }>(
      "Page.createIsolatedWorld",
      { frameId: page.targetId, worldName: WORLD },
      page.sessionId,
    );
    return executionContextId;
  }

  private async eval<T>(s: Session, expression: string): Promise<T> {
    const page = this.page(s);
    const contextId = await this.world(s, page);
    const r = await s.cdp.send<{
      result: { value?: unknown };
      exceptionDetails?: { text: string; exception?: { description?: string } };
    }>(
      "Runtime.evaluate",
      { expression, contextId, returnByValue: true, awaitPromise: true },
      page.sessionId,
    );
    if (r.exceptionDetails)
      throw new RunnerError(
        "bad_request",
        r.exceptionDetails.exception?.description ?? r.exceptionDetails.text,
      );
    return r.result.value as T;
  }

  /** A function with arguments by value: what goes in the arguments does not enter the script text. */
  private async call<T>(s: Session, fn: string, args: unknown[]): Promise<T> {
    const page = this.page(s);
    const executionContextId = await this.world(s, page);
    const r = await s.cdp.send<{ result: { value?: unknown }; exceptionDetails?: { text: string } }>(
      "Runtime.callFunctionOn",
      {
        functionDeclaration: fn,
        executionContextId,
        arguments: args.map((value) => ({ value })),
        returnByValue: true,
      },
      page.sessionId,
    );
    if (r.exceptionDetails) throw new RunnerError("bad_request", "The page did not accept the action");
    return r.result.value as T;
  }

  private async settle(s: Session, ms = DOCUMENT_WAIT_MS) {
    const end = Date.now() + ms;
    while (Date.now() < end) {
      const state = await this.eval<string>(s, "document.readyState").catch(() => "loading");
      if (state === "complete") return;
      await sleep(100);
    }
  }

  private async info(s: Session): Promise<BrowserActResult> {
    const r = await this.eval<{ url: string; title: string }>(
      s,
      "({ url: location.href, title: document.title })",
    ).catch(() => ({ url: this.page(s).url, title: this.page(s).title }));
    const p = this.page(s);
    p.url = r.url;
    p.title = r.title;
    return { ok: true, url: r.url, title: r.title };
  }

  /** The page the agent is on and what it may do there. Sensitive: not even the title goes to the model. */
  private async here(s: Session): Promise<{ info: BrowserActResult; site: SiteVerdict }> {
    const info = await this.info(s);
    const site = siteAccess(policyOf(s), info.url);
    if (site.kind === "blocked" && site.reason === "sensitive") info.title = "";
    return { info, site };
  }

  /** The page text only if the agent may read there. */
  private async readable(s: Session): Promise<BrowserActResult> {
    const { info, site } = await this.here(s);
    if (site.kind === "blocked")
      return { ...info, text: blockMessage(site.reason, hostOf(info.url), site.category) };
    return { ...info, text: await this.eval<string>(s, READ_SCRIPT) };
  }

  private async open(s: Session, url: string): Promise<BrowserActResult> {
    if (!/^https?:\/\//i.test(url)) throw new RunnerError("bad_request", "Only http and https pages");
    const site = siteAccess(policyOf(s), url);
    if (site.kind === "blocked")
      throw new RunnerError("not_allowed", blockMessage(site.reason, hostOf(url), site.category));
    const r = await s.cdp.send<{ errorText?: string; loaderId?: string }>(
      "Page.navigate",
      { url },
      this.page(s).sessionId,
    );
    if (r.errorText) {
      const why = s.blocked.findLast((b) => !b.before);
      return {
        ok: false,
        url,
        title: "",
        text: why
          ? `Blocked before loading: ${blockMessage(why.reason, hostOf(why.url), why.detail)}`
          : `Could not open the page: ${r.errorText}`,
      };
    }
    const wait = this.opts.documentWaitMs ?? DOCUMENT_WAIT_MS;
    if (r.loaderId) await this.committed(s, r.loaderId, wait);
    await this.settle(s, wait);
    return this.readable(s);
  }

  /**
   * Waits for the new document to enter the tab. Without it, the `readyState` read right after navigate may
   * be the old document's (an error page, for example) and the answer would go out with the wrong URL.
   */
  private async committed(s: Session, loaderId: string, ms = DOCUMENT_WAIT_MS) {
    const page = this.page(s);
    const end = Date.now() + ms;
    while (Date.now() < end) {
      const tree = await s.cdp
        .send<{ frameTree: { frame: { loaderId: string } } }>("Page.getFrameTree", {}, page.sessionId)
        .catch(() => null);
      if (tree?.frameTree.frame.loaderId === loaderId) return;
      await sleep(50);
    }
  }

  private async center(s: Session, selector: string): Promise<{ x: number; y: number }> {
    const sel = JSON.stringify(selectorOf(selector));
    const pos = await this.eval<{ x: number; y: number; frame?: boolean } | null>(
      s,
      `(() => { const el = document.querySelector(${sel}); if (!el) return null;
        el.scrollIntoView({ block: 'center', inline: 'center' }); const r = el.getBoundingClientRect();
        const x = r.left + r.width / 2, y = r.top + r.height / 2;
        const hit = document.elementFromPoint(x, y);
        const frame = ${FRAME_TAGS}.test(el.tagName) || (!!hit && hit !== el && !el.contains(hit) && ${FRAME_TAGS}.test(hit.tagName));
        return { x, y, frame }; })()`,
    );
    if (!pos)
      throw new RunnerError("not_found", `No element ${selector} on the page; call browser_read again`);
    if (pos.frame)
      throw new RunnerError(
        "not_allowed",
        "That spot is inside an embedded frame from another page; you can only act on the page itself. Open the frame's page with browser_open if you need it.",
      );
    return pos;
  }

  /**
   * `onTarget`: after moving the mouse there, the point still lands on the element (the page did not put another
   * on top on hover). A styled checkbox stays out: its point lands on the label.
   */
  private async click(s: Session, selector: string, onTarget = false) {
    const { x, y } = await this.center(s, selector);
    const sid = this.page(s).sessionId;
    await s.cdp.send("Input.dispatchMouseEvent", { type: "mouseMoved", x, y }, sid);
    if (onTarget) {
      const sel = JSON.stringify(selectorOf(selector));
      const hit = await this.eval<string | null>(
        s,
        `(() => { const el = document.querySelector(${sel}); const hit = document.elementFromPoint(${x}, ${y});
          if (!el || !hit || el === hit || el.contains(hit) || hit.contains(el)) return null;
          return hit.tagName.toLowerCase(); })()`,
      );
      if (hit)
        throw new RunnerError(
          "page_changed",
          `Something else (${hit}) is over ${selector} now; nothing was clicked. Close it or call browser_read again.`,
        );
    }
    await s.cdp.send(
      "Input.dispatchMouseEvent",
      { type: "mousePressed", x, y, button: "left", clickCount: 1 },
      sid,
    );
    await s.cdp.send(
      "Input.dispatchMouseEvent",
      { type: "mouseReleased", x, y, button: "left", clickCount: 1 },
      sid,
    );
  }

  /** Keys and text go to the focus: if the page moved the focus into an iframe, they do not go. */
  private async focusInPage(s: Session) {
    const inFrame = await this.eval<boolean>(
      s,
      `(() => { const a = document.activeElement; return !!a && ${FRAME_TAGS}.test(a.tagName); })()`,
    );
    if (inFrame)
      throw new RunnerError(
        "not_allowed",
        "The focus is inside an embedded frame from another page; typing there is not allowed.",
      );
  }

  private async focusAndClear(s: Session, selector: string) {
    const sel = JSON.stringify(selectorOf(selector));
    const ok = await this.eval<boolean>(
      s,
      `(() => { const el = document.querySelector(${sel}); if (!el) return false; el.scrollIntoView({ block: 'center' }); el.focus();
        if (el.isContentEditable) { document.execCommand('selectAll'); document.execCommand('delete'); return true; }
        const d = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(el), 'value');
        if (d && d.set) d.set.call(el, ''); else el.value = '';
        el.dispatchEvent(new Event('input', { bubbles: true })); return true; })()`,
    );
    if (!ok)
      throw new RunnerError("not_found", `No element ${selector} on the page; call browser_read again`);
    await this.focusInPage(s);
  }

  private async press(s: Session, key: string) {
    await this.focusInPage(s);
    const sid = this.page(s).sessionId;
    const k = KEYS[key];
    if (!k) {
      if ([...key].length !== 1) throw new RunnerError("bad_request", `Unknown key ${key}`);
      await s.cdp.send("Input.insertText", { text: key }, sid);
      return;
    }
    const base = { key: key === "Space" ? " " : key, code: k.code, windowsVirtualKeyCode: k.vk };
    await s.cdp.send(
      "Input.dispatchKeyEvent",
      { type: k.text ? "keyDown" : "rawKeyDown", ...base, ...(k.text ? { text: k.text } : {}) },
      sid,
    );
    await s.cdp.send("Input.dispatchKeyEvent", { type: "keyUp", ...base }, sid);
  }

  /** The element's http(s) link (or that of the surrounding `<a>`), to follow without clicking on a read-only origin. */
  private async linkOf(s: Session, selector: string): Promise<string | null> {
    const sel = JSON.stringify(selectorOf(selector));
    return this.eval<string | null>(
      s,
      `(() => { const el = document.querySelector(${sel}); const a = el && el.closest('a[href]');
        return a && /^https?:/i.test(a.href) ? a.href : null; })()`,
    );
  }

  private async typeSecret(s: Session, name: string, selector: string) {
    const found = (await this.opts.secrets.values(s.agent)).find((v) => v.name === name);
    if (!found)
      throw new RunnerError("not_found", `You have no secret named ${name}; ask for it with request_secret`);
    if (!found.browser)
      throw new RunnerError(
        "not_allowed",
        `${name} is not bound to any site, so it cannot be typed in the browser. Ask for it again with request_secret and the sites where it is used.`,
      );
    const { sites, field } = found.browser;
    const r = await this.call<{ ok?: true; err?: string; host?: string; kind?: string }>(s, TYPE_SECRET_FN, [
      selectorOf(selector),
      found.value,
      sites,
      field,
    ]);
    if (r.ok) return;
    if (r.err === "not_found")
      throw new RunnerError("not_found", `No element ${selector} on the page; call browser_read again`);
    if (r.err === "scheme") throw new RunnerError("not_allowed", "Secrets are only typed on https pages.");
    if (r.err === "domain")
      throw new RunnerError(
        "not_allowed",
        `${name} can only be typed on ${sites.join(", ")}, not on ${r.host ?? "this page"}.`,
      );
    throw new RunnerError(
      "not_allowed",
      `${name} only goes into a ${field === "password" ? "password field" : "single-line text field"}; ${selector} is ${r.kind ?? "something else"}.`,
    );
  }

  /** The page and the element the action will hit now, with the fingerprint of both. */
  private async describe(
    s: Session,
    action: InspectAction,
    selector: string | undefined,
  ): Promise<{ url: string; element: ElementFacts | null; fingerprint: string }> {
    const { url } = await this.info(s);
    const element =
      action === "click" && selector
        ? await this.describeHit(s, selector)
        : await this.call<ElementFacts | null>(s, DESCRIBE_FN, [
            selector ? selectorOf(selector) : null,
            action === "press",
          ]);
    return { url, element, fingerprint: fingerprintOf(url, element) };
  }

  /**
   * What really gets the click: the node at the element's center (where `click` presses), taken by
   * Chrome, which sees inside a shadow root (`querySelector` stops at the component host) and skips what
   * has `pointer-events: none`, like the click. The click point is the window's; Chrome's, the
   * page's, so it adds the scroll. Without the node, it describes the selector's own element.
   */
  private async describeHit(s: Session, selector: string): Promise<ElementFacts | null> {
    const pos = await this.center(s, selector).catch(() => null);
    if (!pos) return null;
    const page = this.page(s);
    const scroll = await this.eval<{ x: number; y: number }>(s, "({ x: scrollX, y: scrollY })");
    const hit = await s.cdp
      .send<{ backendNodeId: number }>(
        "DOM.getNodeForLocation",
        { x: Math.round(pos.x + scroll.x), y: Math.round(pos.y + scroll.y) },
        page.sessionId,
      )
      .catch(() => null);
    if (!hit) return this.call<ElementFacts | null>(s, DESCRIBE_FN, [selectorOf(selector), false]);
    const node = await s.cdp.send<{ object: { objectId?: string } }>(
      "DOM.resolveNode",
      { backendNodeId: hit.backendNodeId, executionContextId: await this.world(s, page) },
      page.sessionId,
    );
    if (!node.object.objectId) return null;
    const r = await s.cdp.send<{ result: { value?: unknown }; exceptionDetails?: unknown }>(
      "Runtime.callFunctionOn",
      {
        functionDeclaration: DESCRIBE_FN,
        objectId: node.object.objectId,
        arguments: [{ value: null }, { value: false }],
        returnByValue: true,
      },
      page.sessionId,
    );
    if (r.exceptionDetails) throw new RunnerError("bad_request", "The page did not accept the action");
    return (r.result.value ?? null) as ElementFacts | null;
  }

  /**
   * For the server to classify the action before the gate. A page the agent does not read (a sensitive site,
   * outside the list) comes back without the element and with only the origin; the fingerprint holds anyway, and the action
   * that comes with it is rejected by the rule or by the page that changed.
   */
  private async inspect(s: Session, a: OpArgs<"browser.inspect">): Promise<BrowserInspectResult> {
    const policy: BrowserPolicy = { ...a.policy, driver: "agent" };
    const d = await this.describe(s, a.action, a.selector);
    const site = siteAccess(policy, d.url);
    const readable = actionAllowed(site, "read").ok;
    const mask = browserMasker(await this.opts.secrets.values(s.agent).catch(() => []));
    const url = (u: string) => mask.url(forModel(u));
    const el = readable ? d.element : null;
    return {
      url: url(d.url),
      allowed: actionAllowed(site, a.action).ok,
      element: el && {
        ...el,
        label: mask.text(el.label),
        href: el.href && url(el.href),
        form: el.form && { ...el.form, action: url(el.form.action) },
      },
      fingerprint: d.fingerprint,
    };
  }

  /** Click, key and upload only happen on the element the server checked (`expect`). */
  private async expectSame(s: Session, a: OpArgs<"browser.act">, action: InspectAction) {
    if (a.expect === undefined) return;
    if (
      (await this.describe(s, action, action === "press" ? undefined : a.selector)).fingerprint !== a.expect
    )
      throw new RunnerError(
        "page_changed",
        "The page or the element changed since it was checked; nothing was done. Call browser_read and try again.",
      );
  }

  private async act(s: Session, a: OpArgs<"browser.act">): Promise<BrowserActResult> {
    const need = (v: string | undefined, what: string) => {
      if (!v) throw new RunnerError("bad_request", `${a.action} needs ${what}`);
      return v;
    };
    const sid = this.page(s).sessionId;
    if (ACTION_NEEDS[a.action] !== "none") {
      const { info, site } = await this.here(s);
      const verdict = actionAllowed(site, a.action);
      if (!verdict.ok) {
        // A read-only origin: a link becomes a navigation (the rule checks the target), without a click event.
        if (verdict.reason === "read_only" && a.action === "click") {
          const href = await this.linkOf(s, need(a.selector, "an element"));
          if (href) return this.open(s, href);
        }
        throw new RunnerError(
          "not_allowed",
          blockMessage(verdict.reason, hostOf(info.url), verdict.category),
        );
      }
    }
    switch (a.action) {
      case "read":
        return this.readable(s);
      case "back":
        await this.eval(s, "history.back()");
        await sleep(400);
        await this.settle(s, 5000);
        return (await this.here(s)).info;
      case "tabs": {
        if (a.index !== undefined) await this.activate(s, a.index);
        const info = (await this.here(s)).info;
        return {
          ...info,
          tabs: s.pages.map((p, i) => ({
            url: p.url,
            title: sensitiveCategory(hostOf(p.url).split(":")[0] ?? "") ? "" : p.title,
            active: i === s.active,
          })),
        };
      }
      case "click":
        need(a.selector, "an element");
        await this.expectSame(s, a, "click");
        await this.click(s, need(a.selector, "an element"), true);
        await sleep(300);
        await this.settle(s, 5000);
        return (await this.here(s)).info;
      case "fill":
        await this.focusAndClear(s, need(a.selector, "an element"));
        if (a.text) await s.cdp.send("Input.insertText", { text: a.text }, sid);
        return this.info(s);
      case "type_secret":
        await this.typeSecret(s, need(a.name, "a secret name"), need(a.selector, "an element"));
        return this.info(s);
      case "select": {
        const sel = JSON.stringify(selectorOf(need(a.selector, "an element")));
        await this.expectSame(s, a, "select");
        const want = JSON.stringify(need(a.text, "an option"));
        const ok = await this.eval<boolean>(
          s,
          `(() => { const el = document.querySelector(${sel}); if (!el || !el.options) return false;
            const i = Array.from(el.options).findIndex((o) => o.text.trim() === ${want} || o.value === ${want});
            if (i < 0) return false; el.selectedIndex = i;
            el.dispatchEvent(new Event('input', { bubbles: true })); el.dispatchEvent(new Event('change', { bubbles: true })); return true; })()`,
        );
        if (!ok) throw new RunnerError("not_found", `No option ${a.text} in ${a.selector}`);
        return this.info(s);
      }
      case "check": {
        const selector = need(a.selector, "an element");
        const sel = JSON.stringify(selectorOf(selector));
        await this.expectSame(s, a, "check");
        // Only a checkbox and a radio: on another element the click here would bypass the click
        // check (a purchase button marked as a "checkbox").
        const checked = await this.eval<boolean | "other" | null>(
          s,
          `(() => { const el = document.querySelector(${sel}); if (!el) return null;
            if (!(el instanceof HTMLInputElement) || !/^(checkbox|radio)$/i.test(el.type)) return "other";
            return el.checked; })()`,
        );
        if (checked === null) throw new RunnerError("not_found", `No element ${selector} on the page`);
        if (checked === "other")
          throw new RunnerError(
            "bad_request",
            `${selector} is not a checkbox or radio button; use browser_click for other elements`,
          );
        if (checked !== (a.text !== "false")) await this.click(s, selector);
        return this.info(s);
      }
      case "press":
        await this.expectSame(s, a, "press");
        await this.press(s, need(a.key, "a key"));
        await sleep(200);
        await this.settle(s, 5000);
        return (await this.here(s)).info;
      case "scroll":
        await this.eval(s, `window.scrollBy(0, ${Number(a.dy ?? 800)})`);
        return this.info(s);
      case "wait": {
        const ms = a.ms ?? 2000;
        if (!a.text) {
          await sleep(ms);
          return this.info(s);
        }
        const end = Date.now() + ms;
        const want = JSON.stringify(a.text);
        while (Date.now() < end) {
          if (
            await this.eval<boolean>(
              s,
              `(document.body ? document.body.innerText : '').includes(${want})`,
            ).catch(() => false)
          )
            return this.info(s);
          await sleep(200);
        }
        return { ...(await this.info(s)), ok: false, text: `"${a.text}" did not show up` };
      }
      case "screenshot": {
        const shot = await within(
          s.cdp.send<{ data: string }>("Page.captureScreenshot", { format: "jpeg", quality: 70 }, sid),
          SHOT_TIMEOUT_MS,
        );
        if (!shot) throw new RunnerError("browser_unavailable", "The page did not draw; try again");
        return { ...(await this.info(s)), screenshot: shot.data };
      }
      case "upload": {
        const path = this.opts.access.resolve(s.agent, need(a.text, "a file path"));
        if (!existsSync(path) || !statSync(path).isFile())
          throw new RunnerError("not_found", `No file ${a.text}`);
        need(a.selector, "an element");
        await this.expectSame(s, a, "upload");
        const sel = JSON.stringify(selectorOf(need(a.selector, "an element")));
        const r = await s.cdp.send<{ result: { objectId?: string } }>(
          "Runtime.evaluate",
          { expression: `document.querySelector(${sel})`, contextId: await this.world(s) },
          sid,
        );
        if (!r.result.objectId) throw new RunnerError("not_found", `No element ${a.selector} on the page`);
        await s.cdp.send("DOM.setFileInputFiles", { files: [path], objectId: r.result.objectId }, sid);
        return this.info(s);
      }
    }
  }

  // ---- live view ----

  private async startStream(s: Session, fps: number, force = false) {
    const sessionId = this.page(s).sessionId;
    if (s.stream && s.stream.sessionId === sessionId && !force) {
      s.stream.fps = fps;
      s.stream.gate.setFps(fps);
      return { streaming: true, fps };
    }
    s.stream?.gate.stop();
    // It runs from a timer: without `this.page`, which throws when the tab goes away midway.
    const gate = new FrameGate<StreamFrame>(fps, (f) =>
      s.send({
        type: "live_view.frame",
        agentId: s.agent.id,
        ...f,
        url: (s.pages[s.active] ?? s.pages[0])?.url,
      }),
    );
    s.stream = { fps, sessionId, gate };
    await s.cdp.send(
      "Page.startScreencast",
      { format: "jpeg", quality: fps > 5 ? 60 : 50, maxWidth: VIEWPORT.width, maxHeight: VIEWPORT.height },
      sessionId,
    );
    // The screencast only sends a frame when the page changes: the first one goes out right away, without waiting. The capture
    // never answers if the stream restarts midway (the browser_open that started Chrome switches
    // the active tab), and the stream request would be stuck until the server gave up.
    const stream = s.stream;
    void s.cdp
      .send<{ data: string }>("Page.captureScreenshot", { format: "jpeg", quality: 50 }, sessionId)
      .then(({ data }) => {
        if (data && s.stream === stream) gate.first({ data, width: VIEWPORT.width, height: VIEWPORT.height });
      })
      .catch(() => {});
    return { streaming: true, fps };
  }

  private async stopStream(s: Session, reason: "stopped" | "closed" | "error") {
    const st = s.stream;
    s.stream = null;
    st?.gate.stop();
    if (st) await s.cdp.send("Page.stopScreencast", {}, st.sessionId).catch(() => {});
    s.send({ type: "live_view.stream_ended", agentId: s.agent.id, reason });
  }

  /** Mouse and keyboard of whoever took over control (the server only relays from whoever has control). */
  private async input(agent: AgentRef, args: OpArgs<"live_view.input">) {
    const s = this.sessions.get(agent.id);
    if (!s) throw new RunnerError("browser_unavailable", "The browser is not open");
    // Input that arrives after the person hands back (or before the server says they took over)
    // does not count: only the server's notice says a person drives.
    if (s.policy.driver !== "person") return { applied: 0 };
    const sid = this.page(s).sessionId;
    let applied = 0;
    for (const raw of args.events) {
      const parsed = inputEvent.safeParse(raw);
      if (!parsed.success) continue;
      const e = parsed.data;
      if (e.type === "navigate") {
        const url = /^https?:\/\//i.test(e.url) ? e.url : `https://${e.url}`;
        // The person goes to any public site; the rule (with the current driver) and the proxy check it.
        if (siteAccess(policyOf(s), url).kind !== "blocked")
          await s.cdp.send("Page.navigate", { url }, sid).catch(() => {});
      } else if (e.type === "mouse") {
        const type =
          e.action === "move" ? "mouseMoved" : e.action === "down" ? "mousePressed" : "mouseReleased";
        await s.cdp.send(
          "Input.dispatchMouseEvent",
          {
            type,
            x: e.x,
            y: e.y,
            button: e.action === "move" ? "none" : (e.button ?? "left"),
            clickCount: e.clickCount ?? 1,
          },
          sid,
        );
      } else if (e.type === "wheel") {
        await s.cdp.send(
          "Input.dispatchMouseEvent",
          { type: "mouseWheel", x: e.x, y: e.y, deltaX: e.dx, deltaY: e.dy },
          sid,
        );
      } else if (e.type === "key") {
        const k = KEYS[e.key];
        await s.cdp.send(
          "Input.dispatchKeyEvent",
          {
            type: e.action === "up" ? "keyUp" : e.text ? "keyDown" : "rawKeyDown",
            key: e.key,
            code: e.code ?? k?.code ?? "",
            ...(k ? { windowsVirtualKeyCode: k.vk } : {}),
            ...(e.action === "down" && e.text ? { text: e.text } : {}),
          },
          sid,
        );
      } else await s.cdp.send("Input.insertText", { text: e.text }, sid);
      applied++;
    }
    return { applied };
  }
}
