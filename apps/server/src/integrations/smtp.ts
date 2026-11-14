// Minimal SMTP sending (RFC 5321): EHLO, STARTTLS when the port asks for it, AUTH PLAIN, MAIL, RCPT and DATA.
import { connect as netConnect, type Socket } from "node:net";
import { type TLSSocket, connect as tlsConnect } from "node:tls";
import { PRODUCT } from "@vanr/product";

export class SmtpError extends Error {
  constructor(
    message: string,
    readonly kind: "auth" | "unreachable" | "rejected" | "protocol" = "protocol",
  ) {
    super(message);
  }
}

export interface SmtpOptions {
  host: string;
  /** IP already checked to connect to (`host` stays the TLS name). */
  address?: string;
  port: number;
  /** `tls`: TLS from the start (465). `starttls`: upgrades to TLS after EHLO (587). `none`: tests. */
  security: "tls" | "starttls" | "none";
  user: string;
  password: string;
  timeoutMs?: number;
}

class Conn {
  private buffer = "";
  private waiters: (() => void)[] = [];
  private closed = false;

  constructor(readonly socket: Socket | TLSSocket) {
    socket.setEncoding("utf8");
    socket.on("data", (chunk: string) => {
      this.buffer += chunk;
      for (const w of this.waiters.splice(0)) w();
    });
    const end = () => {
      this.closed = true;
      for (const w of this.waiters.splice(0)) w();
    };
    socket.on("close", end);
    socket.on("error", end);
  }

  /** Reads a whole reply (`250-...` lines up to the `250 ...` one). */
  async reply(): Promise<{ code: number; text: string }> {
    const lines: string[] = [];
    for (;;) {
      const at = this.buffer.indexOf("\r\n");
      if (at < 0) {
        if (this.closed) throw new SmtpError("Connection closed", "protocol");
        await new Promise<void>((r) => this.waiters.push(r));
        continue;
      }
      const line = this.buffer.slice(0, at);
      this.buffer = this.buffer.slice(at + 2);
      lines.push(line.slice(4));
      if (line[3] !== "-") return { code: Number(line.slice(0, 3)), text: lines.join("\n") };
    }
  }

  async send(line: string, expect: number[], what: string, kind: SmtpError["kind"] = "protocol") {
    this.socket.write(`${line}\r\n`);
    const r = await this.reply();
    if (!expect.includes(r.code)) throw new SmtpError(`${what}: ${r.code} ${r.text}`, kind);
    return r;
  }
}

function open(opts: SmtpOptions, socket?: Socket): Promise<Socket | TLSSocket> {
  return new Promise((resolve, reject) => {
    const s = socket
      ? tlsConnect({ socket, servername: opts.host })
      : opts.security === "tls"
        ? tlsConnect({ host: opts.address ?? opts.host, port: opts.port, servername: opts.host })
        : netConnect({ host: opts.address ?? opts.host, port: opts.port });
    s.setTimeout(opts.timeoutMs ?? 15_000, () => s.destroy());
    const timer = setTimeout(() => {
      s.destroy();
      reject(new SmtpError("Mail server did not answer in time", "unreachable"));
    }, opts.timeoutMs ?? 15_000);
    s.once(socket || opts.security === "tls" ? "secureConnect" : "connect", () => {
      clearTimeout(timer);
      resolve(s);
    });
    s.once("error", (err) => {
      clearTimeout(timer);
      reject(new SmtpError(`Could not reach the mail server: ${err.message}`, "unreachable"));
    });
  });
}

/** A lone dot on a line ends DATA: lines that start with a dot get another one. */
export const dotStuff = (raw: string) => raw.replace(/\r?\n/g, "\r\n").replace(/^\./gm, "..");

export async function smtpSend(
  opts: SmtpOptions,
  envelope: { from: string; to: readonly string[] },
  raw: string,
): Promise<void> {
  let conn = new Conn(await open(opts));
  try {
    const greet = await conn.reply();
    if (greet.code !== 220) throw new SmtpError(`Greeting: ${greet.code}`, "protocol");
    let ehlo = await conn.send(`EHLO ${PRODUCT.slug}.local`, [250], "EHLO");
    if (opts.security === "starttls") {
      if (!/STARTTLS/i.test(ehlo.text)) throw new SmtpError("Server does not offer STARTTLS", "protocol");
      await conn.send("STARTTLS", [220], "STARTTLS");
      conn.socket.setTimeout(0);
      conn = new Conn(await open(opts, conn.socket as Socket));
      ehlo = await conn.send(`EHLO ${PRODUCT.slug}.local`, [250], "EHLO");
    }
    const plain = Buffer.from(`\u0000${opts.user}\u0000${opts.password}`).toString("base64");
    await conn.send(`AUTH PLAIN ${plain}`, [235], "AUTH", "auth");
    await conn.send(`MAIL FROM:<${envelope.from}>`, [250], "MAIL FROM", "rejected");
    for (const to of envelope.to) await conn.send(`RCPT TO:<${to}>`, [250, 251], "RCPT TO", "rejected");
    await conn.send("DATA", [354], "DATA");
    await conn.send(`${dotStuff(raw)}\r\n.`, [250], "message", "rejected");
    await conn.send("QUIT", [221], "QUIT").catch(() => {});
  } finally {
    conn.socket.destroy();
  }
}
