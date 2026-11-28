// An agent's mailboxes, databases and repositories, on its Access tab, against the fake server. Scout is
// Ana's agent in Birchwood; Jonas manages agents there, Íris is a member.
import { describe, expect, test } from "bun:test";
import { act, screen, within } from "@testing-library/react";
import type { FakeDatabase, FakeMailAccount } from "../../../dev/fake-connections.ts";
import { chooseOption, newServer, renderApp } from "../../../test/app.tsx";

const WS = "workspace_birchwood";
const PATH = `/workspace/${WS}/agents/agt_scout?tab=access`;

const orders = (): FakeMailAccount => ({
  id: "mail_orders",
  workspaceId: WS,
  address: "orders@birchwood.example",
  label: "orders@birchwood.example",
  preset: "gmail",
  provider: "gmail",
  via: "imap",
  status: "active",
  agents: [],
  confirmActions: [],
  disabledActions: [],
});
const shop = (patch: Partial<FakeDatabase> = {}): FakeDatabase => ({
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
  hiddenSuggestion: ["public.customers.card_number"],
  disabledActions: [],
  agents: [],
  ...patch,
});
const seeded = () => {
  const server = newServer();
  server.connections.mail.push(orders());
  server.connections.databases.push(shop());
  server.connections.tables.set("dbc_shop", [
    { schema: "public", name: "customers" },
    { schema: "public", name: "orders" },
    { schema: "sales", name: "Leads" },
  ]);
  return server;
};

describe("mailboxes", () => {
  const part = () => screen.findByRole("region", { name: "Mailboxes" });

  test("a member reads the mailbox access and changes nothing", async () => {
    const server = seeded();
    server.connections.mailboxes.set("agt_scout", [
      {
        accountId: "mail_orders",
        level: "read",
        deletable: false,
        policy: {
          folders: ["Inbox"],
          senderAllowlist: ["@shop.example"],
          lookbackDays: 30,
          recipientAllowlist: [],
          sendsPerDay: 25,
          autoSend: false,
          senderAddress: null,
        },
      },
    ]);
    await renderApp({ path: PATH, signedInAs: "usr_iris", server });
    const form = await within(await part()).findByRole("form", { name: "orders@birchwood.example" });
    const level = within(form).getByRole("combobox", {
      name: "What this agent may do with orders@birchwood.example",
    });
    expect(level.textContent).toBe("Read");
    expect(level.hasAttribute("disabled")).toBe(true);
    expect((within(form).getByLabelText(/^Only mail from/) as HTMLTextAreaElement).value).toBe(
      "@shop.example",
    );
    expect((within(form).getByLabelText(/^Days back/) as HTMLInputElement).value).toBe("30");
    expect(within(form).queryByRole("button", { name: "Save mailbox access" }) === null).toBe(true);
  });

  test("an admin lets the agent write to listed addresses and send to them without asking", async () => {
    const server = seeded();
    const app = await renderApp({ path: PATH, signedInAs: "usr_jonas", server });
    const form = await within(await part()).findByRole("form", { name: "orders@birchwood.example" });
    await chooseOption(
      app,
      within(form).getByRole("combobox", { name: "What this agent may do with orders@birchwood.example" }),
      "Read and write",
    );
    const autoSend = within(form).getByRole("checkbox", { name: /Send without asking/ });
    expect(autoSend.hasAttribute("disabled")).toBe(true);
    expect(within(form).getByText("List at least one address it may write to first.")).toBeDefined();
    const recipients = within(form).getByLabelText(/^May write to/);
    await app.user.type(recipients, "billing@shop.example\nnot-an-address");
    expect(within(form).getByText("“not-an-address” is not an address or an @domain.")).toBeDefined();
    expect(within(form).getByRole("button", { name: "Save mailbox access" }).hasAttribute("disabled")).toBe(
      true,
    );
    await app.user.clear(recipients);
    await app.user.type(recipients, "billing@shop.example\n@birchwood.example");
    const sends = within(form).getByLabelText(/^Messages a day/);
    await app.user.clear(sends);
    await app.user.type(sends, "10");
    await app.user.click(within(form).getByRole("checkbox", { name: /Send without asking/ }));
    await app.user.click(within(form).getByRole("button", { name: "Save mailbox access" }));
    expect(await screen.findByText("Access to orders@birchwood.example is saved.")).toBeDefined();
    const box = server.connections.mailboxes.get("agt_scout")?.[0];
    expect([
      box?.level,
      box?.policy.recipientAllowlist,
      box?.policy.sendsPerDay,
      box?.policy.autoSend,
    ]).toEqual(["read_write", ["billing@shop.example", "@birchwood.example"], 10, true]);
  });

  test("a day count out of range is refused before it is sent", async () => {
    const app = await renderApp({ path: PATH, signedInAs: "usr_jonas", server: seeded() });
    const form = await within(await part()).findByRole("form", { name: "orders@birchwood.example" });
    await chooseOption(
      app,
      within(form).getByRole("combobox", { name: "What this agent may do with orders@birchwood.example" }),
      "Read",
    );
    await app.user.type(within(form).getByLabelText(/^Days back/), "9999");
    expect(within(form).getByText("A whole number from 1 to 3,650, or empty.")).toBeDefined();
    expect(within(form).getByRole("button", { name: "Save mailbox access" }).hasAttribute("disabled")).toBe(
      true,
    );
  });

  test("a folder name with a comma stays one folder", async () => {
    const server = seeded();
    const app = await renderApp({ path: PATH, signedInAs: "usr_jonas", server });
    const form = await within(await part()).findByRole("form", { name: "orders@birchwood.example" });
    await chooseOption(
      app,
      within(form).getByRole("combobox", { name: "What this agent may do with orders@birchwood.example" }),
      "Read",
    );
    await app.user.type(within(form).getByLabelText(/^Only these folders/), "Clients, Brazil\nInbox");
    await app.user.type(within(form).getByLabelText(/^Only mail from/), "a@shop.example, @birch.example");
    await app.user.click(within(form).getByRole("button", { name: "Save mailbox access" }));
    expect(await screen.findByText("Access to orders@birchwood.example is saved.")).toBeDefined();
    const policy = server.connections.mailboxes.get("agt_scout")?.[0]?.policy;
    expect([policy?.folders, policy?.senderAllowlist]).toEqual([
      ["Clients, Brazil", "Inbox"],
      ["a@shop.example", "@birch.example"],
    ]);
  });

  test("without mailboxes it says where they are connected", async () => {
    await renderApp({ path: PATH, signedInAs: "usr_jonas" });
    expect(await within(await part()).findByText("The workspace has no mailboxes")).toBeDefined();
  });
});

describe("databases", () => {
  const part = () => screen.findByRole("region", { name: "Databases" });

  test("an admin picks the tables, keeps the suggested hidden column and drops the daily limit", async () => {
    const server = seeded();
    const app = await renderApp({ path: PATH, signedInAs: "usr_jonas", server });
    const form = await within(await part()).findByRole("form", { name: "Shop" });
    await app.user.click(within(form).getByRole("checkbox", { name: "May query Shop" }));
    const tables = await within(form).findByRole("list", { name: "Tables" });
    const boxes = within(tables).getAllByRole("checkbox");
    expect(boxes.map((each) => each.getAttribute("aria-checked"))).toEqual(["true", "true", "true"]);
    expect(within(tables).getByText('sales."Leads"')).toBeDefined();
    await app.user.click(within(tables).getByRole("checkbox", { name: "public.orders" }));
    expect((within(form).getByLabelText(/^Hidden columns/) as HTMLTextAreaElement).value).toBe(
      "public.customers.card_number",
    );
    const queries = within(form).getByLabelText(/^Queries a day/);
    expect((queries as HTMLInputElement).value).toBe("200");
    await app.user.clear(queries);
    await app.user.click(within(form).getByRole("button", { name: "Save database access" }));
    expect(await screen.findByText("Access to Shop is saved.")).toBeDefined();
    const link = server.connections.agentDatabases.get("agt_scout")?.[0];
    expect([
      link?.level,
      link?.policy.tables,
      link?.policy.maskedColumns,
      link?.policy.queriesPerDay,
    ]).toEqual(["read", ["public.customers", 'sales."Leads"'], ["public.customers.card_number"], null]);
  });

  test("a member reads the chosen tables without asking the database for its list", async () => {
    const server = seeded();
    server.connections.agentDatabases.set("agt_scout", [
      {
        connectionId: "dbc_shop",
        level: "read",
        policy: { tables: ["public.orders"], maskedColumns: [], queriesPerDay: 50, timeoutSeconds: 15 },
      },
    ]);
    const app = await renderApp({ path: PATH, signedInAs: "usr_iris", server });
    const form = await within(await part()).findByRole("form", { name: "Shop" });
    expect(
      within(within(form).getByRole("list", { name: "Tables" })).getByText("public.orders"),
    ).toBeDefined();
    expect(within(form).getByRole("checkbox", { name: "May query Shop" }).hasAttribute("disabled")).toBe(
      true,
    );
    expect(app.server.calls.some((call) => call.method === "listDatabaseTables")).toBe(false);
  });

  test("a list of tables that fails offers a retry and holds the save", async () => {
    const server = seeded();
    server.force("listDatabaseTables", { kind: "error", status: 400, code: "database.unreachable" }, 4);
    const app = await renderApp({ path: PATH, signedInAs: "usr_jonas", server });
    const form = await within(await part()).findByRole("form", { name: "Shop" });
    await app.user.click(within(form).getByRole("checkbox", { name: "May query Shop" }));
    expect(await within(form).findByText("The database's tables could not be listed")).toBeDefined();
    expect(within(form).getByRole("button", { name: "Save database access" }).hasAttribute("disabled")).toBe(
      true,
    );
    server.unforce("listDatabaseTables");
    await app.user.click(within(form).getByRole("button", { name: "Retry" }));
    expect(await within(form).findByRole("list", { name: "Tables" })).toBeDefined();
  });

  test("a database whose password was refused asks for it to be renewed first", async () => {
    const server = seeded();
    server.connections.databases[0] = shop({ status: "reauth_required" });
    const app = await renderApp({ path: PATH, signedInAs: "usr_jonas", server });
    const form = await within(await part()).findByRole("form", { name: "Shop" });
    await app.user.click(within(form).getByRole("checkbox", { name: "May query Shop" }));
    expect(within(form).getByText(/The database refused the saved password/)).toBeDefined();
    await act(async () => {});
    expect(app.server.calls.some((call) => call.method === "listDatabaseTables")).toBe(false);
  });
});

describe("GitHub repositories", () => {
  const part = () => screen.findByRole("region", { name: "GitHub repositories" });

  test("an admin chooses repositories; a whole account covers its repositories", async () => {
    const server = seeded();
    server.connections.installations.push({
      id: "ins_birch",
      workspaceId: WS,
      accountUsername: "birchwood-labs",
      repoScope: "selected",
      suspended: false,
      repositories: [
        { fullName: "birchwood-labs/print-shop", private: true },
        { fullName: "birchwood-labs/site", private: false },
      ],
    });
    server.connections.repositories.set("agt_scout", ["old-org/archive"]);
    const app = await renderApp({ path: PATH, signedInAs: "usr_jonas", server });
    const form = await within(await part()).findByRole("form", { name: "GitHub repositories" });
    expect(within(form).getByRole("checkbox", { name: "old-org/archive" }).getAttribute("aria-checked")).toBe(
      "true",
    );
    await app.user.click(within(form).getByRole("checkbox", { name: /birchwood-labs\/site/ }));
    await app.user.click(within(form).getByRole("button", { name: "Save repositories" }));
    expect(await screen.findByText("The repositories are saved.")).toBeDefined();
    expect(server.connections.repositories.get("agt_scout")).toEqual([
      "old-org/archive",
      "birchwood-labs/site",
    ]);
    await app.user.click(
      within(await within(await part()).findByRole("form", { name: "GitHub repositories" })).getByRole(
        "checkbox",
        {
          name: "Every repository of birchwood-labs",
        },
      ),
    );
    const site = within(await part()).getByRole("checkbox", { name: /birchwood-labs\/site/ });
    expect(site.hasAttribute("disabled")).toBe(true);
  });

  test("more repositories than the server keeps are refused, not cut", async () => {
    const server = seeded();
    server.connections.installations.push({
      id: "ins_big",
      workspaceId: WS,
      accountUsername: "big-org",
      repoScope: "all",
      suspended: false,
      repositories: Array.from({ length: 201 }, (_, i) => ({ fullName: `big-org/r${i}`, private: false })),
    });
    server.connections.repositories.set(
      "agt_scout",
      Array.from({ length: 201 }, (_, i) => `big-org/r${i}`),
    );
    await renderApp({ path: PATH, signedInAs: "usr_jonas", server });
    const form = await within(await part()).findByRole("form", { name: "GitHub repositories" });
    expect(within(form).getByRole("alert").textContent).toContain("At most 200 entries; 201 are chosen.");
    expect(within(form).getByRole("button", { name: "Save repositories" }).hasAttribute("disabled")).toBe(
      true,
    );
  });

  test("without GitHub it says where to install it", async () => {
    await renderApp({ path: PATH, signedInAs: "usr_jonas" });
    expect(await within(await part()).findByText("GitHub is not linked")).toBeDefined();
  });
});
