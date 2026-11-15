// Attacks on the agent's browser with a real Chrome (Playwright's Chromium), with no internet: secrets, the
// screen, a person taking over and the checked actions. Test sites on loopback (testing/attack-sites.ts).
import { expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { consequenceOf } from "@vanr/engine/browser-policy";
import type { BrowserActResult } from "@vanr/engine/runner-protocol";
import type { Access } from "./access";
import { CdpBrowser } from "./cdp";
import type { SecretStore, SecretValue } from "./secrets";
import { html } from "./testing/attack-sites";
import {
  act,
  agent,
  binding,
  browser,
  chrome,
  failure,
  frames,
  inspect,
  open,
  policy,
  send,
  sites,
  useGuardBrowser,
} from "./testing/browser-guard";

let secrets: SecretValue[] = [];
useGuardBrowser(() => secrets);

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
      // The page has settled when two screenshots in a row are the same, and the live view when its last
      // frame stays the same across a few reads (conditions, not a time: under load the page paints late).
      let shot = "";
      for (let i = 0, prev = ""; i < 100; i++, prev = shot) {
        shot = (await act(a, { action: "screenshot" })).screenshot as string;
        if (shot === prev) break;
      }
      let frame = "";
      for (let i = 0, same = 0; i < 400 && same < 5; i++) {
        const last = frames.get(a.id)?.at(-1) ?? "";
        same = last && last === frame ? same + 1 : 0;
        frame = last;
        await Bun.sleep(20);
      }
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
      // Short values are masked in page text as well as fields and URLs.
      secrets = [{ name: "CVV", target: "env", browser: binding(["site.test"]), value: "123" }];
      sites.page("site.test", "/cvv", () =>
        html(`<form><input id="c" name="cvv"><button>ir</button></form><p>Pedido 123</p>`),
      );
      await open(a, sites.https("site.test", "/cvv"));
      await act(a, { action: "type_secret", selector: "#c", name: "CVV" });
      const cvv = await act(a, { action: "read" });
      expect(cvv.text).toContain('"cvv" (secret)');
      expect(cvv.text).toContain("Pedido [secret:CVV]");
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
  "an expired action keeps blocking effects while its work is still unwinding",
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
      const signal = AbortSignal.timeout(50);
      expect(
        await failure(
          slow.handle("live_view.input", a, { events: [{ type: "navigate", url: bank }] }, send, signal),
        ),
      ).toContain("canceled");
      expect(sites.hits).not.toContain("www.itau.com.br/depois");
    } finally {
      await slow.close();
    }
  },
  60_000,
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
        <label style="position:absolute;left:100px;top:100px"><input type="checkbox" id="covered">Remember</label>
        <form method="post" action="/comprar"><button style="position:absolute;left:100px;top:100px;width:200px;height:40px">Buy</button>
        <button id="mutates" type="button" style="position:absolute;left:500px;top:500px" onmouseenter="this.type='submit';this.textContent='Buy'">More</button></form>
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
    const covered = await inspect(a, { action: "check", selector: "#covered" });
    expect(
      await failure(act(a, { action: "check", selector: "#covered", expect: covered.fingerprint })),
    ).toStartWith("page_changed:");
    const mutates = await inspect(a, { action: "click", selector: "#mutates" });
    expect(
      await failure(act(a, { action: "click", selector: "#mutates", expect: mutates.fingerprint })),
    ).toStartWith("page_changed:");
    expect(bought).toBe(0);
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

test.skipIf(!chrome)(
  "an action canceled while the page loads stops: the load is stopped, the page stays, no result comes back",
  async () => {
    const a = agent();
    let release: () => void = () => {};
    let entered: () => void = () => {};
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const reached = new Promise<void>((r) => {
      entered = r;
    });
    sites.page("site.test", "/stay", () => html("<title>stay</title>"));
    sites.page("site.test", "/late", async () => {
      entered();
      await gate;
      return html("<title>LOADED AFTER CANCEL</title>");
    });
    await open(a, sites.http("site.test", "/stay"));
    const c = new AbortController();
    const going = browser.handle(
      "browser.open",
      a,
      { url: sites.http("site.test", "/late"), policy: policy() },
      send,
      c.signal,
    );
    // The page is being answered (a signal from the site, not a time): the request is canceled now.
    await reached;
    c.abort();
    const result = await going.then(
      () => "result",
      (e: { code?: string }) => e.code,
    );
    release();
    expect(result).toBe("canceled");
    const after = await act(a, { action: "read" });
    expect(after.title).toBe("stay");
  },
  30_000,
);

test.skipIf(!chrome)(
  "an action canceled between two of its steps sends no command that acts on the page after the cancel",
  async () => {
    const a = agent();
    sites.page("site.test", "/field", () => html('<input id="field">'));
    await open(a, sites.http("site.test", "/field"));
    const s = (
      Reflect.get(browser, "sessions") as Map<
        string,
        { cdp: { send: (...x: unknown[]) => Promise<unknown> }; unwinding: Set<Promise<void>> }
      >
    ).get(a.id);
    if (!s) throw new Error("no session");
    const c = new AbortController();
    const original = s.cdp.send.bind(s.cdp);
    const after: string[] = [];
    // The commands the action tries after the cancel, sent or rejected: a signal that its next step came.
    const tried: Promise<unknown>[] = [];
    let release: () => void = () => {};
    const gate = new Promise<void>((r) => {
      release = r;
    });
    let reached: () => void = () => {};
    const atStep = new Promise<void>((r) => {
      reached = r;
    });
    let paused = false;
    // The first step of `fill` (focus and clear the field) is held until the request is canceled.
    s.cdp.send = async (...x: unknown[]) => {
      const [method, params] = x as [string, { expression?: string }];
      const late = c.signal.aborted;
      const going = original(...x);
      if (late && method !== "Page.stopLoading") tried.push(going.catch(() => {}));
      const out = await going;
      if (late) after.push(method);
      if (
        !paused &&
        method === "Runtime.evaluate" &&
        params?.expression?.includes("getOwnPropertyDescriptor")
      ) {
        paused = true;
        reached();
        await gate;
      }
      return out;
    };
    try {
      const acting = browser
        .handle(
          "browser.act",
          a,
          { action: "fill", selector: "#field", text: "AFTER CANCEL", policy: policy() },
          send,
          c.signal,
        )
        .then(
          () => "result",
          (e: { code?: string }) => e.code,
        );
      await atStep;
      c.abort();
      expect(await acting).toBe("canceled");
      release();
      // The canceled action's next step comes (rejected or not), and settles.
      while (!tried.length) await Bun.sleep(5);
      await Promise.all(tried);
      await Promise.allSettled([...s.unwinding]);
      const acts = [
        "Page.navigate",
        "Input.dispatchMouseEvent",
        "Input.dispatchKeyEvent",
        "Input.insertText",
        "DOM.setFileInputFiles",
        "Runtime.evaluate",
        "Runtime.callFunctionOn",
      ];
      expect(after.filter((m) => acts.includes(m))).toEqual([]);
    } finally {
      s.cdp.send = original;
    }
  },
  30_000,
);

test.skipIf(!chrome)("keyboard rejects frame focus inside open and closed shadow roots", async () => {
  const a = agent();
  sites.page("frame.test", "/focus", () => html('<input id="trap">'));
  for (const mode of ["open", "closed"]) {
    sites.page("site.test", "/shadow-focus", () =>
      html(`<my-frame></my-frame><script>
      document.querySelector('my-frame').attachShadow({mode:'${mode}'}).innerHTML = '<iframe src="${sites.https("frame.test", "/focus")}"></iframe>';
    </script>`),
    );
    await open(a, sites.https("site.test", "/shadow-focus"));
    const session = Reflect.get(browser, "sessions").get(a.id);
    const frame = [...session.frames].find(([, f]) => f.kind === "iframe");
    if (!frame) throw new Error("missing frame");
    await session.cdp.send(
      "Runtime.evaluate",
      { expression: 'document.querySelector("#trap").focus()' },
      frame[0],
    );
    for (const key of ["X", "Enter"])
      expect(await failure(act(a, { action: "press", key }))).toStartWith("not_allowed:");
    const value = await session.cdp.send(
      "Runtime.evaluate",
      { expression: 'document.querySelector("#trap").value', returnByValue: true },
      frame[0],
    );
    expect(value.result.value).toBe("");
  }
});
