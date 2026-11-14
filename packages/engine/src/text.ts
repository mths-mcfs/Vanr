// Name normalization: channels, handles and wiki slugs follow the same rule.

/** Lowercase, without accents. */
export function fold(text: string): string {
  return text
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .toLowerCase();
}

/** Channel name: lowercase, no accents, spaces become "-", only a-z0-9_-, up to 80. */
export function channelName(input: string): string {
  return fold(input)
    .trim()
    .replace(/\s+/g, "-")
    .replace(/[^a-z0-9_-]/g, "")
    .replace(/^[-_]+/, "")
    .slice(0, 80);
}

/** Handle of a person or agent from their name: a-z0-9_- and 2 to 32 characters. */
export function handleFrom(input: string): string {
  const base = fold(input)
    .trim()
    .replace(/\s+/g, "-")
    .replace(/[^a-z0-9_-]/g, "")
    .replace(/^[-_]+|[-_]+$/g, "")
    .slice(0, 32);
  return base.length >= 2 ? base : `${base || "x"}x`.slice(0, 2);
}

export const HANDLE_RE = /^[a-z0-9][a-z0-9_-]{1,31}$/;

/** Wiki slug: lowercase, no accents, everything else becomes "-", no "-" at either end. */
export function slugify(input: string): string {
  return fold(input)
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

/** First free handle: base, base-2, base-3... */
export function uniqueHandle(base: string, taken: ReadonlySet<string>): string {
  if (!taken.has(base)) return base;
  for (let i = 2; ; i++) {
    const candidate = `${base.slice(0, 29)}-${i}`;
    if (!taken.has(candidate)) return candidate;
  }
}

/** Handles mentioned with @ in the text, lowercased and without repeats. Skips emails (a@b.com). */
export function parseMentions(body: string): string[] {
  const found = new Set<string>();
  for (const m of body.matchAll(/(?<![\p{L}\p{N}_@.-])@([a-z0-9][a-z0-9_-]{1,31})(?![a-z0-9_-])/giu)) {
    const handle = m[1];
    if (handle) found.add(handle.toLowerCase());
  }
  return [...found];
}
