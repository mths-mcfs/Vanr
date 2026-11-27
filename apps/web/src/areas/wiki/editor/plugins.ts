// The wiki editor's own ProseMirror plugins, besides Milkdown's: the trigger of the menus (`/` and
// `[[`), the rule that turns a typed [[target]] into a link, and the view of a link (a click opens
// the page, an attachment shows as an image or a file). What the screen knows (how a link resolves,
// where to go, how to open a menu) comes in through `hooks`.

import { InputRule } from "@milkdown/kit/prose/inputrules";
import { Plugin, PluginKey } from "@milkdown/kit/prose/state";
import type { EditorView } from "@milkdown/kit/prose/view";
import { $inputRule, $prose, $view } from "@milkdown/kit/utils";
import { parseLinkInner } from "@vanr/engine/wiki/links";
import { linkLabel, wikiLinkNode } from "@vanr/engine/wiki/milkdown";

export type Trigger = {
  kind: "slash" | "link";
  /** Where the trigger starts (the `/` or the first `[`) and the cursor. */
  from: number;
  to: number;
  query: string;
  embed: boolean;
};

export type ResolvedLink =
  /** A page: its slug. */
  | { kind: "page"; slug: string }
  /** No page by that name: a click creates it. */
  | { kind: "missing" }
  /** An attachment the import brought: an image shows inline, another file opens. */
  | { kind: "file"; fileId: string; name: string; image: boolean };

export type EditorHooks = {
  resolve: (target: string) => ResolvedLink;
  open: (slug: string, anchor: string | null) => void;
  create: (title: string) => void;
  openFile: (fileId: string) => void;
  /** The address of a page, or of creating it, for the link's href (a modified click opens it in the browser). */
  href: (resolved: ResolvedLink, target: string) => string;
  /** An object URL with an attachment's bytes, for an embedded image. */
  imageUrl: (fileId: string) => Promise<string>;
  trigger: (trigger: Trigger | null) => void;
  /** A key while a menu is open: true when the menu took it. */
  menuKey: (key: string) => boolean;
  /** The links on screen: each resolves again when the list of pages changes. */
  links: Set<() => void>;
};

type Hooks = { readonly current: EditorHooks };

const SLASH = /(?:^|\s)\/([\p{L}\p{N}]{0,24})$/u;
const LINK = /(!?)\[\[([^\]\n]{0,120})$/;

const triggerKey = new PluginKey<{ dismissed: number | null }>("wiki-trigger");

function currentTrigger(view: EditorView): Trigger | null {
  const { selection } = view.state;
  if (!selection.empty) return null;
  const $from = selection.$from;
  // No menu inside a code block.
  if (!$from.parent.isTextblock || $from.parent.type.spec.code === true) return null;
  const before = $from.parent.textBetween(0, $from.parentOffset, undefined, "￼");
  const link = LINK.exec(before);
  if (link) {
    return {
      kind: "link",
      from: $from.pos - link[0].length,
      to: $from.pos,
      query: link[2] ?? "",
      embed: link[1] === "!",
    };
  }
  const slash = SLASH.exec(before);
  if (slash) {
    const length = (slash[1] ?? "").length + 1;
    return { kind: "slash", from: $from.pos - length, to: $from.pos, query: slash[1] ?? "", embed: false };
  }
  return null;
}

/** Opens and closes the `/` and `[[` menus from the text before the cursor; Escape closes one until the text changes. */
export const triggerPlugin = (hooks: Hooks) =>
  $prose(
    () =>
      new Plugin<{ dismissed: number | null }>({
        key: triggerKey,
        state: {
          init: () => ({ dismissed: null }),
          apply: (tr, value) => {
            const meta: unknown = tr.getMeta(triggerKey);
            if (typeof meta === "object" && meta !== null && "dismissed" in meta)
              return meta as { dismissed: number | null };
            return tr.docChanged ? { dismissed: null } : value;
          },
        },
        props: {
          // A blur is no transaction, so `update` would leave the menu open: it closes here, and comes
          // back on the next change once the editor has the focus again.
          handleDOMEvents: {
            blur: () => {
              hooks.current.trigger(null);
              return false;
            },
          },
          handleKeyDown(view, event) {
            const trigger = currentTrigger(view);
            if (trigger === null || triggerKey.getState(view.state)?.dismissed === trigger.from) return false;
            if (event.key === "Escape") {
              view.dispatch(view.state.tr.setMeta(triggerKey, { dismissed: trigger.from }));
              return true;
            }
            if (["ArrowUp", "ArrowDown", "Enter", "Tab"].includes(event.key))
              return hooks.current.menuKey(event.key);
            return false;
          },
        },
        view: () => ({
          update(view) {
            const trigger = currentTrigger(view);
            const dismissed = triggerKey.getState(view.state)?.dismissed;
            hooks.current.trigger(
              trigger !== null && dismissed !== trigger.from && view.hasFocus() ? trigger : null,
            );
          },
          destroy() {
            hooks.current.trigger(null);
          },
        }),
      }),
  );

/** A typed [[target]] becomes a link. */
export const wikiLinkInputRule = $inputRule(
  (ctx) =>
    new InputRule(/(!?)\[\[([^[\]\n]+)\]\]$/, (state, match, start, end) =>
      state.tr.replaceWith(start, end, wikiLinkNode.type(ctx).create({ raw: match[0] })),
    ),
);

/**
 * A link as an `<a>`: its label, marked when nothing answers it, and a click that opens the page or
 * creates it. It resolves again when the screen says so (a page created, renamed or deleted, or the
 * attachments loaded while the editor is open). An embedded image attachment shows as the image, also
 * when it only resolves to one after the editor opened.
 */
export const wikiLinkView = (hooks: Hooks) =>
  $view(wikiLinkNode.node, () => (node) => {
    const raw = String(node.attrs.raw);
    const embed = raw.startsWith("!");
    const { target, anchor } = parseLinkInner(raw.replace(/^!?\[\[|\]\]$/g, ""));
    let resolved = hooks.current.resolve(target);
    // The node's DOM is a frame that holds the link or the image, so one can become the other.
    const frame = document.createElement("span");
    frame.className = "wiki-node";
    frame.contentEditable = "false";
    frame.dataset.raw = raw;
    const link = document.createElement("a");
    link.textContent = linkLabel(raw);
    let image: { element: HTMLImageElement; fileId: string; url?: string } | null = null;
    let gone = false;

    const dropImage = () => {
      if (image?.url !== undefined) URL.revokeObjectURL(image.url);
      image = null;
    };
    const showImage = (fileId: string, name: string) => {
      if (image?.fileId === fileId) return;
      dropImage();
      const element = document.createElement("img");
      element.className = "wiki-embed";
      element.alt = name;
      const shown = { element, fileId } as { element: HTMLImageElement; fileId: string; url?: string };
      image = shown;
      void hooks.current.imageUrl(fileId).then(
        (made) => {
          if (gone || image !== shown) URL.revokeObjectURL(made);
          else {
            shown.url = made;
            element.src = made;
          }
        },
        () => element.classList.add("wiki-embed--failed"),
      );
      frame.replaceChildren(element);
    };
    const showLink = () => {
      dropImage();
      const missing = resolved.kind === "missing";
      const name = `wiki-link${embed ? " wiki-link--embed" : ""}${missing ? " wiki-link--missing" : ""}`;
      if (link.className !== name) link.className = name;
      const href = hooks.current.href(resolved, target);
      if (link.getAttribute("href") !== href) link.setAttribute("href", href);
      if (missing) link.dataset.missing = "true";
      else delete link.dataset.missing;
      if (frame.firstChild !== link) frame.replaceChildren(link);
    };
    const render = () => {
      if (embed && resolved.kind === "file" && resolved.image) showImage(resolved.fileId, resolved.name);
      else showLink();
    };
    const refresh = () => {
      resolved = hooks.current.resolve(target);
      render();
    };
    render();
    hooks.current.links.add(refresh);
    link.addEventListener("click", (event: MouseEvent) => {
      // A click with a modifier is the browser's: a new tab or window.
      if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
      event.preventDefault();
      if (resolved.kind === "page") hooks.current.open(resolved.slug, anchor ?? null);
      else if (resolved.kind === "file") hooks.current.openFile(resolved.fileId);
      else if (target !== "") hooks.current.create(target);
    });
    return {
      dom: frame,
      ignoreMutation: () => true,
      stopEvent: (event) => event.type === "click",
      destroy: () => {
        gone = true;
        dropImage();
        hooks.current.links.delete(refresh);
      },
    };
  });
