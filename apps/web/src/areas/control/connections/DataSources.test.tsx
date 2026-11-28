// The Data sources section of the settings, against the fake server: Birchwood's mailboxes and
// databases. Jonas is an admin there, Íris a member.
import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { act, fireEvent, screen, waitFor, within } from "@testing-library/react";
import type { FakeDatabase, FakeMailAccount } from "../../../../dev/fake-connections.ts";
import { type App, chooseOption, newServer, renderApp } from "../../../../test/app.tsx";

const WS = "workspace_birchwood";
const PATH = `/workspace/${WS}/settings/data-sources`;

let left: string[] = [];
let assign: ReturnType<typeof spyOn>;
beforeEach(() => {
  left = [];
  assign = spyOn(window.location, "assign").mockImplementation((url: string | URL) => {
    left.push(String(url));
  });
});
afterEach(() => assign.mockRestore());

const row = (list: HTMLElement, text: string) => {
  const found = within(list)
    .getAllByRole("listitem")
    .find((item) => item.textContent?.includes(text));
  if (found === undefined) throw new Error(`no row for ${text}`);
  return found;
};
/** Nothing the app keeps (the address, the call cache, the browser's storage) holds this text. */
const keptNowhere = (app: App, secret: string) => {
  const cached = JSON.stringify([
    app.runtime.queryClient
      .getMutationCache()
      .getAll()
      .map((each) => each.state.variables),
    app.runtime.queryClient
      .getQueryCache()
      .getAll()
      .map((each) => each.state.data),
    { ...localStorage, ...sessionStorage },
  ]);
  return !cached.includes(secret) && !app.address().includes(secret);
};
const mailbox = (patch: Partial<FakeMailAccount> = {}): FakeMailAccount => ({
  id: "mail_orders",
  workspaceId: WS,
  address: "orders@birchwood.example",
  label: "Orders",
  preset: "gmail",
  provider: "gmail",
  via: "imap",
  status: "active",
  agents: [{ agentId: "agt_scout", level: "read" }],
  confirmActions: [],
  disabledActions: [],
  ...patch,
});
const database = (patch: Partial<FakeDatabase> = {}): FakeDatabase => ({
  id: "dbc_shop",
  workspaceId: WS,
  label: "Shop",
  provider: "supabase",
  host: "db.shop.example",
  port: 5432,
  database: "shop",
  username: "reader",
  sslmode: "require",
  status: "active",
  canWrite: false,
  hiddenSuggestion: [],
  disabledActions: [],
  agents: [],
  ...patch,
});

describe("mailboxes", () => {
  const boxes = () => screen.findByRole("region", { name: "Mailboxes" });

  test("a member is kept out of the section", async () => {
    await renderApp({ path: PATH, signedInAs: "usr_iris" });
    expect(await screen.findByText("This section is for admins")).toBeDefined();
    expect(screen.queryByRole("region", { name: "Mailboxes" }) === null).toBe(true);
  });

  test("an admin connects a Gmail mailbox with an app password that is kept nowhere", async () => {
    const app = await renderApp({ path: PATH, signedInAs: "usr_jonas" });
    expect(await within(await boxes()).findByText("No mailboxes yet")).toBeDefined();
    await app.user.click(within(await boxes()).getByRole("button", { name: "Connect a mailbox" }));
    const form = await screen.findByRole("form", { name: "Connect with a password" });
    expect(within(form).getByRole("link", { name: "Make an app password on Gmail" })).toBeDefined();
    await app.user.type(within(form).getByLabelText(/^Email address/), "orders@birchwood.example");
    await app.user.type(within(form).getByLabelText(/^App password/), "abcd efgh ijkl");
    await app.user.click(within(form).getByRole("button", { name: "Connect" }));
    expect(await screen.findByText("orders@birchwood.example is connected.")).toBeDefined();
    const list = within(await boxes()).getByRole("list", { name: "Mailboxes" });
    expect(within(row(list, "orders@birchwood.example")).getByText("Connected")).toBeDefined();
    expect(within(row(list, "orders@birchwood.example")).getByText("No agents")).toBeDefined();
    expect(app.server.calls.find((call) => call.method === "createMailAccountImap")?.params.password).toBe(
      "abcd efgh ijkl",
    );
    expect(keptNowhere(app, "abcd efgh ijkl")).toBe(true);
  });

  test("another provider needs both servers and real ports", async () => {
    const app = await renderApp({ path: PATH, signedInAs: "usr_jonas" });
    await app.user.click(within(await boxes()).getByRole("button", { name: "Connect a mailbox" }));
    const form = await screen.findByRole("form", { name: "Connect with a password" });
    await chooseOption(app, within(form).getByRole("combobox", { name: "Provider" }), "Another provider");
    await app.user.type(within(form).getByLabelText(/^Email address/), "desk@birchwood.example");
    await app.user.type(within(form).getByLabelText(/^App password/), "secret-1");
    const connect = within(form).getByRole("button", { name: "Connect" });
    expect(connect.hasAttribute("disabled")).toBe(true);
    await app.user.type(within(form).getByLabelText(/^Incoming server/), "imap.birchwood.example");
    await app.user.type(within(form).getByLabelText(/^Outgoing server/), "smtp.birchwood.example");
    const imapPort = within(form).getByLabelText(/^IMAP port/);
    await app.user.clear(imapPort);
    await app.user.type(imapPort, "99999");
    expect(within(form).getByText("A port is a whole number from 1 to 65535.")).toBeDefined();
    expect(connect.hasAttribute("disabled")).toBe(true);
    await app.user.clear(imapPort);
    await app.user.type(imapPort, "143");
    await app.user.click(connect);
    expect(await screen.findByText("desk@birchwood.example is connected.")).toBeDefined();
    const sent = app.server.calls.find((call) => call.method === "createMailAccountImap")?.params;
    expect([sent?.preset, sent?.imapHost, sent?.imapPort, sent?.smtpHost, sent?.smtpPort]).toEqual([
      "other",
      "imap.birchwood.example",
      143,
      "smtp.birchwood.example",
      587,
    ]);
  });

  test("a refused password says why and connects nothing", async () => {
    const app = await renderApp({ path: PATH, signedInAs: "usr_jonas" });
    await app.user.click(within(await boxes()).getByRole("button", { name: "Connect a mailbox" }));
    const form = await screen.findByRole("form", { name: "Connect with a password" });
    await app.user.type(within(form).getByLabelText(/^Email address/), "orders@birchwood.example");
    await app.user.type(within(form).getByLabelText(/^App password/), "wrong-password");
    await app.user.click(within(form).getByRole("button", { name: "Connect" }));
    expect((await within(form).findByRole("alert")).textContent).toBe(
      "The mail server refused that address and password.",
    );
    expect(app.server.connections.mail.length).toBe(0);
  });

  test("signing in with a hosted provider leaves for it", async () => {
    const app = await renderApp({ path: PATH, signedInAs: "usr_jonas" });
    await app.user.click(within(await boxes()).getByRole("button", { name: "Connect a mailbox" }));
    await app.user.click(await screen.findByRole("button", { name: "Sign in with Gmail" }));
    await act(async () => {});
    expect(left).toEqual(["https://gmail.example/consent"]);
  });

  test("coming back from a hosted sign-in lands here and says so once", async () => {
    const app = await renderApp({
      path: `/workspace/${WS}/settings/connectors?mail_connected=mail_new`,
      signedInAs: "usr_jonas",
    });
    expect(await screen.findByText("The mailbox is connected.")).toBeDefined();
    expect(app.address()).toBe(PATH);
    await renderApp({ path: `${PATH}?mail_error=denied`, signedInAs: "usr_jonas" });
    expect(await screen.findByText("The provider did not give access to the mailbox.")).toBeDefined();
  });

  test("an admin decides which actions wait for a person and which never happen", async () => {
    const server = newServer();
    server.connections.mail.push(mailbox());
    const app = await renderApp({ path: PATH, signedInAs: "usr_jonas", server });
    const list = await within(await boxes()).findByRole("list", { name: "Mailboxes" });
    expect(within(row(list, "Orders")).getByText("1 agent")).toBeDefined();
    await app.user.click(
      within(row(list, "Orders")).getByRole("button", { name: "Edit orders@birchwood.example" }),
    );
    const form = await screen.findByRole("form", { name: "Edit orders@birchwood.example" });
    await chooseOption(
      app,
      within(form).getByRole("combobox", { name: "Rule for: Send a new message" }),
      "A person approves first",
    );
    await chooseOption(app, within(form).getByRole("combobox", { name: "Rule for: Delete" }), "Never");
    await app.user.click(within(form).getByRole("button", { name: "Save mailbox" }));
    expect(await screen.findByText("orders@birchwood.example is saved.")).toBeDefined();
    const saved = server.connections.mail[0];
    expect([saved?.confirmActions, saved?.disabledActions]).toEqual([["send"], ["delete"]]);
    expect(
      app.server.calls.find((call) => call.method === "updateMailAccount")?.params.password,
    ).toBeUndefined();
  });

  test("a mailbox whose password was refused needs a new one to be saved", async () => {
    const server = newServer();
    server.connections.mail.push(mailbox({ status: "reauth_required" }));
    const app = await renderApp({ path: PATH, signedInAs: "usr_jonas", server });
    const list = await within(await boxes()).findByRole("list", { name: "Mailboxes" });
    expect(within(row(list, "Orders")).getByText("Password refused")).toBeDefined();
    await app.user.click(
      within(row(list, "Orders")).getByRole("button", { name: "Edit orders@birchwood.example" }),
    );
    const form = await screen.findByRole("form", { name: "Edit orders@birchwood.example" });
    const save = within(form).getByRole("button", { name: "Save mailbox" });
    expect(save.hasAttribute("disabled")).toBe(true);
    await app.user.type(within(form).getByLabelText(/^New password/), "fresh-pass");
    await app.user.click(save);
    expect(await screen.findByText("orders@birchwood.example is saved.")).toBeDefined();
    expect(server.connections.mail[0]?.status).toBe("active");
    expect(keptNowhere(app, "fresh-pass")).toBe(true);
  });

  test("a refused new password saves none of the other changes", async () => {
    const server = newServer();
    server.connections.mail.push(mailbox());
    const app = await renderApp({ path: PATH, signedInAs: "usr_jonas", server });
    const list = await within(await boxes()).findByRole("list", { name: "Mailboxes" });
    await app.user.click(
      within(row(list, "Orders")).getByRole("button", { name: "Edit orders@birchwood.example" }),
    );
    const form = await screen.findByRole("form", { name: "Edit orders@birchwood.example" });
    await chooseOption(app, within(form).getByRole("combobox", { name: "Rule for: Delete" }), "Never");
    await app.user.type(within(form).getByLabelText(/^New password/), "wrong-password");
    await app.user.click(within(form).getByRole("button", { name: "Save mailbox" }));
    expect((await within(form).findByRole("alert")).textContent).toBe(
      "The mail server refused that address and password.",
    );
    expect(server.connections.mail[0]?.disabledActions).toEqual([]);
  });

  test("access lost while connecting closes the dialog and says so", async () => {
    const server = newServer();
    server.force("createMailAccountImap", { kind: "error", status: 403, code: "forbidden" });
    const app = await renderApp({ path: PATH, signedInAs: "usr_jonas", server });
    await app.user.click(within(await boxes()).getByRole("button", { name: "Connect a mailbox" }));
    const form = await screen.findByRole("form", { name: "Connect with a password" });
    await app.user.type(within(form).getByLabelText(/^Email address/), "orders@birchwood.example");
    await app.user.type(within(form).getByLabelText(/^App password/), "abcd efgh ijkl");
    await app.user.click(within(form).getByRole("button", { name: "Connect" }));
    expect(await screen.findByText("You don't have permission to do that.")).toBeDefined();
    expect(screen.queryByRole("dialog", { name: "Connect a mailbox" }) === null).toBe(true);
  });

  test("the dialog stays open while a mailbox connects", async () => {
    const server = newServer();
    const held = server.hold("createMailAccountImap");
    const app = await renderApp({ path: PATH, signedInAs: "usr_jonas", server });
    await app.user.click(within(await boxes()).getByRole("button", { name: "Connect a mailbox" }));
    const form = await screen.findByRole("form", { name: "Connect with a password" });
    await app.user.type(within(form).getByLabelText(/^Email address/), "orders@birchwood.example");
    await app.user.type(within(form).getByLabelText(/^App password/), "abcd efgh ijkl");
    await app.user.click(within(form).getByRole("button", { name: "Connect" }));
    await app.user.keyboard("{Escape}");
    expect(screen.getByRole("dialog", { name: "Connect a mailbox" })).toBeDefined();
    held.release();
    expect(await screen.findByText("orders@birchwood.example is connected.")).toBeDefined();
  });

  test("saving only a new password leaves the action rules alone", async () => {
    const server = newServer();
    server.connections.mail.push(mailbox({ confirmActions: ["send"] }));
    const app = await renderApp({ path: PATH, signedInAs: "usr_jonas", server });
    const list = await within(await boxes()).findByRole("list", { name: "Mailboxes" });
    await app.user.click(
      within(row(list, "Orders")).getByRole("button", { name: "Edit orders@birchwood.example" }),
    );
    const form = await screen.findByRole("form", { name: "Edit orders@birchwood.example" });
    await app.user.type(within(form).getByLabelText(/^New password/), "fresh-pass");
    await app.user.click(within(form).getByRole("button", { name: "Save mailbox" }));
    expect(await screen.findByText("orders@birchwood.example is saved.")).toBeDefined();
    const sent = app.server.calls.find((call) => call.method === "updateMailAccount")?.params;
    expect([sent?.confirmActions, sent?.disabledActions]).toEqual([undefined, undefined]);
  });

  test("a mailbox the person can no longer see closes its dialog for good", async () => {
    const server = newServer();
    server.connections.mail.push(mailbox());
    const app = await renderApp({ path: PATH, signedInAs: "usr_jonas", server });
    const list = await within(await boxes()).findByRole("list", { name: "Mailboxes" });
    await app.user.click(
      within(row(list, "Orders")).getByRole("button", { name: "Edit orders@birchwood.example" }),
    );
    await screen.findByRole("form", { name: "Edit orders@birchwood.example" });
    server.force("listMailAccounts", { kind: "error", status: 403, code: "forbidden" }, 4);
    await act(async () => {
      await app.runtime.queryClient.refetchQueries();
    });
    expect(await within(await boxes()).findByText("The mailboxes could not be loaded")).toBeDefined();
    expect(screen.queryByRole("form", { name: "Edit orders@birchwood.example" }) === null).toBe(true);
    server.unforce("listMailAccounts");
    await act(async () => {
      await app.runtime.queryClient.refetchQueries();
    });
    expect(await within(await boxes()).findByRole("list", { name: "Mailboxes" })).toBeDefined();
    expect(screen.queryByRole("form", { name: "Edit orders@birchwood.example" }) === null).toBe(true);
  });

  test("each connection attempt shows its own failure", async () => {
    const server = newServer();
    server.force("createMailAccountComposio", {
      kind: "error",
      status: 400,
      code: "mail.composio_unavailable",
    });
    const app = await renderApp({ path: PATH, signedInAs: "usr_jonas", server });
    await app.user.click(within(await boxes()).getByRole("button", { name: "Connect a mailbox" }));
    const form = await screen.findByRole("form", { name: "Connect with a password" });
    await app.user.type(within(form).getByLabelText(/^Email address/), "orders@birchwood.example");
    await app.user.type(within(form).getByLabelText(/^App password/), "wrong-password");
    await app.user.click(within(form).getByRole("button", { name: "Connect" }));
    expect((await within(form).findByRole("alert")).textContent).toBe(
      "The mail server refused that address and password.",
    );
    await app.user.click(screen.getByRole("button", { name: "Sign in with Gmail" }));
    expect(
      await within(form).findByText("Signing in with this provider is not set up on this server."),
    ).toBeDefined();
    expect(within(form).queryByText("The mail server refused that address and password.") === null).toBe(
      true,
    );
  });

  test("a rule another admin set while the dialog was open survives a save of other things", async () => {
    const server = newServer();
    server.connections.mail.push(mailbox());
    const app = await renderApp({ path: PATH, signedInAs: "usr_jonas", server });
    const list = await within(await boxes()).findByRole("list", { name: "Mailboxes" });
    await app.user.click(
      within(row(list, "Orders")).getByRole("button", { name: "Edit orders@birchwood.example" }),
    );
    const form = await screen.findByRole("form", { name: "Edit orders@birchwood.example" });
    // Meanwhile someone else stops agents from sending, and the list reloads with the dialog open.
    const account = server.connections.mail[0];
    if (account === undefined) throw new Error("no mailbox");
    account.disabledActions = ["send"];
    await act(async () => {
      await app.runtime.queryClient.refetchQueries();
    });
    await app.user.type(within(form).getByLabelText(/^New password/), "fresh-pass");
    await app.user.click(within(form).getByRole("button", { name: "Save mailbox" }));
    expect(await screen.findByText("orders@birchwood.example is saved.")).toBeDefined();
    expect(server.connections.mail[0]?.disabledActions).toEqual(["send"]);
    // A rule this person changes goes, and the other admin's stays.
    await app.user.click(
      within(row(list, "Orders")).getByRole("button", { name: "Edit orders@birchwood.example" }),
    );
    const again = await screen.findByRole("form", { name: "Edit orders@birchwood.example" });
    account.disabledActions = ["send", "forward"];
    await act(async () => {
      await app.runtime.queryClient.refetchQueries();
    });
    await chooseOption(app, within(again).getByRole("combobox", { name: "Rule for: Delete" }), "Never");
    await app.user.click(within(again).getByRole("button", { name: "Save mailbox" }));
    expect((await screen.findAllByText("orders@birchwood.example is saved.")).length).toBeGreaterThan(0);
    expect([...(server.connections.mail[0]?.disabledActions ?? [])].sort()).toEqual([
      "delete",
      "forward",
      "send",
    ]);
  });

  test("a mailbox rule another admin changed while the dialog is open shows, and can be changed back", async () => {
    const server = newServer();
    server.connections.mail.push(mailbox());
    const app = await renderApp({ path: PATH, signedInAs: "usr_jonas", server });
    const list = await within(await boxes()).findByRole("list", { name: "Mailboxes" });
    await app.user.click(
      within(row(list, "Orders")).getByRole("button", { name: "Edit orders@birchwood.example" }),
    );
    const form = await screen.findByRole("form", { name: "Edit orders@birchwood.example" });
    const account = server.connections.mail[0];
    if (account === undefined) throw new Error("no mailbox");
    account.confirmActions = ["send"];
    await act(async () => {
      await app.runtime.queryClient.refetchQueries();
    });
    await waitFor(() =>
      expect(within(form).getByRole("combobox", { name: "Rule for: Send a new message" }).textContent).toBe(
        "A person approves first",
      ),
    );
    const send = within(form).getByRole("combobox", { name: "Rule for: Send a new message" });
    await chooseOption(app, send, "Allowed");
    await app.user.click(within(form).getByRole("button", { name: "Save mailbox" }));
    expect(await screen.findByText("orders@birchwood.example is saved.")).toBeDefined();
    expect(server.connections.mail[0]?.confirmActions).toEqual([]);
  });

  test("a rename another admin made while the dialog was open is kept when the person saves something else", async () => {
    const server = newServer();
    server.connections.mail.push(mailbox());
    const app = await renderApp({ path: PATH, signedInAs: "usr_jonas", server });
    const list = await within(await boxes()).findByRole("list", { name: "Mailboxes" });
    await app.user.click(
      within(row(list, "Orders")).getByRole("button", { name: "Edit orders@birchwood.example" }),
    );
    const form = await screen.findByRole("form", { name: "Edit orders@birchwood.example" });
    const account = server.connections.mail[0];
    if (account === undefined) throw new Error("no mailbox");
    account.label = "Orders desk";
    await act(async () => {
      await app.runtime.queryClient.refetchQueries();
    });
    await waitFor(() => expect(within(list).getByText("Orders desk")).toBeDefined());
    await app.user.type(within(form).getByLabelText(/^New password/), "fresh-pass");
    await app.user.click(within(form).getByRole("button", { name: "Save mailbox" }));
    expect(await screen.findByText("orders@birchwood.example is saved.")).toBeDefined();
    expect(server.connections.mail[0]?.label).toBe("Orders desk");
  });

  test("a rule set and set back is no change, even after another admin changed it", async () => {
    const server = newServer();
    server.connections.mail.push(mailbox());
    const app = await renderApp({ path: PATH, signedInAs: "usr_jonas", server });
    const list = await within(await boxes()).findByRole("list", { name: "Mailboxes" });
    await app.user.click(
      within(row(list, "Orders")).getByRole("button", { name: "Edit orders@birchwood.example" }),
    );
    const form = await screen.findByRole("form", { name: "Edit orders@birchwood.example" });
    await chooseOption(app, within(form).getByRole("combobox", { name: "Rule for: Delete" }), "Never");
    await chooseOption(app, within(form).getByRole("combobox", { name: "Rule for: Delete" }), "Allowed");
    const account = server.connections.mail[0];
    if (account === undefined) throw new Error("no mailbox");
    account.disabledActions = ["delete"];
    await act(async () => {
      await app.runtime.queryClient.refetchQueries();
    });
    await waitFor(() =>
      expect(within(form).getByRole("combobox", { name: "Rule for: Delete" }).textContent).toBe("Never"),
    );
    await chooseOption(
      app,
      within(form).getByRole("combobox", { name: "Rule for: Send a new message" }),
      "A person approves first",
    );
    await app.user.click(within(form).getByRole("button", { name: "Save mailbox" }));
    expect(await screen.findByText("orders@birchwood.example is saved.")).toBeDefined();
    expect([server.connections.mail[0]?.disabledActions, server.connections.mail[0]?.confirmActions]).toEqual(
      [["delete"], ["send"]],
    );
  });

  test("a refusal from the mail server's network rule says what it is about", async () => {
    const server = newServer();
    server.connections.plaintextAllowed = false;
    // A mail host that only speaks plain text, as the server finds out when it tries TLS.
    server.connections.plainHosts.add("imap.birchwood.example");
    server.connections.blockedHosts.add("imap.internal");
    const app = await renderApp({ path: PATH, signedInAs: "usr_jonas", server });
    await app.user.click(within(await boxes()).getByRole("button", { name: "Connect a mailbox" }));
    const form = await screen.findByRole("form", { name: "Connect with a password" });
    await chooseOption(app, within(form).getByRole("combobox", { name: "Provider" }), "Another provider");
    await app.user.type(within(form).getByLabelText(/^Email address/), "desk@birchwood.example");
    await app.user.type(within(form).getByLabelText(/^App password/), "secret-1");
    await app.user.type(within(form).getByLabelText(/^Incoming server/), "imap.birchwood.example");
    await app.user.type(within(form).getByLabelText(/^Outgoing server/), "smtp.birchwood.example");
    await app.user.click(within(form).getByRole("button", { name: "Connect" }));
    expect((await within(form).findByRole("alert")).textContent).toBe(
      "This server only connects to mail servers over an encrypted (TLS) connection. Use the encrypted ports, such as 993 and 465.",
    );
    const imapHost = within(form).getByLabelText(/^Incoming server/);
    await app.user.clear(imapHost);
    await app.user.type(imapHost, "imap.internal");
    await app.user.click(within(form).getByRole("button", { name: "Connect" }));
    expect(
      await within(form).findByText(
        "That mail server is on a private network, which this server does not allow.",
      ),
    ).toBeDefined();
  });

  test("a hosted sign-in that can't start says so", async () => {
    const server = newServer();
    server.connections.hostedMailDown = true;
    const app = await renderApp({ path: PATH, signedInAs: "usr_jonas", server });
    await app.user.click(within(await boxes()).getByRole("button", { name: "Connect a mailbox" }));
    await app.user.click(await screen.findByRole("button", { name: "Sign in with Gmail" }));
    expect(
      await screen.findByText("The sign-in with the provider could not start. Try again in a moment."),
    ).toBeDefined();
    expect(left).toEqual([]);
  });

  test("two quick presses on Disconnect remove the mailbox once", async () => {
    const server = newServer();
    server.connections.mail.push(mailbox());
    const app = await renderApp({ path: PATH, signedInAs: "usr_jonas", server });
    const list = await within(await boxes()).findByRole("list", { name: "Mailboxes" });
    await app.user.click(
      within(row(list, "Orders")).getByRole("button", { name: "Disconnect orders@birchwood.example" }),
    );
    const confirm = await screen.findByRole("alertdialog", { name: "Disconnect orders@birchwood.example?" });
    const yes = within(confirm).getByRole("button", { name: "Disconnect" });
    await act(async () => {
      fireEvent.click(yes);
      fireEvent.click(yes);
    });
    expect(await screen.findByText("orders@birchwood.example is disconnected.")).toBeDefined();
    expect(app.server.calls.filter((call) => call.method === "deleteMailAccount").length).toBe(1);
  });

  test("disconnecting asks first", async () => {
    const server = newServer();
    server.connections.mail.push(mailbox());
    const app = await renderApp({ path: PATH, signedInAs: "usr_jonas", server });
    const list = await within(await boxes()).findByRole("list", { name: "Mailboxes" });
    await app.user.click(
      within(row(list, "Orders")).getByRole("button", { name: "Disconnect orders@birchwood.example" }),
    );
    const confirm = await screen.findByRole("alertdialog", { name: "Disconnect orders@birchwood.example?" });
    await app.user.click(within(confirm).getByRole("button", { name: "Disconnect" }));
    expect(await screen.findByText("orders@birchwood.example is disconnected.")).toBeDefined();
    expect(server.connections.mail.length).toBe(0);
  });
});

describe("databases", () => {
  const block = () => screen.findByRole("region", { name: "Databases" });

  test("an admin connects one by its connection string; the string is kept nowhere", async () => {
    const app = await renderApp({ path: PATH, signedInAs: "usr_jonas" });
    expect(await within(await block()).findByText("No databases yet")).toBeDefined();
    await app.user.click(within(await block()).getByRole("button", { name: "Connect a database" }));
    const form = await screen.findByRole("form", { name: "Connect a database" });
    const secret = "postgres://reader:s3cret@db.shop.example:5432/shop";
    await app.user.type(within(form).getByLabelText(/^Connection string/), secret);
    expect(within(form).getByRole("combobox", { name: "Encryption" }).textContent).toBe("Encrypted");
    await app.user.click(within(form).getByRole("button", { name: "Connect" }));
    expect(await screen.findByText("shop @ db.shop.example is connected.")).toBeDefined();
    const sent = app.server.calls.find((call) => call.method === "createDatabase")?.params;
    expect([sent?.url, sent?.sslmode, sent?.provider]).toEqual([secret, "require", "supabase"]);
    const list = within(await block()).getByRole("list", { name: "Databases" });
    const shop = row(list, "shop @ db.shop.example");
    expect(within(shop).getByText("Supabase: reader at db.shop.example, database shop")).toBeDefined();
    expect(
      within(shop).getByText(
        "Columns that look private: public.customers.card_number. Hide them on each agent.",
      ),
    ).toBeDefined();
    expect(keptNowhere(app, "s3cret")).toBe(true);
  });

  test("by fields, the port is checked and the certificate can be checked too", async () => {
    const app = await renderApp({ path: PATH, signedInAs: "usr_jonas" });
    await app.user.click(within(await block()).getByRole("button", { name: "Connect a database" }));
    const form = await screen.findByRole("form", { name: "Connect a database" });
    await app.user.click(within(form).getByRole("radio", { name: /Separate fields/ }));
    await app.user.type(within(form).getByRole("textbox", { name: /^Host(?! on)/ }), "pg.birchwood.example");
    await app.user.type(within(form).getByLabelText(/^Database/), "ledger");
    await app.user.type(within(form).getByLabelText(/^User/), "auditor");
    await app.user.type(within(form).getByLabelText(/^Password/), "pw-123");
    const port = within(form).getByLabelText(/^Port/);
    await app.user.clear(port);
    await app.user.type(port, "0");
    expect(within(form).getByText("A port is a whole number from 1 to 65535.")).toBeDefined();
    expect(within(form).getByRole("button", { name: "Connect" }).hasAttribute("disabled")).toBe(true);
    await app.user.clear(port);
    await app.user.type(port, "6543");
    await chooseOption(
      app,
      within(form).getByRole("combobox", { name: "Encryption" }),
      "Encrypted, and the certificate checked",
    );
    await app.user.click(within(form).getByRole("button", { name: "Connect" }));
    expect(await screen.findByText("ledger @ pg.birchwood.example is connected.")).toBeDefined();
    const sent = app.server.calls.find((call) => call.method === "createDatabase")?.params;
    expect([sent?.host, sent?.port, sent?.database, sent?.username, sent?.sslmode]).toEqual([
      "pg.birchwood.example",
      6543,
      "ledger",
      "auditor",
      "verify-full",
    ]);
    expect(sent?.url).toBeUndefined();
  });

  test("the way to connect can't change while a connection is on its way", async () => {
    const server = newServer();
    const held = server.hold("createDatabase");
    const app = await renderApp({ path: PATH, signedInAs: "usr_jonas", server });
    await app.user.click(within(await block()).getByRole("button", { name: "Connect a database" }));
    const form = await screen.findByRole("form", { name: "Connect a database" });
    await app.user.type(
      within(form).getByLabelText(/^Connection string/),
      "postgres://r:p@db.shop.example/shop",
    );
    await app.user.click(within(form).getByRole("button", { name: "Connect" }));
    const fields = within(form).getByRole("radio", { name: /Separate fields/ });
    expect(fields.hasAttribute("disabled")).toBe(true);
    held.release();
    expect(await screen.findByText("shop @ db.shop.example is connected.")).toBeDefined();
  });

  test("an sslmode written in the string is the one sent, whatever the choice below", async () => {
    const app = await renderApp({ path: PATH, signedInAs: "usr_jonas" });
    await app.user.click(within(await block()).getByRole("button", { name: "Connect a database" }));
    const form = await screen.findByRole("form", { name: "Connect a database" });
    await app.user.type(
      within(form).getByLabelText(/^Connection string/),
      "postgres://r:p@db.shop.example/shop?sslmode=require",
    );
    await chooseOption(
      app,
      within(form).getByRole("combobox", { name: "Encryption" }),
      "Not encrypted (only where this server allows it)",
    );
    await app.user.click(within(form).getByRole("button", { name: "Connect" }));
    expect(await screen.findByText("shop @ db.shop.example is connected.")).toBeDefined();
    expect(app.server.calls.find((call) => call.method === "createDatabase")?.params.sslmode).toBe("require");
  });

  test("a string with an escape that does not decode is refused as not a URL", async () => {
    const app = await renderApp({ path: PATH, signedInAs: "usr_jonas" });
    await app.user.click(within(await block()).getByRole("button", { name: "Connect a database" }));
    const form = await screen.findByRole("form", { name: "Connect a database" });
    await app.user.type(
      within(form).getByLabelText(/^Connection string/),
      "postgres://r:p@db.shop.example/ledger%ZZ",
    );
    await app.user.click(within(form).getByRole("button", { name: "Connect" }));
    expect((await within(form).findByRole("alert")).textContent).toBe(
      "Use a connection string that starts with postgres://.",
    );
  });

  test("renaming a database leaves its action list alone", async () => {
    const server = newServer();
    server.connections.databases.push(database());
    const app = await renderApp({ path: PATH, signedInAs: "usr_jonas", server });
    const list = await within(await block()).findByRole("list", { name: "Databases" });
    await app.user.click(within(row(list, "Shop")).getByRole("button", { name: "Edit Shop" }));
    const form = await screen.findByRole("form", { name: "Edit Shop" });
    const name = within(form).getByLabelText(/^Name/);
    await app.user.clear(name);
    await app.user.type(name, "Shop replica");
    await app.user.click(within(form).getByRole("button", { name: "Save database" }));
    expect(await screen.findByText("Shop replica is saved.")).toBeDefined();
    expect(
      app.server.calls.find((call) => call.method === "updateDatabase")?.params.disabledActions,
    ).toBeUndefined();
  });

  test("a database action another admin turned off while the dialog was open stays off", async () => {
    const server = newServer();
    server.connections.databases.push(database());
    const app = await renderApp({ path: PATH, signedInAs: "usr_jonas", server });
    const list = await within(await block()).findByRole("list", { name: "Databases" });
    await app.user.click(within(row(list, "Shop")).getByRole("button", { name: "Edit Shop" }));
    const form = await screen.findByRole("form", { name: "Edit Shop" });
    const shop = server.connections.databases[0];
    if (shop === undefined) throw new Error("no database");
    shop.disabledActions = ["query"];
    await act(async () => {
      await app.runtime.queryClient.refetchQueries();
    });
    await app.user.click(within(form).getByRole("checkbox", { name: "List the tables" }));
    await app.user.click(within(form).getByRole("button", { name: "Save database" }));
    expect(await screen.findByText("Shop is saved.")).toBeDefined();
    expect([...(server.connections.databases[0]?.disabledActions ?? [])].sort()).toEqual(["query", "tables"]);
  });

  test("a change another admin made while the dialog is open shows, and can be changed back", async () => {
    const server = newServer();
    server.connections.databases.push(database());
    const app = await renderApp({ path: PATH, signedInAs: "usr_jonas", server });
    const list = await within(await block()).findByRole("list", { name: "Databases" });
    await app.user.click(within(row(list, "Shop")).getByRole("button", { name: "Edit Shop" }));
    const form = await screen.findByRole("form", { name: "Edit Shop" });
    const query = within(form).getByRole("checkbox", { name: "Run read-only queries" });
    expect(query.getAttribute("aria-checked")).toBe("true");
    const shop = server.connections.databases[0];
    if (shop === undefined) throw new Error("no database");
    shop.disabledActions = ["query"];
    await act(async () => {
      await app.runtime.queryClient.refetchQueries();
    });
    await waitFor(() =>
      expect(
        within(form).getByRole("checkbox", { name: "Run read-only queries" }).getAttribute("aria-checked"),
      ).toBe("false"),
    );
    await app.user.click(within(form).getByRole("checkbox", { name: "Run read-only queries" }));
    await app.user.click(within(form).getByRole("button", { name: "Save database" }));
    expect(await screen.findByText("Shop is saved.")).toBeDefined();
    expect(server.connections.databases[0]?.disabledActions).toEqual([]);
  });

  test("a database rename another admin made while the dialog was open is kept", async () => {
    const server = newServer();
    server.connections.databases.push(database());
    const app = await renderApp({ path: PATH, signedInAs: "usr_jonas", server });
    const list = await within(await block()).findByRole("list", { name: "Databases" });
    await app.user.click(within(row(list, "Shop")).getByRole("button", { name: "Edit Shop" }));
    const form = await screen.findByRole("form", { name: "Edit Shop" });
    const shop = server.connections.databases[0];
    if (shop === undefined) throw new Error("no database");
    shop.label = "Shop replica";
    await act(async () => {
      await app.runtime.queryClient.refetchQueries();
    });
    await waitFor(() => expect(within(list).getByText("Shop replica")).toBeDefined());
    await app.user.click(within(form).getByRole("checkbox", { name: "List the tables" }));
    await app.user.click(within(form).getByRole("button", { name: "Save database" }));
    expect(await screen.findByText("Shop replica is saved.")).toBeDefined();
    expect(server.connections.databases[0]?.label).toBe("Shop replica");
  });

  test("a database action toggled and toggled back is no change, even after another admin changed it", async () => {
    const server = newServer();
    server.connections.databases.push(database());
    const app = await renderApp({ path: PATH, signedInAs: "usr_jonas", server });
    const list = await within(await block()).findByRole("list", { name: "Databases" });
    await app.user.click(within(row(list, "Shop")).getByRole("button", { name: "Edit Shop" }));
    const form = await screen.findByRole("form", { name: "Edit Shop" });
    const query = () => within(form).getByRole("checkbox", { name: "Run read-only queries" });
    await app.user.click(query());
    await app.user.click(query());
    const shop = server.connections.databases[0];
    if (shop === undefined) throw new Error("no database");
    shop.disabledActions = ["query"];
    await act(async () => {
      await app.runtime.queryClient.refetchQueries();
    });
    await waitFor(() => expect(query().getAttribute("aria-checked")).toBe("false"));
    await app.user.click(within(form).getByRole("checkbox", { name: "List the tables" }));
    await app.user.click(within(form).getByRole("button", { name: "Save database" }));
    expect(await screen.findByText("Shop is saved.")).toBeDefined();
    expect([...(server.connections.databases[0]?.disabledActions ?? [])].sort()).toEqual(["query", "tables"]);
  });

  test("an unencrypted connection the server refuses is explained for a database", async () => {
    const server = newServer();
    server.connections.plaintextAllowed = false;
    const app = await renderApp({ path: PATH, signedInAs: "usr_jonas", server });
    await app.user.click(within(await block()).getByRole("button", { name: "Connect a database" }));
    const form = await screen.findByRole("form", { name: "Connect a database" });
    await app.user.type(
      within(form).getByLabelText(/^Connection string/),
      "postgres://r:p@db.shop.example/shop",
    );
    await chooseOption(
      app,
      within(form).getByRole("combobox", { name: "Encryption" }),
      "Not encrypted (only where this server allows it)",
    );
    await app.user.click(within(form).getByRole("button", { name: "Connect" }));
    expect((await within(form).findByRole("alert")).textContent).toBe(
      "This server only connects to databases over an encrypted (TLS) connection. Pick Encrypted.",
    );
  });

  test("two quick presses connect a database once", async () => {
    const app = await renderApp({ path: PATH, signedInAs: "usr_jonas" });
    await app.user.click(within(await block()).getByRole("button", { name: "Connect a database" }));
    const form = await screen.findByRole("form", { name: "Connect a database" });
    await app.user.type(
      within(form).getByLabelText(/^Connection string/),
      "postgres://r:p@db.shop.example/shop",
    );
    await act(async () => {
      fireEvent.submit(form);
      fireEvent.submit(form);
    });
    expect(await screen.findByText("shop @ db.shop.example is connected.")).toBeDefined();
    expect(app.server.calls.filter((call) => call.method === "createDatabase").length).toBe(1);
  });

  test("a refused login says why in the dialog", async () => {
    const app = await renderApp({ path: PATH, signedInAs: "usr_jonas" });
    await app.user.click(within(await block()).getByRole("button", { name: "Connect a database" }));
    const form = await screen.findByRole("form", { name: "Connect a database" });
    await app.user.type(
      within(form).getByLabelText(/^Connection string/),
      "postgres://reader@db.shop.example/shop",
    );
    await app.user.type(within(form).getByLabelText(/^Password/), "wrong-password");
    await app.user.click(within(form).getByRole("button", { name: "Connect" }));
    expect((await within(form).findByRole("alert")).textContent).toBe(
      "The database refused that user or password.",
    );
    expect(app.server.connections.databases.length).toBe(0);
  });

  test("a login that could write is flagged, and actions can be turned off", async () => {
    const server = newServer();
    server.connections.databases.push(
      database({ canWrite: true, agents: [{ agentId: "agt_ledger", level: "read" }] }),
    );
    const app = await renderApp({ path: PATH, signedInAs: "usr_jonas", server });
    const list = await within(await block()).findByRole("list", { name: "Databases" });
    const shop = row(list, "Shop");
    expect(within(shop).getByText(/This user could change data/)).toBeDefined();
    expect(within(shop).getByText("1 agent")).toBeDefined();
    await app.user.click(within(shop).getByRole("button", { name: "Edit Shop" }));
    const form = await screen.findByRole("form", { name: "Edit Shop" });
    await app.user.click(within(form).getByRole("checkbox", { name: "Run read-only queries" }));
    await app.user.click(within(form).getByRole("button", { name: "Save database" }));
    expect(await screen.findByText("Shop is saved.")).toBeDefined();
    expect(server.connections.databases[0]?.disabledActions).toEqual(["query"]);
    expect(app.server.calls.find((call) => call.method === "updateDatabase")?.params.label).toBeUndefined();
  });

  test("a database whose password was refused is renewed with a new one", async () => {
    const server = newServer();
    server.connections.databases.push(database({ status: "reauth_required" }));
    const app = await renderApp({ path: PATH, signedInAs: "usr_jonas", server });
    const list = await within(await block()).findByRole("list", { name: "Databases" });
    await app.user.click(within(row(list, "Shop")).getByRole("button", { name: "Edit Shop" }));
    const form = await screen.findByRole("form", { name: "Edit Shop" });
    expect(within(form).getByText("Type the database's new password to use it again.")).toBeDefined();
    expect(within(form).getByRole("button", { name: "Save database" }).hasAttribute("disabled")).toBe(true);
    await app.user.type(within(form).getByLabelText(/^New password/), "renewed-pw");
    await app.user.click(within(form).getByRole("button", { name: "Save database" }));
    expect(await screen.findByText("Shop works again.")).toBeDefined();
    expect(server.connections.databases[0]?.status).toBe("active");
    expect(keptNowhere(app, "renewed-pw")).toBe(true);
  });

  test("disconnecting asks first", async () => {
    const server = newServer();
    server.connections.databases.push(database());
    const app = await renderApp({ path: PATH, signedInAs: "usr_jonas", server });
    const list = await within(await block()).findByRole("list", { name: "Databases" });
    await app.user.click(within(row(list, "Shop")).getByRole("button", { name: "Disconnect Shop" }));
    const confirm = await screen.findByRole("alertdialog", { name: "Disconnect Shop?" });
    await app.user.click(within(confirm).getByRole("button", { name: "Disconnect" }));
    expect(await screen.findByText("Shop is disconnected.")).toBeDefined();
    expect(server.connections.databases.length).toBe(0);
  });

  test("closing the connect and edit dialogs gives the focus back to their buttons", async () => {
    const server = newServer();
    server.connections.databases.push(database());
    const app = await renderApp({ path: PATH, signedInAs: "usr_jonas", server });
    const add = within(await block()).getByRole("button", { name: "Connect a database" });
    await app.user.click(add);
    await screen.findByRole("form", { name: "Connect a database" });
    await app.user.keyboard("{Escape}");
    await act(async () => {});
    expect(document.activeElement === add).toBe(true);
    const list = await within(await block()).findByRole("list", { name: "Databases" });
    const edit = within(row(list, "Shop")).getByRole("button", { name: "Edit Shop" });
    await app.user.click(edit);
    await screen.findByRole("form", { name: "Edit Shop" });
    await app.user.keyboard("{Escape}");
    await act(async () => {});
    expect(document.activeElement === edit).toBe(true);
  });

  test("a list that fails to load offers a retry", async () => {
    const server = newServer();
    server.force("listDatabases", { kind: "error", status: 500, code: "internal" }, 4);
    const app = await renderApp({ path: PATH, signedInAs: "usr_jonas", server });
    const failed = await screen.findByText("The databases could not be loaded");
    server.unforce("listDatabases");
    const retry = within(failed.closest(".wire-block") as HTMLElement).getByRole("button", { name: "Retry" });
    await app.user.click(retry);
    expect(await within(await block()).findByText("No databases yet")).toBeDefined();
  });
});
