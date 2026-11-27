// The inbox against the fake server. Ana's Birchwood inbox holds two open requests (an approval and a
// question), a mention and a DM, then reactions, a finished assignment and a routine report.
import { describe, expect, test } from "bun:test";
import { act, screen, waitFor, within } from "@testing-library/react";
import { QUERY_RETRIES } from "@vanr/client/react";
import { newServer, renderApp } from "../../../../test/app.tsx";

const PATH = "/workspace/workspace_birchwood/notifications";
const group = (name: string) => screen.getByRole("region", { name });
const headlines = (name: string) =>
  within(group(name))
    .getAllByRole("button", { name: /mentioned|asked|question|wrote|reacted|finished|report/ })
    .map((button) => button.textContent);
const rowOf = (headline: RegExp) => {
  const row = screen.getByRole("button", { name: headline }).closest("li");
  if (row === null) throw new Error("no row");
  return row;
};
const notice = (server: ReturnType<typeof newServer>, id: string) =>
  server.notifications.find((candidate) => candidate.id === id);

describe("the inbox", () => {
  test("Action needed: open requests first, then the rest by day, with the counts on the tabs", async () => {
    await renderApp({ path: PATH, signedInAs: "usr_ana" });
    await screen.findByRole("region", { name: "Waiting on you" });
    expect(headlines("Waiting on you")).toEqual([
      "Unread: Ledger asked for your approval",
      "Unread: Scout has a question for you",
    ]);
    expect(headlines("Today")).toEqual([
      "Unread: Jonas Lind mentioned you in #print-queue",
      "Unread: Íris Valença wrote to you",
    ]);
    expect(screen.getByRole("tab", { name: /Action needed/ }).textContent).toContain("4");
    expect(screen.getByRole("tab", { name: /FYI/ }).getAttribute("aria-selected")).toBe("false");
    expect(rowOf(/mentioned you in #print-queue/).textContent).toContain(
      "@ana can you look at the stuck job in the queue?",
    );
    expect(rowOf(/mentioned you in #print-queue/).textContent).toContain("mentioned you");
    expect(document.title).toBe("Inbox | Birchwood Labs | Vanr");
  });

  test("an open request has no Done: it leaves the inbox once it is answered", async () => {
    await renderApp({ path: PATH, signedInAs: "usr_ana" });
    const approval = await screen.findByRole("button", { name: /asked for your approval/ });
    const row = approval.closest("li") as HTMLElement;
    expect(within(row).queryByRole("button", { name: "Done" })).toBeNull();
    expect(within(rowOf(/wrote to you/)).getByRole("button", { name: "Done" })).toBeDefined();
  });

  test("opening a notice marks it read and goes where it came from", async () => {
    const app = await renderApp({ path: PATH, signedInAs: "usr_ana" });
    await app.user.click(await screen.findByRole("button", { name: /Jonas Lind mentioned you/ }));
    await waitFor(() => expect(app.address()).toBe("/workspace/workspace_birchwood/channel/ch_print"));
    await waitFor(() => expect(notice(app.server, "ntf_mention")?.readAt).not.toBeNull());
  });

  test("snoozing (muting) a notice takes it out until then", async () => {
    const app = await renderApp({ path: PATH, signedInAs: "usr_ana" });
    await screen.findByRole("button", { name: /wrote to you/ });
    await app.user.click(within(rowOf(/wrote to you/)).getByRole("button", { name: "Snooze" }));
    await app.user.click(await screen.findByRole("menuitem", { name: "Until tomorrow, 9:00" }));
    expect(await screen.findByText(/^Snoozed until /)).toBeDefined();
    await waitFor(() => expect(screen.queryByRole("button", { name: /wrote to you/ }) === null).toBe(true));
    expect(notice(app.server, "ntf_dm")?.mutedUntil).not.toBeNull();
  });

  test("Done takes a notice out of the inbox; Pin keeps it past the retention", async () => {
    const app = await renderApp({ path: `${PATH}?filter=fyi`, signedInAs: "usr_ana" });
    const reaction = await screen.findByRole("button", { name: /Tomás Eriksen reacted 🎉/ });
    await app.user.click(within(reaction.closest("li") as HTMLElement).getByRole("button", { name: "Pin" }));
    expect(await screen.findByText("Pinned: it stays past the three months.")).toBeDefined();
    expect(notice(app.server, "ntf_reaction")?.savedAt).not.toBeNull();
    await app.user.click(within(rowOf(/Tomás Eriksen reacted/)).getByRole("button", { name: "Done" }));
    await waitFor(() =>
      expect(screen.queryByRole("button", { name: /Tomás Eriksen reacted/ }) === null).toBe(true),
    );
    expect(notice(app.server, "ntf_reaction")?.doneAt).not.toBeNull();
  });

  test("FYI groups by day; All has filters", async () => {
    const app = await renderApp({ path: `${PATH}?filter=fyi`, signedInAs: "usr_ana" });
    await screen.findByRole("region", { name: "Yesterday" });
    expect(screen.getByRole("region", { name: "This week" })).toBeDefined();
    expect(screen.getByRole("region", { name: "Older" })).toBeDefined();
    await app.user.click(screen.getByRole("tab", { name: "All" }));
    await waitFor(() => expect(app.address()).toBe(`${PATH}?filter=all`));
    await app.user.click(await screen.findByRole("button", { name: "Mentions (1)" }));
    await waitFor(() => expect(app.address()).toBe(`${PATH}?filter=mentions`));
    await waitFor(() =>
      expect(screen.getAllByRole("button", { name: /^Unread:/ }).map((b) => b.textContent)).toEqual([
        "Unread: Jonas Lind mentioned you in #print-queue",
      ]),
    );
  });

  test("Mark all read reads what the tab shows", async () => {
    const app = await renderApp({ path: PATH, signedInAs: "usr_ana" });
    await app.user.click(await screen.findByRole("button", { name: "Mark these read" }));
    expect(await screen.findByText("Marked as read.")).toBeDefined();
    expect(notice(app.server, "ntf_dm")?.readAt).not.toBeNull();
    expect(notice(app.server, "ntf_reaction")?.readAt).toBeNull();
    await waitFor(() => expect(screen.queryAllByRole("button", { name: /^Unread:/ })).toHaveLength(0));
  });

  test("empty: what lands in the tab", async () => {
    const server = newServer();
    server.notifications = [];
    await renderApp({ path: PATH, signedInAs: "usr_ana", server });
    expect(await screen.findByText("Nothing needs you right now")).toBeDefined();
    expect(screen.getByText("Requests, direct messages and mentions land here.")).toBeDefined();
  });

  test("failed: what could not be loaded and a retry that works", async () => {
    const server = newServer();
    server.force("listNotifications", { kind: "error", status: 500, code: "internal" }, 1 + QUERY_RETRIES);
    const app = await renderApp({ path: PATH, signedInAs: "usr_ana", server });
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("The inbox could not be loaded");
    await app.user.click(within(alert).getByRole("button", { name: "Retry" }));
    await screen.findByRole("region", { name: "Waiting on you" });
  });

  test("older pages are added below, each notice once", async () => {
    const server = newServer();
    const sample = server.notifications.find((candidate) => candidate.id === "ntf_routine");
    if (sample === undefined) throw new Error("no sample");
    for (let n = 0; n < 60; n += 1) {
      server.notifications.push({ ...sample, id: `ntf_old_${n}`, latest: { title: `Report ${n}` } });
    }
    const app = await renderApp({ path: `${PATH}?filter=fyi`, signedInAs: "usr_ana", server });
    await screen.findByRole("region", { name: "Older" });
    const notices = () => within(screen.getByRole("main")).getAllByRole("listitem");
    const before = notices().length;
    expect(before).toBe(50);
    await app.user.click(screen.getByRole("button", { name: "Show older notices" }));
    await waitFor(() => expect(notices()).toHaveLength(64));
    expect(screen.queryByRole("button", { name: "Show older notices" }) === null).toBe(true);
  });

  test("a link from a push or an email opens the notice's source", async () => {
    const app = await renderApp({ path: `${PATH}?open=ntf_dm`, signedInAs: "usr_ana" });
    await waitFor(() => expect(app.address()).toBe("/workspace/workspace_birchwood/dm/person/usr_iris"));
    expect(notice(app.server, "ntf_dm")?.readAt).not.toBeNull();
  });

  test("a notice that arrives in real time shows up", async () => {
    const app = await renderApp({ path: PATH, signedInAs: "usr_ana" });
    await screen.findByRole("region", { name: "Today" });
    const sample = notice(app.server, "ntf_mention");
    if (sample === undefined) throw new Error("no sample");
    const fresh = { ...sample, id: "ntf_fresh", latest: { text: "One more thing" } };
    app.server.notifications.push(fresh);
    const { workspaceId: _w, userId: _u, ...shown } = fresh;
    app.server.emit("workspace_birchwood", { type: "notification.shown", notification: shown });
    expect(await screen.findByText("One more thing")).toBeDefined();
  });

  /** An FYI inbox of 60 read reports and, on the second page, one unread one. */
  const twoPages = () => {
    const server = newServer();
    const sample = server.notifications.find((candidate) => candidate.id === "ntf_routine");
    if (sample === undefined) throw new Error("no sample");
    server.notifications = server.notifications.filter((candidate) => candidate.tab !== "fyi");
    for (let n = 0; n < 60; n += 1) {
      const updatedAt = new Date(Date.parse(sample.updatedAt) - n * 60_000).toISOString();
      server.notifications.push({
        ...sample,
        id: `ntf_report_${n}`,
        updatedAt,
        readAt: n === 55 ? null : updatedAt,
        latest: { title: `Report ${n}` },
      });
    }
    return server;
  };

  test("Mark these read works when the only unread notice is on a page not loaded yet", async () => {
    const server = twoPages();
    const app = await renderApp({ path: `${PATH}?filter=fyi`, signedInAs: "usr_ana", server });
    await screen.findByText("Report 0");
    expect(screen.queryByRole("button", { name: /^Unread:/ }) === null).toBe(true);
    const mark = screen.getByRole("button", { name: "Mark these read" });
    expect(mark.hasAttribute("disabled")).toBe(false);
    await app.user.click(mark);
    await waitFor(() => expect(notice(server, "ntf_report_55")?.readAt).not.toBeNull());
  });

  test("a notice hidden in real time leaves an older page too", async () => {
    const server = twoPages();
    const app = await renderApp({ path: `${PATH}?filter=fyi`, signedInAs: "usr_ana", server });
    await screen.findByText("Report 0");
    await app.user.click(screen.getByRole("button", { name: "Show older notices" }));
    expect(await screen.findByText("Report 57")).toBeDefined();
    server.notifications = server.notifications.filter((candidate) => candidate.id !== "ntf_report_57");
    server.emit("workspace_birchwood", { type: "notification.hidden", id: "ntf_report_57" });
    await waitFor(() => expect(screen.queryByText("Report 57") === null).toBe(true));
    expect(screen.getByText("Report 58")).toBeDefined();
  });

  test("a refused Done says why, in the interface language", async () => {
    const server = newServer();
    server.force("completeNotification", {
      kind: "error",
      status: 409,
      code: "notification.waiting",
      message: "Answer the request first; it leaves the inbox by itself",
    });
    const app = await renderApp({ path: PATH, signedInAs: "usr_ana", server, languages: ["pt-BR"] });
    const dm = await screen.findByRole("button", { name: /escreveu para você/ });
    await app.user.click(within(dm.closest("li") as HTMLElement).getByRole("button", { name: "Feito" }));
    expect(await screen.findByText("Responda o pedido primeiro: ele sai da caixa sozinho.")).toBeDefined();
  });

  test("a notice hidden while the first answer is on its way stays hidden", async () => {
    const server = newServer();
    // The answer is computed now and reaches the browser only on release: it still has the DM.
    const late = server.delay("listNotifications");
    await renderApp({ path: PATH, signedInAs: "usr_ana", server });
    server.notifications = server.notifications.filter((candidate) => candidate.id !== "ntf_dm");
    server.emit("workspace_birchwood", { type: "notification.hidden", id: "ntf_dm" });
    late.release();
    await screen.findByRole("region", { name: "Today" });
    expect(screen.queryByText("Lunch on Friday?") === null).toBe(true);
  });

  test("an older notice changed in real time out of the filter leaves it", async () => {
    const server = newServer();
    const sample = server.notifications.find((candidate) => candidate.id === "ntf_routine");
    if (sample === undefined) throw new Error("no sample");
    for (let n = 0; n < 60; n += 1) {
      const updatedAt = new Date(Date.parse(sample.updatedAt) - n * 60_000).toISOString();
      server.notifications.push({
        ...sample,
        id: `ntf_unread_${n}`,
        updatedAt,
        latest: { title: `Unread ${n}` },
      });
    }
    const app = await renderApp({ path: `${PATH}?filter=unread`, signedInAs: "usr_ana", server });
    await screen.findByText("Unread 0");
    await app.user.click(screen.getByRole("button", { name: "Show older notices" }));
    expect(await screen.findByText("Unread 57")).toBeDefined();
    const changed = notice(server, "ntf_unread_57");
    if (changed === undefined) throw new Error("no notice");
    changed.readAt = changed.updatedAt;
    const { workspaceId: _w, userId: _u, ...shown } = changed;
    server.emit("workspace_birchwood", { type: "notification.shown", notification: shown });
    await waitFor(() => expect(screen.queryByText("Unread 57") === null).toBe(true));
    expect(screen.getByText("Unread 58")).toBeDefined();
  });

  describe("older pages stay whole while the first page changes", () => {
    const reports = () => {
      const server = newServer();
      const sample = server.notifications.find((candidate) => candidate.id === "ntf_routine");
      if (sample === undefined) throw new Error("no sample");
      server.notifications = server.notifications.filter((candidate) => candidate.tab !== "fyi");
      for (let n = 0; n < 60; n += 1) {
        const updatedAt = new Date(Date.parse(sample.updatedAt) - n * 60_000).toISOString();
        server.notifications.push({
          ...sample,
          id: `ntf_report_${n}`,
          updatedAt,
          readAt: updatedAt,
          latest: { title: `Report ${n}` },
        });
      }
      return { server, sample };
    };
    const strip = (notice: ReturnType<typeof newServer>["notifications"][number]) => {
      const { workspaceId: _w, userId: _u, ...rest } = notice;
      return rest;
    };
    const count = (pattern: RegExp) => screen.queryAllByText(pattern).length;
    const settle = () => act(async () => new Promise((resolve) => setTimeout(resolve, 100)));

    test("a new notice on top pushes the last of the first page down, and it stays", async () => {
      const { server, sample } = reports();
      const app = await renderApp({ path: `${PATH}?filter=fyi`, signedInAs: "usr_ana", server });
      await screen.findByText("Report 0");
      await app.user.click(screen.getByRole("button", { name: "Show older notices" }));
      expect(await screen.findByText("Report 59")).toBeDefined();
      const fresh = {
        ...sample,
        id: "ntf_new",
        updatedAt: new Date(Date.parse(sample.updatedAt) + 60_000).toISOString(),
        readAt: null,
        latest: { title: "Brand new" },
      };
      server.notifications.push(fresh);
      await act(async () =>
        server.emit("workspace_birchwood", { type: "notification.shown", notification: strip(fresh) }),
      );
      expect(await screen.findByText("Brand new")).toBeDefined();
      await waitFor(() => expect(count(/^Report \d+$/)).toBe(60));
      expect(count(/^Report 49$/)).toBe(1);
    });

    test("changes while the first page is on its way all land", async () => {
      const { server } = reports();
      const app = await renderApp({ path: `${PATH}?filter=fyi`, signedInAs: "usr_ana", server });
      await screen.findByText("Report 0");
      await app.user.click(screen.getByRole("button", { name: "Show older notices" }));
      expect(await screen.findByText("Report 57")).toBeDefined();
      const late = server.delay("listNotifications");
      const ten = notice(server, "ntf_report_10");
      if (ten === undefined) throw new Error("no notice");
      ten.latest = { title: "Report 10 edited" };
      await act(async () =>
        server.emit("workspace_birchwood", { type: "notification.shown", notification: strip(ten) }),
      );
      server.notifications = server.notifications.filter(
        (candidate) => candidate.id !== "ntf_report_3" && candidate.id !== "ntf_report_57",
      );
      await act(async () => {
        server.emit("workspace_birchwood", { type: "notification.hidden", id: "ntf_report_3" });
        server.emit("workspace_birchwood", { type: "notification.hidden", id: "ntf_report_57" });
      });
      late.release();
      await waitFor(() => expect(count(/^Report 10 edited$/)).toBe(1));
      await waitFor(() => expect(count(/^Report \d+( edited)?$/)).toBe(58));
      expect(count(/^Report 3$/)).toBe(0);
      expect(count(/^Report 57$/)).toBe(0);
    });

    test("changes while older notices are on their way all land", async () => {
      const { server } = reports();
      const app = await renderApp({ path: `${PATH}?filter=fyi`, signedInAs: "usr_ana", server });
      await screen.findByText("Report 0");
      const late = server.delay("listNotifications");
      await app.user.click(screen.getByRole("button", { name: "Show older notices" }));
      server.notifications = server.notifications.filter((candidate) => candidate.id !== "ntf_report_57");
      const moved = notice(server, "ntf_report_55");
      const top = notice(server, "ntf_report_0");
      if (moved === undefined || top === undefined) throw new Error("no notice");
      moved.updatedAt = new Date(Date.parse(top.updatedAt) + 60_000).toISOString();
      moved.latest = { title: "Report 55 moved" };
      await act(async () => {
        server.emit("workspace_birchwood", { type: "notification.hidden", id: "ntf_report_57" });
        server.emit("workspace_birchwood", { type: "notification.shown", notification: strip(moved) });
      });
      late.release();
      await waitFor(() => expect(count(/^Report 59$/)).toBe(1));
      await settle();
      expect(count(/^Report 57$/)).toBe(0);
      expect(count(/^Report 55( moved)?$/)).toBe(1);
      expect(count(/^Report \d+( moved)?$/)).toBe(59);
    });

    test("Show older asks only for the next page", async () => {
      const { server, sample } = reports();
      for (let n = 60; n < 130; n += 1) {
        const updatedAt = new Date(Date.parse(sample.updatedAt) - n * 60_000).toISOString();
        server.notifications.push({
          ...sample,
          id: `ntf_report_${n}`,
          updatedAt,
          readAt: updatedAt,
          latest: { title: `Report ${n}` },
        });
      }
      const app = await renderApp({ path: `${PATH}?filter=fyi`, signedInAs: "usr_ana", server });
      await screen.findByText("Report 0");
      await app.user.click(screen.getByRole("button", { name: "Show older notices" }));
      await screen.findByText("Report 99");
      await app.user.click(screen.getByRole("button", { name: "Show older notices" }));
      await screen.findByText("Report 129");
      const older = server.calls.filter(
        (call) => call.method === "listNotifications" && call.params.cursor !== undefined,
      );
      expect(older.map((call) => call.params.cursor)).toEqual(["50", "100"]);
    });

    test("an older range that fails to load again is dropped, and Show older can try again", async () => {
      const { server, sample } = reports();
      const app = await renderApp({ path: `${PATH}?filter=fyi`, signedInAs: "usr_ana", server });
      await screen.findByText("Report 0");
      await app.user.click(screen.getByRole("button", { name: "Show older notices" }));
      await screen.findByText("Report 59");
      server.force(
        "listNotifications",
        { kind: "error", status: 500, code: "internal" },
        1,
        (params) => params.cursor !== undefined,
      );
      const fresh = {
        ...sample,
        id: "ntf_new",
        updatedAt: new Date(Date.parse(sample.updatedAt) + 60_000).toISOString(),
        readAt: null,
        latest: { title: "Brand new" },
      };
      server.notifications.push(fresh);
      await act(async () =>
        server.emit("workspace_birchwood", { type: "notification.shown", notification: strip(fresh) }),
      );
      await screen.findByText("Brand new");
      await waitFor(() => expect(count(/^Report 59$/)).toBe(0));
      expect(count(/^Report 49$/)).toBe(0);
      await app.user.click(screen.getByRole("button", { name: "Show older notices" }));
      await waitFor(() => expect(count(/^Report \d+$/)).toBe(60));
    });

    test("hidden then shown again while the first page is on its way ends shown, once", async () => {
      const { server } = reports();
      await renderApp({ path: `${PATH}?filter=fyi`, signedInAs: "usr_ana", server });
      await screen.findByText("Report 2");
      const late = server.delay("listNotifications");
      const two = notice(server, "ntf_report_2");
      if (two === undefined) throw new Error("no notice");
      await act(async () =>
        server.emit("workspace_birchwood", { type: "notification.hidden", id: "ntf_report_2" }),
      );
      two.latest = { title: "Report 2 back" };
      await act(async () =>
        server.emit("workspace_birchwood", { type: "notification.shown", notification: strip(two) }),
      );
      late.release();
      await waitFor(() => expect(count(/^Report 2 back$/)).toBe(1));
      expect(count(/^Report 2$/)).toBe(0);
    });
  });

  test("Mark these read stays off in a filter with nothing unread, even when other notices are", async () => {
    const server = newServer();
    const mention = notice(server, "ntf_mention");
    if (mention === undefined) throw new Error("no notice");
    mention.readAt = mention.updatedAt;
    await renderApp({ path: `${PATH}?filter=mentions`, signedInAs: "usr_ana", server });
    await screen.findByRole("button", { name: /Jonas Lind mentioned you/ });
    expect(screen.getByRole("button", { name: "Mark these read" }).hasAttribute("disabled")).toBe(true);
  });
});
