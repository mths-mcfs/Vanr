import { describe, expect, test } from "bun:test";
import { FakeServer } from "../../dev/fake-server.ts";
import { directTransport, fakeFetch, newJar } from "../../dev/fake-wire.ts";
import { buildRequest, createApi } from "./api.ts";
import { ApiError, errorFromResponse, isApiError, parseRetryAfter, toApiError } from "./error.ts";
import { methodKey, queryKey } from "./keys.ts";
import { API_METHODS, METHODS } from "./methods.ts";
import { createFetchTransport, type Transport, type TransportRequest } from "./transport.ts";

async function failure(run: () => Promise<unknown>): Promise<ApiError> {
  try {
    await run();
  } catch (cause) {
    if (isApiError(cause)) return cause;
    throw cause;
  }
  throw new Error("expected the call to fail");
}

const recording = (answer: unknown) => {
  const requests: TransportRequest[] = [];
  const transport: Transport = {
    request: async (request) => {
      requests.push(request);
      return answer;
    },
  };
  return { requests, transport };
};

describe("the method table", () => {
  test("every path is under the versioned API or the sign-in service", () => {
    for (const method of API_METHODS) {
      expect(METHODS[method].path, method).toMatch(/^\/api\/(v1|auth)\//);
    }
  });

  test("workspace operations name the workspace in the plural collection, with a named parameter", () => {
    for (const method of API_METHODS) {
      const { path } = METHODS[method];
      if (path.includes("workspace"))
        expect(path, method).toMatch(/^\/api\/v1\/workspaces(\/:workspaceId\/|$)/);
      expect(path, method).not.toMatch(/:id\b/);
    }
  });

  test("only the operations that work without a session are exempt from the session rule", () => {
    const open = API_METHODS.filter((method) => !METHODS[method].session).sort();
    expect(open.map(String)).toEqual(
      [
        "confirmWaitlist",
        "createWaitlist",
        "getAuthConfig",
        "getInvitation",
        "requestInvitationNew",
        "requestPasswordReset",
        "resetPassword",
        "sendVerificationEmail",
        "signIn",
        "signOut",
        "signUp",
        "verifyEmail",
      ].sort(),
    );
  });
});

describe("buildRequest", () => {
  test("path parameters fill the path, encoded; the rest is the body", () => {
    expect(
      buildRequest({ verb: "POST", path: "/api/v1/things/:thingId/accept" }, { thingId: "a b", note: "x" }),
    ).toEqual({
      verb: "POST",
      path: "/api/v1/things/a%20b/accept",
      body: { note: "x" },
    });
  });

  test("a GET sends the rest as the query string and no body", () => {
    expect(
      buildRequest({ verb: "GET", path: "/api/auth/verify-email" }, { token: "t1", skip: undefined }),
    ).toEqual({
      verb: "GET",
      path: "/api/auth/verify-email",
      query: { token: "t1" },
    });
    expect(buildRequest({ verb: "GET", path: "/api/v1/me" }, {})).toEqual({
      verb: "GET",
      path: "/api/v1/me",
    });
  });

  test("a POST without data still sends an empty object", () => {
    expect(buildRequest({ verb: "POST", path: "/api/auth/sign-out" }, {})).toEqual({
      verb: "POST",
      path: "/api/auth/sign-out",
      body: {},
    });
  });

  test("a missing path parameter never reaches the server", () => {
    expect(() => buildRequest({ verb: "GET", path: "/api/v1/workspaces/:workspaceId/agents" }, {})).toThrow(
      'parameter "workspaceId" is missing',
    );
  });
});

describe("answers are validated before a screen sees them", () => {
  test("a well-formed answer is returned, without fields the web did not ask for", async () => {
    const { transport, requests } = recording({
      agents: [
        { id: "agt_1", name: "Scout", handle: "scout", busy: true, archivedAt: null, instructions: "secret" },
      ],
    });
    const api = createApi(transport);
    expect(await api.listAgents({ workspaceId: "workspace_1" })).toEqual({
      agents: [{ id: "agt_1", name: "Scout", handle: "scout", busy: true, archivedAt: null }],
    });
    expect(requests).toEqual([{ verb: "GET", path: "/api/v1/workspaces/workspace_1/agents" }]);
  });

  test.each([
    ["a wrong field type", { agents: [{ id: 7, name: "Scout", handle: "s", busy: true, archivedAt: null }] }],
    ["a missing field", { agents: [{ id: "agt_1", name: "Scout" }] }],
    ["another shape", ["agt_1"]],
    ["nothing", null],
  ])("%s is a malformed-response error", async (_name, answer) => {
    const api = createApi(recording(answer).transport);
    const error = await failure(() => api.listAgents({ workspaceId: "workspace_1" }));
    expect(error).toMatchObject({ status: 502, code: "response.malformed", retryable: true });
  });

  test("`call` is the same operation by name", async () => {
    const api = createApi(recording({ workspaceId: "workspace_9" }).transport);
    expect(await api.call("acceptInvitation", { invitationId: "tok" })).toEqual({
      workspaceId: "workspace_9",
    });
  });
});

describe("one error type", () => {
  test("the server's envelope", () => {
    const error = errorFromResponse({
      status: 403,
      body: {
        error: { code: "invitation.wrong_email", message: "For another email", params: { email: "a@b.co" } },
      },
      retryAfter: null,
    });
    expect(error).toMatchObject({
      status: 403,
      code: "invitation.wrong_email",
      message: "For another email",
      retryable: false,
      params: { email: "a@b.co" },
    });
  });

  test("the sign-in service's body, with its code in lower case", () => {
    const error = errorFromResponse({
      status: 401,
      body: { code: "INVALID_EMAIL_OR_PASSWORD", message: "Invalid email or password" },
      retryAfter: null,
    });
    expect(error).toMatchObject({ status: 401, code: "invalid_email_or_password", retryable: false });
  });

  test("a busy server carries the wait the server asked for", () => {
    const error = errorFromResponse({
      status: 503,
      body: { error: { code: "signup_busy", message: "Busy" } },
      retryAfter: "5",
    });
    expect(error).toMatchObject({ status: 503, code: "signup_busy", retryable: true, retryAfterSeconds: 5 });
  });

  test.each([
    [undefined, 500],
    ["<html>bad gateway</html>", 502],
    [{ unexpected: true }, 418],
    [null, 404],
  ])("a body that is not an error (%p) still gives a code", (body, status) => {
    const error = errorFromResponse({ status, body, retryAfter: null });
    expect(error.code).toBe(`http_${status}`);
    expect(error.status).toBe(status);
  });

  test("which statuses are worth retrying", () => {
    const retryable = (status: number) => new ApiError({ status, code: "x", message: "" }).retryable;
    expect([0, 408, 429, 500, 502, 503, 504].map(retryable)).toEqual(Array(7).fill(true));
    expect([400, 401, 403, 404, 409, 410, 422].map(retryable)).toEqual(Array(7).fill(false));
  });

  test("Retry-After is whole seconds or nothing", () => {
    expect(parseRetryAfter("5")).toBe(5);
    expect(parseRetryAfter(" 12 ")).toBe(12);
    expect(parseRetryAfter("0")).toBe(0);
    for (const junk of [null, "", "soon", "-3", "1.5", "Wed, 21 Oct 2026 07:28:00 GMT"]) {
      expect(parseRetryAfter(junk), String(junk)).toBeUndefined();
    }
  });

  test("anything thrown becomes an ApiError", () => {
    expect(toApiError(new TypeError("boom"))).toMatchObject({
      status: 0,
      code: "client.unexpected",
      message: "boom",
    });
    expect(toApiError("text")).toMatchObject({ code: "client.unexpected" });
    const original = new ApiError({ status: 404, code: "not_found", message: "" });
    expect(toApiError(original)).toBe(original);
  });
});

describe("the fetch transport", () => {
  test("sends JSON with the session cookie and the interface language", async () => {
    const seen: { url: string; init: RequestInit }[] = [];
    const transport = createFetchTransport({
      baseUrl: "https://vanr.test",
      locale: () => "pt-BR",
      fetch: async (url, init) => {
        seen.push({ url, init });
        return Response.json({ ok: true });
      },
    });
    await transport.request({
      verb: "POST",
      path: "/api/v1/waitlist",
      body: { email: "a@b.co" },
      query: { a: "1" },
    });
    expect(seen[0]?.url).toBe("https://vanr.test/api/v1/waitlist?a=1");
    expect(seen[0]?.init).toMatchObject({
      method: "POST",
      credentials: "include",
      body: '{"email":"a@b.co"}',
      headers: { accept: "application/json", "content-type": "application/json", "accept-language": "pt-BR" },
    });
  });

  test("no answer is a retryable network error", async () => {
    const transport = createFetchTransport({
      fetch: async () => {
        throw new TypeError("Failed to fetch");
      },
    });
    const error = await failure(() => transport.request({ verb: "GET", path: "/api/v1/me" }));
    expect(error).toMatchObject({ status: 0, code: "network.unreachable", retryable: true });
  });

  test("an empty 2xx answer is null, and a 2xx that is not JSON is malformed", async () => {
    const empty = createFetchTransport({ fetch: async () => new Response(null, { status: 204 }) });
    expect(await empty.request({ verb: "POST", path: "/x" })).toBeNull();
    const html = createFetchTransport({ fetch: async () => new Response("<html>", { status: 200 }) });
    expect(await failure(() => html.request({ verb: "GET", path: "/x" }))).toMatchObject({
      code: "response.malformed",
    });
  });

  test("an aborted call rejects with the abort, not with a network error", async () => {
    const controller = new AbortController();
    const transport = createFetchTransport({
      fetch: async (_url, init) => {
        controller.abort();
        throw init.signal?.reason ?? new Error("aborted");
      },
    });
    const outcome = await transport
      .request({ verb: "GET", path: "/api/v1/me", signal: controller.signal })
      .then(
        () => "resolved",
        (cause: unknown) => cause,
      );
    expect(isApiError(outcome)).toBe(false);
  });
});

describe("the session rule", () => {
  test("a 401 from an operation that needs a session reports the session ended, and still rejects", async () => {
    const server = new FakeServer();
    const ended: ApiError[] = [];
    const api = createApi(directTransport(server, newJar()), {
      onSessionEnded: (error) => ended.push(error),
    });
    const error = await failure(() => api.getMe());
    expect(error).toMatchObject({ status: 401, code: "unauthorized" });
    expect(ended).toEqual([error]);
  });

  test("a 401 from signing in or from an email link is an ordinary error", async () => {
    const server = new FakeServer();
    const ended: ApiError[] = [];
    const api = createApi(directTransport(server, newJar()), {
      onSessionEnded: (error) => ended.push(error),
    });
    const wrong = await failure(() =>
      api.signIn({ email: "ana@birchwood.example", password: "wrong-password" }),
    );
    expect(wrong).toMatchObject({ status: 401, code: "invalid_email_or_password" });
    const link = await failure(() => api.verifyEmail({ token: "no-such-token" }));
    expect(link).toMatchObject({ status: 401, code: "invalid_token" });
    expect(ended).toEqual([]);
  });
});

describe("both wires give the same answers", () => {
  const wires = {
    fetch: (server: FakeServer) => createFetchTransport({ fetch: fakeFetch(server, newJar()) }),
    direct: (server: FakeServer) => directTransport(server, newJar()),
  };
  for (const [name, wire] of Object.entries(wires)) {
    test(`${name}: sign in, read, fail, sign out`, async () => {
      const server = new FakeServer();
      const api = createApi(wire(server));
      expect(await api.getAuthConfig()).toMatchObject({ signupOpen: true, firstRun: false });
      await api.signIn({ email: "ana@birchwood.example", password: "birch-and-tar" });
      const me = await api.getMe();
      expect(me.user.name).toBe("Ana Beatriz Souza");
      expect(me.workspaces.map((workspace) => workspace.id)).toEqual([
        "workspace_birchwood",
        "workspace_nightshift",
      ]);
      server.force("getOverview", { kind: "error", status: 503, code: "internal", retryAfter: 7 });
      expect(await failure(() => api.getOverview({ workspaceId: "workspace_birchwood" }))).toMatchObject({
        status: 503,
        code: "internal",
        retryAfterSeconds: 7,
      });
      server.force("getOverview", { kind: "offline" });
      expect(await failure(() => api.getOverview({ workspaceId: "workspace_birchwood" }))).toMatchObject({
        status: 0,
        code: "network.unreachable",
      });
      expect(await api.getOverview({ workspaceId: "workspace_birchwood" })).toEqual({
        people: 4,
        agents: 3,
        myApprovalQueue: 2,
        budgetSpentPct: 38,
      });
      expect(await api.requestInvitationNew({ invitationId: "inv-expired" })).toBeUndefined();
      await api.signOut();
      expect(await failure(() => api.getMe())).toMatchObject({ status: 401 });
    });
  }
});

describe("cache keys", () => {
  test("a key is the method name and its parameters, in a stable order", () => {
    expect(queryKey("getMe")).toEqual(["getMe", {}]);
    expect(queryKey("listAgents", { workspaceId: "workspace_1" })).toEqual([
      "listAgents",
      { workspaceId: "workspace_1" },
    ]);
    const a = queryKey("createWaitlist", { email: "a@b.co", locale: "en" });
    const b = queryKey("createWaitlist", { locale: "en", email: "a@b.co" });
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });

  test("the method key is the prefix of every key of that method", () => {
    expect(queryKey("listAgents", { workspaceId: "workspace_1" }).slice(0, 1)).toEqual([
      ...methodKey("listAgents"),
    ]);
  });
});
