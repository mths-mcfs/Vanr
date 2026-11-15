// Preview of the exact effect on the approval card: whole text, final recipients,
// resolved links and diff. "Resolved" here is the real destination of each link, as the browser would open it:
// the href of `[text](url)` and of `<a href>` shows next to the text the reader sees. Redirects are not
// followed (no network in the gate).
import { diffArrays } from "diff";

const MD_LINK = /\[([^\]\n]{0,300})\]\((\S{1,2000}?)(?:\s+"[^"]*")?\)/g;
const HTML_LINK = /<a\s[^>]*?href\s*=\s*["']([^"']{1,2000})["'][^>]*>([\s\S]{0,300}?)<\/a>/gi;
const BARE = /\bhttps?:\/\/[^\s<>()"'\]]{1,2000}/gi;

function hostOf(url: string): string | null {
  try {
    return new URL(url).host.toLowerCase();
  } catch {
    return null;
  }
}

/**
 * Links of the text with their real destination. A link whose text looks like another address is marked as
 * "text → destination", so the person sees that `[bank.com](http://other.site)` goes somewhere else.
 */
export function linksIn(text: string): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  const add = (label: string, href: string) => {
    const host = hostOf(href);
    const shown = label.trim();
    const shownHost = hostOf(shown.startsWith("http") ? shown : `https://${shown}`);
    const misleading =
      host !== null && shown !== href && shownHost !== null && /\./.test(shown) && shownHost !== host;
    const line = misleading ? `${shown} → ${href}` : href;
    if (!seen.has(line)) {
      seen.add(line);
      out.push(line);
    }
  };
  const covered: [number, number][] = [];
  for (const m of text.matchAll(MD_LINK)) {
    add(m[1] ?? "", m[2] ?? "");
    covered.push([m.index ?? 0, (m.index ?? 0) + m[0].length]);
  }
  for (const m of text.matchAll(HTML_LINK)) {
    add((m[2] ?? "").replace(/<[^>]*>/g, ""), m[1] ?? "");
    covered.push([m.index ?? 0, (m.index ?? 0) + m[0].length]);
  }
  for (const m of text.matchAll(BARE)) {
    const at = m.index ?? 0;
    if (covered.some(([a, b]) => at >= a && at < b)) continue;
    add(m[0], m[0].replace(/[.,;:!?]+$/, ""));
  }
  return out;
}

/** Above this many line pairs, the diff is skipped: the whole text goes out and the new one comes in. */
const DIFF_MAX_PAIRS = 4_000_000;

const MARK = { added: "+ ", removed: "- ", same: "  " } as const;

/**
 * Line diff in a short unified format: `+` new line, `-` removed line, `  ` unchanged. The lines are compared
 * whole (the `diff` package's array diff, a minimal edit script). Very large texts fall back to
 * "everything out, everything in" instead of spending the time.
 */
export function lineDiff(before: string, after: string): string {
  const oldLines = before.split("\n");
  const newLines = after.split("\n");
  const changes =
    oldLines.length * newLines.length > DIFF_MAX_PAIRS
      ? [
          { removed: true, added: false, value: oldLines },
          { removed: false, added: true, value: newLines },
        ]
      : diffArrays(oldLines, newLines);
  return changes
    .flatMap((change) => {
      const mark = change.added ? MARK.added : change.removed ? MARK.removed : MARK.same;
      return change.value.map((line) => mark + line);
    })
    .join("\n");
}
