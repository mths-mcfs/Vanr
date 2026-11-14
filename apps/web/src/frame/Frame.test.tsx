import { afterEach, describe, expect, test } from "bun:test";
import { act, screen, waitFor, within } from "@testing-library/react";
import { type App, newServer, renderApp, setViewportWidth } from "../../test/app.tsx";
import { STORAGE_KEYS } from "../platform/storage.ts";
import { ROUTE_IDS, ROUTES } from "../routes.ts";
import { NAVIGATION } from "./Sidebar.tsx";

const HOME = "/workspace/workspace_birchwood";
const open = (path = HOME, options: Partial<Parameters<typeof renderApp>[0]> = {}) =>
  renderApp({ path, signedInAs: "usr_ana", ...options });
const areas = () => screen.getByRole("navigation", { name: "Areas" });
const working = () => screen.getByRole("region", { name: "At work" });
const calls = (app: App, method: string) => app.server.calls.filter((call) => call.method === method).length;

afterEach(() => setViewportWidth(1024));

describe("navigation", () => {
  test("every area is a link to its route, and the open one is marked", async () => {
    await open(`${HOME}/wiki`);
    await screen.findByRole("heading", { level: 1, name: "Wiki" });
    const links = within(areas()).getAllByRole("link");
    expect(links.map((link) => link.getAttribute("href"))).toEqual(
      NAVIGATION.flat().map((id) => ROUTES[id].path.replace("$workspaceId", "workspace_birchwood")),
    );
    expect(
      links.filter((link) => link.getAttribute("aria-current") === "page").map((link) => link.textContent),
    ).toEqual(["Wiki"]);
  });

  test("Home is not marked as open on the screens under it", async () => {
    await open(`${HOME}/issues`);
    await screen.findByRole("heading", { level: 1, name: "Issues" });
    expect(within(areas()).getByRole("link", { name: "Home" }).getAttribute("aria-current")).toBeNull();
  });

  test("what waits for the person is counted beside the area, with a spoken name", async () => {
    await open();
    await screen.findByRole("heading", { level: 1, name: "Birchwood Labs" });
    expect(await within(areas()).findByRole("link", { name: "Inbox, 3 waiting" })).toBeDefined();
    expect(within(areas()).getByRole("link", { name: "Approvals, 2 waiting" }).textContent).toBe(
      "Approvals2",
    );
    expect(within(areas()).getByRole("link", { name: "Threads" }).textContent).toBe("Threads");
  });

  test("the navigation has no icons: the only images in the sidebar are agents and the person", async () => {
    await open();
    await within(working()).findByRole("img", { name: "Scout, at work" });
    const sidebar = screen.getByRole("complementary", { name: "Workspace sidebar" });
    expect(within(areas()).queryAllByRole("img")).toEqual([]);
    expect(areas().querySelectorAll("svg")).toHaveLength(0);
    expect(
      within(sidebar)
        .getAllByRole("img")
        .map((image) => image.getAttribute("aria-label")),
    ).toEqual(["Scout, at work", "Ledger, at work", "Ana Beatriz Souza"]);
  });

  test("every workspace route opens inside the frame, built or not, with its own title", async () => {
    const app = await open();
    await screen.findByRole("heading", { level: 1, name: "Birchwood Labs" });
    const params: Record<string, string> = {
      workspaceId: "workspace_birchwood",
      section: "general",
      issueSeq: "12",
    };
    for (const id of ROUTE_IDS) {
      if (ROUTES[id].access !== "member") continue;
      const path = ROUTES[id].path.replace(
        /\$([A-Za-z]+)/g,
        (_, name: string) => params[name] ?? `${name}_1`,
      );
      await act(() => app.runtime.router.navigate({ to: path }));
      await waitFor(() => expect(screen.getByRole("main").querySelector("h1"), id).not.toBeNull());
      expect(screen.getByRole("navigation", { name: "Areas" }), id).toBeDefined();
      expect(document.title, id).toMatch(/ \| Birchwood Labs \| Vanr$/);
    }
  });

  test("a route its area has not built says what the area is and that it is not in this build", async () => {
    await open(`${HOME}/debates/debate_7`);
    await screen.findByRole("heading", { level: 1, name: "Debate" });
    expect(
      screen.getByText("Questions that agents and people argue in rounds until there is a verdict."),
    ).toBeDefined();
    expect(screen.getByText("This area is not part of this build yet.")).toBeDefined();
    expect(screen.queryByText(/soon/i)).toBeNull();
  });

  test("Ctrl+K opens the search route", async () => {
    const app = await open();
    await screen.findByRole("heading", { level: 1, name: "Birchwood Labs" });
    await app.user.keyboard("{Control>}k{/Control}");
    await screen.findByRole("heading", { level: 1, name: "Search" });
    expect(app.address()).toBe(`${HOME}/search`);
  });

  test("the skip link moves focus to the content", async () => {
    const app = await open();
    await screen.findByRole("heading", { level: 1, name: "Birchwood Labs" });
    await app.user.tab();
    expect(document.activeElement?.textContent).toBe("Skip to content");
    await app.user.keyboard("{Enter}");
    expect(document.activeElement).toBe(screen.getByRole("main"));
  });

  test("shortened addresses lead to the settings section they stand for", async () => {
    const members = await open(`${HOME}/members`);
    await screen.findByRole("heading", { level: 2, name: "Members" });
    expect(members.address()).toBe(`${HOME}/settings/members`);
    members.unmount();
    const settings = await open(`${HOME}/settings`);
    await screen.findByRole("heading", { level: 2, name: "General" });
    expect(settings.address()).toBe(`${HOME}/settings/general`);
    settings.unmount();
    const unknown = await open(`${HOME}/settings/no-such-section`);
    await screen.findByRole("heading", { level: 2, name: "General" });
    expect(unknown.address()).toBe(`${HOME}/settings/general`);
  });

  test("an address outside the route table says so", async () => {
    await open("/workspace/workspace_birchwood/no/such/screen");
    await screen.findByRole("heading", { level: 1, name: "There is nothing at this address" });
  });
});

describe("the workspace menu", () => {
  test("lists the person's workspaces and switches between them", async () => {
    const app = await open();
    await app.user.click(await screen.findByRole("button", { name: "Birchwood Labs, workspace menu" }));
    const options = await screen.findAllByRole("menuitemradio");
    expect(options.map((option) => [option.textContent, option.getAttribute("aria-checked")])).toEqual([
      ["Birchwood Labs", "true"],
      ["Night Shift", "false"],
    ]);
    await app.user.click(screen.getByRole("menuitemradio", { name: "Night Shift" }));
    await screen.findByRole("heading", { level: 1, name: "Night Shift" });
    expect(app.address()).toBe("/workspace/workspace_nightshift");
    expect(await within(working()).findByText("No agent is at work right now.")).toBeDefined();
  });

  test("leads to members, settings and creating a workspace", async () => {
    const app = await open();
    const menu = () => app.user.click(screen.getByRole("button", { name: "Birchwood Labs, workspace menu" }));
    await screen.findByRole("heading", { level: 1, name: "Birchwood Labs" });
    await menu();
    await app.user.click(await screen.findByRole("menuitem", { name: "Members" }));
    await screen.findByRole("heading", { level: 2, name: "Members" });
    await menu();
    await app.user.click(await screen.findByRole("menuitem", { name: "Settings" }));
    await screen.findByRole("heading", { level: 2, name: "General" });
    await menu();
    await app.user.click(await screen.findByRole("menuitem", { name: "Create a workspace" }));
    await screen.findByRole("heading", { level: 1, name: "Name your workspace" });
  });
});

describe("the account menu", () => {
  const menu = async (app: App, name = "Ana Beatriz Souza, account menu") =>
    app.user.click(await screen.findByRole("button", { name }));

  test("changes the language of everything on screen and remembers it", async () => {
    const app = await open();
    await menu(app);
    await app.user.click(await screen.findByRole("menuitemradio", { name: "Português (Brasil)" }));
    const translated = await screen.findByRole("navigation", { name: "Áreas" });
    expect(within(translated).getByRole("link", { name: "Caixa de entrada, 3 esperando" })).toBeDefined();
    expect(screen.getByText(/2 aprovações esperam por você\./)).toBeDefined();
    expect(document.documentElement.lang).toBe("pt-BR");
    app.unmount();
    await open(HOME, { server: app.server, store: app.runtime.store, languages: ["en-US"] });
    expect(await screen.findByRole("region", { name: "Em atividade" })).toBeDefined();
  });

  test("the language the person picked is the one sent with the calls that follow", async () => {
    const app = await open();
    expect(app.runtime.language.current).toBe("en");
    await menu(app);
    await app.user.click(await screen.findByRole("menuitemradio", { name: "Português (Brasil)" }));
    await screen.findByRole("region", { name: "Em atividade" });
    expect(app.runtime.language.current).toBe("pt-BR");
  });

  test("changes the theme and remembers it", async () => {
    const app = await open();
    await menu(app);
    await app.user.click(await screen.findByRole("menuitemradio", { name: "Dark" }));
    expect(document.documentElement.getAttribute("data-theme")).toBe("dark");
    expect(app.runtime.store.getItem(STORAGE_KEYS.theme)).toBe('"dark"');
    await menu(app);
    await app.user.click(await screen.findByRole("menuitemradio", { name: "System" }));
    expect(document.documentElement.hasAttribute("data-theme")).toBe(false);
  });

  test("a stored theme that is not one is ignored", async () => {
    const app = await open();
    app.unmount();
    app.runtime.store.setItem(STORAGE_KEYS.theme, '"neon"');
    await open(HOME, { server: app.server, store: app.runtime.store });
    await screen.findByRole("heading", { level: 1, name: "Birchwood Labs" });
    expect(document.documentElement.hasAttribute("data-theme")).toBe(false);
  });

  test("shows who is signed in, leads to the profile and signs out", async () => {
    const app = await open();
    await menu(app);
    expect(await screen.findByText("ana@birchwood.example")).toBeDefined();
    await app.user.click(screen.getByRole("menuitem", { name: "Profile" }));
    await screen.findByRole("heading", { level: 2, name: "Profile" });
    await menu(app);
    await app.user.click(await screen.findByRole("menuitem", { name: "Sign out" }));
    expect((await screen.findByRole("status")).textContent).toBe("You signed out.");
    expect(app.address()).toBe("/login?reason=signed_out");
    expect(app.jar.session).toBeUndefined();
  });
});

describe("agents at work", () => {
  test("lists the agents in the middle of a run, each with a lit sigil that says so", async () => {
    await open();
    const lit = await within(working()).findAllByRole("img");
    expect(
      lit.map((sigil) => [sigil.getAttribute("aria-label"), sigil.hasAttribute("data-working")]),
    ).toEqual([
      ["Scout, at work", true],
      ["Ledger, at work", true],
    ]);
    expect(
      within(working())
        .getAllByRole("link")
        .map((link) => link.getAttribute("href")),
    ).toEqual([`${HOME}/agents/agt_scout`, `${HOME}/agents/agt_ledger`]);
  });

  test("follows the workspace in real time, without a reload", async () => {
    const app = await open();
    await within(working()).findByRole("img", { name: "Scout, at work" });
    await act(async () => app.server.setAgentBusy("agt_tally", true));
    await within(working()).findByRole("img", { name: "Tally, at work" });
    await act(async () => {
      for (const id of ["agt_scout", "agt_ledger", "agt_tally"]) app.server.setAgentBusy(id, false);
    });
    expect(await within(working()).findByText("No agent is at work right now.")).toBeDefined();
    expect(screen.getByText(/No agent is at work right now\./, { selector: ".page__lead" })).toBeDefined();
  });

  test("a failure to load the agents says so and can be retried", async () => {
    const server = newServer();
    server.force("listAgents", { kind: "error", status: 403, code: "forbidden" });
    const app = await open(`${HOME}/wiki`, { server });
    expect(await within(working()).findByText("The agents could not be loaded.")).toBeDefined();
    await app.user.click(within(working()).getByRole("button", { name: "Retry" }));
    await within(working()).findByRole("img", { name: "Scout, at work" });
  });

  test("the channel list is a place the chat area fills; until then it says so plainly", async () => {
    await open();
    expect(
      await within(screen.getByRole("region", { name: "Channels" })).findByText(
        "The channel list is not part of this build yet.",
      ),
    ).toBeDefined();
  });
});

describe("a lost connection", () => {
  test("shows the banner, reconnects on request and refetches what may have changed", async () => {
    const app = await open();
    await within(working()).findByRole("img", { name: "Scout, at work" });
    expect(screen.queryByText("Connection lost. Reconnecting.")).toBeNull();
    await act(async () => {
      app.server.blockConnections(true);
      app.server.dropConnections();
    });
    const banner = (await screen.findByText("Connection lost. Reconnecting.")).closest('[role="status"]');
    expect(banner).not.toBeNull();
    // Changed while the web could not hear about it.
    app.server.setAgentBusy("agt_tally", true, false);
    app.server.blockConnections(false);
    const before = calls(app, "listAgents");
    await app.user.click(screen.getByRole("button", { name: "Reconnect now" }));
    await waitFor(() => expect(screen.queryByText("Connection lost. Reconnecting.")).toBeNull());
    await within(working()).findByRole("img", { name: "Tally, at work" });
    expect(calls(app, "listAgents")).toBeGreaterThan(before);
  });

  test("it also comes back on its own, after the first wait", async () => {
    const app = await open();
    await within(working()).findByRole("img", { name: "Scout, at work" });
    await act(async () => app.server.dropConnections());
    await screen.findByText("Connection lost. Reconnecting.");
    await app.advance(500);
    await waitFor(() => expect(screen.queryByText("Connection lost. Reconnecting.")).toBeNull());
  });

  test("one connection serves the frame and the screen in it", async () => {
    const app = await open(`${HOME}/agents`);
    await screen.findByRole("list", { name: "Agents" });
    expect(app.server.openSockets()).toHaveLength(1);
    await app.user.click(within(areas()).getByRole("link", { name: "Wiki" }));
    await screen.findByRole("heading", { level: 1, name: "Wiki" });
    expect(app.server.openSockets()).toHaveLength(1);
  });
});

describe("the sidebar on a small screen", () => {
  test("it is a drawer: closed at first, with the working agents kept in the header", async () => {
    await setViewportWidth(390);
    const app = await open();
    const count = await screen.findByRole("button", { name: "2 agents at work. Open navigation." });
    expect(screen.queryByRole("navigation", { name: "Areas" })).toBeNull();
    expect(screen.queryByRole("complementary")).toBeNull();
    await app.user.click(count);
    const drawer = await screen.findByRole("dialog", { name: "Workspace sidebar" });
    expect(within(drawer).getByRole("navigation", { name: "Areas" })).toBeDefined();
    expect(within(drawer).getByRole("region", { name: "At work" })).toBeDefined();
    expect(within(drawer).getByRole("button", { name: "Ana Beatriz Souza, account menu" })).toBeDefined();
  });

  test("it closes on navigating and on Escape", async () => {
    await setViewportWidth(390);
    const app = await open();
    const toggle = await screen.findByRole("button", { name: "Open navigation" });
    await app.user.click(toggle);
    await app.user.click(within(await screen.findByRole("dialog")).getByRole("link", { name: "Routines" }));
    await screen.findByRole("heading", { level: 1, name: "Routines" });
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    await app.user.click(screen.getByRole("button", { name: "Open navigation" }));
    await screen.findByRole("dialog");
    await app.user.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  });

  test("no working agents, no count in the header", async () => {
    await setViewportWidth(390);
    await open("/workspace/workspace_nightshift");
    await screen.findByRole("heading", { level: 1, name: "Night Shift" });
    expect(screen.queryByRole("button", { name: /at work\. Open navigation\.$/ })).toBeNull();
  });
});

describe("the sidebar on a wide screen", () => {
  test("it can be hidden, the choice is remembered, and the working agents move to the header", async () => {
    const app = await open();
    await within(working()).findByRole("img", { name: "Scout, at work" });
    await app.user.click(screen.getByRole("button", { name: "Hide navigation" }));
    expect(screen.queryByRole("complementary")).toBeNull();
    expect(screen.getByRole("button", { name: "2 agents at work. Open navigation." })).toBeDefined();
    expect(screen.getByRole("button", { name: "Show navigation" }).getAttribute("aria-expanded")).toBe(
      "false",
    );
    app.unmount();
    const again = await open(HOME, { server: app.server, store: app.runtime.store });
    await screen.findByRole("heading", { level: 1, name: "Birchwood Labs" });
    expect(screen.queryByRole("complementary")).toBeNull();
    await again.user.click(screen.getByRole("button", { name: "Show navigation" }));
    expect(screen.getByRole("complementary", { name: "Workspace sidebar" })).toBeDefined();
  });

  test("a stored choice that is not one leaves the sidebar shown", async () => {
    const app = await open();
    app.unmount();
    app.runtime.store.setItem(STORAGE_KEYS.sidebar, '{"hidden":true}');
    await open(HOME, { server: app.server, store: app.runtime.store });
    expect(await screen.findByRole("complementary", { name: "Workspace sidebar" })).toBeDefined();
  });
});

describe("the home of a workspace", () => {
  test("says who works here, who is working and what waits, in sentences", async () => {
    await open();
    expect(
      await screen.findByText(
        "4 people and 3 agents work here. Scout and Ledger are at work. 2 approvals are waiting for you. 38% of this month's agent budget is spent.",
      ),
    ).toBeDefined();
    expect(screen.queryByRole("heading", { level: 2, name: "First steps" })).toBeNull();
  });

  test("a member without the right to see usage is not told the budget", async () => {
    await open(HOME, { signedInAs: "usr_iris" });
    expect(
      await screen.findByText("4 people and 3 agents work here. Scout and Ledger are at work."),
    ).toBeDefined();
  });

  test("a failure to load says so and can be retried", async () => {
    const server = newServer();
    server.force("getOverview", { kind: "error", status: 403, code: "forbidden" });
    const app = await open(HOME, { server });
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("This could not be loaded");
    expect(alert.textContent).toContain("You don't have permission to do that.");
    await app.user.click(within(alert).getByRole("button", { name: "Retry" }));
    await screen.findByText(/4 people and 3 agents work here\./);
  });
});
