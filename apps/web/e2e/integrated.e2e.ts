// The integrated journey: one run across the areas, with two people in their own browsers and an agent
// on the fake model. The owner signs up, names a workspace, makes an agent and invites a member, who
// accepts on a tablet. They talk in #general, the owner approves the agent's post to #announce, closes an
// assignment, runs a routine, and puts a file, a wiki page, a debate, an issue and an event where the
// member finds them through the tablet's navigation drawer. Last, the real runner CLI pairs with the
// workspace and comes online for both of them.
import { type ChildProcess, spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Page } from "@playwright/test";
import { expect, type Text, test } from "./fixtures.ts";
import { browserOf, card, dayRegion, lane } from "./helpers.ts";

const RUNNER_ENTRY = join(import.meta.dirname, "../../runner/src/main.ts");
/** Narrower than the docked sidebar's 900 px: the navigation is a drawer, as on a tablet. */
const TABLET = { width: 820, height: 1180 };
const PRINT_MS = 30_000;

type Area = "assignments" | "calendar" | "debates" | "files" | "issues" | "wiki";

/** Opens an area through the navigation drawer, the way a person on a tablet gets there. */
async function openArea(tab: Page, t: Text, area: Area) {
  await tab.getByRole("button", { name: t("shell", "sidebar.open") }).click();
  const drawer = tab.getByRole("dialog", { name: t("shell", "sidebar.label") });
  // A count beside the area changes its name to "<area>, <n> waiting".
  await drawer.getByRole("link", { name: new RegExp(`^${t("shell", `route.${area}`)}(,|$)`) }).click();
  await expect(drawer).toHaveCount(0);
}

/**
 * The real runner CLI (`vanr-runner <args>`) in its own process. Its config and work folder live in
 * `home`, so it never reads or writes the machine's own runner.
 */
function runnerCli(home: string, args: string[]) {
  const child: ChildProcess = spawn("bun", [RUNNER_ENTRY, ...args], {
    cwd: home,
    stdio: ["ignore", "pipe", "pipe"],
    // VANR_RUNNER_HOME is where the CLI keeps its config (see apps/runner/src/config.ts).
    env: { PATH: process.env.PATH, HOME: home, VANR_RUNNER_HOME: join(home, "config") },
  });
  let output = "";
  const listeners = new Set<() => void>();
  const take = (chunk: Buffer) => {
    output += chunk.toString("utf8");
    for (const listener of listeners) listener();
  };
  child.stdout?.on("data", take);
  child.stderr?.on("data", take);
  const exited = new Promise<number | null>((resolve) => child.once("close", (code) => resolve(code)));
  return {
    exited,
    output: () => output,
    /** The first match of `pattern` in what the runner printed; fails if it exits or stays quiet. */
    printed(pattern: RegExp): Promise<RegExpMatchArray> {
      return new Promise((resolve, reject) => {
        const done = () => {
          clearTimeout(timer);
          listeners.delete(check);
        };
        const check = () => {
          const match = output.match(pattern);
          if (match === null) return;
          done();
          resolve(match);
        };
        const timer = setTimeout(() => {
          done();
          reject(new Error(`the runner did not print ${pattern} in ${PRINT_MS} ms:\n${output}`));
        }, PRINT_MS);
        listeners.add(check);
        check();
        void exited.then((code) => {
          if (!listeners.has(check)) return;
          done();
          reject(new Error(`the runner exited (${code}) before it printed ${pattern}:\n${output}`));
        });
      });
    },
    async stop() {
      if (child.exitCode !== null || child.signalCode !== null) return;
      child.kill("SIGTERM");
      await exited;
    },
  };
}

test("from sign-up to a paired runner: an owner and a member work across the areas with an agent", async ({
  page,
  browser,
  server,
  locale,
  t,
  seedUser,
  signIn,
  apiAs,
}) => {
  // Every area in one run, with the agent's runs, a 30 s send window and a runner pairing in it.
  test.setTimeout(300_000);
  const owner = await seedUser();
  const member = await seedUser();
  const workspace = "Kiln Works";
  const today = new Date();

  // The owner names the workspace they just signed up for.
  await signIn(owner);
  await page.goto("/");
  await expect(page.getByRole("heading", { level: 1, name: t("account", "workspace.title") })).toBeVisible();
  await page.getByLabel(t("account", "workspace.name")).fill(workspace);
  await page.getByRole("button", { name: t("account", "workspace.submit") }).click();
  await expect(page.getByRole("heading", { level: 1, name: workspace })).toBeVisible();
  await expect(page).toHaveURL(/\/workspace\/[^/]+$/);
  const workspaceId = new URL(page.url()).pathname.split("/").pop() ?? "";
  const home = `/workspace/${workspaceId}`;
  const base = `/api/v1/workspaces/${workspaceId}`;
  const ownerApi = await apiAs(owner);
  const { channels } = (await (await ownerApi.get(`${base}/channels`)).json()) as {
    channels: { id: string; isGeneral: boolean }[];
  };
  const general = channels.find((channel) => channel.isGeneral)?.id ?? "";
  const made = await ownerApi.post(`${base}/channels`, { data: { name: "announce", visibility: "public" } });
  expect(made.ok()).toBe(true);
  const announce = ((await made.json()) as { id: string }).id;

  // An agent, step by step, in #general and #announce. The fake model reads its debate position here.
  await page.goto(`${home}/agents`);
  await page.getByRole("button", { name: t("agents", "team.add") }).click();
  const next = () => page.getByRole("button", { name: t("agents", "new.next") }).click();
  await expect(
    page.getByRole("form", {
      name: t("agents", "new.stepOf", { at: 1, total: 6, step: t("agents", "new.step.role") }),
    }),
  ).toBeVisible();
  await page.getByRole("button", { name: new RegExp(`^${t("agents", "role.support")}`) }).click();
  await next();
  await page.getByLabel(t("agents", "field.name"), { exact: true }).fill("Kiln Bot");
  await expect(page.getByLabel(t("agents", "field.handle"))).toHaveValue("kiln-bot");
  await next();
  await page
    .getByRole("textbox", { name: t("agents", "field.instructions") })
    .fill("Keep the studio's notes. [[debate:Yes|Yes]]");
  await next();
  await expect(page.getByRole("checkbox", { name: "#general" })).toBeChecked();
  await page.getByRole("checkbox", { name: "#announce" }).click();
  await next();
  await expect(page.getByRole("combobox", { name: t("agents", "field.model") })).not.toBeEmpty();
  await next();
  await page.getByRole("button", { name: t("agents", "new.create") }).click();
  await expect(
    page.getByRole("heading", { name: t("agents", "new.created", { name: "Kiln Bot" }) }),
  ).toBeVisible();

  // The owner invites the member by email; the member opens the link on a tablet and accepts.
  await page.goto(`${home}/settings/members`);
  const form = page.getByRole("form", { name: t("settings", "members.inviteHeading") });
  await form.getByLabel(t("settings", "members.emails")).fill(member.email);
  await form.getByRole("button", { name: t("settings", "members.invite", { count: 1 }) }).click();
  const results = page.getByRole("list", { name: t("settings", "members.results"), exact: true });
  const link = (await results.getByText(/\/invite\//).textContent()) ?? "";
  const tablet = await browserOf(browser, server, await apiAs(member), locale, TABLET);
  const runnerHome = await mkdtemp(join(tmpdir(), "vanr-e2e-runner-"));
  const started: ReturnType<typeof runnerCli>[] = [];
  try {
    const theirs = await tablet.newPage();
    await theirs.goto(new URL(link).pathname);
    await expect(
      theirs.getByRole("heading", { name: t("account", "invite.title", { workspace }) }),
    ).toBeVisible();
    await theirs.getByRole("button", { name: t("account", "invite.accept.submit") }).click();
    await expect(theirs.getByRole("heading", { level: 1, name: workspace })).toBeVisible();
    await expect(theirs).toHaveURL(new RegExp(`${home}$`));
    expect((await (await apiAs(member)).post(`${base}/channels/${announce}/join`)).ok()).toBe(true);

    // They talk in #general, each seeing the other's message without a reload.
    const post = "The kiln is fired on Friday.";
    await page.goto(`${home}/channel/${general}`);
    await theirs.goto(`${home}/channel/${general}`);
    const composer = (tab: Page) =>
      tab.getByRole("textbox", { name: t("chat", "composer.hintChannel", { channel: "general" }) });
    const directive = JSON.stringify({ channel: "#announce", text: post });
    await composer(page).fill(`@kiln-bot tell them [[tool:post_message ${directive}]]`);
    await composer(page).press("Enter");
    const theirLog = theirs.getByRole("log", { name: t("chat", "history.label") });
    await expect(theirLog.getByText(/tell them/)).toBeVisible();
    await composer(theirs).fill("I will load it on Thursday.");
    await composer(theirs).press("Enter");
    const ownLog = page.getByRole("log", { name: t("chat", "history.label") });
    await expect(ownLog.getByText("I will load it on Thursday.")).toBeVisible();

    // The agent asks to post in #announce; the owner approves it from the card in the conversation.
    // The post waits out its send window while the rest goes on, and is read in #announce further down.
    const approval = page.getByRole("article", {
      name: t("control", "title.post_message", { channel: "#announce" }),
    });
    await expect(approval).toBeVisible({ timeout: 30_000 });
    await approval.getByRole("button", { name: t("control", "allow.send") }).click();
    await expect(
      approval.getByText(
        t("control", "card.decidedBy", { status: t("control", "status.approved"), name: owner.name }),
      ),
    ).toBeVisible();

    // An assignment from goal to done.
    await page.goto(`${home}/assignments`);
    await page
      .getByRole("button", { name: t("work", "asg.new") })
      .first()
      .click();
    const goal = page.getByRole("dialog", { name: t("work", "asg.new") });
    await goal.getByRole("textbox", { name: t("work", "asg.form.goal") }).fill("Every glaze has a label.");
    await goal.getByRole("textbox", { name: t("work", "asg.form.title") }).fill("Label the glazes");
    await goal.getByRole("button", { name: t("work", "asg.form.create") }).click();
    const panel = page.getByRole("region", { name: t("work", "asg.panel") });
    await panel.getByRole("button", { name: t("work", "asg.start") }).click();
    await expect(panel.getByText(t("work", "asg.status.active"), { exact: true })).toBeVisible();
    await panel.getByRole("button", { name: t("work", "asg.close") }).click();
    const close = page.getByRole("dialog", { name: t("work", "asg.close.title") });
    await close.getByRole("radio", { name: t("work", "asg.close.done") }).click();
    await close.getByRole("textbox", { name: t("work", "asg.close.note") }).fill("Labels are on.");
    await close.getByRole("button", { name: t("work", "asg.close.submit") }).click();
    await expect(panel.getByText(t("work", "asg.status.done"), { exact: true })).toBeVisible();

    // A routine runs by hand and finishes.
    await page.goto(`${home}/routines`);
    await page
      .getByRole("button", { name: t("work", "recur.new") })
      .first()
      .click();
    const recipe = page.getByRole("dialog", { name: t("work", "recur.new") });
    await recipe.getByRole("textbox", { name: t("work", "recur.form.name") }).fill("Clay count");
    await recipe
      .getByRole("textbox", { name: t("work", "recur.form.instruction") })
      .fill("Count the clay left.");
    await recipe.getByRole("combobox", { name: t("work", "recur.form.trigger") }).click();
    await page.getByRole("option", { name: t("work", "recur.form.trigger.webhook") }).click();
    await recipe.getByRole("button", { name: t("work", "recur.form.create") }).click();
    const routine = page.getByRole("article", { name: "Clay count" });
    await routine.getByRole("button", { name: t("work", "recur.runNow") }).click();
    await expect(
      routine
        .getByRole("list", { name: t("work", "recur.runs") })
        .getByText(t("work", "recur.status.ok"), { exact: true }),
    ).toBeVisible({ timeout: 60_000 });

    // A file the owner uploads, found by the member.
    await page.goto(`${home}/files`);
    await page.getByTestId("files-upload").setInputFiles({
      name: "glaze-recipes.txt",
      mimeType: "text/plain",
      buffer: Buffer.from("Celadon: two parts feldspar."),
    });
    await expect(
      page.getByRole("list", { name: t("files", "upload.title") }).getByText(t("files", "upload.state.done")),
    ).toBeVisible();
    await openArea(theirs, t, "files");
    await expect(
      theirs
        .getByRole("list", { name: t("files", "drive.list") })
        .getByRole("button", { name: "glaze-recipes.txt" }),
    ).toBeVisible();

    // A wiki page the owner writes, read by the member.
    const title = "Firing schedule";
    await page.goto(`${home}/wiki`);
    await page.getByRole("button", { name: t("wiki", "create.action") }).click();
    const create = page.getByRole("dialog", { name: t("wiki", "create.title") });
    await create.getByRole("textbox", { name: t("wiki", "create.pageTitle") }).fill(title);
    await create.getByRole("textbox", { name: t("wiki", "create.body") }).fill("Bisque on Monday.");
    await create.getByRole("button", { name: t("wiki", "create.submit") }).click();
    await expect(page.getByRole("textbox", { name: t("wiki", "page.editor", { title }) })).toContainText(
      "Bisque on Monday.",
    );
    await openArea(theirs, t, "wiki");
    await theirs.getByRole("link", { name: title }).first().click();
    await expect(theirs.getByRole("textbox", { name: t("wiki", "page.editor", { title }) })).toContainText(
      "Bisque on Monday.",
    );

    // A debate with the agent and the member: the member answers on their turn, the agent writes the
    // synthesis, and the owner accepts the verdict.
    const question = "Do we buy a second kiln?";
    await page.goto(`${home}/debates`);
    await page
      .getByRole("button", { name: t("debates", "list.start") })
      .first()
      .click();
    const table = page.getByRole("dialog", { name: t("debates", "start.title") });
    await table.getByRole("textbox", { name: t("debates", "start.question") }).fill(question);
    await table.getByRole("textbox", { name: t("debates", "start.options") }).fill("Yes\nNo");
    await table.getByRole("combobox", { name: t("debates", "start.rounds") }).click();
    await page.getByRole("option", { name: t("debates", "start.rounds.vote") }).click();
    await table.getByRole("checkbox", { name: "Kiln Bot" }).click();
    await table.getByRole("checkbox", { name: member.name }).click();
    await table.getByRole("button", { name: t("debates", "start.submit") }).click();
    await expect(page.getByRole("heading", { level: 1, name: question })).toBeVisible();
    const debate = new URL(page.url()).pathname;
    await openArea(theirs, t, "debates");
    await expect(
      theirs
        .getByRole("region", { name: t("debates", "list.group.you", { count: 1 }) })
        .getByRole("article", { name: question }),
    ).toBeVisible({ timeout: 30_000 });
    await theirs.goto(debate);
    const turn = theirs.getByRole("region", { name: t("debates", "turn.title") });
    await turn.getByRole("combobox", { name: t("debates", "turn.answer") }).click();
    await theirs.getByRole("option", { name: "Yes", exact: true }).click();
    await turn.getByRole("combobox", { name: t("debates", "turn.confidence") }).click();
    await theirs
      .getByRole("option", { name: t("debates", "turn.confidence.value", { value: 80 }), exact: true })
      .click();
    await turn.getByRole("textbox", { name: t("debates", "turn.text") }).fill("The orders keep growing.");
    await turn.getByRole("button", { name: t("debates", "turn.send") }).click();
    await expect(theirs.getByText(t("debates", "turn.sent"), { exact: true })).toBeVisible();
    await expect(theirs.getByRole("region", { name: t("debates", "out.title") })).toBeVisible({
      timeout: 45_000,
    });
    await page.reload();
    await page.getByRole("button", { name: t("debates", "verdict.accept") }).click();
    await expect(
      page.getByText(
        new RegExp(
          t("debates", "verdict.acceptedBy", { name: owner.name, when: "" }).trim().replace(/,$/, ""),
        ),
      ),
    ).toBeVisible();

    // An issue on the board, and an event on the calendar, both where the member looks for them.
    const issue = "Replace the kiln shelf";
    await page.goto(`${home}/issues`);
    await page
      .getByRole("button", { name: t("work", "tracker.new") })
      .first()
      .click();
    const write = page.getByRole("dialog", { name: t("work", "new.title") });
    await write.getByRole("textbox", { name: t("work", "new.issueTitle") }).fill(issue);
    await write.getByRole("textbox", { name: t("work", "new.description") }).fill("The shelf cracked.");
    await write.getByRole("button", { name: t("work", "new.submit") }).click();
    await expect(card(lane(page, t, "todo"), issue)).toBeVisible();
    await openArea(theirs, t, "issues");
    await expect(card(lane(theirs, t, "todo"), issue)).toBeVisible();

    const event = "Clay delivery";
    await page.goto(`${home}/calendar`);
    await page.getByRole("button", { name: t("work", "week.new") }).click();
    const plan = page.getByRole("dialog", { name: t("work", "cal.new.title") });
    await plan.getByRole("textbox", { name: t("work", "cal.field.title") }).fill(event);
    await plan.getByRole("button", { name: t("work", "cal.create") }).click();
    await expect(page.getByText(t("work", "cal.created", { title: event }), { exact: true })).toBeVisible();
    await openArea(theirs, t, "calendar");
    await expect(
      dayRegion(theirs, locale, today).getByRole("button", { name: new RegExp(event) }),
    ).toBeVisible();

    // The member finds the closed assignment, and the agent's approved post has gone out in #announce.
    await openArea(theirs, t, "assignments");
    await theirs.getByRole("tab", { name: t("work", "asg.tab.closed", { count: 1 }) }).click();
    await expect(theirs.getByRole("article", { name: "Label the glazes" })).toBeVisible();
    await theirs.goto(`${home}/channel/${announce}`);
    await expect(
      theirs.getByRole("log", { name: t("chat", "history.label") }).getByText(post, { exact: true }),
    ).toBeVisible({ timeout: 60_000 });

    // The real runner CLI asks for a code; the owner confirms it, and the runner keeps its credential.
    const pairing = runnerCli(runnerHome, [
      "pair",
      "--server",
      server.url,
      "--name",
      "Studio laptop",
      "--no-exec",
    ]);
    started.push(pairing);
    const [, address = ""] = await pairing.printed(/Open (\S+) and confirm/);
    await page.goto(new URL(address).pathname + new URL(address).search);
    await expect(
      page.getByRole("heading", { name: t("agents", "pair.askTitle", { name: "Studio laptop" }) }),
    ).toBeVisible();
    await page.getByRole("button", { name: t("agents", "pair.accept") }).click();
    await expect(
      page.getByRole("heading", { name: t("agents", "pair.accepted", { name: "Studio laptop" }) }),
    ).toBeVisible();
    expect(await pairing.exited).toBe(0);
    expect(pairing.output()).toContain(`Connected to ${workspace} as Studio laptop.`);

    // Started, it connects, and both people see it online.
    const running = runnerCli(runnerHome, ["start"]);
    started.push(running);
    await running.printed(/connected as Studio laptop/);
    await page.getByRole("button", { name: t("agents", "pair.openRunner") }).click();
    await expect(page.getByRole("heading", { level: 1, name: "Studio laptop" })).toBeVisible();
    await expect(page.getByText(t("agents", "runners.online")).first()).toBeVisible();
    await theirs.goto(`${home}/settings/runners`);
    await expect(
      theirs
        .getByRole("list", { name: t("agents", "runners.title") })
        .getByRole("listitem")
        .filter({ hasText: "Studio laptop" }),
    ).toContainText(t("agents", "runners.online"));
  } finally {
    await Promise.all(started.map((cli) => cli.stop()));
    await tablet.close();
    await rm(runnerHome, { recursive: true, force: true });
  }
});
