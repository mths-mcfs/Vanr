// The Data sources section against the real server: an owner connects a customer database (a Postgres
// double on a local port) by its fields, unencrypted because the double speaks plain text. The server
// opens a read-only session to check it, and the section then lists it with the column it suggests
// hiding. After a reload the connection is still there, and its password is in no answer.
import { expect, test } from "./fixtures.ts";
import { type PostgresDouble, startPostgresDouble } from "./postgres-double.ts";

let pg: PostgresDouble | undefined;
test.beforeEach(async () => {
  pg = await startPostgresDouble();
});
test.afterEach(async () => {
  // A double that never started has nothing to stop.
  await pg?.stop();
  pg = undefined;
});

test("an owner connects a database source and it holds after a reload", async ({
  page,
  t,
  seedUser,
  signIn,
  apiAs,
}) => {
  const owner = await seedUser({ workspace: "Data Sources Journey" });
  if (pg === undefined) throw new Error("the Postgres double did not start");
  const double = pg;
  await signIn(owner);
  await page.goto(`/workspace/${owner.workspace.id}/settings/data-sources`);
  const databases = page.getByRole("region", { name: t("control", "db.title") });
  await expect(databases.getByText(t("control", "db.none"))).toBeVisible();
  await expect(page.getByRole("region", { name: t("control", "box.title") })).toBeVisible();

  await databases.getByRole("button", { name: t("control", "db.add") }).click();
  const form = page.getByRole("form", { name: t("control", "db.addTitle") });
  await form.getByLabel(t("control", "db.name"), { exact: true }).fill("Shop customers");
  await form.getByRole("radio", { name: new RegExp(t("control", "db.byFields")) }).check();
  await form.getByRole("textbox", { name: t("control", "db.host"), exact: true }).fill(double.host);
  await form.getByLabel(t("control", "db.port"), { exact: true }).fill(String(double.port));
  await form.getByLabel(t("control", "db.database"), { exact: true }).fill("postgres");
  await form.getByLabel(t("control", "db.username"), { exact: true }).fill("postgres");
  await form.getByLabel(t("control", "db.password"), { exact: true }).fill("double-password");
  const tls = form.getByRole("combobox", { name: t("control", "db.tls") });
  await expect(tls).toHaveText(t("control", "db.tlsMode.require"));
  await tls.click();
  await page.getByRole("option", { name: t("control", "db.tlsMode.disable") }).click();
  await form.getByRole("button", { name: t("control", "db.connect") }).click();
  await expect(
    page.getByText(t("control", "db.connected", { name: "Shop customers" }), { exact: true }),
  ).toBeVisible();

  const listed = databases
    .getByRole("list", { name: t("control", "db.title") })
    .getByRole("listitem")
    .filter({ hasText: "Shop customers" });
  await expect(listed).toContainText(t("control", "db.status.active"));
  await expect(listed).toContainText(t("control", "wire.noAgents"));
  await expect(listed).toContainText("public.customers.card_number");

  await page.reload();
  await expect(listed).toContainText(t("control", "db.status.active"));

  const api = await apiAs(owner);
  const answer = await api.get(`/api/v1/workspaces/${owner.workspace.id}/databases`);
  const text = await answer.text();
  expect(text.includes("double-password")).toBe(false);
  const body = JSON.parse(text) as { connections: { label: string; host: string; port?: number }[] };
  expect(body.connections.map((each) => [each.label, each.host])).toEqual([["Shop customers", double.host]]);
});
