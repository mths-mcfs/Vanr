// What the files area's screens share: names for the people and agents behind an item, dates and
// sizes in the interface language, the query's words marked in a snippet, and the glyph of each kind.

import { useQueryClient } from "@tanstack/react-query";
import { type KeyPrefix, prefixKey, useApiQuery, useVanrClient } from "@vanr/client/react";
import type { ActorRef, FileKind } from "@vanr/contract";
import { Code, FileDiff, FileText, type LucideIcon, Paperclip, Table2, Workflow } from "lucide-react";
import { useCallback, useMemo } from "react";
import { useLocale, useMessages } from "../../i18n/react.tsx";
import { useClock } from "../../platform/clock.tsx";

export const FILE_KINDS: readonly FileKind[] = ["document", "table", "diff", "diagram", "html", "file"];

export const KIND_ICON: Record<FileKind, LucideIcon> = {
  document: FileText,
  table: Table2,
  diff: FileDiff,
  diagram: Workflow,
  html: Code,
  file: Paperclip,
};

/** Names and searches are cut at 200 characters, as the server does. */
export const TITLE_MAX = 200;
/** A written document holds up to a million characters. */
export const DOCUMENT_MAX = 1_000_000;

/** The name of whoever made or changed something: a member or an agent. */
export function useActorName(workspaceId: string): (actor: ActorRef) => string {
  const t = useMessages("files");
  const members = useApiQuery("listMembers", { workspaceId });
  const agents = useApiQuery("listAgents", { workspaceId });
  return useMemo(() => {
    const names = new Map<string, string>();
    for (const member of members.data ?? []) names.set(`person:${member.userId}`, member.name);
    for (const agent of agents.data ?? []) names.set(`agent:${agent.id}`, agent.name);
    return (actor: ActorRef) => names.get(`${actor.type}:${actor.id}`) ?? t("actor.unknown");
  }, [members.data, agents.data, t]);
}

const UNITS: [Intl.RelativeTimeFormatUnit, number][] = [
  ["year", 365 * 86_400_000],
  ["month", 30 * 86_400_000],
  ["week", 7 * 86_400_000],
  ["day", 86_400_000],
  ["hour", 3_600_000],
  ["minute", 60_000],
];

/** "3 hours ago", "in 2 days": the distance from now in the largest unit that fits. */
export function relativeTime(iso: string, now: number, locale: string): string {
  const delta = Date.parse(iso) - now;
  const format = new Intl.RelativeTimeFormat(locale, { numeric: "auto" });
  for (const [unit, ms] of UNITS) {
    if (Math.abs(delta) >= ms) return format.format(Math.round(delta / ms), unit);
  }
  return format.format(0, "minute");
}

/** "1.5 MB": a size in bytes in the largest unit that keeps it above one. */
export function formatBytes(bytes: number, locale: string): string {
  const units = ["byte", "kilobyte", "megabyte", "gigabyte"] as const;
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return new Intl.NumberFormat(locale, {
    style: "unit",
    unit: units[unit],
    unitDisplay: "short",
    maximumFractionDigits: unit === 0 ? 0 : 1,
  }).format(value);
}

/** The relative time of a date, kept current with the app's clock. */
export function useRelativeTime(): (iso: string) => string {
  const { locale } = useLocale();
  const clock = useClock();
  return (iso) => relativeTime(iso, clock.now(), locale);
}

const fold = (text: string) =>
  text
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .toLowerCase();

/**
 * The text cut into the parts that match a word of the query and the parts that don't. Matching
 * ignores case and accents; operators such as `from:` and `-word` are not words to mark.
 */
export function highlightParts(text: string, query: string): { text: string; hit: boolean }[] {
  const words = query
    .split(/\s+/)
    .map((word) => word.replace(/^"|"$/g, ""))
    .filter((word) => word.length >= 2 && !word.startsWith("-") && !/^[a-z]+:/i.test(word))
    .map(fold);
  if (words.length === 0) return [{ text, hit: false }];
  const folded = fold(text);
  // Folding can change the length (a decomposed letter); fall back to no marks then.
  if (folded.length !== text.length) return [{ text, hit: false }];
  const marks = new Array<boolean>(text.length).fill(false);
  for (const word of words) {
    for (let at = folded.indexOf(word); at !== -1; at = folded.indexOf(word, at + word.length)) {
      marks.fill(true, at, at + word.length);
    }
  }
  const parts: { text: string; hit: boolean }[] = [];
  for (let i = 0; i < text.length; i++) {
    const last = parts.at(-1);
    if (last !== undefined && last.hit === marks[i]) last.text += text[i];
    else parts.push({ text: text[i] ?? "", hit: marks[i] ?? false });
  }
  return parts;
}

/** A snippet with the query's words marked. */
export function Marked({ text, query }: { text: string; query: string }) {
  return (
    <>
      {highlightParts(text, query).map((part, index) =>
        part.hit ? (
          <mark key={index} className="files-mark">
            {part.text}
          </mark>
        ) : (
          <span key={index}>{part.text}</span>
        ),
      )}
    </>
  );
}

/** Refetches what a change made stale, named by method and arguments as in `invalidates`. */
export function useRefetch(): (prefixes: readonly KeyPrefix[]) => Promise<void> {
  const client = useVanrClient();
  const queries = useQueryClient();
  return useCallback(
    async (prefixes) => {
      await Promise.all(
        prefixes.map((prefix) => queries.invalidateQueries({ queryKey: prefixKey(client, prefix) })),
      );
    },
    [client, queries],
  );
}
