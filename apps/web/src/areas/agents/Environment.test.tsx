import { describe, expect, test } from "bun:test";
import { screen, waitFor, within } from "@testing-library/react";
import { chooseOption, newServer, renderApp } from "../../../test/app.tsx";

const tab = (agentId: string) => `/workspace/workspace_birchwood/agents/${agentId}?tab=environment`;

describe("the agent's environment", () => {
  test("where it works, and moving it to another runner", async () => {
    const app = await renderApp({ path: tab("agt_scout"), signedInAs: "usr_ana" });
    expect(await screen.findByText("Works on Studio Mac, which is online.")).toBeDefined();
    await chooseOption(app, screen.getByRole("combobox", { name: "Runner" }), "Shed box (offline)");
    expect(await screen.findByText("Its tools now run on Shed box")).toBeDefined();
    expect(app.server.runnerWork.targets.get("agt_scout")).toBe("rnr_shed");
    expect(await screen.findByText("Works on Shed box, which is offline.")).toBeDefined();
  });

  test("a member sees the runner without changing it", async () => {
    await renderApp({ path: tab("agt_scout"), signedInAs: "usr_iris" });
    await screen.findByText("Works on Studio Mac, which is online.");
    expect(screen.getByRole("combobox", { name: "Runner" }).hasAttribute("disabled")).toBe(true);
  });

  test("no runner to use: the way to pair one", async () => {
    const server = newServer();
    server.runnerWork.runners = [];
    server.runnerWork.targets.clear();
    await renderApp({ path: tab("agt_scout"), signedInAs: "usr_iris", server });
    expect(await screen.findByText("The agent works on no runner.")).toBeDefined();
    expect(screen.getByRole("link", { name: "Pair a runner" }).getAttribute("href")).toBe(
      "/workspace/workspace_birchwood/settings/runners",
    );
  });

  test("secrets show by name; deleting one asks first", async () => {
    const app = await renderApp({ path: tab("agt_scout"), signedInAs: "usr_ana" });
    const secrets = await screen.findByRole("list", { name: "Secrets" });
    expect(secrets.textContent).toContain("PRINT_API_KEY");
    expect(secrets.textContent).toContain("as an environment variable");
    await app.user.click(within(secrets).getByRole("button", { name: "Delete the secret PRINT_API_KEY" }));
    const dialog = await screen.findByRole("alertdialog", { name: "Delete the secret PRINT_API_KEY?" });
    await app.user.click(within(dialog).getByRole("button", { name: "Delete" }));
    expect(await screen.findByText("The secret PRINT_API_KEY was deleted")).toBeDefined();
    expect(await screen.findByText("The agent holds no secrets.")).toBeDefined();
  });

  test("a domain the commands asked for is allowed", async () => {
    const app = await renderApp({ path: tab("agt_scout"), signedInAs: "usr_ana" });
    const domains = await screen.findByRole("list", { name: "Network for commands" });
    expect(domains.textContent).toContain("paper.example.com");
    expect(domains.textContent).toContain("Waiting");
    await app.user.click(within(domains).getByRole("button", { name: "Allow" }));
    expect(await screen.findByText("paper.example.com is allowed")).toBeDefined();
    await waitFor(() =>
      expect(screen.getByRole("list", { name: "Network for commands" }).textContent).toContain("Allowed"),
    );
  });

  test("the browser policy: a site is checked and lowercased, and nothing changes until saved", async () => {
    const app = await renderApp({ path: tab("agt_scout"), signedInAs: "usr_ana" });
    await screen.findByText("No sites on the list.");
    await app.user.type(screen.getByLabelText("Site"), "not a site");
    expect(screen.getByText("That is not a domain, with or without *. in front.")).toBeDefined();
    await app.user.clear(screen.getByLabelText("Site"));
    await app.user.type(screen.getByLabelText("Site"), " Docs.Example.com ");
    await app.user.click(screen.getByRole("button", { name: "Put on the list" }));
    expect(screen.getByRole("list", { name: "Sites" }).textContent).toContain("docs.example.com");
    expect(app.server.runnerWork.browser.get("agt_scout")).toBeUndefined();
    await app.user.type(screen.getByLabelText("Private network ranges"), "8.8.8.8/32");
    expect(screen.getByText("8.8.8.8/32 is not a private range the browser can open.")).toBeDefined();
    expect(screen.getByRole("button", { name: "Save browser policy" }).hasAttribute("disabled")).toBe(true);
    await app.user.clear(screen.getByLabelText("Private network ranges"));
    await app.user.click(screen.getByRole("radio", { name: /^Strict/ }));
    await app.user.click(screen.getByRole("button", { name: "Save browser policy" }));
    expect(await screen.findByText("Browser policy saved")).toBeDefined();
    expect(app.server.runnerWork.browser.get("agt_scout")?.sites).toEqual([
      { pattern: "docs.example.com", access: "read" },
    ]);
    expect(app.server.runnerWork.browser.get("agt_scout")?.level).toBe("strict");
  });

  test("saving the level alone leaves the private ranges where they were", async () => {
    const server = newServer();
    server.runnerWork.browser.set("agt_scout", {
      level: "balanced",
      sites: [],
      permittedDomains: [],
      privateRanges: ["10.0.0.0/8"],
      privateRangesRunnerId: "rnr_shed",
    });
    const app = await renderApp({ path: tab("agt_scout"), signedInAs: "usr_ana", server });
    await screen.findByText(/These ranges belong to Shed box/);
    await app.user.click(screen.getByRole("radio", { name: /^Free/ }));
    await app.user.click(screen.getByRole("button", { name: "Save browser policy" }));
    expect(await screen.findByText("Browser policy saved")).toBeDefined();
    const saved = server.runnerWork.browser.get("agt_scout");
    expect(saved?.level).toBe("free");
    expect(saved?.privateRangesRunnerId).toBe("rnr_shed");
    const sent = server.calls.filter((call) => call.method === "setAgentBrowserPolicy").at(-1)?.params ?? {};
    expect("privateRanges" in sent).toBe(false);
  });

  test("a sensitive site is called out", async () => {
    const app = await renderApp({ path: tab("agt_scout"), signedInAs: "usr_ana" });
    await screen.findByText("No sites on the list.");
    await app.user.type(screen.getByLabelText("Site"), "nubank.com.br");
    expect(screen.getByText(/This site holds sensitive data/)).toBeDefined();
  });

  test("taking over the browser and handing it back", async () => {
    const app = await renderApp({ path: tab("agt_scout"), signedInAs: "usr_iris" });
    expect(await screen.findByText("Nobody is driving the agent's browser.")).toBeDefined();
    await app.user.click(screen.getByRole("button", { name: "Take over the browser" }));
    expect(await screen.findByText("You are driving the agent's browser.")).toBeDefined();
    await app.user.click(screen.getByRole("button", { name: "Give control back" }));
    expect(await screen.findByText("Nobody is driving the agent's browser.")).toBeDefined();
  });

  test("an offline runner says why the browser is not there", async () => {
    const server = newServer();
    const studio = server.runnerWork.runners.find((runner) => runner.id === "rnr_studio");
    if (studio !== undefined) studio.online = false;
    await renderApp({ path: tab("agt_scout"), signedInAs: "usr_iris", server });
    expect(
      await screen.findByText("The agent's runner is offline, so its browser is not running."),
    ).toBeDefined();
    expect(screen.queryByRole("button", { name: "Take over the browser" }) === null).toBe(true);
  });
});
