// The items of the editor's `/` menu: turn the block into a paragraph, a heading, a list, a task, a
// quote, a callout, code, a table or a divider. The search reads the label and keywords in English
// and Portuguese, without accents.
import { type CmdKey, commandsCtx, editorViewCtx } from "@milkdown/kit/core";
import type { Ctx } from "@milkdown/kit/ctx";
import {
  createCodeBlockCommand,
  insertHrCommand,
  turnIntoTextCommand,
  wrapInBlockquoteCommand,
  wrapInBulletListCommand,
  wrapInHeadingCommand,
  wrapInOrderedListCommand,
} from "@milkdown/kit/preset/commonmark";
import { insertTableCommand } from "@milkdown/kit/preset/gfm";
import { wikiRawNode } from "@vanr/engine/wiki/milkdown";
import {
  Code,
  Heading1,
  Heading2,
  Heading3,
  Info,
  List,
  ListChecks,
  ListOrdered,
  type LucideIcon,
  Minus,
  Pilcrow,
  Quote,
  Table,
} from "lucide-react";

export type SlashId =
  | "text"
  | "h1"
  | "h2"
  | "h3"
  | "bullet"
  | "ordered"
  | "task"
  | "quote"
  | "callout"
  | "code"
  | "table"
  | "divider";

export type SlashItem = {
  id: SlashId;
  icon: LucideIcon;
  keywords: readonly string[];
  run: (ctx: Ctx) => void;
};

const call = <T>(ctx: Ctx, key: CmdKey<T>, payload?: T) => ctx.get(commandsCtx).call(key, payload);

/** A task: a bulleted item with `checked`, which the Markdown keeps as `[ ]`. */
function taskList(ctx: Ctx) {
  call(ctx, wrapInBulletListCommand.key);
  const view = ctx.get(editorViewCtx);
  const { $from } = view.state.selection;
  for (let depth = $from.depth; depth > 0; depth--) {
    const node = $from.node(depth);
    if (node.type.name === "list_item") {
      view.dispatch(
        view.state.tr.setNodeMarkup($from.before(depth), undefined, { ...node.attrs, checked: false }),
      );
      return;
    }
  }
}

/** A callout: a quote that starts with `[!note]`. */
function callout(ctx: Ctx) {
  call(ctx, wrapInBlockquoteCommand.key);
  const view = ctx.get(editorViewCtx);
  const { from } = view.state.selection;
  view.dispatch(
    view.state.tr.insert(from, [
      wikiRawNode.type(ctx).create({ raw: "[!note]" }),
      view.state.schema.text(" "),
    ]),
  );
}

export const SLASH_ITEMS: readonly SlashItem[] = [
  {
    id: "text",
    icon: Pilcrow,
    keywords: ["text", "paragraph", "texto", "paragrafo"],
    run: (ctx) => call(ctx, turnIntoTextCommand.key),
  },
  {
    id: "h1",
    icon: Heading1,
    keywords: ["heading", "titulo", "h1"],
    run: (ctx) => call(ctx, wrapInHeadingCommand.key, 1),
  },
  {
    id: "h2",
    icon: Heading2,
    keywords: ["heading", "titulo", "h2"],
    run: (ctx) => call(ctx, wrapInHeadingCommand.key, 2),
  },
  {
    id: "h3",
    icon: Heading3,
    keywords: ["heading", "titulo", "h3"],
    run: (ctx) => call(ctx, wrapInHeadingCommand.key, 3),
  },
  {
    id: "bullet",
    icon: List,
    keywords: ["list", "bullet", "lista"],
    run: (ctx) => call(ctx, wrapInBulletListCommand.key),
  },
  {
    id: "ordered",
    icon: ListOrdered,
    keywords: ["ordered", "numbered", "numerada"],
    run: (ctx) => call(ctx, wrapInOrderedListCommand.key),
  },
  { id: "task", icon: ListChecks, keywords: ["task", "todo", "checkbox", "tarefa"], run: taskList },
  {
    id: "quote",
    icon: Quote,
    keywords: ["quote", "citacao"],
    run: (ctx) => call(ctx, wrapInBlockquoteCommand.key),
  },
  { id: "callout", icon: Info, keywords: ["callout", "note", "aviso", "nota"], run: callout },
  {
    id: "code",
    icon: Code,
    keywords: ["code", "codigo"],
    run: (ctx) => call(ctx, createCodeBlockCommand.key),
  },
  {
    id: "table",
    icon: Table,
    keywords: ["table", "tabela"],
    run: (ctx) => call(ctx, insertTableCommand.key, { row: 3, col: 3 }),
  },
  {
    id: "divider",
    icon: Minus,
    keywords: ["divider", "rule", "divisoria", "linha"],
    run: (ctx) => call(ctx, insertHrCommand.key),
  },
];

export const fold = (text: string) =>
  text
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .toLowerCase();

/** The items whose label or keywords hold the query, at most 12. */
export function filterSlash(query: string, label: (item: SlashItem) => string): SlashItem[] {
  const wanted = fold(query.trim());
  const hits =
    wanted === ""
      ? [...SLASH_ITEMS]
      : SLASH_ITEMS.filter((item) =>
          [label(item), ...item.keywords].some((word) => fold(word).includes(wanted)),
        );
  return hits.slice(0, 12);
}
