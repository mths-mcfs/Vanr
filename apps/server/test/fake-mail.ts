// Fake IMAP and SMTP servers, but real ones: local TCP, no TLS, in-memory mailbox. The email
// tests point the account at them (host 127.0.0.1, a port the system picked).
import { createServer, type Server, type Socket } from "node:net";

export interface FakeMessage {
  uid: number;
  flags: string[];
  raw: string;
  date: Date;
}

export interface FakeMailServer {
  host: string;
  imapPort: number;
  smtpPort: number;
  user: string;
  password: string;
  folders: Map<string, { special: string | null; messages: FakeMessage[]; nextUid: number }>;
  sent: { from: string; to: string[]; raw: string }[];
  deliver(folder: string, raw: string, date?: Date): number;
  stop(): void;
}

const listen = (server: Server) =>
  new Promise<number>((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      resolve(typeof addr === "object" && addr ? addr.port : 0);
    });
  });

const unquote = (s: string) => (s.startsWith('"') ? s.slice(1, -1).replace(/\\(.)/g, "$1") : s);

/** Tokens of an IMAP line: atoms, "strings" and (lists) as text. */
function tokens(line: string): string[] {
  const out: string[] = [];
  let i = 0;
  while (i < line.length) {
    if (line[i] === " ") {
      i++;
      continue;
    }
    if (line[i] === '"') {
      let j = i + 1;
      while (j < line.length && line[j] !== '"') j += line[j] === "\\" ? 2 : 1;
      out.push(line.slice(i, j + 1));
      i = j + 1;
      continue;
    }
    if (line[i] === "(") {
      let depth = 0;
      let j = i;
      for (; j < line.length; j++) {
        if (line[j] === "(") depth++;
        if (line[j] === ")" && --depth === 0) break;
      }
      out.push(line.slice(i, j + 1));
      i = j + 1;
      continue;
    }
    let j = i;
    while (j < line.length && line[j] !== " ") j++;
    out.push(line.slice(i, j));
    i = j;
  }
  return out;
}

const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];
const parseDate = (s: string) => {
  const [d, m, y] = s.split("-");
  return new Date(Date.UTC(Number(y), MONTHS.indexOf((m ?? "").toLowerCase()), Number(d)));
};

function matches(msg: FakeMessage, criteria: string[]): boolean {
  const lower = msg.raw.toLowerCase();
  const head = lower.slice(0, lower.indexOf("\r\n\r\n") === -1 ? undefined : lower.indexOf("\r\n\r\n"));
  for (let i = 0; i < criteria.length; i++) {
    const key = (criteria[i] ?? "").toUpperCase();
    const arg = criteria[i + 1] ?? "";
    if (key === "ALL") continue;
    if (key === "UNSEEN") {
      if (msg.flags.includes("\\Seen")) return false;
      continue;
    }
    i++;
    if (key === "UID") {
      const [a, b] = arg.split(":");
      const lo = Number(a);
      const hi = b === "*" ? Number.POSITIVE_INFINITY : Number(b ?? a);
      if (msg.uid < lo || msg.uid > hi) return false;
    } else if (key === "SINCE") {
      if (msg.date < parseDate(arg)) return false;
    } else if (key === "FROM") {
      if (!/^from:.*$/m.exec(head)?.[0].includes(unquote(arg).toLowerCase())) return false;
    } else if (key === "SUBJECT") {
      if (!/^subject:.*$/m.exec(head)?.[0].includes(unquote(arg).toLowerCase())) return false;
    } else if (key === "TEXT") {
      if (!lower.includes(unquote(arg).toLowerCase())) return false;
    }
  }
  return true;
}

export async function startFakeMail(
  options: { move?: boolean; uidPlus?: boolean } = {},
): Promise<FakeMailServer> {
  const user = "lia@workshop.test";
  const password = "app-password";
  const folders: FakeMailServer["folders"] = new Map([
    ["INBOX", { special: null, messages: [], nextUid: 1 }],
    ["Sent", { special: "\\Sent", messages: [], nextUid: 1 }],
    ["Drafts", { special: "\\Drafts", messages: [], nextUid: 1 }],
    ["Trash", { special: "\\Trash", messages: [], nextUid: 1 }],
    ["Archive", { special: "\\Archive", messages: [], nextUid: 1 }],
  ]);
  const sent: FakeMailServer["sent"] = [];
  const deliver = (folder: string, raw: string, date = new Date()) => {
    const box = folders.get(folder);
    if (!box) throw new Error(`no folder ${folder}`);
    const uid = box.nextUid++;
    box.messages.push({ uid, flags: [], raw: raw.replace(/\r?\n/g, "\r\n"), date });
    return uid;
  };

  const imap = createServer((socket: Socket) => {
    let buffer = Buffer.alloc(0);
    let authed = false;
    let selected: string | null = null;
    let pendingAppend: { tag: string; folder: string; size: number } | null = null;
    const send = (s: string) => socket.write(`${s}\r\n`);
    send("* OK fake IMAP ready");
    const handle = (line: string) => {
      const [tag = "*", rawCmd = "", ...rest] = tokens(line);
      let cmd = rawCmd.toUpperCase();
      let args = rest;
      if (cmd === "UID") {
        cmd = `UID ${(args[0] ?? "").toUpperCase()}`;
        args = args.slice(1);
      }
      if (cmd === "CAPABILITY") {
        send(`* CAPABILITY IMAP4rev1${options.uidPlus ? " UIDPLUS" : ""}`);
        return send(`${tag} OK capabilities`);
      }
      if (cmd === "LOGOUT") {
        send("* BYE");
        send(`${tag} OK bye`);
        socket.end();
        return;
      }
      if (cmd === "LOGIN") {
        authed = unquote(args[0] ?? "") === user && unquote(args[1] ?? "") === password;
        send(authed ? `${tag} OK logged in` : `${tag} NO [AUTHENTICATIONFAILED] bad credentials`);
        return;
      }
      if (!authed) return send(`${tag} NO not authenticated`);
      if (cmd === "LIST") {
        for (const [name, box] of folders) {
          send(`* LIST (\\HasNoChildren${box.special ? ` ${box.special}` : ""}) "/" "${name}"`);
        }
        return send(`${tag} OK LIST done`);
      }
      if (cmd === "SELECT" || cmd === "EXAMINE") {
        const name = unquote(args[0] ?? "");
        const box = folders.get(name);
        if (!box) return send(`${tag} NO no such folder`);
        selected = name;
        send(`* ${box.messages.length} EXISTS`);
        send("* OK [UIDVALIDITY 7] ok");
        return send(`${tag} OK [READ-WRITE] selected`);
      }
      if (cmd === "APPEND") {
        const size = Number(/\{(\d+)\}$/.exec(line)?.[1] ?? 0);
        pendingAppend = { tag, folder: unquote(args[0] ?? ""), size };
        return send("+ go ahead");
      }
      const box = selected ? folders.get(selected) : undefined;
      if (!box) return send(`${tag} NO select first`);
      if (cmd === "UID SEARCH") {
        const uids = box.messages.filter((m) => matches(m, args)).map((m) => m.uid);
        send(`* SEARCH${uids.length ? ` ${uids.join(" ")}` : ""}`);
        return send(`${tag} OK search done`);
      }
      if (cmd === "UID FETCH") {
        const set = new Set((args[0] ?? "").split(",").map(Number));
        box.messages.forEach((m, i) => {
          if (!set.has(m.uid)) return;
          const max = Number(/<0\.(\d+)>/.exec(line)?.[1] ?? 1e9);
          const body = Buffer.from(m.raw).subarray(0, max);
          socket.write(
            `* ${i + 1} FETCH (UID ${m.uid} FLAGS (${m.flags.join(" ")}) BODY[]<0> {${body.length}}\r\n`,
          );
          socket.write(body);
          socket.write(")\r\n");
        });
        return send(`${tag} OK fetch done`);
      }
      if (cmd === "UID STORE") {
        const msg = box.messages.find((m) => m.uid === Number(args[0]));
        const flags = (args[2] ?? "").replace(/[()]/g, "").split(/\s+/).filter(Boolean);
        if (msg) msg.flags = [...new Set([...msg.flags, ...flags])];
        return send(`${tag} OK stored`);
      }
      if (cmd === "UID COPY") {
        const msg = box.messages.find((m) => m.uid === Number(args[0]));
        const to = folders.get(unquote(args[1] ?? ""));
        if (!msg || !to) return send(`${tag} NO cannot copy`);
        to.messages.push({ ...msg, uid: to.nextUid++ });
        return send(`${tag} OK copied`);
      }
      if (cmd === "UID EXPUNGE" && options.uidPlus) {
        box.messages = box.messages.filter(
          (m) => m.uid !== Number(args[0]) || !m.flags.includes("\\Deleted"),
        );
        return send(`${tag} OK expunged`);
      }
      if (cmd === "UID MOVE") {
        if (options.move === false) return send(`${tag} BAD MOVE unavailable`);
        const at = box.messages.findIndex((m) => m.uid === Number(args[0]));
        const to = folders.get(unquote(args[1] ?? ""));
        if (at < 0 || !to) return send(`${tag} NO cannot move`);
        const [msg] = box.messages.splice(at, 1);
        if (msg) to.messages.push({ ...msg, uid: to.nextUid++ });
        return send(`${tag} OK moved`);
      }
      if (cmd === "EXPUNGE") {
        box.messages = box.messages.filter((m) => !m.flags.includes("\\Deleted"));
        return send(`${tag} OK expunged`);
      }
      send(`${tag} BAD unknown command`);
    };
    socket.on("data", (chunk: Buffer) => {
      buffer = Buffer.concat([buffer, chunk]);
      for (;;) {
        if (pendingAppend) {
          if (buffer.length < pendingAppend.size + 2) return;
          const raw = buffer.subarray(0, pendingAppend.size).toString("utf8");
          buffer = buffer.subarray(pendingAppend.size + 2);
          const { tag, folder } = pendingAppend;
          pendingAppend = null;
          if (folders.has(folder)) {
            const uid = deliver(folder, raw);
            const msg = folders.get(folder)?.messages.find((m) => m.uid === uid);
            if (msg) msg.flags = ["\\Seen"];
            send(`${tag} OK appended`);
          } else send(`${tag} NO no such folder`);
          continue;
        }
        const at = buffer.indexOf("\r\n");
        if (at < 0) return;
        const line = buffer.subarray(0, at).toString("utf8");
        buffer = buffer.subarray(at + 2);
        handle(line);
      }
    });
    socket.on("error", () => {});
  });

  const smtp = createServer((socket: Socket) => {
    let buffer = "";
    let inData = false;
    let authed = false;
    let from = "";
    let to: string[] = [];
    const send = (s: string) => socket.write(`${s}\r\n`);
    send("220 fake SMTP ready");
    socket.setEncoding("utf8");
    socket.on("data", (chunk: string) => {
      buffer += chunk;
      for (;;) {
        if (inData) {
          const end = buffer.indexOf("\r\n.\r\n");
          if (end < 0) return;
          const raw = buffer.slice(0, end).replace(/^\.\./gm, ".");
          buffer = buffer.slice(end + 5);
          inData = false;
          sent.push({ from, to, raw });
          send("250 queued");
          continue;
        }
        const at = buffer.indexOf("\r\n");
        if (at < 0) return;
        const line = buffer.slice(0, at);
        buffer = buffer.slice(at + 2);
        const upper = line.toUpperCase();
        if (upper.startsWith("EHLO")) {
          send("250-fake");
          send("250 AUTH PLAIN");
        } else if (upper.startsWith("AUTH PLAIN ")) {
          const [, u, p] = Buffer.from(line.slice(11), "base64").toString("utf8").split("\u0000");
          authed = u === user && p === password;
          send(authed ? "235 ok" : "535 bad credentials");
        } else if (!authed) send("530 auth first");
        else if (upper.startsWith("MAIL FROM:")) {
          from = /<([^>]*)>/.exec(line)?.[1] ?? "";
          to = [];
          send("250 ok");
        } else if (upper.startsWith("RCPT TO:")) {
          to.push(/<([^>]*)>/.exec(line)?.[1] ?? "");
          send("250 ok");
        } else if (upper === "DATA") {
          inData = true;
          send("354 go");
        } else if (upper === "QUIT") {
          send("221 bye");
          socket.end();
        } else send("502 not implemented");
      }
    });
    socket.on("error", () => {});
  });

  const [imapPort, smtpPort] = await Promise.all([listen(imap), listen(smtp)]);
  return {
    host: "127.0.0.1",
    imapPort,
    smtpPort,
    user,
    password,
    folders,
    sent,
    deliver,
    stop() {
      imap.close();
      smtp.close();
    },
  };
}
