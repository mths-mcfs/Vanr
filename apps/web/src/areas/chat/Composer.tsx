// Where a message is written: text with light formatting, a quoted message, emoji, and @mentions
// picked from the people and agents of the conversation. Enter sends and Shift+Enter breaks the line,
// except while a mention list is open or a character is being composed. The text is kept as a draft
// per conversation, and the agents that will answer are named above the field before it is sent.
import type { DirectoryMember, Message } from "@vanr/contract";
import { AgentSigil, Avatar, Icon, Menu, MenuContent, MenuItem, MenuTrigger } from "@vanr/ui";
import {
  Bold,
  Code,
  Italic,
  Link,
  List,
  ListOrdered,
  type LucideIcon,
  Quote,
  SendHorizontal,
  Smile,
  SquareCode,
  Strikethrough,
  X,
} from "lucide-react";
import { type KeyboardEvent, useId, useLayoutEffect, useRef, useState } from "react";
import { useMessages } from "../../i18n/react.tsx";
import { useDraft } from "../../session/react.tsx";
import { useConversation } from "./context.tsx";
import type { Outgoing } from "./hooks.ts";
import { useAuthorName } from "./Message.tsx";

const EMOJI = [
  "😀",
  "😂",
  "🙂",
  "😉",
  "😍",
  "🤔",
  "😅",
  "😮",
  "😢",
  "🙏",
  "👏",
  "💪",
  "👍",
  "👎",
  "🔥",
  "✨",
  "🚀",
  "✅",
  "❌",
  "⚠️",
  "💡",
  "📌",
  "☕",
  "🎯",
];

/** How many people and agents the mention list offers at once. */
const MENTIONS = 6;
/** A quote keeps this much of the message it quotes. */
export const QUOTE_LENGTH = 140;

type Edit = { text: string; start: number; end: number };

/** Wraps the selection in a marker (or puts the empty pair at the caret). */
export function wrap(edit: Edit, before: string, after = before): Edit {
  const picked = edit.text.slice(edit.start, edit.end);
  const text = edit.text.slice(0, edit.start) + before + picked + after + edit.text.slice(edit.end);
  return { text, start: edit.start + before.length, end: edit.start + before.length + picked.length };
}

/** Starts every selected line (or the caret's line) with a prefix; numbered lists count up. */
export function prefixLines(edit: Edit, prefix: (index: number) => string): Edit {
  const from = edit.text.lastIndexOf("\n", edit.start - 1) + 1;
  const toBreak = edit.text.indexOf("\n", edit.end);
  const to = toBreak === -1 ? edit.text.length : toBreak;
  const lines = edit.text.slice(from, to).split("\n");
  const changed = lines.map((line, index) => prefix(index) + line).join("\n");
  const text = edit.text.slice(0, from) + changed + edit.text.slice(to);
  return { text, start: from, end: from + changed.length };
}

/** The mention being typed just before the caret: `@` at a word's start and what follows it. */
export function mentionAt(text: string, caret: number): { from: number; query: string } | null {
  const match = /(^|\s)@([\p{L}\p{N}_.-]*)$/u.exec(text.slice(0, caret));
  if (match === null) return null;
  return { from: caret - (match[2] ?? "").length - 1, query: match[2] ?? "" };
}

/** Who matches a query by name or handle: agents first, then people, at most MENTIONS. */
export function mentionChoices(
  people: readonly DirectoryMember[],
  query: string,
  me: string,
): DirectoryMember[] {
  const q = query.toLowerCase();
  const fits = (entry: DirectoryMember) =>
    entry.name.toLowerCase().includes(q) || (entry.handle ?? "").toLowerCase().includes(q);
  const pool = people.filter((entry) => !(entry.type === "person" && entry.id === me) && fits(entry));
  return [
    ...pool.filter((entry) => entry.type === "agent"),
    ...pool.filter((entry) => entry.type === "person"),
  ].slice(0, MENTIONS);
}

const handleOf = (entry: DirectoryMember) => entry.handle ?? entry.name.replace(/\s+/g, "");

/** The agents a text will reach: the ones mentioned, else the agent of a direct message. */
export function answering(
  text: string,
  people: readonly DirectoryMember[],
  dmAgentId: string | undefined,
): string[] {
  const agents = people.filter((entry) => entry.type === "agent" && entry.handle !== null);
  const mentioned = agents.filter((entry) =>
    new RegExp(
      `(^|\\s)@${(entry.handle ?? "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?![\\p{L}\\p{N}_])`,
      "iu",
    ).test(text),
  );
  if (mentioned.length > 0) return mentioned.map((entry) => entry.id);
  return dmAgentId === undefined ? [] : [dmAgentId];
}

type Tool = {
  key: string;
  icon: LucideIcon;
  label: "bold" | "italic" | "strike" | "code" | "fence" | "link" | "list" | "numbered" | "quote";
  apply: (edit: Edit) => Edit;
};

const TOOLS: Tool[] = [
  { key: "bold", icon: Bold, label: "bold", apply: (edit) => wrap(edit, "**") },
  { key: "italic", icon: Italic, label: "italic", apply: (edit) => wrap(edit, "_") },
  { key: "strike", icon: Strikethrough, label: "strike", apply: (edit) => wrap(edit, "~~") },
  { key: "code", icon: Code, label: "code", apply: (edit) => wrap(edit, "`") },
  { key: "fence", icon: SquareCode, label: "fence", apply: (edit) => wrap(edit, "```\n", "\n```") },
  { key: "link", icon: Link, label: "link", apply: (edit) => wrap(edit, "[", "](https://)") },
  { key: "list", icon: List, label: "list", apply: (edit) => prefixLines(edit, () => "- ") },
  {
    key: "numbered",
    icon: ListOrdered,
    label: "numbered",
    apply: (edit) => prefixLines(edit, (i) => `${i + 1}. `),
  },
  { key: "quote", icon: Quote, label: "quote", apply: (edit) => prefixLines(edit, () => "> ") },
];

export function Composer({
  quoting,
  onClearQuote,
  onSend,
  onTyping,
  dmAgentId,
  placeholder,
}: {
  quoting: Message | null;
  onClearQuote: () => void;
  onSend: (outgoing: Outgoing) => void;
  onTyping: () => void;
  dmAgentId?: string;
  placeholder: string;
}) {
  const t = useMessages("chat");
  const { channelId, people, me, directory } = useConversation();
  const authorName = useAuthorName();
  const [text, setText, discard] = useDraft(`chat:${channelId}`);
  const field = useRef<HTMLTextAreaElement>(null);
  const [caret, setCaret] = useState(0);
  const [dismissed, setDismissed] = useState<number | null>(null);
  const [active, setActive] = useState(0);
  const list = useId();
  const pending = useRef<{ start: number; end: number } | null>(null);

  const typed = mentionAt(text, caret);
  const choices =
    typed === null || dismissed === typed.from ? [] : mentionChoices(people, typed.query, me.userId);
  const open = choices.length > 0;
  const selected = Math.min(active, Math.max(0, choices.length - 1));

  // The field grows with its text up to the height the stylesheet allows, then scrolls.
  // biome-ignore lint/correctness/useExhaustiveDependencies: the height follows the text.
  useLayoutEffect(() => {
    const element = field.current;
    if (element === null) return;
    element.style.height = "auto";
    element.style.height = `${element.scrollHeight}px`;
    if (pending.current !== null) {
      element.setSelectionRange(pending.current.start, pending.current.end);
      setCaret(pending.current.end);
      pending.current = null;
    }
  }, [text]);

  const change = (next: string) => {
    setText(next);
    if (next.trim() !== "") onTyping();
  };

  const applyEdit = (edit: Edit) => {
    pending.current = { start: edit.start, end: edit.end };
    change(edit.text);
    field.current?.focus();
  };

  const current = (): Edit => {
    const element = field.current;
    return { text, start: element?.selectionStart ?? text.length, end: element?.selectionEnd ?? text.length };
  };

  const pick = (entry: DirectoryMember) => {
    if (typed === null) return;
    const insert = `@${handleOf(entry)} `;
    const next = text.slice(0, typed.from) + insert + text.slice(caret);
    const at = typed.from + insert.length;
    applyEdit({ text: next, start: at, end: at });
    setActive(0);
  };

  const send = () => {
    const body = text.trim();
    if (body === "") return;
    onSend({
      body,
      ...(quoting !== null && {
        replyTo: quoting.id,
        replyExcerpt: {
          author: quoting.author,
          authorName: authorName(quoting.author),
          excerpt: quoting.body.slice(0, QUOTE_LENGTH),
          messageId: quoting.id,
          threadId: quoting.threadId,
        },
      }),
    });
    setText("");
    discard();
    onClearQuote();
  };

  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.nativeEvent.isComposing) return;
    if (open) {
      if (event.key === "ArrowDown" || event.key === "ArrowUp") {
        event.preventDefault();
        const step = event.key === "ArrowDown" ? 1 : -1;
        setActive((selected + step + choices.length) % choices.length);
        return;
      }
      if (event.key === "Enter" || event.key === "Tab") {
        event.preventDefault();
        const entry = choices[selected];
        if (entry !== undefined) pick(entry);
        return;
      }
      if (event.key === "Escape") {
        event.preventDefault();
        if (typed !== null) setDismissed(typed.from);
        return;
      }
    }
    if ((event.metaKey || event.ctrlKey) && (event.key === "b" || event.key === "i")) {
      event.preventDefault();
      applyEdit(wrap(current(), event.key === "b" ? "**" : "_"));
      return;
    }
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      send();
    }
  };

  const answerers = answering(text, people, dmAgentId);

  return (
    <div className="chat-composer">
      {answerers.length > 0 && (
        <p className="chat-composer__answer">
          {answerers.map((agentId) => (
            <AgentSigil key={agentId} agentId={agentId} name={directory.agentName(agentId)} size="sm" />
          ))}
          <span>
            {t("composer.answering", {
              count: answerers.length,
              agents: answerers.map((agentId) => directory.agentName(agentId)).join(", "),
            })}
          </span>
        </p>
      )}
      {quoting !== null && (
        <div className="chat-composer__quote">
          <blockquote className="chat-quote">
            <span className="chat-quote__author">{authorName(quoting.author)}</span>
            <span className="chat-quote__text">{quoting.body.slice(0, QUOTE_LENGTH)}</span>
          </blockquote>
          <button
            type="button"
            className="chat-icon-button"
            aria-label={t("composer.dropQuote")}
            onClick={onClearQuote}
          >
            <Icon icon={X} size="sm" />
          </button>
        </div>
      )}
      {open && (
        <div className="chat-mentions" id={list} role="listbox" aria-label={t("composer.mentions")}>
          {choices.map((entry, index) => (
            <div
              key={`${entry.type}-${entry.id}`}
              id={`${list}-${index}`}
              role="option"
              tabIndex={-1}
              aria-selected={index === selected}
              className="chat-mentions__option"
              onMouseDown={(event) => {
                event.preventDefault();
                pick(entry);
              }}
            >
              {entry.type === "agent" ? (
                <AgentSigil agentId={entry.id} name="" size="sm" aria-hidden="true" />
              ) : (
                <Avatar name={entry.name} size="sm" aria-hidden="true" />
              )}
              <span>{entry.name}</span>
              <span className="chat-mentions__handle">@{handleOf(entry)}</span>
            </div>
          ))}
        </div>
      )}
      <div className="chat-composer__box">
        <textarea
          ref={field}
          className="chat-composer__field"
          rows={1}
          value={text}
          placeholder={placeholder}
          aria-label={placeholder}
          aria-autocomplete="list"
          aria-controls={open ? list : undefined}
          aria-activedescendant={open ? `${list}-${selected}` : undefined}
          onChange={(event) => {
            change(event.target.value);
            setCaret(event.target.selectionStart);
            setDismissed(null);
          }}
          onSelect={(event) => setCaret(event.currentTarget.selectionStart)}
          onKeyDown={onKeyDown}
        />
        <div className="chat-composer__bar">
          <div className="chat-composer__tools" role="toolbar" aria-label={t("composer.marks")}>
            {TOOLS.map((tool) => (
              <button
                key={tool.key}
                type="button"
                className="chat-icon-button"
                aria-label={t(`mark.${tool.label}`)}
                onMouseDown={(event) => event.preventDefault()}
                onClick={() => applyEdit(tool.apply(current()))}
              >
                <Icon icon={tool.icon} size="sm" />
              </button>
            ))}
            <Menu>
              <MenuTrigger asChild>
                <button type="button" className="chat-icon-button" aria-label={t("mark.emoji")}>
                  <Icon icon={Smile} size="sm" />
                </button>
              </MenuTrigger>
              <MenuContent className="chat-emoji">
                {EMOJI.map((emoji) => (
                  <MenuItem
                    key={emoji}
                    onSelect={() => {
                      const edit = current();
                      const next = edit.text.slice(0, edit.start) + emoji + edit.text.slice(edit.end);
                      const at = edit.start + emoji.length;
                      applyEdit({ text: next, start: at, end: at });
                    }}
                  >
                    {emoji}
                  </MenuItem>
                ))}
              </MenuContent>
            </Menu>
          </div>
          <button
            type="button"
            className="chat-composer__send"
            aria-label={t("composer.go")}
            disabled={text.trim() === ""}
            onClick={send}
          >
            <Icon icon={SendHorizontal} size="sm" />
          </button>
        </div>
      </div>
    </div>
  );
}
