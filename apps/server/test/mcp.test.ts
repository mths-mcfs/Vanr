import { afterAll, expect, test } from "bun:test";
import { McpAuthRequired, McpClient, parseSse } from "../src/integrations/mcp";
import {
  consentUrl,
  discoverAuthServer,
  exchangeCode,
  pkcePair,
  registerClient,
} from "../src/integrations/oauth";
import { startFakeMcp } from "./fake-mcp";

/** The fake MCP server listens on loopback over plain HTTP. */
const LOCAL = { allowPrivate: true, allowPlaintext: true };

const mcp = startFakeMcp();
afterAll(() => mcp.stop());

test("lists tools in SSE, keeps the session and calls a tool", async () => {
  const client = new McpClient({
    url: mcp.url,
    fetch,
    policy: LOCAL,
    headers: { authorization: `Bearer ${mcp.apiKey}` },
  });
  const tools = await client.listTools();
  expect(tools.map((t) => [t.name, t.annotations?.readOnlyHint ?? false])).toEqual([
    ["list_items", true],
    ["create_item", false],
  ]);
  expect(await client.callTool("create_item", { name: "washer" })).toEqual({
    text: "created: washer",
    isError: false,
  });
  // initialize without a session; the rest with the session the server gave.
  expect(mcp.calls.map((c) => [c.method, c.session])).toEqual([
    ["initialize", null],
    ["notifications/initialized", "sess-1"],
    ["tools/list", "sess-1"],
    ["tools/call", "sess-1"],
  ]);
  expect((await client.callTool("nothing", {})).isError).toBe(true);
});

test("without a credential the server asks for authorization and says where the metadata is", async () => {
  const client = new McpClient({ url: mcp.url, fetch, policy: LOCAL });
  const err = await client.listTools().catch((e: unknown) => e);
  expect(err).toBeInstanceOf(McpAuthRequired);
  expect((err as McpAuthRequired).resourceMetadata).toBe(
    `${mcp.origin}/.well-known/oauth-protected-resource/mcp`,
  );
});

test("OAuth with discovery, dynamic registration and PKCE gives a token the server accepts", async () => {
  const server = await discoverAuthServer(fetch, mcp.url, null, LOCAL);
  expect(server.token_endpoint).toBe(`${mcp.origin}/token`);
  const redirectUri = "http://localhost:9/api/v1/connectors/oauth/callback";
  const client = await registerClient(fetch, server.registration_endpoint ?? "", redirectUri, "test");
  const { verifier, challenge } = pkcePair();
  const url = consentUrl({
    endpoint: server.authorization_endpoint,
    clientId: client.clientId,
    redirectUri,
    state: "st-1",
    challenge,
    resource: mcp.url,
  });
  const back = await mcp.authorize(url);
  expect(back.state).toBe("st-1");
  const now = new Date("2026-10-20T12:00:00Z");
  // Wrong verifier: the server rejects it.
  await expect(
    exchangeCode(
      fetch,
      { tokenEndpoint: server.token_endpoint, code: back.code, verifier: "other", redirectUri, ...client },
      now,
    ),
  ).rejects.toThrow();
  const again = await mcp.authorize(url);
  const tokens = await exchangeCode(
    fetch,
    { tokenEndpoint: server.token_endpoint, code: again.code, verifier, redirectUri, ...client },
    now,
  );
  expect(tokens.expiresAt).toBe("2026-10-20T13:00:00.000Z");
  const authed = new McpClient({
    url: mcp.url,
    fetch,
    policy: LOCAL,
    headers: { authorization: `Bearer ${tokens.accessToken}` },
  });
  expect((await authed.callTool("list_items", {})).text).toBe("bolt, nut");
});

test("SSE: joins data lines and ignores what is not JSON", () => {
  expect(parseSse(': ping\n\ndata: {"a":\ndata: 1}\n\ndata: hi\n\n')).toEqual([{ a: 1 }]);
});
