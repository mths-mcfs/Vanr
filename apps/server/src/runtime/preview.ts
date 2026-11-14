// Preview of the exact effect on the approval card: whole text, final recipients,
// resolved links and diff. "Resolved" here is the real destination of each link, as the browser would open it:
// the href of `[text](url)` and of `<a href>` shows next to the text the reader sees. Redirects are not
// followed (no network in the gate).

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

/**
 * Line diff (LCS) in a short unified format: `+` new line, `-` removed line, `  ` unchanged.
 * Very large texts fall back to "everything out, everything in" instead of spending quadratic memory.
 */
export function lineDiff(before: string, after: string): string {
  const a = before.split("\n");
  const b = after.split("\n");
  if (a.length * b.length > 4_000_000)
    return [...a.map((l) => `- ${l}`), ...b.map((l) => `+ ${l}`)].join("\n");
  const n = a.length;
  const m = b.length;
  const lcs: Uint32Array[] = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
  for (let i = n - 1; i >= 0; i--) {
    const row = lcs[i] as Uint32Array;
    const next = lcs[i + 1] as Uint32Array;
    for (let j = m - 1; j >= 0; j--)
      row[j] =
        a[i] === b[j] ? (next[j + 1] as number) + 1 : Math.max(next[j] as number, row[j + 1] as number);
  }
  const out: string[] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      out.push(`  ${a[i]}`);
      i++;
      j++;
    } else if ((lcs[i + 1]?.[j] ?? 0) >= (lcs[i]?.[j + 1] ?? 0)) out.push(`- ${a[i++]}`);
    else out.push(`+ ${b[j++]}`);
  }
  while (i < n) out.push(`- ${a[i++]}`);
  while (j < m) out.push(`+ ${b[j++]}`);
  return out.join("\n");
}
