// The wiki's block editor: Milkdown (ProseMirror) with the engine's Markdown schema, the same one the
// server reads and writes, bound to the page's live Y.Doc. `/` changes the block, `[[` links a page,
// a handle drags a block, and the cursors of the others on the page show where they are; the block an
// agent just changed is lit for a few seconds. Without a live document (it is still connecting, or the
// server refused it), the published text is shown read only.
import {
  defaultValueCtx,
  editorViewCtx,
  editorViewOptionsCtx,
  Editor as Milkdown,
  rootCtx,
} from "@milkdown/kit/core";
import { BlockProvider, block } from "@milkdown/kit/plugin/block";
import { clipboard } from "@milkdown/kit/plugin/clipboard";
import { cursor } from "@milkdown/kit/plugin/cursor";
import { indent } from "@milkdown/kit/plugin/indent";
import { Plugin } from "@milkdown/kit/prose/state";
import { Decoration, DecorationSet } from "@milkdown/kit/prose/view";
import { $prose } from "@milkdown/kit/utils";
import { collab, collabServiceCtx } from "@milkdown/plugin-collab";
import { configureWikiMarkdown, wikiLinkNode, wikiMarkdownPlugins } from "@vanr/engine/wiki/milkdown";
import { Icon } from "@vanr/ui";
import { FilePlus, FileText, GripVertical, type LucideIcon } from "lucide-react";
import { forwardRef, useEffect, useImperativeHandle, useMemo, useRef, useState } from "react";
import { relativePositionToAbsolutePosition, ySyncPluginKey } from "y-prosemirror";
import * as Y from "yjs";
import { useMessages } from "../../../i18n/react.tsx";
import type { Live } from "../page/collab.ts";
import { type EditorHooks, type Trigger, triggerPlugin, wikiLinkInputRule, wikiLinkView } from "./plugins.ts";
import { filterSlash, fold, type SlashItem } from "./slash.ts";

export type LinkCandidate = { slug: string; title: string; folder: string; altTitles: readonly string[] };

export type EditorHandle = {
  /**
   * Scrolls to the heading with this text in the open document, the `nth` one (from 0) when several
   * share it; false when there is none.
   */
  scrollToHeading: (text: string, nth?: number) => boolean;
  focus: () => void;
};

export type EditorSource = { kind: "live"; live: Live } | { kind: "static"; body: string };

type Props = {
  source: EditorSource;
  editable: boolean;
  /** The editor's accessible name. */
  label: string;
  pages: readonly LinkCandidate[];
  hooks: Omit<EditorHooks, "trigger" | "menuKey" | "links">;
  /** The passage selected now, with a little of the text around it (null: nothing selected). */
  onPick?: (picked: Picked | null) => void;
  /** The editor is made and holds its document: the live one, or the published text read only. */
  onReady?: (kind: EditorSource["kind"]) => void;
};

export type Picked = { quote: string; before: string; after: string };

/**
 * A selection without the spaces at its ends, which go to the text around it so that the quote and its
 * context still meet; null when only spaces were selected.
 */
export function trimPicked(raw: string, before: string, after: string): Picked | null {
  const quote = raw.trim();
  if (quote === "") return null;
  const lead = raw.slice(0, raw.length - raw.trimStart().length);
  const trail = raw.slice(raw.trimEnd().length);
  return { quote, before: before + lead, after: trail + after };
}

const AROUND = 64;
const BLOCKS = "\n\n";

/** Tells the screen which passage is selected, for a comment on it. */
const pickPlugin = (onPick: () => ((picked: Picked | null) => void) | undefined) =>
  $prose(
    () =>
      new Plugin({
        view: () => ({
          update(view, previous) {
            if (previous.selection.eq(view.state.selection) && previous.doc.eq(view.state.doc)) return;
            const report = onPick();
            if (report === undefined) return;
            const { from, to, empty } = view.state.selection;
            // Blocks are apart by a blank line, as in the Markdown, so a passage over two paragraphs is
            // found in the published text.
            const raw = empty ? "" : view.state.doc.textBetween(from, to, BLOCKS);
            const size = view.state.doc.content.size;
            report(
              trimPicked(
                raw,
                view.state.doc.textBetween(Math.max(0, from - AROUND), from, BLOCKS),
                view.state.doc.textBetween(to, Math.min(size, to + AROUND), BLOCKS),
              ),
            );
          },
        }),
      }),
  );

type MenuItem =
  | { kind: "slash"; item: SlashItem; label: string; icon: LucideIcon }
  | { kind: "page"; page: LinkCandidate; label: string; icon: LucideIcon }
  | { kind: "create"; title: string; label: string; icon: LucideIcon };

const LINK_HITS = 8;

/** Lights the block an agent just changed: its presence holds a cursor there for a few seconds. */
const agentBlocks = (awareness: () => Live["provider"]["awareness"]) =>
  $prose(
    () =>
      new Plugin({
        props: {
          decorations(state) {
            const sync = ySyncPluginKey.getState(state);
            const presence = awareness();
            if (!sync?.binding || presence === null) return null;
            const marks: Decoration[] = [];
            for (const peer of presence.getStates().values()) {
              if (peer.user?.kind !== "agent" || peer.cursor?.anchor === undefined) continue;
              const at = relativePositionToAbsolutePosition(
                sync.doc,
                sync.type,
                Y.createRelativePositionFromJSON(peer.cursor.anchor),
                sync.binding.mapping,
              );
              if (at === null || at > state.doc.content.size) continue;
              const $at = state.doc.resolve(at);
              if ($at.depth >= 1)
                marks.push(Decoration.node($at.before(1), $at.after(1), { class: "wiki-block--agent" }));
            }
            return DecorationSet.create(state.doc, marks);
          },
        },
      }),
  );

/** The caret of someone else on the page, with their name. */
function caret(user: { name?: string; color?: string; kind?: string }): HTMLElement {
  const mark = document.createElement("span");
  const agent = user.kind === "agent";
  mark.className = agent ? "wiki-cursor wiki-cursor--agent" : "wiki-cursor";
  if (!agent && user.color !== undefined) mark.style.setProperty("--wiki-who", user.color);
  const label = document.createElement("span");
  label.className = "wiki-cursor__label";
  label.textContent = user.name ?? "";
  mark.append(label);
  return mark;
}

export const Editor = forwardRef<EditorHandle, Props>(function Editor(props, ref) {
  const t = useMessages("wiki");
  const root = useRef<HTMLDivElement>(null);
  const handle = useRef<HTMLDivElement>(null);
  const editorRef = useRef<Milkdown | null>(null);
  const editable = useRef(props.editable);
  const latest = useRef(props);
  latest.current = props;
  const [trigger, setTrigger] = useState<Trigger | null>(null);
  const [active, setActive] = useState(0);
  const menu = useRef<{ items: MenuItem[]; active: number; pick: (item: MenuItem) => void }>({
    items: [],
    active: 0,
    pick: () => {},
  });

  const hooks = useRef<EditorHooks>({
    resolve: (target) => latest.current.hooks.resolve(target),
    open: (slug, anchor) => latest.current.hooks.open(slug, anchor),
    create: (title) => latest.current.hooks.create(title),
    openFile: (fileId) => latest.current.hooks.openFile(fileId),
    imageUrl: (fileId) => latest.current.hooks.imageUrl(fileId),
    href: (resolved, target, anchor) => latest.current.hooks.href(resolved, target, anchor),
    links: new Set(),
    trigger: (next) =>
      setTrigger((current) =>
        current !== null &&
        next !== null &&
        current.kind === next.kind &&
        current.from === next.from &&
        current.query === next.query
          ? current
          : next,
      ),
    menuKey: (key) => {
      const open = menu.current;
      if (open.items.length === 0) return false;
      if (key === "ArrowDown") setActive((index) => (index + 1) % open.items.length);
      else if (key === "ArrowUp") setActive((index) => (index - 1 + open.items.length) % open.items.length);
      else {
        const item = open.items[open.active];
        if (item !== undefined) open.pick(item);
      }
      return true;
    },
  });

  const source = props.source;
  // The editor is made once per document; everything else reaches it through the refs, since making it
  // again would lose the cursor and the undo history.
  useEffect(() => {
    const element = root.current;
    const grip = handle.current;
    if (element === null || grip === null) return;
    let disposed = false;
    const live = source.kind === "live" ? source.live : null;
    const editor = Milkdown.make()
      .config((ctx) => {
        ctx.set(rootCtx, element);
        configureWikiMarkdown(ctx);
        if (source.kind === "static") ctx.set(defaultValueCtx, source.body);
        ctx.update(editorViewOptionsCtx, (options) => ({
          ...options,
          editable: () => editable.current,
          // Read on every update, so a renamed page's editor carries the new title.
          attributes: () => ({
            class: "wiki-prose",
            role: "textbox",
            "aria-multiline": "true",
            "aria-label": latest.current.label,
            spellcheck: "true",
          }),
        }));
        ctx.set(block.key, {
          view: () => {
            const provider = new BlockProvider({
              ctx,
              content: grip,
              getOffset: () => 8,
              getPlacement: () => "left-start",
            });
            return { update: () => provider.update(), destroy: () => provider.destroy() };
          },
        });
      })
      .use(wikiMarkdownPlugins)
      .use(clipboard)
      .use(cursor)
      .use(indent)
      .use(block)
      .use(triggerPlugin(hooks))
      .use(wikiLinkInputRule)
      .use(wikiLinkView(hooks))
      .use(pickPlugin(() => latest.current.onPick));
    if (live !== null) editor.use(collab).use(agentBlocks(() => live.provider.awareness));
    void editor.create().then(() => {
      if (disposed) {
        void editor.destroy();
        return;
      }
      editorRef.current = editor;
      if (live === null) {
        latest.current.onReady?.("static");
        return;
      }
      editor.action((ctx) => {
        const service = ctx.get(collabServiceCtx);
        service.bindDoc(live.doc).setOptions({ yCursorOpts: { cursorBuilder: caret } });
        if (live.provider.awareness !== null) service.setAwareness(live.provider.awareness);
        service.connect();
      });
      latest.current.onReady?.("live");
    });
    return () => {
      disposed = true;
      editorRef.current = null;
      if (editor.status !== "Created") return;
      // The Yjs binding goes first: destroyed under it, the editor's state is gone while the binding
      // still answers the document's updates.
      if (live !== null) editor.action((ctx) => ctx.get(collabServiceCtx).disconnect());
      void editor.destroy();
    };
  }, [source]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: the label is read through `latest`; a new one asks the view to apply it.
  useEffect(() => {
    editable.current = props.editable;
    editorRef.current?.action((ctx) => ctx.get(editorViewCtx).setProps({}));
  }, [props.editable, props.label]);

  // The pages changed: the [[links]] on screen resolve again (only what changed touches the DOM).
  // biome-ignore lint/correctness/useExhaustiveDependencies: the new list is the signal; `resolve` arrives through the ref.
  useEffect(() => {
    for (const refresh of hooks.current.links) refresh();
  }, [props.pages, props.hooks.resolve]);

  useImperativeHandle(ref, () => ({
    scrollToHeading(text, nth = 0) {
      const wanted = text.trim().toLowerCase();
      let found = false;
      editorRef.current?.action((ctx) => {
        const view = ctx.get(editorViewCtx);
        let at: number | null = null;
        let seen = 0;
        view.state.doc.descendants((node, position) => {
          if (at !== null) return false;
          if (node.type.name === "heading" && node.textContent.trim().toLowerCase() === wanted) {
            if (seen === nth) at = position;
            seen += 1;
          }
          return true;
        });
        if (at === null) return;
        const dom = view.nodeDOM(at);
        if (dom instanceof HTMLElement) {
          dom.scrollIntoView({ block: "start", behavior: "smooth" });
          found = true;
        }
      });
      return found;
    },
    focus() {
      editorRef.current?.action((ctx) => ctx.get(editorViewCtx).focus());
    },
  }));

  const items = useMemo<MenuItem[]>(() => {
    if (trigger === null) return [];
    const slashLabel = (item: SlashItem) => t(`slash.${item.id}`);
    if (trigger.kind === "slash") {
      return filterSlash(trigger.query, slashLabel).map((item) => ({
        kind: "slash",
        item,
        label: slashLabel(item),
        icon: item.icon,
      }));
    }
    const base = (trigger.query.split(/[|#]/)[0] ?? "").trim();
    const wanted = fold(base);
    const pages: MenuItem[] = props.pages
      .filter(
        (page) =>
          wanted === "" ||
          [page.title, ...page.altTitles, `${page.folder}/${page.title}`].some((name) =>
            fold(name).includes(wanted),
          ),
      )
      .slice(0, LINK_HITS)
      .map((page) => ({ kind: "page", page, label: page.title, icon: FileText }));
    if (base !== "" && !props.pages.some((page) => fold(page.title) === wanted))
      pages.push({ kind: "create", title: base, label: t("link.create", { title: base }), icon: FilePlus });
    return pages;
  }, [trigger, props.pages, t]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: the menu goes back to its first item when it changes.
  useEffect(() => setActive(0), [trigger?.kind, trigger?.from, trigger?.query]);

  const pick = (item: MenuItem) => {
    const editor = editorRef.current;
    const open = trigger;
    if (editor === null || open === null) return;
    editor.action((ctx) => {
      const view = ctx.get(editorViewCtx);
      if (item.kind === "slash") {
        view.dispatch(view.state.tr.delete(open.from, open.to));
        item.item.run(ctx);
      } else {
        const title = item.kind === "page" ? item.page.title : item.title;
        // Two pages with this title: the link carries the folder.
        const twin =
          item.kind === "page" &&
          item.page.folder !== "" &&
          props.pages.filter((page) => fold(page.title) === fold(title)).length > 1;
        const target = twin && item.kind === "page" ? `${item.page.folder}/${title}` : title;
        const rest = open.query.slice((open.query.split(/[|#]/)[0] ?? "").length);
        const raw = `${open.embed ? "!" : ""}[[${target}${rest}]]`;
        view.dispatch(view.state.tr.replaceWith(open.from, open.to, wikiLinkNode.type(ctx).create({ raw })));
        if (item.kind === "create") latest.current.hooks.create(item.title);
      }
      view.focus();
    });
    setTrigger(null);
  };
  menu.current = { items, active, pick };

  let at: { left: number; top: number } | null = null;
  if (trigger !== null && items.length > 0) {
    editorRef.current?.action((ctx) => {
      const coords = ctx.get(editorViewCtx).coordsAtPos(trigger.from);
      const box = root.current?.getBoundingClientRect();
      if (box !== undefined) at = { left: coords.left - box.left, top: coords.bottom - box.top + 6 };
    });
  }

  return (
    <div className="wiki-editor">
      <div ref={handle} className="wiki-editor__grip" aria-hidden="true">
        <Icon icon={GripVertical} />
      </div>
      <div ref={root} className="wiki-editor__root" />
      {at !== null && (
        <div
          className="wiki-menu"
          role="listbox"
          aria-label={trigger?.kind === "slash" ? t("slash.label") : t("link.label")}
          style={at}
        >
          {items.map((item, index) => (
            <button
              key={`${item.kind}:${item.kind === "page" ? item.page.slug : item.label}`}
              type="button"
              role="option"
              aria-selected={index === active}
              className="wiki-menu__item"
              onMouseDown={(event) => {
                event.preventDefault();
                pick(item);
              }}
              onMouseEnter={() => setActive(index)}
            >
              <Icon icon={item.icon} />
              <span>{item.label}</span>
              {item.kind === "page" && item.page.folder !== "" && (
                <span className="wiki-menu__hint">{item.page.folder}</span>
              )}
            </button>
          ))}
        </div>
      )}
    </div>
  );
});
