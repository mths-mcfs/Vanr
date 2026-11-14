import { expect, test } from "bun:test";
import {
  type AimedAction,
  actionAllowed,
  type BrowserPolicy,
  checkRanges,
  consequenceOf,
  type ElementFacts,
  hostMatches,
  sensitiveCategory,
  siteAccess,
} from "./browser-policy";

const policy = (over: Partial<BrowserPolicy> = {}): BrowserPolicy => ({
  driver: "agent",
  level: "balanced",
  sites: [],
  privateRanges: [],
  ...over,
});

test("levels: strict blocks outside the list, balanced allows reading, free allows acting", () => {
  const url = "https://example.org/a";
  expect(siteAccess(policy({ level: "strict" }), url)).toEqual({ kind: "blocked", reason: "not_allowed" });
  expect(siteAccess(policy({ level: "balanced" }), url)).toEqual({ kind: "read" });
  expect(siteAccess(policy({ level: "free" }), url)).toEqual({ kind: "write" });
});

test("a read-only origin allows reading and scrolling, but not clicking or typing", () => {
  const p = policy({ level: "strict", sites: [{ pattern: "docs.example.org", access: "read" }] });
  const site = siteAccess(p, "https://docs.example.org/guia");
  expect(site).toEqual({ kind: "read" });
  expect(actionAllowed(site, "read").ok).toBe(true);
  expect(actionAllowed(site, "scroll").ok).toBe(true);
  expect(actionAllowed(site, "click")).toEqual({ ok: false, reason: "read_only" });
  expect(actionAllowed(site, "fill")).toEqual({ ok: false, reason: "read_only" });
  expect(actionAllowed(site, "type_secret")).toEqual({ ok: false, reason: "read_only" });
  expect(actionAllowed(site, "back").ok).toBe(true);
});

test("the most specific rule wins", () => {
  const p = policy({
    level: "strict",
    sites: [
      { pattern: "*.example.org", access: "write" },
      { pattern: "admin.example.org", access: "read" },
    ],
  });
  expect(siteAccess(p, "https://app.example.org/").kind).toBe("write");
  expect(siteAccess(p, "https://example.org/").kind).toBe("write");
  expect(siteAccess(p, "https://admin.example.org/").kind).toBe("read");
  expect(siteAccess(p, "https://evil-example.org/").kind).toBe("blocked");
});

test("a sensitive site blocks the agent even when listed, and lets the person in", () => {
  const p = policy({ level: "free", sites: [{ pattern: "*.itau.com.br", access: "write" }] });
  for (const url of [
    "https://www.itau.com.br/",
    "https://itau.com.br./",
    "https://ITAU.com.br/conta",
    "https://mail.google.com/mail/u/0/",
    "https://conectesus.saude.gov.br/",
    "https://sso.acesso.gov.br/login",
    "https://user:pass@www.nubank.com.br/",
  ])
    expect([url, siteAccess(p, url).kind]).toEqual([url, "blocked"]);
  expect(siteAccess(p, "https://www.itau.com.br/")).toEqual({
    kind: "blocked",
    reason: "sensitive",
    category: "bank",
  });
  expect(siteAccess({ ...p, driver: "person" }, "https://www.itau.com.br/").kind).toBe("write");
  // The same name inside another domain is not the bank.
  expect(sensitiveCategory("itau.com.br.evil.example")).toBeNull();
  expect(sensitiveCategory("google.com")).toBeNull();
});

test("a user and password in the URL do not fool the rule", () => {
  const p = policy({ level: "strict", sites: [{ pattern: "example.org", access: "write" }] });
  expect(siteAccess(p, "https://example.org@evil.example/").kind).toBe("blocked");
  expect(siteAccess(p, "https://example.org:443@evil.example/").kind).toBe("blocked");
});

test("a private-network IP literal is blocked, even written another way, and for the person too", () => {
  for (const url of [
    "http://127.0.0.1:8080/",
    "http://localhost.:1/",
    "http://2130706433/",
    "http://0x7f.1/",
    "http://[::1]/",
    "http://[::ffff:169.254.169.254]/",
    "http://169.254.169.254/latest/meta-data/",
    "http://10.0.0.1/",
    "http://192.168.0.1/",
  ]) {
    const v = siteAccess(policy({ level: "free" }), url);
    if (url.includes("localhost")) continue; // a name: the proxy, which resolves it, is the one that blocks
    expect([url, v]).toEqual([url, { kind: "blocked", reason: "private_network" }]);
    expect([url, siteAccess(policy({ driver: "person" }), url).kind]).toEqual([url, "blocked"]);
  }
  const lan = policy({ level: "strict", privateRanges: ["192.168.1.0/24"] });
  expect(siteAccess(lan, "http://192.168.1.7/").kind).toBe("write");
  expect(siteAccess(lan, "http://192.168.2.7/").kind).toBe("blocked");
});

test("only http and https; the blank page and the error page are read only", () => {
  const p = policy({ level: "free" });
  for (const url of [
    "file:///etc/passwd",
    "data:text/html,x",
    "javascript:alert(1)",
    "chrome://settings",
    "ftp://x/",
    "nada",
  ])
    expect([url, siteAccess(p, url).kind]).toEqual([url, "blocked"]);
  expect(siteAccess(p, "about:blank").kind).toBe("read");
  expect(siteAccess(p, "chrome-error://chromewebdata/").kind).toBe("read");
});

test("site patterns", () => {
  expect(hostMatches("a.b.example.org", "*.example.org")).toBe(true);
  expect(hostMatches("example.org", "*.example.org")).toBe(true);
  expect(hostMatches("notexample.org", "*.example.org")).toBe(false);
  expect(hostMatches("www.example.org", "example.org")).toBe(false);
  expect(checkRanges(["10.0.0.0/8", "192.168.1.5"]).ok).toBe(true);
  expect(checkRanges(["10.0.0.0/8", "lan"])).toEqual({ ok: false, bad: "lan" });
  // A public range (already open) or one that spills into the public space is not an "allowed private network".
  expect(checkRanges(["8.8.8.0/24"])).toEqual({ ok: false, bad: "8.8.8.0/24" });
  expect(checkRanges(["10.0.0.0/7"])).toEqual({ ok: false, bad: "10.0.0.0/7" });
  expect(
    checkRanges(["127.0.0.2/32", "::1/128", "fd12:3456::/32", "100.64.0.0/10", "169.254.0.0/16"]).ok,
  ).toBe(true);
});

const el = (over: Partial<ElementFacts> = {}): ElementFacts => ({
  tag: "button",
  type: "button",
  role: null,
  label: "",
  href: null,
  form: null,
  submits: false,
  editable: false,
  control: true,
  ...over,
});

test("consequential action: purchase, publish, delete and form submit escalate; search and navigation do not", () => {
  const post = { method: "post", action: "https://loja.test/pedido", search: false };
  const get = { method: "get", action: "https://loja.test/busca", search: true };
  // Without `method` the browser says GET, but the page's JavaScript sends it as it likes (an SPA comment box).
  const spa = { method: "get", action: "https://loja.test/post", search: false };
  const cases: [ElementFacts | null, AimedAction, string | undefined, string | null][] = [
    [el({ label: "Finalizar compra" }), "click", undefined, "purchase"],
    [el({ label: "Buy now" }), "click", undefined, "purchase"],
    [el({ tag: "a", label: "Pagar com Pix", href: "https://loja.test/pix" }), "click", undefined, "purchase"],
    [el({ label: "Excluir conta" }), "click", undefined, "delete"],
    [el({ tag: "a", label: "Delete", href: "https://x.test/del?id=3" }), "click", undefined, "delete"],
    [el({ label: "Publicar" }), "click", undefined, "publish"],
    [el({ label: "Enviar mensagem" }), "click", undefined, "send"],
    // A POST form submit button, whatever its text (login, sign up).
    [el({ type: "submit", label: "Entrar", form: post, submits: true }), "click", undefined, "submit"],
    // A GET form is navigation (search), like opening the URL.
    [el({ type: "submit", label: "Buscar", form: get, submits: true }), "click", undefined, null],
    [el({ tag: "a", label: "Próxima página", href: "https://x.test/2" }), "click", undefined, null],
    [el({ label: "Aceitar cookies" }), "click", undefined, null],
    [el({ label: "Posts" }), "click", undefined, null],
    [null, "click", undefined, null],
    // Enter in a field: submits the POST form; not the GET one; outside a form and in a textarea, the page decides.
    [el({ tag: "input", type: "text", editable: true, label: "q", form: post }), "press", "Enter", "submit"],
    [el({ tag: "input", type: "search", editable: true, label: "q", form: get }), "press", "Enter", null],
    [el({ tag: "textarea", editable: true, label: "Mensagem" }), "press", "Enter", "submit"],
    [el({ tag: "input", type: "text", editable: true, label: "Comprar" }), "press", "Tab", null],
    // Enter or space on a button is a click on it; space in a field is just a space.
    [el({ label: "Confirmar pagamento" }), "press", " ", "purchase"],
    [el({ tag: "input", type: "text", editable: true, form: post }), "press", " ", null],
    // Sending a file from the environment to the site always asks.
    [null, "upload", undefined, "upload"],
    // Adversarial review (round 3): a form that is not a search, focus on something the page drew, labels.
    [el({ type: "submit", label: "OK", form: spa, submits: true }), "click", undefined, "submit"],
    [
      el({ tag: "input", type: "text", editable: true, label: "nome", form: spa }),
      "press",
      "Enter",
      "submit",
    ],
    [el({ tag: "my-box", control: false }), "press", "Enter", "submit"],
    [el({ tag: "div", control: false, label: "Card" }), "click", undefined, null],
    [el({ tag: "input", type: "checkbox", label: "Excluir minha conta" }), "check", undefined, "delete"],
    [el({ tag: "select", label: "Plano" }), "select", "Cancelar assinatura", "delete"],
    [el({ tag: "input", type: "checkbox", label: "Lembrar de mim" }), "check", undefined, null],
    // Round 4: Enter on a form checkbox or range submits (implicit submission); space only toggles.
    [el({ tag: "input", type: "checkbox", label: "Lembrar", form: post }), "press", "Enter", "submit"],
    [el({ tag: "input", type: "range", label: "Volume", form: post }), "press", "Enter", "submit"],
    [el({ tag: "input", type: "checkbox", label: "Lembrar", form: get }), "press", "Enter", null],
    [el({ tag: "input", type: "checkbox", label: "Lembrar", form: post }), "press", " ", null],
    ...(
      [
        ["Reply", "publish"],
        ["Comentar", "publish"],
        ["Retweet", "publish"],
        ["Merge pull request", "publish"],
        ["Reservar", "purchase"],
        ["Book now", "purchase"],
        ["Dar lance", "purchase"],
        ["Aprovar", "send"],
        ["Invite", "send"],
        ["Sim", "send"],
        ["Yes, I'm sure", "send"],
        ["Finalizar", "send"],
        ["OK", null],
        ["Salvar", null],
        ["Adicionar ao carrinho", null],
      ] as const
    ).map(([label, want]) => [el({ label }), "click", undefined, want] as (typeof cases)[number]),
  ];
  for (const [facts, action, key, want] of cases)
    expect([facts?.label ?? null, action, key, consequenceOf(facts, action, key)]).toEqual([
      facts?.label ?? null,
      action,
      key,
      want,
    ]);
});
