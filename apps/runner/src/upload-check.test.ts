import { afterAll, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Access, RunnerError } from "./access";
import { CdpBrowser } from "./cdp";
import { readOp } from "./ops";
import { sandboxOff } from "./sandbox";
import type { SecretStore } from "./secrets";

// A reserved file does not leave through the browser: the upload passes the same check as read_file (the
// agent's folders, the secret files, a symlink by its target), before any command to the browser.
const dir = mkdtempSync(join(tmpdir(), "runner-upload-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const agent = { id: "agt_0000000012345678", handle: "lia" };
const tools = { claude: false, codex: false, commands: true, browser: true };
const access = new Access(() => ({
  access: { folders: [], tools },
  workDir: join(dir, "ws"),
  paused: false,
}));
const root = access.agentRoot(agent);
const secretFile = join(root, "creds", "key.pem");
mkdirSync(join(root, "creds"), { recursive: true });
writeFileSync(secretFile, "-----BEGIN PRIVATE KEY-----\n");
writeFileSync(join(root, "report.pdf"), "pdf");
const outside = join(dir, "outside.txt");
writeFileSync(outside, "outside");
symlinkSync(secretFile, join(root, "innocent.txt"));
symlinkSync(outside, join(root, "out-link.txt"));
const secrets = {
  secretFiles: () => [secretFile],
  masks: async () => [],
  values: async () => [],
} as unknown as SecretStore;

/** A browser with one agent session whose CDP connection records every command it gets. */
function browserRecording() {
  const b = Object.create(CdpBrowser.prototype) as Record<string, unknown>;
  const commands: string[] = [];
  const session = {
    agent,
    policy: { driver: "agent" },
    pages: [{ sessionId: "s" }],
    active: 0,
    cdp: {
      send: async (method: string) => {
        commands.push(method);
        return { result: { objectId: "o1", value: true } };
      },
    },
  };
  Object.assign(b, { opts: { access, secrets } });
  const upload = (path: string) =>
    (Reflect.get(b, "act") as (...a: unknown[]) => Promise<unknown>).call(b, session, {
      action: "upload",
      text: path,
      selector: "#f",
    });
  return { upload, commands };
}

const codeOf = (p: Promise<unknown>) =>
  p.then(
    () => "ok",
    (e: unknown) => (e instanceof RunnerError ? e.code : String(e)),
  );

test("the upload refuses what read_file refuses, before any command reaches the browser", async () => {
  const ctx = {
    access,
    secrets,
    sandbox: sandboxOff(),
    policy: { home: dir, runnerHome: join(dir, "home"), uid: 0, path: "" },
    agent,
    signal: new AbortController().signal,
  };
  for (const path of [
    secretFile,
    "creds/key.pem",
    "innocent.txt",
    "out-link.txt",
    outside,
    "../../x",
    "missing",
  ]) {
    const { upload, commands } = browserRecording();
    const read = await codeOf(readOp(ctx, { path }));
    const sent = await codeOf(upload(path));
    expect({ path, sent }).toEqual({ path, sent: read });
    expect(sent).not.toBe("ok");
    expect({ path, commands }).toEqual({ path, commands: [] });
  }
});

test("an allowed file passes the check and the upload goes on to the page", async () => {
  const { upload, commands } = browserRecording();
  await codeOf(upload("report.pdf"));
  // Past the check, the action talks to the page (the fake page here does not answer the rest of it).
  expect(commands.length).toBeGreaterThan(0);
});
