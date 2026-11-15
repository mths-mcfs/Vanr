// Attacks on the agent's browser with a real Chrome (Playwright's Chromium), with no internet: the network
// and origin rules. Test sites on loopback (testing/attack-sites.ts) and a victim on 127.0.0.1 that counts
// hits; each test reproduces the attack and shows the block: the victim and the blocked site end with no hits.
import { expect, test } from "bun:test";
import { html, SITE_IP } from "./testing/attack-sites";
import {
  act,
  agent,
  blockNoted,
  browser,
  chrome,
  failure,
  inspect,
  open,
  policy,
  send,
  sites,
  useGuardBrowser,
} from "./testing/browser-guard";

useGuardBrowser(() => []);

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
      const r = await open(a, sites.http("site.test", `/r${i}`));
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
  "what is blocked between one action and the next shows up in the following answer, marked",
  async () => {
    const a = agent();
    // The page runs into the block only when the test lets it (it asks `/go` until the answer is yes):
    // after the first answer, however loaded the host is.
    let go = false;
    sites.page("site.test", "/go", () => new Response(go ? "yes" : "no"));
    sites.page("site.test", "/later", () =>
      html(
        `ok<script>(async () => { while ((await (await fetch('/go')).text()) !== 'yes') await new Promise((r) => setTimeout(r, 20)); fetch('http://127.0.0.1:${sites.port}/late').catch(() => {}); })()</script>`,
      ),
    );
    const first = await open(a, sites.http("site.test", "/later"));
    expect(first.blocked ?? []).toEqual([]);
    // The page runs into the block only now, and the next action goes only once the runner noted it: the
    // block is between the two answers by construction (a block noted during an action belongs to it).
    const noted = blockNoted(a.id, (b) => b.reason === "private_network");
    go = true;
    await noted;
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
