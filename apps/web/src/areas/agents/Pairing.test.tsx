import { describe, expect, test } from "bun:test";
import { screen } from "@testing-library/react";
import { chooseOption, newServer, renderApp } from "../../../test/app.tsx";

describe("pairing a runner by code", () => {
  test("the person checks the computer, picks the workspace and accepts", async () => {
    const app = await renderApp({ path: "/connect?code=birch7", signedInAs: "usr_ana" });
    await screen.findByRole("heading", { name: "Pair Garage laptop?" });
    const facts = screen.getByLabelText("The computer asking");
    expect(facts.textContent).toContain("BIRCH7");
    expect(facts.textContent).toContain("garage.local");
    expect(facts.textContent).toContain("linux x64");
    expect(screen.getByText("The code expires in 9 minutes.")).toBeDefined();
    const accept = screen.getByRole("button", { name: "Pair it" });
    // Ana is in two workspaces: one has to be picked.
    expect(accept.hasAttribute("disabled")).toBe(true);
    await chooseOption(app, screen.getByRole("combobox", { name: "Workspace" }), "Birchwood Labs");
    await app.user.clear(screen.getByLabelText("Name"));
    expect(accept.hasAttribute("disabled")).toBe(true);
    await app.user.type(screen.getByLabelText("Name"), "Garage");
    await app.user.click(accept);
    await screen.findByRole("heading", { name: "Garage is paired" });
    expect(app.server.runnerWork.pairings[0]?.status).toBe("approved");
    await app.user.click(screen.getByRole("button", { name: "Open the runner" }));
    await screen.findByRole("heading", { level: 1, name: "Garage" });
  });

  test("declining tells the runner", async () => {
    const app = await renderApp({ path: "/connect?code=BIRCH7", signedInAs: "usr_jonas" });
    await app.user.click(await screen.findByRole("button", { name: "Decline" }));
    await screen.findByRole("heading", { name: "The pairing was declined" });
    expect(app.server.runnerWork.pairings[0]?.status).toBe("denied");
  });

  test("a code that expired is typed again", async () => {
    const server = newServer();
    const request = server.runnerWork.pairings[0];
    if (request !== undefined) request.expiresAt = "2026-11-01T00:00:00.000Z";
    const app = await renderApp({ path: "/connect?code=BIRCH7", signedInAs: "usr_ana", server });
    await screen.findByRole("heading", { name: "This code is not valid" });
    if (request !== undefined) request.expiresAt = "2026-12-01T00:00:00.000Z";
    await app.user.click(screen.getByRole("button", { name: "Check the code" }));
    await screen.findByRole("heading", { name: "Pair Garage laptop?" });
  });

  test("someone with no workspace where they may post can neither pair nor decline", async () => {
    await renderApp({ path: "/connect?code=BIRCH7", signedInAs: "usr_noor" });
    await screen.findByRole("heading", { name: "Pair Garage laptop?" });
    expect(screen.getByText("You are not in a workspace where you may pair a runner.")).toBeDefined();
    expect(screen.getByRole("button", { name: "Pair it" }).hasAttribute("disabled")).toBe(true);
    expect(screen.getByRole("button", { name: "Decline" }).hasAttribute("disabled")).toBe(true);
  });

  test("a code with a character no code has asks for it again", async () => {
    await renderApp({ path: "/connect?code=BIRCH-7", signedInAs: "usr_ana" });
    await screen.findByRole("heading", { name: "This code is not valid" });
    expect(screen.getByLabelText("Code")).toBeDefined();
  });

  test("without a code the person types it, trimmed and uppercased", async () => {
    const app = await renderApp({ path: "/connect", signedInAs: "usr_ana" });
    await screen.findByRole("heading", { name: "Pair a runner" });
    await app.user.type(screen.getByLabelText("Code"), "  birch7 ");
    await app.user.click(screen.getByRole("button", { name: "Check the code" }));
    await screen.findByRole("heading", { name: "Pair Garage laptop?" });
    expect(app.address()).toBe("/connect?code=BIRCH7");
  });
});
