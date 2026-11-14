// The transport's failure modes: every way a call can go wrong ends in one ApiError with the right code,
// status and retryable flag, and a good answer comes back validated and stripped to the contract.
import { describe, expect, test } from "bun:test";
import { createClient } from "../src/client.ts";
import { ManualClock } from "../src/clock.ts";
import { ApiError } from "../src/errors.ts";

const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });

const channel = {
  id: "ch_1",
  budgetPerMonthUsd: null,
  createdAt: "2026-11-01T00:00:00.000Z",
  isGeneral: true,
  isMember: true,
  name: "general",
  topic: "",
  unreadCount: 0,
  visibility: "public" as const,
};

function clientAnswering(answer: (url: string, init: RequestInit) => Response | Promise<Response>) {
  const calls: { url: string; init: RequestInit }[] = [];
  const client = createClient({
    baseUrl: "http://vanr.test/",
    fetch: async (url, init) => {
      calls.push({ url, init });
      return answer(url, init);
    },
  });
  return { client, calls };
}

async function failure(p: Promise<unknown>): Promise<ApiError> {
  try {
    await p;
  } catch (err) {
    if (err instanceof ApiError) return err;
    throw err;
  }
  throw new Error("expected the call to fail");
}

describe("answers", () => {
  test("a valid answer is unwrapped and loses fields the contract doesn't have", async () => {
    const { client } = clientAnswering(() => json({ channels: [{ ...channel, secret: "x" }] }));
    const list = await client.api.listChannels({ workspaceId: "ws_1" });
    expect(list).toEqual([channel]);
    expect(Object.keys(list[0] ?? {})).not.toContain("secret");
  });

  test("path parameters are encoded and query values serialized; empty ones are left out", async () => {
    const { client, calls } = clientAnswering(() => json({ hits: [] }));
    await client.api.getSearch({
      workspaceId: "w/1 ?",
      query: { q: "a b", kinds: ["file", "wiki"], limit: undefined },
    });
    expect(calls[0]?.url).toBe(
      "http://vanr.test/api/v1/workspaces/w%2F1%20%3F/search?q=a+b&kinds=file%2Cwiki",
    );
    expect(calls[0]?.init.method).toBe("GET");
    expect(calls[0]?.init.body).toBeUndefined();
  });

  test("a fixed query in the path is kept next to the caller's", async () => {
    const { client, calls } = clientAnswering(() => json({ invitations: [] }));
    await client.api.listAllInvitations({ workspaceId: "w" });
    expect(calls[0]?.url).toBe("http://vanr.test/api/v1/workspaces/w/invitations?scope=all");
  });

  test("a JSON body goes as JSON; a POST without one sends {}", async () => {
    const { client, calls } = clientAnswering(() => json(channel));
    await client.api.createChannel({ workspaceId: "w", body: { name: "eng", visibility: "private" } });
    await client.api.joinChannel({ workspaceId: "w", channelId: "c" }).catch(() => {});
    expect(calls[0]?.init.body).toBe('{"name":"eng","visibility":"private"}');
    expect(new Headers(calls[0]?.init.headers).get("content-type")).toBe("application/json");
    expect(calls[1]?.init.body).toBe("{}");
  });

  test("a status listed as 'none' resolves to null", async () => {
    const { client } = clientAnswering(() =>
      json({ error: { code: "unauthorized", message: "Sign in" } }, 401),
    );
    expect(await client.api.getMe()).toBeNull();
  });

  test("a no-content answer resolves to undefined whatever the body", async () => {
    const { client } = clientAnswering(() => new Response(null, { status: 204 }));
    expect(
      await client.api.deleteChannelMemberAgent({ workspaceId: "w", channelId: "c", agentId: "a" }),
    ).toBeUndefined();
  });

  test("a download hands over the stream with its type, size and name", async () => {
    const { client } = clientAnswering(
      () =>
        new Response("hello", {
          headers: {
            "content-type": "text/plain",
            "content-length": "5",
            "content-disposition": "attachment; filename*=UTF-8''notes%20v2.txt",
          },
        }),
    );
    const file = await client.api.getFileBlob({ workspaceId: "w", fileId: "f", query: { version: 2 } });
    expect(file.contentType).toBe("text/plain");
    expect(file.size).toBe(5);
    expect(file.fileName).toBe("notes v2.txt");
    expect(await (await file.blob()).text()).toBe("hello");
  });

  test("the caller's signal still cancels a download after its headers arrived", async () => {
    const controller = new AbortController();
    const client = createClient({
      fetch: async (_url, init) =>
        new Response(
          new ReadableStream<Uint8Array>({
            start(c) {
              c.enqueue(new TextEncoder().encode("part"));
              init.signal?.addEventListener("abort", () =>
                c.error(new DOMException("aborted", "AbortError")),
              );
            },
          }),
        ),
    });
    const file = await client.api.exportWiki({ workspaceId: "w" }, { signal: controller.signal });
    const reader = file.body.getReader();
    expect((await reader.read()).done).toBe(false);
    controller.abort();
    await expect(reader.read()).rejects.toThrow();
  });

  test("a multipart upload sends the file with its name and the other fields", async () => {
    const { client, calls } = clientAnswering(() =>
      json({ error: { code: "file.too_large", message: "Too big" } }, 413),
    );
    await client.api
      .uploadFile({
        workspaceId: "w",
        body: { file: { blob: new Blob(["abc"]), fileName: "a.txt" }, title: "A", channelId: undefined },
      })
      .catch(() => {});
    const form = calls[0]?.init.body;
    expect(form).toBeInstanceOf(FormData);
    if (!(form instanceof FormData)) return;
    const file = form.get("file");
    expect(file instanceof File ? file.name : null).toBe("a.txt");
    expect(form.get("title")).toBe("A");
    expect(form.has("channelId")).toBe(false);
  });
});

describe("failures", () => {
  test("the error envelope becomes an ApiError with the server's code and params", async () => {
    const { client } = clientAnswering(() =>
      json({ error: { code: "channel.name_taken", message: "Taken", params: { name: "eng" } } }, 409),
    );
    const err = await failure(
      client.api.createChannel({ workspaceId: "w", body: { name: "eng", visibility: "public" } }),
    );
    expect(err).toMatchObject({
      status: 409,
      code: "channel.name_taken",
      message: "Taken",
      retryable: false,
    });
    expect(err.params).toEqual({ name: "eng" });
  });

  test("a code this client doesn't know keeps the status code and the raw one", async () => {
    const { client } = clientAnswering(() => json({ error: { code: "brand_new", message: "New" } }, 422));
    const err = await failure(client.api.listChannels({ workspaceId: "w" }));
    expect(err).toMatchObject({ status: 422, code: "http_422", rawCode: "brand_new", message: "New" });
  });

  test("a failure without the envelope (a proxy page) is http_<status>, retryable when the server is down", async () => {
    const { client } = clientAnswering(
      () => new Response("<html>Bad gateway</html>", { status: 502, statusText: "Bad Gateway" }),
    );
    const err = await failure(client.api.listChannels({ workspaceId: "w" }));
    expect(err).toMatchObject({ status: 502, code: "http_502", message: "Bad Gateway", retryable: true });
  });

  test("rate limiting is retryable", async () => {
    const { client } = clientAnswering(() =>
      json({ error: { code: "rate_limit", message: "Slow down" } }, 429),
    );
    expect((await failure(client.api.listChannels({ workspaceId: "w" }))).retryable).toBe(true);
  });

  test("a dropped connection is a retryable network error", async () => {
    const { client } = clientAnswering(() => {
      throw new TypeError("fetch failed");
    });
    const err = await failure(client.api.listChannels({ workspaceId: "w" }));
    expect(err).toMatchObject({ status: 0, code: "network", retryable: true });
    expect(err.cause).toBeInstanceOf(TypeError);
  });

  test("an answer that is not JSON is invalid_response", async () => {
    const { client } = clientAnswering(() => new Response("<html>ok</html>", { status: 200 }));
    const err = await failure(client.api.listChannels({ workspaceId: "w" }));
    expect(err).toMatchObject({ status: 200, code: "invalid_response", retryable: false });
  });

  test("JSON that breaks the contract is invalid_response and says where", async () => {
    const { client } = clientAnswering(() => json({ channels: [{ ...channel, visibility: "secret" }] }));
    const err = await failure(client.api.listChannels({ workspaceId: "w" }));
    expect(err.code).toBe("invalid_response");
    expect(err.params).toEqual({ path: "$.channels[0].visibility", expected: '"private" | "public"' });
  });

  test("the deadline aborts the call with a retryable timeout", async () => {
    const clock = new ManualClock();
    let aborted = false;
    const client = createClient({
      clock,
      timeoutMs: 1000,
      fetch: (_url, init) =>
        new Promise((_resolve, reject) => {
          init.signal?.addEventListener("abort", () => {
            aborted = true;
            reject(new DOMException("aborted", "AbortError"));
          });
        }),
    });
    const pending = failure(client.api.listChannels({ workspaceId: "w" }));
    clock.advance(999);
    expect(aborted).toBe(false);
    clock.advance(1);
    const err = await pending;
    expect(aborted).toBe(true);
    expect(err).toMatchObject({ status: 0, code: "timeout", retryable: true });
  });

  test("a per-call deadline overrides the client's", async () => {
    const clock = new ManualClock();
    const client = createClient({
      clock,
      timeoutMs: 60_000,
      fetch: (_url, init) =>
        new Promise((_resolve, reject) =>
          init.signal?.addEventListener("abort", () => reject(new Error("aborted"))),
        ),
    });
    const pending = failure(client.api.listChannels({ workspaceId: "w" }, { timeoutMs: 10 }));
    clock.advance(10);
    expect((await pending).code).toBe("timeout");
  });

  test("the caller's signal cancels the call, and that is not retryable", async () => {
    const controller = new AbortController();
    const client = createClient({
      fetch: (_url, init) =>
        new Promise((_resolve, reject) =>
          init.signal?.addEventListener("abort", () => reject(new Error("aborted"))),
        ),
    });
    const pending = failure(client.api.listChannels({ workspaceId: "w" }, { signal: controller.signal }));
    controller.abort();
    expect(await pending).toMatchObject({ code: "canceled", retryable: false });
  });

  test("a signal aborted before the call never reaches fetch", async () => {
    const { client, calls } = clientAnswering(() => json({ channels: [] }));
    const controller = new AbortController();
    controller.abort();
    expect(
      (await failure(client.api.listChannels({ workspaceId: "w" }, { signal: controller.signal }))).code,
    ).toBe("canceled");
    expect(calls).toHaveLength(0);
  });

  test("the timer is cleared when the answer arrives", async () => {
    const clock = new ManualClock();
    const client = createClient({ clock, fetch: async () => json({ channels: [] }) });
    await client.api.listChannels({ workspaceId: "w" });
    expect(clock.pending()).toEqual([]);
  });
});
