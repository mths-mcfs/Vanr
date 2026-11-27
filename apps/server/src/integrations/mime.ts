// Reading and building email messages (RFC 5322 + MIME): enough for the agent to read the text of a
// message and reply. HTML becomes plain text; attachments only show up by name.
import { HttpError } from "../http";

export interface ParsedMail {
  messageId: string | null;
  /** The From header as people read it (encoded words decoded). Never a sender's address: see `fromAddress`. */
  from: string;
  /** The sender's address, read from the raw header before any decoding (empty when there is none). */
  fromAddress: string;
  to: string[];
  cc: string[];
  subject: string;
  date: string | null;
  inReplyTo: string | null;
  references: string | null;
  text: string;
  attachments: string[];
}

/** Decodes in the message's charset; TextDecoder itself rejects an unknown label (falls back to UTF-8). */
function decode(bytes: Uint8Array, charset: string): string {
  const label = charset.trim().toLowerCase() === "utf8" ? "utf-8" : charset.trim().toLowerCase() || "utf-8";
  try {
    return new TextDecoder(label as "utf-8").decode(bytes);
  } catch {
    return Buffer.from(bytes).toString("utf8");
  }
}

function decodeWords(value: string): string {
  return value
    .replace(/\?=\s+=\?/g, "?==?")
    .replace(/=\?([^?]+)\?([bBqQ])\?([^?]*)\?=/g, (_, charset: string, enc: string, data: string) => {
      try {
        const bytes =
          enc.toUpperCase() === "B"
            ? Buffer.from(data, "base64")
            : Buffer.from(
                data
                  .replace(/_/g, " ")
                  .replace(/=([0-9A-Fa-f]{2})/g, (_m, h: string) => String.fromCharCode(parseInt(h, 16))),
                "latin1",
              );
        return decode(bytes, charset);
      } catch {
        return data;
      }
    });
}

function splitHead(raw: string): { headers: Map<string, string>; body: string } {
  const norm = raw.replace(/\r\n/g, "\n");
  const at = norm.indexOf("\n\n");
  const head = at === -1 ? norm : norm.slice(0, at);
  const body = at === -1 ? "" : norm.slice(at + 2);
  const headers = new Map<string, string>();
  let last = "";
  for (const line of head.split("\n")) {
    if (/^[ \t]/.test(line) && last) {
      headers.set(last, `${headers.get(last) ?? ""} ${line.trim()}`);
      continue;
    }
    const colon = line.indexOf(":");
    if (colon <= 0) continue;
    last = line.slice(0, colon).trim().toLowerCase();
    if (!headers.has(last)) headers.set(last, line.slice(colon + 1).trim());
  }
  return { headers, body };
}

function param(value: string, name: string): string | null {
  const m = new RegExp(`${name}\\*?=("([^"]*)"|[^;\\s]+)`, "i").exec(value);
  return m ? (m[2] ?? m[1] ?? "").replace(/^"|"$/g, "") : null;
}

function decodeBody(body: string, encoding: string, charset: string): string {
  const enc = encoding.toLowerCase();
  let bytes: Buffer;
  if (enc === "base64") bytes = Buffer.from(body.replace(/\s+/g, ""), "base64");
  else if (enc === "quoted-printable") {
    const soft = body.replace(/=\r?\n/g, "");
    const out: number[] = [];
    for (let i = 0; i < soft.length; i++) {
      const ch = soft[i];
      const hex = soft.slice(i + 1, i + 3);
      if (ch === "=" && /^[0-9A-Fa-f]{2}$/.test(hex)) {
        out.push(parseInt(hex, 16));
        i += 2;
      } else out.push(...Buffer.from(ch ?? "", "utf8"));
    }
    bytes = Buffer.from(out);
  } else bytes = Buffer.from(body, "utf8");
  return decode(bytes, charset);
}

const htmlToText = (html: string) =>
  html
    .replace(/<(script|style)[\s\S]*?<\/\1>/gi, "")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|li|tr|h\d)>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, "&")
    .replace(/\n{3,}/g, "\n\n")
    .trim();

/** Text of the part (recursive in multipart): prefers text/plain, falls back to converted HTML. */
function textOf(
  raw: string,
  attachments: string[],
  depth = 0,
): { plain: string | null; html: string | null } {
  const { headers, body } = splitHead(raw);
  const type = headers.get("content-type") ?? "text/plain";
  const encoding = headers.get("content-transfer-encoding") ?? "7bit";
  const disposition = headers.get("content-disposition") ?? "";
  const filename = param(disposition, "filename") ?? param(type, "name");
  if (/^multipart\//i.test(type) && depth < 5) {
    const boundary = param(type, "boundary");
    if (!boundary) return { plain: body, html: null };
    let plain: string | null = null;
    let html: string | null = null;
    for (const part of body.split(`--${boundary}`).slice(1)) {
      if (part.startsWith("--")) break;
      const got = textOf(part.replace(/^\n/, ""), attachments, depth + 1);
      plain ??= got.plain;
      html ??= got.html;
    }
    return { plain, html };
  }
  if (/attachment/i.test(disposition) || (filename && !/^text\//i.test(type))) {
    attachments.push(attachmentName(filename));
    return { plain: null, html: null };
  }
  const charset = param(type, "charset") ?? "utf-8";
  const decoded = decodeBody(body, encoding, charset);
  if (/^text\/html/i.test(type)) return { plain: null, html: decoded };
  if (/^text\//i.test(type)) return { plain: decoded, html: null };
  return { plain: null, html: null };
}

/**
 * An attachment's name as the sender wrote it, reduced to its last path part: the name comes from outside, and
 * whoever saves the file uses it (`../../etc/passwd` becomes `passwd`). Control characters go away.
 */
export function attachmentName(raw: string | null | undefined): string {
  // biome-ignore lint/suspicious/noControlCharactersInRegex: control characters are what is removed
  const decoded = decodeWords(raw ?? "").replace(/[\u0000-\u001f\u007f]/g, "");
  const base = decoded.split(/[/\\]/).pop()?.trim() ?? "";
  return base && base !== "." && base !== ".." ? base : "anexo";
}

/**
 * Only the addresses of a From/To/Cc header, one per mailbox. A display name (quoted or not) or a comment is text,
 * not a mailbox: in `"ana@ok.test" <eve@bad.test>` or `ana@ok.test <eve@bad.test>` the address is eve's.
 */
export function addresses(value: string | undefined): string[] {
  if (!value) return [];
  const out: string[] = [];
  // Without quoted strings and comments, a comma only separates mailboxes.
  // An angle address is kept whole (its local part may be quoted: `<"ana"@client.test>`).
  const bare = value.replace(/<[^>]*>|"(?:[^"\\]|\\.)*"|\([^()]*\)/g, (m) => (m.startsWith("<") ? m : " "));
  for (const mailbox of bare.split(",")) {
    // In `name <addr>` the address ends the mailbox: a display name can't add one after it.
    const angle = [...mailbox.matchAll(/<([^>]*)>/g)].at(-1);
    const addr = (angle ? angle[1] : mailbox.match(/[^\s,;:<>"]+@[^\s,;:<>"]+/)?.[0])?.trim().toLowerCase();
    if (addr) out.push(addr);
  }
  return out;
}

export function parseMail(raw: string): ParsedMail {
  const { headers } = splitHead(raw);
  const attachments: string[] = [];
  const { plain, html } = textOf(raw, attachments);
  return {
    messageId: headers.get("message-id") ?? null,
    from: decodeWords(headers.get("from") ?? ""),
    // From the raw header: a display name in encoded words decodes to anything, an allowed address included.
    fromAddress: addresses(headers.get("from"))[0] ?? "",
    to: addresses(headers.get("to")),
    cc: addresses(headers.get("cc")),
    subject: decodeWords(headers.get("subject") ?? ""),
    date: headers.get("date") ?? null,
    inReplyTo: headers.get("in-reply-to") ?? null,
    references: headers.get("references") ?? null,
    text: (plain ?? (html ? htmlToText(html) : "")).trim(),
    attachments,
  };
}

/**
 * A header value can't carry CR, LF or NUL: a line break starts a header of its own (a hidden Bcc), so the
 * value is rejected, not cleaned: whoever sent it has a bug or is attacking.
 */
export function assertHeaderValue(field: string, value: string) {
  if (/[\r\n]/.test(value) || value.includes("\0"))
    throw new HttpError(400, "invalid_mail_header", `The ${field} field has a line break`, { field });
}

const encodeWord = (s: string) =>
  /^[\x20-\x7e]*$/.test(s) ? s : `=?UTF-8?B?${Buffer.from(s, "utf8").toString("base64")}?=`;

/** Builds a UTF-8 text message (base64 body, 76-character lines). */
export function buildMail(input: {
  from: string;
  to: readonly string[];
  cc?: readonly string[];
  subject: string;
  text: string;
  date: Date;
  messageId: string;
  inReplyTo?: string | null;
  references?: string | null;
}): string {
  assertHeaderValue("from", input.from);
  for (const a of input.to) assertHeaderValue("to", a);
  for (const a of input.cc ?? []) assertHeaderValue("cc", a);
  assertHeaderValue("subject", input.subject);
  assertHeaderValue("message-id", input.messageId);
  if (input.inReplyTo) assertHeaderValue("in-reply-to", input.inReplyTo);
  if (input.references) assertHeaderValue("references", input.references);
  const body = Buffer.from(input.text, "utf8").toString("base64").replace(/.{76}/g, "$&\r\n");
  const lines = [
    `From: ${input.from}`,
    `To: ${input.to.join(", ")}`,
    ...(input.cc?.length ? [`Cc: ${input.cc.join(", ")}`] : []),
    `Subject: ${encodeWord(input.subject)}`,
    `Date: ${input.date.toUTCString().replace("GMT", "+0000")}`,
    `Message-ID: ${input.messageId}`,
    ...(input.inReplyTo ? [`In-Reply-To: ${input.inReplyTo}`] : []),
    ...(input.references ? [`References: ${input.references}`] : []),
    "MIME-Version: 1.0",
    "Content-Type: text/plain; charset=utf-8",
    "Content-Transfer-Encoding: base64",
    "",
    body,
  ];
  return lines.join("\r\n");
}
