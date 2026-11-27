// People for the journeys that need more than one: an API client signed in as someone, and a second
// person brought into a workspace through a real invitation. (Kept here until the shared fixtures
// carry `invite()` and `apiAs()`.)
import { type APIRequestContext, request } from "@playwright/test";
import type { SeededMember, SeededUser } from "./fixtures.ts";
import type { RunningServer } from "./server.ts";

async function ok(response: Awaited<ReturnType<APIRequestContext["post"]>>, what: string): Promise<void> {
  if (!response.ok()) throw new Error(`${what}: HTTP ${response.status()} ${await response.text()}`);
}

/** An API client with a fresh session of the person. The caller disposes it. */
export async function apiAs(server: RunningServer, user: SeededUser): Promise<APIRequestContext> {
  const api = await request.newContext({ baseURL: server.url, extraHTTPHeaders: { origin: server.url } });
  await ok(
    await api.post("/api/auth/sign-in/email", { data: { email: user.email, password: user.password } }),
    "sign-in",
  );
  return api;
}

/** Invites the person into the owner's workspace as a member, and accepts for them. */
export async function join(
  server: RunningServer,
  owner: SeededMember,
  person: SeededUser,
): Promise<SeededMember> {
  const by = await apiAs(server, owner);
  const them = await apiAs(server, person);
  try {
    const invited = await by.post(`/api/v1/workspaces/${owner.workspace.id}/invitations`, {
      data: { email: person.email, role: "member" },
    });
    await ok(invited, "invite");
    const { url } = (await invited.json()) as { url: string };
    const token = new URL(url).pathname.split("/").pop() ?? "";
    await ok(await them.post(`/api/v1/invitations/${token}/accept`, { data: {} }), "accept");
    return { ...person, workspace: owner.workspace };
  } finally {
    await by.dispose();
    await them.dispose();
  }
}
