// The notification preferences and the inbox's own rules, against the fake server.
import { describe, expect, test } from "bun:test";
import { screen, waitFor, within } from "@testing-library/react";
import { QUERY_RETRIES } from "@vanr/client/react";
import type { AppNotification } from "@vanr/contract";
import { DEFAULT_NOTIFICATION_SETTINGS } from "../../../../dev/fake-server.ts";
import { chooseOption, newServer, renderApp } from "../../../../test/app.tsx";
import { dayGroupOf, destinationOf, joinPages, laterOptions } from "./notices.ts";

const PATH = "/workspace/workspace_birchwood/notifications/settings";
const saved = (server: ReturnType<typeof newServer>) =>
  server.notificationSettings.get("workspace_birchwood/usr_ana");

describe("notification preferences", () => {
  test("muting a channel and adding a rule wait for Save, then stay", async () => {
    const app = await renderApp({ path: PATH, signedInAs: "usr_ana" });
    expect(await screen.findByText("No channel is muted.")).toBeDefined();
    expect(screen.getByRole("button", { name: "Save preferences" }).hasAttribute("disabled")).toBe(true);
    await chooseOption(app, screen.getByRole("combobox", { name: "Mute a channel" }), "#print-queue");
    expect(
      within(screen.getByRole("list", { name: "Muted channels" })).getByText("#print-queue"),
    ).toBeDefined();
    await app.user.click(screen.getByRole("button", { name: "Add a rule" }));
    await chooseOption(app, screen.getByRole("combobox", { name: "Rule 1: kind" }), "Reactions");
    expect(saved(app.server)).toBeUndefined();
    await app.user.click(screen.getByRole("button", { name: "Save preferences" }));
    expect(await screen.findByText("Preferences saved.")).toBeDefined();
    expect(saved(app.server)?.channels).toEqual({ ch_print: { push: false, email: false } });
    expect(saved(app.server)?.rules).toEqual([{ id: expect.any(String), kind: "reaction", tab: "fyi" }]);
    expect(saved(app.server)?.locale).toBe("en");
  });

  test("unmuting is a change like any other", async () => {
    const server = newServer();
    server.notificationSettings.set("workspace_birchwood/usr_ana", {
      ...DEFAULT_NOTIFICATION_SETTINGS,
      channels: { ch_general: { push: false, email: false } },
    });
    const app = await renderApp({ path: PATH, signedInAs: "usr_ana", server });
    await app.user.click(await screen.findByRole("button", { name: "Unmute #general" }));
    await app.user.click(screen.getByRole("button", { name: "Save preferences" }));
    await waitFor(() => expect(saved(server)?.channels).toEqual({}));
  });

  test("do not disturb saves at once, without saving the rest of the draft", async () => {
    const app = await renderApp({ path: PATH, signedInAs: "usr_ana" });
    await app.user.click(await screen.findByRole("switch", { name: /Quiet hours every day/ }));
    await app.user.click(screen.getByRole("button", { name: "For an hour" }));
    expect(await screen.findByText(/^Do not disturb until /)).toBeDefined();
    expect(saved(app.server)?.dndUntil).not.toBeNull();
    expect(saved(app.server)?.quietHours.enabled).toBe(false);
    expect(screen.getByRole("button", { name: "Save preferences" }).hasAttribute("disabled")).toBe(false);
    await app.user.click(screen.getByRole("button", { name: "Turn it off" }));
    await waitFor(() => expect(saved(app.server)?.dndUntil).toBeNull());
  });

  test("turning email off turns its column off", async () => {
    const app = await renderApp({ path: PATH, signedInAs: "usr_ana" });
    const approvals = await screen.findByRole("checkbox", { name: "Email for Approval requests" });
    expect(approvals.getAttribute("aria-checked")).toBe("true");
    expect(screen.getByRole("checkbox", { name: "Email for Reactions" }).getAttribute("aria-checked")).toBe(
      "false",
    );
    await app.user.click(screen.getByRole("switch", { name: /Email when something waits on me/ }));
    expect(approvals.hasAttribute("disabled")).toBe(true);
  });

  test("do not disturb never writes back a field that Save just changed", async () => {
    const app = await renderApp({ path: PATH, signedInAs: "usr_ana" });
    await app.user.click(await screen.findByRole("switch", { name: /Push to my devices/ }));
    await app.user.click(screen.getByRole("button", { name: "Save preferences" }));
    await screen.findByText("Preferences saved.");
    // Straight after the save, before any refetch could land.
    await app.user.click(screen.getByRole("button", { name: "For an hour" }));
    await waitFor(() => expect(saved(app.server)?.dndUntil).not.toBeNull());
    expect(saved(app.server)?.push).toBe(false);
  });

  test("an edit made while Save is on its way stays a draft", async () => {
    const server = newServer();
    const held = server.hold("setNotificationSettings");
    const app = await renderApp({ path: PATH, signedInAs: "usr_ana", server });
    await app.user.click(await screen.findByRole("switch", { name: /Push to my devices/ }));
    await app.user.click(screen.getByRole("button", { name: "Save preferences" }));
    await app.user.click(screen.getByRole("switch", { name: /Quiet hours every day/ }));
    held.release();
    await screen.findByText("Preferences saved.");
    expect(screen.getByRole("switch", { name: /Quiet hours every day/ }).getAttribute("aria-checked")).toBe(
      "true",
    );
    expect(screen.getByRole("button", { name: "Save preferences" }).hasAttribute("disabled")).toBe(false);
  });

  test("channels that fail to load say so and can be loaded again", async () => {
    const server = newServer();
    server.force("listChannels", { kind: "error", status: 500, code: "internal" }, 1 + QUERY_RETRIES);
    const app = await renderApp({ path: PATH, signedInAs: "usr_ana", server });
    const alerts = await screen.findAllByText("The channels could not be loaded, so none can be picked.");
    expect(alerts.length).toBeGreaterThan(0);
    const alert = alerts[0]?.closest("[role=alert]") as HTMLElement;
    await app.user.click(within(alert).getByRole("button", { name: "Retry" }));
    await waitFor(() =>
      expect(screen.queryByText("The channels could not be loaded, so none can be picked.") === null).toBe(
        true,
      ),
    );
  });

  test("failed: a retry that works", async () => {
    const server = newServer();
    server.force(
      "getNotificationSettings",
      { kind: "error", status: 500, code: "internal" },
      1 + QUERY_RETRIES,
    );
    const app = await renderApp({ path: PATH, signedInAs: "usr_ana", server });
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("Your notification preferences could not be loaded");
    await app.user.click(within(alert).getByRole("button", { name: "Retry" }));
    expect(await screen.findByRole("heading", { level: 2, name: "Delivery" })).toBeDefined();
  });
});

const base: AppNotification = {
  id: "n",
  actors: [{ type: "person", id: "usr_jonas" }],
  count: 1,
  createdAt: "2026-11-14T10:00:00.000Z",
  updatedAt: "2026-11-14T10:00:00.000Z",
  critical: false,
  doneAt: null,
  kind: "mention",
  latest: {},
  mutedUntil: null,
  readAt: null,
  reason: "mentioned",
  remindAt: null,
  ruleId: null,
  savedAt: null,
  source: {},
  tab: "action_needed",
  waiting: false,
  workState: null,
};

describe("where a notice leads", () => {
  const ws = "workspace_birchwood";
  test("each source to its screen", () => {
    expect(destinationOf({ ...base, kind: "approval", source: { approvalId: "a" } }, ws)?.route).toBe(
      "approvals",
    );
    expect(destinationOf({ ...base, source: { debateId: "d" } }, ws)).toEqual({
      route: "debate",
      params: { workspaceId: ws, debateId: "d" },
    });
    expect(destinationOf({ ...base, source: { issueSeq: 12 } }, ws)).toEqual({
      route: "issue",
      params: { workspaceId: ws, issueSeq: "12" },
    });
    expect(destinationOf({ ...base, source: { channelId: "c", threadId: "t" } }, ws)?.route).toBe("thread");
    expect(destinationOf({ ...base, source: { channelId: "c" } }, ws)?.route).toBe("channel");
    expect(
      destinationOf(
        { ...base, kind: "dm", actors: [{ type: "agent", id: "agt" }], source: { dmId: "x" } },
        ws,
      ),
    ).toEqual({ route: "dmAgent", params: { workspaceId: ws, agentId: "agt" } });
    expect(destinationOf({ ...base, actors: [{ type: "agent", id: "agt" }] }, ws)?.route).toBe("agent");
    expect(destinationOf(base, ws)).toBeUndefined();
  });

  test("pages are joined without repeating a notice", () => {
    const a = { ...base, id: "a" };
    const b = { ...base, id: "b" };
    expect(joinPages([a, b], [b, { ...base, id: "c" }]).map((n) => n.id)).toEqual(["a", "b", "c"]);
    // Two older pages that both carry the same notice.
    const c = { ...base, id: "c" };
    expect(joinPages([a], [c], [c, b]).map((n) => n.id)).toEqual(["a", "c", "b"]);
  });

  test("day groups and the later options follow the local calendar", () => {
    const now = new Date(2026, 10, 14, 12).getTime(); // a Saturday, noon local time
    expect(dayGroupOf(new Date(2026, 10, 14, 0, 30).toISOString(), now)).toBe("today");
    expect(dayGroupOf(new Date(2026, 10, 13, 23).toISOString(), now)).toBe("yesterday");
    expect(dayGroupOf(new Date(2026, 10, 9).toISOString(), now)).toBe("week");
    expect(dayGroupOf(new Date(2026, 10, 7).toISOString(), now)).toBe("older");
    const [hour, tomorrow, monday] = laterOptions(now);
    expect(hour?.at.getTime()).toBe(now + 3_600_000);
    expect(tomorrow?.at.getTime()).toBe(new Date(2026, 10, 15, 9).getTime());
    expect(monday?.at.getTime()).toBe(new Date(2026, 10, 16, 9).getTime());
    // A day with 25 hours (clocks going back) still has its whole yesterday.
    const afterShift = new Date(2026, 10, 2, 12).getTime();
    expect(dayGroupOf(new Date(2026, 10, 1, 0, 30).toISOString(), afterShift)).toBe("yesterday");
    // On a Monday, "Monday" is the next one.
    expect(laterOptions(new Date(2026, 10, 16, 8).getTime())[2]?.at.getTime()).toBe(
      new Date(2026, 10, 23, 9).getTime(),
    );
  });
});
