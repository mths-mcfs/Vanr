// The Data sources section of the settings, against the fake server: Birchwood's mailboxes and
// databases. Jonas is an admin there, Íris a member.
import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { act, screen, within } from "@testing-library/react";
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
      within(shop).getByText('Columns that look private: public.customers."card_number". Hide them on each agent.'),
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
