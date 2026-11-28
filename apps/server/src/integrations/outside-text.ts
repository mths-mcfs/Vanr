// The one door for text that comes from an outside service (an MCP server, Composio, an OAuth or GitHub
// endpoint, an IMAP or SMTP server) on its way into an error the person sees or a log line. A service can echo
// what we sent it, so every secret of that connection is taken out, in the forms it travels in (plain, base64,
// base64url, percent-encoded), then control characters go and the text is cut to a fixed length.

/** The longest outside text kept in an error or a log line. */
export const OUTSIDE_TEXT_MAX = 300;
const REDACTED = "[redacted]";

/**
 * The forms a secret travels in: as is, base64, base64url, percent-encoded (both hex cases) and form-encoded
 * (a space as `+`, as a query string re-serialized by `URLSearchParams` carries it).
 */
function forms(secret: string): string[] {
  const encoded = encodeURIComponent(secret);
  const form = encoded.replace(/%20/g, "+");
  const lower = (text: string) => text.replace(/%[0-9A-F]{2}/g, (m) => m.toLowerCase());
  return [
    secret,
    Buffer.from(secret).toString("base64"),
    Buffer.from(secret).toString("base64").replace(/=+$/, ""),
    Buffer.from(secret).toString("base64url"),
    encoded,
    lower(encoded),
    form,
    lower(form),
  ];
}

/**
 * The message of `raw` (an error or anything thrown) safe to show and to log: without the connection's
 * `secrets`, without control characters, at most OUTSIDE_TEXT_MAX characters.
 */
export function outsideText(raw: unknown, secrets: ReadonlyArray<string | null | undefined>): string {
  let text = raw instanceof Error ? raw.message : String(raw);
  const all = new Set<string>();
  for (const s of secrets) if (s) for (const f of forms(s)) if (f) all.add(f);
  // Longest first, so a secret inside a longer one doesn't leave the rest behind.
  for (const f of [...all].sort((a, b) => b.length - a.length)) text = text.split(f).join(REDACTED);
  // biome-ignore lint/suspicious/noControlCharactersInRegex: control characters are what this removes
  text = text.replace(/[\u0000-\u001f\u007f-\u009f]+/g, " ").trim();
  return text.length > OUTSIDE_TEXT_MAX ? `${text.slice(0, OUTSIDE_TEXT_MAX - 1)}…` : text;
}
