// Name normalization: channels, handles and wiki slugs follow the same rule.

/** Lowercase, without accents. */
export function fold(text: string): string {
  return text
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .toLowerCase();
}

/** Kept as they are in a channel name or handle; everything else outside whitespace is dropped. */
const isNameChar = (c: string) => (c >= "a" && c <= "z") || (c >= "0" && c <= "9") || c === "-" || c === "_";
const isSeparator = (c: string) => c === "-" || c === "_";
const WHITESPACE = /\s/;

/**
 * One pass over the folded text. Each run of whitespace becomes a single "-", but only once something
 * follows it (so the ends behave as if trimmed); characters outside a-z0-9_- vanish; nothing starts
 * with "-" or "_". `trailing: false` also removes the "-"/"_" left at the end, before the length cut.
 */
function nameChars(input: string, opts: { max: number; trailing: boolean }): string {
  let out = "";
  let gap = false;
  for (const c of fold(input)) {
    if (WHITESPACE.test(c)) {
      gap = true;
      continue;
    }
    if (gap && out) out += "-";
    gap = false;
    if (isNameChar(c) && (out || !isSeparator(c))) out += c;
  }
  if (!opts.trailing) {
    let end = out.length;
    while (end > 0 && isSeparator(out[end - 1] as string)) end--;
    out = out.slice(0, end);
  }
  return out.slice(0, opts.max);
}

/** Channel name: lowercase, no accents, spaces become "-", only a-z0-9_-, up to 80. */
export function channelName(input: string): string {
  return nameChars(input, { max: 80, trailing: true });
}

/** Handle of a person or agent from their name: a-z0-9_- and 2 to 32 characters. */
export function handleFrom(input: string): string {
  const base = nameChars(input, { max: 32, trailing: false });
  return base.length >= 2 ? base : `${base}xx`.slice(0, 2);
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
