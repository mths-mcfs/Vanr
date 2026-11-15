// Scripts the runner runs in the page's isolated world, and the keys and selectors the actions use.
import { createHash } from "node:crypto";
import type { ElementFacts } from "@vanr/engine/browser-policy";

/** Isolated world of the runner's scripts: the page reaches neither their variables nor swaps the prototypes. */
export const WORLD = "vanr-agent";

export const KEYS: Record<string, { code: string; vk: number; text?: string }> = {
  Enter: { code: "Enter", vk: 13, text: "\r" },
  Tab: { code: "Tab", vk: 9 },
  Escape: { code: "Escape", vk: 27 },
  Backspace: { code: "Backspace", vk: 8 },
  Delete: { code: "Delete", vk: 46 },
  ArrowUp: { code: "ArrowUp", vk: 38 },
  ArrowDown: { code: "ArrowDown", vk: 40 },
  ArrowLeft: { code: "ArrowLeft", vk: 37 },
  ArrowRight: { code: "ArrowRight", vk: 39 },
  Home: { code: "Home", vk: 36 },
  End: { code: "End", vk: 35 },
  PageUp: { code: "PageUp", vk: 33 },
  PageDown: { code: "PageDown", vk: 34 },
  Space: { code: "Space", vk: 32, text: " " },
};

// Reads the page: visible text and the elements one can interact with, numbered (data-mref). A password
// field and a field where the runner typed a secret (marked in the isolated world, away from the page) come out
// without the value.
export const READ_SCRIPT = `(() => {
  const marked = globalThis.__vanrSecretFields;
  // The cut carries "…": the runner checks whether what is left before it is the start of a secret.
  const cut = (s, n) => (s.length > n ? s.slice(0, n) + '…' : s);
  const secret = (el) => !!marked && marked.has(el);
  const visible = (el) => { const r = el.getBoundingClientRect(); const st = getComputedStyle(el);
    return r.width > 0 && r.height > 0 && st.visibility !== 'hidden' && st.display !== 'none'; };
  const sel = 'a[href],button,input:not([type=hidden]),select,textarea,[role=button],[role=link],[role=checkbox],[role=tab],[role=menuitem],[contenteditable=true],summary';
  document.querySelectorAll('[data-mref]').forEach((e) => e.removeAttribute('data-mref'));
  const items = []; let n = 0;
  for (const el of document.querySelectorAll(sel)) {
    if (n >= 300 || !visible(el)) continue;
    n++; el.setAttribute('data-mref', String(n));
    const tag = el.tagName.toLowerCase();
    const role = el.getAttribute('role') || (tag === 'a' ? 'link' : tag === 'input' ? (el.type || 'text') : tag);
    const lab = el.labels && el.labels.length ? el.labels[0].innerText : '';
    const own = tag === 'select' ? '' : el.innerText;
    const val = el.type === 'password' || secret(el) || el.type === 'checkbox' || el.type === 'radio' || tag === 'select' ? '' : el.value;
    const label = cut((el.getAttribute('aria-label') || lab || own || val || el.placeholder || el.title || el.name || el.id || '').trim().replace(/\\s+/g, ' '), 80);
    let extra = '';
    if (tag === 'input' && (el.type === 'checkbox' || el.type === 'radio')) extra = el.checked ? ' [x]' : ' [ ]';
    else if (el.type === 'password') extra = ' (password)';
    else if (secret(el)) extra = ' (secret)';
    else if ((tag === 'input' || tag === 'textarea') && el.value) extra = ' = "' + cut(String(el.value), 60) + '"';
    else if (tag === 'select') extra = ' = "' + (el.options[el.selectedIndex] ? el.options[el.selectedIndex].text : '') + '" (options: ' + Array.from(el.options).slice(0, 12).map((o) => o.text).join(' | ') + ')';
    items.push('[' + n + '] ' + role + ' "' + label + '"' + extra);
  }
  const text = cut((document.body ? document.body.innerText : '').replace(/\\n{3,}/g, '\\n\\n'), 15000);
  return text + (items.length ? '\\n\\nElements:\\n' + items.join('\\n') : '');
})()`;

export const selectorOf = (raw: string) =>
  /^@?\d+$/.test(raw.trim()) ? `[data-mref="${raw.trim().replace("@", "")}"]` : raw;

/**
 * Types a secret in the same step that checks everything: an https page, the binding's site, a field of the right
 * type in the main document. The value goes straight to the element (without `Input.insertText`, which would go to
 * wherever the focus was, even a cross-origin iframe the page put in the way). The mask
 * goes in before the value: the next frame of the stream and the screenshot already come out with dots, and it comes back
 * if the page removes it (a "show password" button, a class swap).
 */
export const TYPE_SECRET_FN = `function (selector, value, sites, field) {
  const host = location.hostname.toLowerCase().replace(/\\.+$/, "");
  if (location.protocol !== "https:") return { err: "scheme", host };
  const bound = sites.some((p) => p.startsWith("*.") ? host === p.slice(2) || host.endsWith("." + p.slice(2)) : host === p);
  if (!bound) return { err: "domain", host };
  const el = document.querySelector(selector);
  if (!el) return { err: "not_found" };
  const kind = el instanceof HTMLInputElement ? (el.type || "text").toLowerCase() : el.tagName.toLowerCase();
  const fits = el instanceof HTMLInputElement &&
    (field === "password" ? kind === "password" : ["text", "email", "tel", "number", "search", "url"].includes(kind));
  if (!fits) return { err: "field", kind };
  const mask = () => {
    if (el.style.getPropertyValue("-webkit-text-security") !== "disc" || el.style.getPropertyPriority("-webkit-text-security") !== "important")
      el.style.setProperty("-webkit-text-security", "disc", "important");
  };
  mask();
  new MutationObserver(mask).observe(el, { attributes: true, attributeFilter: ["style", "type", "class"] });
  el.scrollIntoView({ block: "center" });
  el.focus();
  if (!globalThis.__vanrSecretFields) globalThis.__vanrSecretFields = new WeakSet();
  globalThis.__vanrSecretFields.add(el);
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set.call(el, value);
  el.dispatchEvent(new Event("input", { bubbles: true }));
  el.dispatchEvent(new Event("change", { bubbles: true }));
  return { ok: true };
}`;

export const FRAME_TAGS = "/^(IFRAME|FRAME|OBJECT|EMBED)$/";

/**
 * What the action will hit: the node at the click point (the runner calls the function on it, `this`), the focus
 * (going down through open shadow roots) or the `selector`. It walks up to the surrounding control (button, link,
 * field), through slot and shadow root, and reports what it says and the form it submits: that of the
 * submit button, or that of the default button when it is Enter in a field, with `formmethod` and `formaction`. The
 * server classifies the action from this; from a text field only the name or the placeholder goes, never the value.
 */
export const DESCRIBE_FN = `function (selector, focus) {
  let raw = this instanceof Node ? this : null;
  if (!raw && focus) {
    raw = document.activeElement;
    while (raw && raw.shadowRoot && raw.shadowRoot.activeElement) raw = raw.shadowRoot.activeElement;
  }
  if (!raw && selector) raw = document.querySelector(selector);
  if (raw && raw.nodeType === 3) raw = raw.parentElement;
  if (!raw || raw === document.body || raw === document.documentElement) return null;
  const CONTROL = 'button, input, select, textarea, a[href], label, [role=button], [role=link], [role=menuitem], [role=tab], [role=checkbox], [role=switch], [role=option], [contenteditable=""], [contenteditable="true"]';
  const up = (n) => n.assignedSlot || n.parentElement || (n.getRootNode() instanceof ShadowRoot ? n.getRootNode().host : null);
  let el = null;
  for (let n = raw; n && n.nodeType === 1; n = up(n)) if (n.matches(CONTROL)) { el = n; break; }
  const control = !!el;
  if (!el) el = raw;
  if (el.tagName === "LABEL" && el.control) el = el.control;
  const tag = el.tagName.toLowerCase();
  const type = tag === "input" || tag === "button" ? String(el.type || "").toLowerCase() : "";
  const textual = (e) => e.tagName === "TEXTAREA" || (e.tagName === "INPUT" && !/^(submit|button|image|reset|checkbox|radio|file|hidden|range|color)$/i.test(e.type));
  const editable = textual(el) || el.isContentEditable;
  const squash = (v) => String(v || "").replace(/\\s+/g, " ").trim().slice(0, 120);
  const labelOf = (e) => (e.labels && e.labels[0] ? e.labels[0].innerText : "");
  const own = tag === "input" ? (editable ? el.placeholder || el.name : labelOf(el) || el.value || el.alt)
    : tag === "select" ? labelOf(el) || el.name
    : editable ? "" : el.innerText || el.textContent;
  const label = squash(el.getAttribute("aria-label") || own || el.title);
  const a = el.closest("a[href]");
  const isSubmit = (b) => (b.tagName === "BUTTON" && b.type === "submit") || (b.tagName === "INPUT" && (b.type === "submit" || b.type === "image"));
  const f = el.form || null;
  let form = null;
  let submits = false;
  if (f) {
    const all = Array.from(f.elements);
    submits = isSubmit(el);
    // Enter in an input that is not a button (text, checkbox, radio, range) submits through the default button.
    const by = submits ? el : tag === "input" ? all.find(isSubmit) || null : null;
    const fields = all.filter(textual);
    const search = f.getAttribute("role") === "search" || !!f.closest("search, [role=search]") ||
      fields.some((e) => e.type === "search") ||
      (fields.length === 1 && fields[0].tagName === "INPUT" && /^(q|query|search|s|k|keywords?|busca|pesquisa|termo)$/i.test(fields[0].name || ""));
    form = {
      method: String((by && by.hasAttribute("formmethod") ? by.formMethod : f.method) || "get").toLowerCase(),
      action: by && by.hasAttribute("formaction") ? by.formAction : f.action,
      search,
    };
  }
  return { tag, type: type || null, role: el.getAttribute("role"), label, href: a && /^https?:/i.test(a.href) ? a.href : null, form, submits, editable, control };
}`;

/** Fingerprint of the page and the element: what the server checked is what the runner hits. */
export const fingerprintOf = (url: string, el: ElementFacts | null) =>
  createHash("sha256")
    .update(JSON.stringify([url, el]))
    .digest("base64url");
