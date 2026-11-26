import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sealSecret } from "@vanr/contract";
import { schema } from "@vanr/engine/db";
import { newId } from "@vanr/engine/ids";
import {
  BROWSER_GUARD_FEATURE,
  connectUrl,
  type ExecResult,
  type HelloFrame,
  type ListResult,
  type ReadResult,
  RUNNER_PROTOCOL,
} from "@vanr/engine/runner-protocol";
import { PRODUCT } from "@vanr/product";
import { RunnerClient } from "@vanr/runner/client";
import { RUNNER_VERSION, readConfig, writeConfig } from "@vanr/runner/config";
import { type DeviceStart, pair } from "@vanr/runner/pair";
import { sandboxOff } from "@vanr/runner/sandbox";
import { SecretStore } from "@vanr/runner/secrets";
import { eq } from "drizzle-orm";
import { createWorkspace, joinWorkspace } from "../src/members";
import { RunnerCallError } from "../src/runners/hub";
import { installScript } from "../src/runners/install";
import type { RunningServer } from "../src/server";
import { type Browser, SERVER_TEST_MS, signedIn, startTestServer, TestSocket } from "./harness";

// Runners end to end: the real runner pairs by code, connects to the runners' WebSocket and serves the server's
// requests. It includes the two problems of the original this step fixes: secrets written in the clear on disk
// and an install.sh that didn't check the download. The workspace is created with members.createWorkspace and the
// agent is a row in the database (the workspaces and agents routes come with slices S4 and S5).
let server: RunningServer;
const clients: RunnerClient[] = [];
beforeAll(async () => {
  server = await startTestServer();
}, SERVER_TEST_MS);
afterAll(async () => {
  for (const r of clients) await r.stop();
  await server.stop();
}, SERVER_TEST_MS);

let n = 0;
const email = (who: string) => `${who}${++n}@runners.test`;

/** A request through the browser: the status and the JSON body (the shape is what each test checks). */
async function api(b: Browser, method: string, path: string, payload?: unknown) {
  const res = await b.json(path, method, payload);
  const text = await res.text();
  // biome-ignore lint/suspicious/noExplicitAny: in tests the body is checked by the assertions
  const body: any = text ? JSON.parse(text) : null;
  return { status: res.status, body };
}

/** Polls until `ok` holds: what it waits on is the runner process reacting, not the clock. */
async function until<T>(read: () => T | Promise<T>, ok: (v: T) => boolean, ms = 10_000): Promise<T> {
  const end = Date.now() + ms;
  for (;;) {
    const v = await read();
    if (ok(v)) return v;
    if (Date.now() > end) throw new Error(`timed out; last value: ${JSON.stringify(v)}`);
    await new Promise((r) => setTimeout(r, 25));
  }
}

/** Ana owns the workspace; Beto is a member; Lia is an agent whose owner is Ana. */
async function team() {
  const ana = await signedIn(server, "Ana", email("ana"));
  const { workspaceId } = await createWorkspace(server.deps.db, {
    name: "Workshop",
    context: "",
    user: ana.user,
  });
  const beto = await signedIn(server, "Beto", email("beto"));
  await joinWorkspace(server.deps.db, { workspaceId, userId: beto.user.id, name: "Beto", role: "member" });
  const lia = { id: newId("agt"), handle: "lia" };
  await server.deps.db.insert(schema.agents).values({
    id: lia.id,
    workspaceId,
    name: "Lia",
    handle: lia.handle,
    role: "support",
    model: "claude-haiku-5-5",
    ownerUserId: ana.user.id,
    appearance: { color: "blue", eyes: "dot", adornment: "none" },
  });
  return { workspaceId, ana, beto, lia, ws: `/api/v1/workspaces/${workspaceId}` };
}

type Team = Awaited<ReturnType<typeof team>>;

/** Pairs a new runner folder (or the same one, to reconnect) confirming through Ana's browser. */
async function pairRunner(t: Team, home: string, name = "Notebook") {
  // biome-ignore lint/suspicious/noExplicitAny: the pairing page's body, checked by the tests
  let confirmed: Promise<any> = Promise.resolve();
  const config = await pair({
    server: server.url,
    home,
    name,
    workDir: join(home, "work"),
    print: () => {},
    onCode: (start: DeviceStart) => {
      confirmed = (async () => {
        const seen = await api(
          t.ana.browser,
          "GET",
          `/api/v1/runner-pairings/${start.userCode.toLowerCase()}`,
        );
        expect(seen.status).toBe(200);
        const ok = await api(
          t.ana.browser,
          "POST",
          `${t.ws}/runner-pairings/${seen.body.userCode}/confirm`,
          {},
        );
        expect(ok.status).toBe(200);
        return seen.body;
      })();
    },
    sleep: async () => {
      await confirmed;
    },
  });
  return { config, seen: await confirmed };
}

async function connect(home: string) {
  const client = new RunnerClient({
    sandbox: sandboxOff(),
    home,
    executors: [],
    browser: null,
    backoffBaseMs: 50,
  });
  clients.push(client);
  client.start();
  // Settled with the server: after the welcome of the real hello (the first one stays neutral until the
  // runner knows its secrets).
  await client.ready();
  return client;
}

const call = <T>(
  runnerId: string,
  op: Parameters<RunningServer["deps"]["runners"]["call"]>[1],
  args: object,
  agent: { id: string; handle: string },
) => server.deps.runners.call(runnerId, op, args as never, { agent }) as Promise<T>;

async function callError(p: Promise<unknown>): Promise<RunnerCallError> {
  try {
    await p;
  } catch (err) {
    if (err instanceof RunnerCallError) return err;
    throw err;
  }
  throw new Error("expected RunnerCallError, call succeeded");
}

function filesUnder(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...filesUnder(p));
    else out.push(p);
  }
  return out;
}

const runnersOf = async (t: Team, who = t.ana) =>
  (await api(who.browser, "GET", `${t.ws}/runners`)).body.runners;

describe("runners", () => {
  test(
    "CLI grants and equivalent access keep an operation running; a reduction cancels it",
    async () => {
      const t = await team();
      const home = mkdtempSync(join(tmpdir(), "runner-access-"));
      const { config } = await pairRunner(t, home);
      const folder = { path: join(home, "shared"), agents: [t.lia.id] };
      config.access.folders = [folder];
      config.access.tools.claude = false;
      writeConfig(home, config);
      const runner = await connect(home);
      const socket = await TestSocket.open(t.ana.browser, t.workspaceId);
      const root = runner.access.agentRoot(t.lia);
      let finished = false;
      const ready = Promise.withResolvers<void>();
      const running = server.deps.runners
        .call(
          config.runnerId,
          "exec",
          { command: "echo ready; while [ ! -f release ]; do sleep 0.02; done", timeoutSeconds: 15 },
          { agent: t.lia, onOutput: () => ready.resolve() },
        )
        .catch((err) => err.code)
        .finally(() => {
          finished = true;
        });
      try {
        await ready.promise;
        // Tool, folder and audience grants arrive through the real runner's config poller.
        const extra = { path: join(home, "extra"), agents: [] };
        const granted = {
          ...config.access,
          tools: { ...config.access.tools, claude: true },
          folders: [{ ...folder, agents: [] }, extra],
        };
        for (const access of [granted, { ...granted, folders: [...granted.folders].reverse() }]) {
          const current = readConfig(home);
          if (!current) throw new Error("config missing");
          writeConfig(home, { ...current, access });
          await socket.event("runner.access");
          expect(finished).toBe(false);
        }
        // Commands and this agent's folder access remain allowed; narrowing the audience cancels old work.
        const current = readConfig(home);
        if (!current) throw new Error("config missing");
        writeConfig(home, { ...current, access: { ...granted, folders: [folder, extra] } });
        await socket.event("runner.access");
        expect(await running).toBe("canceled");
      } finally {
        writeFileSync(join(root, "release"), "");
        await runner.stop();
        await running;
        socket.close();
        await socket.closed;
      }
    },
    SERVER_TEST_MS,
  );

  test(
    "pair by code, connect, lend to the agent, run a command, work with files and remove",
    async () => {
      const t = await team();
      const home = mkdtempSync(join(tmpdir(), "runner-"));
      const { config, seen } = await pairRunner(t, home);
      expect(seen.reconnect).toBeNull();
      expect(config.runnerId).toStartWith("rnr_");
      expect(config.token).toStartWith("rrt_");
      expect(config.workspaceId).toBe(t.workspaceId);

      // The database keeps only the token's hash and the secrets key sealed.
      const [row] = await server.deps.db
        .select()
        .from(schema.runners)
        .where(eq(schema.runners.id, config.runnerId));
      expect(row?.tokenHash).toBe(createHash("sha256").update(config.token).digest("hex"));
      expect(JSON.stringify(row)).not.toContain(config.token);

      // A used code doesn't work again.
      const used = await api(t.ana.browser, "GET", `/api/v1/runner-pairings/${seen.userCode}`);
      expect(used.body.error.code).toBe("runner.pairing_invalid");

      const runner = await connect(home);
      const [listed] = await runnersOf(t);
      expect(listed).toMatchObject({
        id: config.runnerId,
        online: true,
        manageable: true,
        pairedByUserId: t.ana.user.id,
      });
      expect((await runnersOf(t, t.beto))[0]?.manageable).toBe(false);
      expect(
        (await api(t.beto.browser, "PATCH", `${t.ws}/runners/${config.runnerId}`, { name: "Mine" })).status,
      ).toBe(403);
      expect(
        (await api(t.ana.browser, "PATCH", `${t.ws}/runners/${config.runnerId}`, { name: "Ana's laptop" }))
          .body,
      ).toEqual({ id: config.runnerId, name: "Ana's laptop" });

      // Lending it to the agent: the runner learns which agents use it.
      const target = `${t.ws}/agents/${t.lia.id}/environment/target`;
      expect((await api(t.beto.browser, "PUT", target, { runnerId: config.runnerId })).status).toBe(403);
      expect((await api(t.ana.browser, "PUT", target, { runnerId: config.runnerId })).body).toEqual({
        kind: "runner",
        runnerId: config.runnerId,
        name: "Ana's laptop",
        online: true,
      });
      const environment = `${t.ws}/agents/${t.lia.id}/environment`;
      expect((await api(t.ana.browser, "GET", environment)).body.status).toBe("running");
      await until(
        () => runner.agents.map((a) => a.handle),
        (h) => h.includes("lia"),
      );
      expect((await api(t.ana.browser, "POST", `${environment}/stop`)).body.status).toBe("stopped");
      expect((await api(t.ana.browser, "POST", `${environment}/start`)).body.status).toBe("running");

      const agent = t.lia;
      const ran = await call<ExecResult>(config.runnerId, "exec", { command: "pwd && echo hi" }, agent);
      expect(ran.exitCode).toBe(0);
      expect(ran.stdout).toContain(join(home, "work", `lia-${t.lia.id.slice(-8)}`));
      expect(ran.stdout).toContain("hi");
      await call(config.runnerId, "write", { path: "notes/a.txt", content: "first" }, agent);
      await call(
        config.runnerId,
        "write",
        { path: "notes/a.txt", content: " and second", append: true },
        agent,
      );
      expect((await call<ReadResult>(config.runnerId, "read", { path: "notes/a.txt" }, agent)).content).toBe(
        "first and second",
      );
      const files = await call<ListResult>(config.runnerId, "list", { path: "notes" }, agent);
      expect(files.entries.map((e) => e.name)).toEqual(["a.txt"]);
      expect((await callError(call(config.runnerId, "read", { path: "/etc/hostname" }, agent))).code).toBe(
        "not_allowed",
      );
      expect((await callError(call(config.runnerId, "read", { path: "../outside.txt" }, agent))).code).toBe(
        "outside_work_dir",
      );

      // Reducing access from the app: the runner's config decides, and it changes there.
      const reduced = await api(t.ana.browser, "POST", `${t.ws}/runners/${config.runnerId}/access/reduce`, {
        disableTool: "commands",
      });
      expect(reduced.status).toBe(200);
      expect(reduced.body.access.tools.commands).toBe(false);
      expect(JSON.parse(readFileSync(join(home, "config.json"), "utf8")).access.tools.commands).toBe(false);
      expect((await callError(call(config.runnerId, "exec", { command: "echo hi" }, agent))).code).toBe(
        "exec_disabled",
      );
      expect((await runnersOf(t))[0]?.shellAllowed).toBe(false);

      // Paused from the CLI (`pause` writes the config): the runner tells and the app shows the runner paused.
      const cfg = readConfig(home);
      if (!cfg) throw new Error("config missing");
      writeConfig(home, { ...cfg, paused: true });
      await until(
        async () => (await runnersOf(t))[0]?.paused,
        (paused) => paused === true,
      );
      writeConfig(home, { ...cfg, paused: false });
      await until(
        async () => (await runnersOf(t))[0]?.paused,
        (paused) => paused === false,
      );

      // Offline: it shows in the outages with the agent that depends on it.
      expect((await api(t.ana.browser, "GET", `${t.ws}/runners/outages`)).body.outages).toEqual([]);
      await runner.stop();
      await until(
        () => server.deps.runners.isOnline(config.runnerId),
        (on) => !on,
      );
      const outages = await api(t.ana.browser, "GET", `${t.ws}/runners/outages`);
      expect(outages.body.outages).toMatchObject([
        { runnerId: config.runnerId, agentIds: [t.lia.id], waitingJobs: 0 },
      ]);
      expect((await api(t.ana.browser, "POST", `${environment}/start`)).body.error.code).toBe(
        "runner.offline",
      );

      // Removed: the runner is rejected on the next connection and the agent is left without a runner.
      const again = await connect(home);
      expect((await api(t.ana.browser, "DELETE", `${t.ws}/runners/${config.runnerId}`)).status).toBe(204);
      expect(await again.exited).toBe("revoked");
      expect(await runnersOf(t)).toEqual([]);
      expect((await api(t.ana.browser, "GET", environment)).body.status).toBe("none");
      const late = new RunnerClient({ sandbox: sandboxOff(), home, executors: [], browser: null });
      clients.push(late);
      late.start();
      expect(await late.exited).toBe("revoked");
    },
    SERVER_TEST_MS,
  );

  test(
    "denying the code and pairing the same runner again keeps the runner",
    async () => {
      const t = await team();
      const home = mkdtempSync(join(tmpdir(), "runner-"));
      const first = await pairRunner(t, home);

      // A denied request: the runner gets access_denied.
      let denied: Promise<unknown> = Promise.resolve();
      const rejected = pair({
        server: server.url,
        home: mkdtempSync(join(tmpdir(), "runner-")),
        print: () => {},
        onCode: (s) => {
          denied = api(t.ana.browser, "POST", `/api/v1/runner-pairings/${s.userCode}/deny`);
        },
        sleep: async () => {
          await denied;
        },
      });
      await expect(rejected).rejects.toMatchObject({ code: "access_denied" });

      // Who doesn't manage the runner (Beto neither paired it nor configures) doesn't see "Reconnect": confirming
      // as him would create another runner. Ana, who paired it, sees it.
      // biome-ignore lint/suspicious/noExplicitAny: the pairing page's body, checked below
      let betoSaw: Promise<any> = Promise.resolve();
      const byBeto = pair({
        server: server.url,
        home,
        print: () => {},
        onCode: (s) => {
          betoSaw = (async () => {
            const seen = await api(t.beto.browser, "GET", `/api/v1/runner-pairings/${s.userCode}`);
            await api(t.beto.browser, "POST", `/api/v1/runner-pairings/${s.userCode}/deny`);
            return seen.body;
          })();
        },
        sleep: async () => {
          await betoSaw;
        },
      });
      await expect(byBeto).rejects.toMatchObject({ code: "access_denied" });
      expect((await betoSaw).reconnect).toBeNull();

      const second = await pairRunner(t, home);
      expect(second.seen.reconnect).toEqual({ runnerId: first.config.runnerId, workspaceId: t.workspaceId });
      expect(second.config.runnerId).toBe(first.config.runnerId);
      expect(second.config.token).not.toBe(first.config.token);
      expect(await runnersOf(t)).toHaveLength(1);

      // The old token stopped working.
      const runner = await connect(home);
      expect(runner.runnerId).toBe(first.config.runnerId);
      await runner.stop();
    },
    SERVER_TEST_MS,
  );

  test(
    "secrets stay encrypted on the runner, go only to the command and come out masked",
    async () => {
      const t = await team();
      const home = mkdtempSync(join(tmpdir(), "runner-"));
      const { config } = await pairRunner(t, home);
      let runner = await connect(home);
      await api(t.ana.browser, "PUT", `${t.ws}/agents/${t.lia.id}/environment/target`, {
        runnerId: config.runnerId,
      });
      const agent = t.lia;
      const value = "super-secret-value-123";

      const deliver = async (requestId: string, name: string, target: string, sealedFor = name) => {
        const { publicKey } = await call<{ publicKey: string }>(
          config.runnerId,
          "secret.prepare",
          { requestId },
          agent,
        );
        const box = await sealSecret(publicKey, value, {
          requestId,
          workspaceId: t.workspaceId,
          name: sealedFor,
          target,
        });
        return call(
          config.runnerId,
          "secret.store",
          { requestId, workspaceId: t.workspaceId, name, target, box },
          agent,
        );
      };

      // A box sealed for another name doesn't open (the browser binds the value to the request).
      expect((await callError(deliver("sr_wrong", "API_TOKEN", "env", "OTHER"))).code).toBe("bad_request");
      expect(await deliver("sr_env", "API_TOKEN", "env")).toEqual({ stored: true });
      expect(await deliver("sr_file", "KEY", "file:.cred/key.txt")).toEqual({ stored: true });

      // No file of the runner has the value in the clear (nor the key that opens the store).
      for (const file of filesUnder(home)) expect(readFileSync(file, "utf8")).not.toContain(value);
      const storeKey = await server.deps.db
        .select({ k: schema.runners.storeKey })
        .from(schema.runners)
        .where(eq(schema.runners.id, config.runnerId));
      expect(storeKey[0]?.k).toBeTruthy();
      expect(await new SecretStore(home).values(agent).catch((e: Error) => e.message)).toMatch(/locked|key/i);

      const ran = await call<ExecResult>(
        config.runnerId,
        "exec",
        { command: `test "$API_TOKEN" = ${value} && echo same; echo "$API_TOKEN"; cat .cred/key.txt` },
        agent,
      );
      expect(ran.stdout).toContain("same");
      expect(ran.stdout).toContain("[secret:API_TOKEN]");
      expect(ran.stdout).not.toContain(value);
      const root = join(home, "work", `lia-${t.lia.id.slice(-8)}`);
      expect(existsSync(join(root, ".cred/key.txt"))).toBe(false);
      expect(await call(config.runnerId, "secret.list", {}, agent)).toMatchObject({
        secrets: [
          { name: "API_TOKEN", target: "env" },
          { name: "KEY", target: "file" },
        ],
      });

      // Restarted, the runner gets the key from the server again and the secret still holds.
      await runner.stop();
      runner = await connect(home);
      const after = await call<ExecResult>(
        config.runnerId,
        "exec",
        { command: `test "$API_TOKEN" = ${value} && echo ok` },
        agent,
      );
      expect(after.stdout.trim()).toBe("ok");
      expect(await call(config.runnerId, "secret.remove", { name: "KEY" }, agent)).toEqual({ removed: true });
      await runner.stop();
    },
    SERVER_TEST_MS,
  );

  test(
    "a runner without the browser guard (browser.guard.1) gets no browser",
    async () => {
      const t = await team();
      const home = mkdtempSync(join(tmpdir(), "runner-"));
      const { config } = await pairRunner(t, home);
      // A runner from before the proxy and the rule-before-load says it has a browser, but doesn't send the
      // feature. Protocol 2: the hello carries a single-use session taken with the runner's credential, and each
      // session swaps the credential (the old one, reused, revokes the runner).
      let credential = config.token;
      const helloWith = async (features: string[]) => {
        const minted = await fetch(`${server.url}/api/v1/runners/session`, {
          method: "POST",
          headers: { authorization: `Bearer ${credential}`, "content-type": "application/json" },
          body: JSON.stringify({ protocol: RUNNER_PROTOCOL, version: RUNNER_VERSION }),
        });
        const fresh = (await minted.json()) as { session: string; credential: string };
        credential = fresh.credential;
        const ws = new WebSocket(connectUrl(server.url));
        const welcome = new Promise<void>((resolve, reject) => {
          ws.onmessage = (ev) => {
            if (JSON.parse(String(ev.data)).type === "welcome") resolve();
          };
          ws.onclose = () => reject(new Error("closed before welcome"));
        });
        await new Promise((r) => {
          ws.onopen = r;
        });
        const hello: HelloFrame = {
          type: "hello",
          session: fresh.session,
          version: RUNNER_VERSION,
          protocol: RUNNER_PROTOCOL,
          os: "linux",
          arch: "x64",
          hostname: "old",
          workDir: null,
          paused: false,
          access: config.access,
          browser: true,
          executors: [],
          cli: {},
          jobs: [],
          features,
          sandbox: sandboxOff().status(),
        };
        ws.send(JSON.stringify(hello));
        await welcome;
        const gone = new Promise((r) => {
          ws.onclose = r;
        });
        ws.close();
        await gone;
        const [row] = await server.deps.db
          .select({ browser: schema.runners.browser })
          .from(schema.runners)
          .where(eq(schema.runners.id, config.runnerId));
        return row?.browser;
      };
      expect(await helloWith([])).toBe(false);
      expect(await helloWith([BROWSER_GUARD_FEATURE])).toBe(true);
    },
    SERVER_TEST_MS,
  );

  test("the install.sh checks the runner's sha256 and rejects a tampered download", async () => {
    const script = await (await fetch(`${server.url}/api/v1/runners/install.sh`)).text();
    const sha = /BUNDLE_SHA256='([0-9a-f]{64})'/.exec(script)?.[1];
    const res = await fetch(`${server.url}/runner/${PRODUCT.runnerName}.mjs`);
    const bytes = new Uint8Array(await res.arrayBuffer());
    expect(createHash("sha256").update(bytes).digest("hex")).toBe(sha as string);
    expect(res.headers.get("x-content-sha256")).toBe(sha as string);

    // Asynchronous: the script downloads from this same process (spawnSync would hang the test server).
    const run = async (text: string, home: string) => {
      const proc = Bun.spawn(["sh", "-s", "--", "--no-pair", "--no-service"], {
        stdin: new TextEncoder().encode(text),
        stdout: "pipe",
        stderr: "pipe",
        env: { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: home },
      });
      const [out, err] = await Promise.all([
        new Response(proc.stdout).text(),
        new Response(proc.stderr).text(),
      ]);
      return { code: await proc.exited, out, err };
    };

    const home = mkdtempSync(join(tmpdir(), "install-"));
    const ok = await run(script, home);
    expect(ok.err).toBe("");
    expect(ok.code).toBe(0);
    const bin = join(home, PRODUCT.runnerDir, "bin", PRODUCT.runnerName);
    const version = Bun.spawn([bin, "version"], {
      stdout: "pipe",
      env: { PATH: process.env.PATH ?? "", HOME: home },
    });
    expect(await new Response(version.stdout).text()).toMatch(/\d+\.\d+\.\d+/);

    // A proxy on the way flips a byte of the bundle: the script rejects it and installs nothing.
    const tampered = Bun.serve({
      port: 0,
      fetch: () => {
        const copy = bytes.slice();
        copy[copy.length - 2] = (copy[copy.length - 2] ?? 0) ^ 1;
        return new Response(copy);
      },
    });
    try {
      const bad = mkdtempSync(join(tmpdir(), "install-"));
      const fail = await run(
        installScript({ server: `http://localhost:${tampered.port}`, sha256: sha as string }),
        bad,
      );
      expect(fail.code).toBe(1);
      expect(fail.err).toContain("checksum mismatch");
      expect(filesUnder(join(bad, PRODUCT.runnerDir))).toEqual([]);
    } finally {
      tampered.stop(true);
    }
  }, 60_000);
});
