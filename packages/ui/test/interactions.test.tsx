import { afterAll, afterEach, beforeEach, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { act } from "react";
import { copy } from "../gallery/copy/index.ts";
import { mirrorPointerStates } from "../gallery/forceStates.ts";
import { contrast, parseColorTokens, readStyles } from "./tokens.ts";

// Radix must load after the DOM exists, independently of the server-render specs' module cache.
if (process.env.VANR_DOM_TEST !== "1") {
  test("interactive regressions in an isolated DOM", async () => {
    const child = Bun.spawn([process.execPath, "test", import.meta.path], {
      env: { ...process.env, VANR_DOM_TEST: "1" },
      stdout: "ignore",
      stderr: "pipe",
    });
    const output = await new Response(child.stderr).text();
    expect(await child.exited, output).toBe(0);
  }, 15000);
} else {
  GlobalRegistrator.register({ url: "http://localhost" });
  Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);
  const { createRoot } = await import("react-dom/client");
  const { App } = await import("../gallery/App.tsx");
  const { Button, ConfirmDialog } = await import("../src/index.ts");
  const { useState } = await import("react");
  const tokens = parseColorTokens(readStyles("tokens.css"));
  const style = document.createElement("style");
  // Happy DOM lacks cascade layers. Preserve their order while testing the actual declarations.
  style.textContent = [
    // Happy DOM misserializes var() colors in outline shorthands when cloning via CSSOM.
    readStyles("base.css")
      .match(/:focus-visible\s*\{[^}]*\}/)?.[0]
      ?.replace("var(--vr-focus)", tokens.get("focus")?.light ?? ""),
    ...["controls", "overlays", "display"].map((file) => {
      const css = readStyles(`components/${file}.css`);
      return css.slice(css.indexOf("{") + 1, css.lastIndexOf("}"));
    }),
  ].join("\n");
  document.head.append(style);
  document.documentElement.style.setProperty(
    "--vr-ring",
    readStyles("tokens.css").match(/--vr-ring:\s*([^;]+)/)?.[1] ?? "",
  );
  mirrorPointerStates();
  let container: HTMLDivElement;
  let root: ReturnType<typeof createRoot>;
  beforeEach(() => {
    history.replaceState(null, "", "/#states");
    for (const [name, value] of tokens)
      document.documentElement.style.setProperty(`--vr-${name}`, value.light);
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
  });
  afterEach(async () => {
    await act(() => root.unmount());
    container.remove();
  });
  afterAll(async () => GlobalRegistrator.unregister());

  test("navigation starts the new page at the main landmark", async () => {
    history.replaceState(null, "", "/#components");
    await act(() => root.render(<App />));
    window.scrollTo(0, 1740);
    expect(window.scrollY).toBe(1740);
    await act(() => {
      window.location.hash = "#states";
      window.dispatchEvent(new Event("hashchange"));
    });
    expect(container.querySelector("h1")?.textContent).toBe("States");
    expect(window.scrollY).toBe(0);
    expect(document.activeElement === container.querySelector("main")).toBe(true);
  });

  test("the context menu target participates in keyboard focus", async () => {
    history.replaceState(null, "", "/#components");
    await act(() => root.render(<App />));
    const target = container.querySelector<HTMLElement>(".g-context");
    expect(target?.tabIndex).toBe(0);
    target?.focus();
    expect(document.activeElement === target).toBe(true);
  });

  test("the pressed primary specimen paints the hovered fill during a pointer press", async () => {
    await act(() => root.render(<App />));
    const pressed = container.querySelector("tbody tr:first-child td:nth-of-type(4) button");
    expect(pressed).not.toBeNull();
    if (pressed)
      expect(getComputedStyle(pressed).backgroundColor).toBe(tokens.get("accent-hover")?.light ?? "");
  });

  test("the removable chip paints hover and focus on its remove button", async () => {
    await act(() => root.render(<App />));
    const row = [...container.querySelectorAll("tr")].find(
      (row) => row.querySelector("th")?.textContent === "Chip removable",
    );
    const hovered = row?.querySelector("td:nth-of-type(2) button");
    const focused = row?.querySelector("td:nth-of-type(3) button");
    expect(hovered).toBeTruthy();
    expect(focused).toBeTruthy();
    if (hovered) expect(getComputedStyle(hovered).backgroundColor).toBe(tokens.get("bg-hover")?.light ?? "");
    if (focused) {
      expect(getComputedStyle(focused).outlineStyle).toBe("solid");
      expect(getComputedStyle(focused).outlineOffset).toBe("0");
      expect(getComputedStyle(focused.parentElement ?? focused).outlineStyle).not.toBe("solid");
    }
  });

  test("keyboard focus on a floating item paints a contrasting ring in both themes", () => {
    const item = document.createElement("div");
    item.className = "vr-menu-item";
    item.tabIndex = -1;
    item.setAttribute("data-highlighted", "");
    container.append(item);
    item.focus();
    for (const theme of ["light", "dark"] as const) {
      for (const [name, value] of tokens)
        document.documentElement.style.setProperty(`--vr-${name}`, value[theme]);
      const css = getComputedStyle(item);
      expect(css.outlineStyle).toBe("solid");
      expect(Number.parseFloat(css.outlineWidth)).toBeGreaterThan(0);
      expect(contrast(css.outlineColor, css.backgroundColor)).toBeGreaterThanOrEqual(3);
      expect(contrast(css.outlineColor, tokens.get("bg-overlay")?.[theme] ?? "")).toBeGreaterThanOrEqual(3);
    }
  });

  test("changing language replaces editable specimen values", async () => {
    await act(() => root.render(<App />));
    const textareas = [...container.querySelectorAll("textarea")];
    expect(textareas).toHaveLength(5);
    textareas[0]?.focus();
    if (textareas[0]) textareas[0].value = "Edited specimen";
    const longInput = container.querySelector<HTMLInputElement>(".g-narrow input");
    if (longInput) longInput.value = "Edited channel";
    const language = container.querySelector('[role="combobox"][aria-label="Language"]');
    await act(() =>
      language?.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true })),
    );
    const portuguese = [...document.querySelectorAll<HTMLElement>('[role="option"]')].find(
      (node) => node.textContent === "Português (Brasil)",
    );
    expect(portuguese).toBeDefined();
    await act(() => portuguese?.click());
    expect(document.documentElement.lang).toBe("pt-BR");
    for (const textarea of container.querySelectorAll("textarea")) {
      expect(textarea.value).toBe(copy["pt-BR"].typeSpecimen.paragraph);
      expect(textarea.readOnly).toBe(false);
    }
    expect(container.querySelector<HTMLInputElement>(".g-narrow input")?.value).toBe(
      copy["pt-BR"].stateMatrix.longSampleText,
    );
  });

  test("synchronous uncontrolled confirmation closes and returns focus to the trigger", async () => {
    let confirmed = 0;
    await act(() =>
      root.render(
        <ConfirmDialog
          trigger={<Button>Open</Button>}
          title="Confirm?"
          description="An action"
          confirmLabel="Confirm"
          cancelLabel="Cancel"
          onConfirm={() => confirmed++}
        />,
      ),
    );
    const trigger = container.querySelector("button");
    trigger?.focus();
    await act(() => trigger?.click());
    expect(document.querySelectorAll('[role="alertdialog"]')).toHaveLength(1);
    const confirm = [...document.querySelectorAll<HTMLButtonElement>('[role="alertdialog"] button')].find(
      (button) => button.textContent === "Confirm",
    );
    await act(() => confirm?.click());
    expect(confirmed).toBe(1);
    expect(document.querySelectorAll('[role="alertdialog"]')).toHaveLength(0);
    await act(async () => new Promise((resolve) => setTimeout(resolve, 0)));
    expect(document.activeElement === trigger).toBe(true);
  });

  test("caller-managed confirmation stays open and blocks repeats while busy", async () => {
    let confirmed = 0;
    function AsyncConfirm() {
      const [confirming, setConfirming] = useState(false);
      return (
        <ConfirmDialog
          defaultOpen
          title="Confirm?"
          description="An action"
          confirmLabel="Confirm"
          cancelLabel="Cancel"
          confirming={confirming}
          onConfirm={() => {
            confirmed++;
            setConfirming(true);
          }}
        />
      );
    }
    await act(() => root.render(<AsyncConfirm />));
    const confirm = [...document.querySelectorAll<HTMLButtonElement>('[role="alertdialog"] button')].find(
      (button) => button.textContent === "Confirm",
    );
    await act(() => confirm?.click());
    expect(document.querySelectorAll('[role="alertdialog"]')).toHaveLength(1);
    expect(confirm?.getAttribute("aria-busy")).toBe("true");
    await act(() => confirm?.click());
    expect(confirmed).toBe(1);
  });
}
