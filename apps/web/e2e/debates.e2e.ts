// Debates end to end, against the real server and its runtime with the fake model. In one, the owner puts
// a question to two agents and a member from the debates page, in that speaking order, and finds it in the
// list with the member waited on; the member's own list puts it under what needs them, as their turn. In
// the other, the agents answer as their instructions script them, the member gives a position on their
// turn, the lead agent writes the synthesis, and the owner reads the verdict, now with names, and accepts it.
import { expect, test } from "./fixtures.ts";

test.describe("the debates", () => {
  // Opening hands round 0 to the runtime: more than the usual 30 s on a busy machine.
  test.setTimeout(90_000);

  test("a debate with two agents and a person starts and waits on the person", async ({
    page,
    t,
    seedUser,
    signIn,
    apiAs,
  }) => {
    const owner = await seedUser({ workspace: "Debate Journey" });
    const member = await seedUser({ joins: { by: owner } });
    const api = await apiAs(owner);
    const base = `/api/v1/workspaces/${owner.workspace.id}`;
    const { channels } = (await (await api.get(`${base}/channels`)).json()) as {
      channels: { id: string; isGeneral: boolean }[];
    };
    const general = channels.find((channel) => channel.isGeneral)?.id ?? "";
    const suffix = Date.now().toString(36);
    for (const name of ["Quill", "Rivet"]) {
      const made = await api.post(`${base}/agents`, {
        data: { name, handle: `${name.toLowerCase()}${suffix}`, role: "assistant", channelIds: [general] },
      });
      expect(made.ok()).toBe(true);
    }

    await signIn(owner);
    await page.goto(`/workspace/${owner.workspace.id}/debates`);
    await expect(page.getByText(t("debates", "list.empty.title"))).toBeVisible();
    await page
      .getByRole("button", { name: t("debates", "list.start") })
      .first()
      .click();
    const dialog = page.getByRole("dialog", { name: t("debates", "start.title") });
    await dialog
      .getByRole("textbox", { name: t("debates", "start.question") })
      .fill("Do we rent a second press?");
    await dialog.getByRole("checkbox", { name: "Rivet" }).click();
    await dialog.getByRole("checkbox", { name: "Quill" }).click();
    await dialog.getByRole("checkbox", { name: member.name }).click();
    await expect(
      dialog.getByRole("checkbox", { name: t("debates", "start.seat", { order: 3, name: member.name }) }),
    ).toBeVisible();
    await expect(dialog.getByText(t("debates", "start.estimate.pick"))).toHaveCount(0);
    await dialog.getByRole("button", { name: t("debates", "start.submit") }).click();
    await expect(page).toHaveURL(/\/debates\/[^/]+$/);

    await page.goto(`/workspace/${owner.workspace.id}/debates`);
    const row = page.getByRole("article", { name: "Do we rent a second press?" });
    await expect(row).toBeVisible();
    await expect(row.getByText(t("debates", "row.waitsOn", { name: member.name }))).toBeAttached();
    await expect(row.getByText(t("debates", "row.opening"))).toBeVisible();

    const { debates } = (await (await api.get(`${base}/debates`)).json()) as {
      debates: { title: string; goal: string; speakers: { type: string }[]; waitingUserIds: string[] }[];
    };
    const made = debates.find((debate) => debate.title === "Do we rent a second press?");
    expect(made?.goal).toBe("Do we rent a second press?");
    expect(made?.speakers.map((speaker) => speaker.type)).toEqual(["agent", "agent", "person"]);
    expect(made?.waitingUserIds.length).toBe(1);

    await signIn(member);
    await page.goto(`/workspace/${owner.workspace.id}/debates`);
    const needs = page.getByRole("region", { name: t("debates", "list.group.you", { count: 1 }) });
    const mine = needs.getByRole("article", { name: "Do we rent a second press?" });
    await expect(mine).toBeVisible();
    await expect(mine.getByText(t("debates", "state.yourTurn"))).toBeVisible();
  });

  test("two agents and a person argue a vote and the owner reads and accepts the verdict", async ({
    page,
    t,
    seedUser,
    signIn,
    apiAs,
  }) => {
    const owner = await seedUser({ workspace: "Verdict Journey" });
    const member = await seedUser({ joins: { by: owner } });
    const api = await apiAs(owner);
    const base = `/api/v1/workspaces/${owner.workspace.id}`;
    const { channels } = (await (await api.get(`${base}/channels`)).json()) as {
      channels: { id: string; isGeneral: boolean }[];
    };
    const general = channels.find((channel) => channel.isGeneral)?.id ?? "";
    const suffix = Date.now().toString(36);
    // The fake model gives each agent the position its instructions script.
    for (const name of ["Quill", "Rivet"]) {
      const made = await api.post(`${base}/agents`, {
        data: {
          name,
          handle: `${name.toLowerCase()}${suffix}`,
          role: "assistant",
          channelIds: [general],
          instructions: "[[debate:Yes|Yes]]",
        },
      });
      expect(made.ok()).toBe(true);
    }

    await signIn(owner);
    await page.goto(`/workspace/${owner.workspace.id}/debates`);
    await page
      .getByRole("button", { name: t("debates", "list.start") })
      .first()
      .click();
    const dialog = page.getByRole("dialog", { name: t("debates", "start.title") });
    await dialog
      .getByRole("textbox", { name: t("debates", "start.question") })
      .fill("Do we open a second shop?");
    await dialog.getByRole("textbox", { name: t("debates", "start.options") }).fill("Yes\nNo");
    await dialog.getByRole("combobox", { name: t("debates", "start.rounds") }).click();
    await page.getByRole("option", { name: t("debates", "start.rounds.vote") }).click();
    await dialog.getByRole("checkbox", { name: "Quill" }).click();
    await dialog.getByRole("checkbox", { name: "Rivet" }).click();
    await dialog.getByRole("checkbox", { name: member.name }).click();
    await dialog.getByRole("button", { name: t("debates", "start.submit") }).click();
    await expect(page.getByRole("heading", { level: 1, name: "Do we open a second shop?" })).toBeVisible();
    const address = page.url();
    // Nobody steers but who opened it: the owner can conclude, and it waits on the member.
    await expect(page.getByRole("button", { name: t("debates", "steer.conclude") })).toBeVisible();
    await expect(page.getByText(t("debates", "page.blind"))).toBeVisible();

    await signIn(member);
    await page.goto(address);
    const turn = page.getByRole("region", { name: t("debates", "turn.title") });
    await expect(turn).toBeVisible();
    await expect(page.getByRole("button", { name: t("debates", "steer.conclude") })).toHaveCount(0);
    await turn.getByRole("combobox", { name: t("debates", "turn.answer") }).click();
    await page.getByRole("option", { name: "Yes", exact: true }).click();
    await turn.getByRole("combobox", { name: t("debates", "turn.confidence") }).click();
    await page
      .getByRole("option", { name: t("debates", "turn.confidence.value", { value: 80 }), exact: true })
      .click();
    await turn.getByRole("textbox", { name: t("debates", "turn.text") }).fill("Demand is there.");
    await turn.getByRole("button", { name: t("debates", "turn.send") }).click();
    await expect(page.getByText(t("debates", "turn.sent"), { exact: true })).toBeVisible();

    // The round closes, the lead agent writes the synthesis, and the page follows without a reload.
    const synthesis = page.getByRole("region", { name: t("debates", "out.title") });
    await expect(synthesis).toBeVisible({ timeout: 45_000 });
    await signIn(owner);
    await page.goto(address);
    await expect(synthesis).toBeVisible();
    const grid = page.getByRole("table");
    // Closed: the agents' names are revealed beside their letters, and the majority is theirs.
    await expect(grid.getByRole("rowheader", { name: /Quill/ })).toBeVisible();
    await expect(grid.getByRole("rowheader", { name: /Rivet/ })).toBeVisible();
    // The member's own position, as they gave it: the answer and how sure they were.
    const memberRow = grid
      .getByRole("row")
      .filter({ has: page.getByRole("rowheader", { name: member.name }) });
    await expect(memberRow.getByRole("link", { name: "Yes", exact: true })).toBeVisible();
    await expect(memberRow.getByText(t("debates", "pos.confidence", { value: 80 }))).toBeVisible();
    // The server's majority of the round: every answer was Yes.
    const lead = t("debates", "pos.lead", { answer: "Yes", count: 7, total: 8 })
      .replace("7", "COUNT")
      .replace("8", "TOTAL");
    const leadPattern = new RegExp(
      `^${lead
        .replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
        .replace("COUNT", "(\\d+)")
        .replace("TOTAL", "\\1")}$`,
    );
    await expect(grid.getByRole("row").last().getByText(leadPattern)).toBeVisible();
    await expect(page.getByText(t("debates", "verdict.pending"))).toBeVisible();
    await page.getByRole("button", { name: t("debates", "verdict.accept") }).click();
    await expect(
      page.getByText(
        new RegExp(
          t("debates", "verdict.acceptedBy", { name: owner.name, when: "" }).trim().replace(/,$/, ""),
        ),
      ),
    ).toBeVisible();
    await expect(page.getByRole("region", { name: t("debates", "turn.title") })).toHaveCount(0);

    const answer = await api.get(`${base}/debates`);
    const { debates } = (await answer.json()) as {
      debates: { title: string; status: string; verdictState: { state: string } | null }[];
    };
    const made = debates.find((debate) => debate.title === "Do we open a second shop?");
    expect(made?.status).toBe("done");
    expect(made?.verdictState?.state).toBe("accepted");
    const detail = (await (await api.get(`${base}/debates/${address.split("/").pop()}`)).json()) as {
      posts: {
        author: { id: string } | null;
        claimData: { answer: string; confidence: number | null } | null;
      }[];
    };
    // The member's own post, found by who they are.
    const memberApi = await apiAs(member);
    const session = (await (await memberApi.get("/api/auth/get-session")).json()) as { user: { id: string } };
    const position = detail.posts.find(
      (post) => post.author?.id === session.user.id && post.claimData !== null,
    );
    expect(position?.claimData).toMatchObject({ answer: "Yes", confidence: 0.8 });
  });
});
