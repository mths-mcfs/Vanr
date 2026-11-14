import { expect, test } from "bun:test";
import { importSkill } from "./github";

for (const [description, expected] of [
  ["A description", "A description"],
  [">\n  A folded\n  description", "A folded description\n"],
] as const) {
  test(`skill import preserves YAML with CRLF and BOM: ${expected}`, async () => {
    const md = `\uFEFF---\nname: test-skill\ndescription: ${description}\n---\nDo the work.`.replaceAll(
      "\n",
      "\r\n",
    );
    const fetcher: typeof fetch = Object.assign(
      async (url: string | URL | Request) =>
        String(url).includes("raw.githubusercontent.com") ? new Response(md) : Response.json([]),
      { preconnect() {} },
    );
    expect(await importSkill(fetcher, "https://github.com/test/repo/tree/main/test-skill")).toMatchObject({
      name: "test-skill",
      description: expected,
      body: "Do the work.",
    });
  });
}
