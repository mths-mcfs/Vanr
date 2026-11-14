import { expect, test } from "bun:test";
import { JobOutput } from "./jobs";
import { maskSecrets } from "./secrets";
import { seeded } from "./testing/random";

// A job's output is masked before it is split into lines: a secret of several lines (a PEM key) never goes
// out one line at a time, wherever the pieces of the output are cut.
const PEM = "-----BEGIN KEY-----\nAAAASECRETLINE1\nBBBBSECRETLINE2\n-----END KEY-----";
const MASKS: [string, string][] = [
  [PEM, "[secret:PEM]"],
  ["tok_abc123", "[secret:TOKEN]"],
];

/** The lines the job reads from the whole output at once, masked: what any cut must give. */
function wholeLines(text: string): string[] {
  const parts = maskSecrets(text, MASKS).split("\n");
  const last = (parts.pop() ?? "").trim();
  return [...parts.map((l) => l.trimEnd()).filter(Boolean), ...(last ? [last] : [])];
}

test("property: for any cut of the output into pieces, the lines equal those of the masked whole output", () => {
  let seed = 7;
  const rand = (n: number) => {
    seed = (Math.imul(seed, 1103515245) + 12345) & 0x7fffffff;
    return seed % n;
  };
  const words = [
    "build ok",
    PEM,
    "tok_abc123",
    "line\n",
    "\n",
    " ",
    "-----BEGIN KEY-----",
    "AAAASECRETLINE1\n",
  ];
  let cuts = 0;
  for (let round = 0; round < 800; round++) {
    let text = "";
    const n = 3 + rand(12);
    for (let i = 0; i < n; i++) text += words[rand(words.length)];
    const expected = wholeLines(text);
    for (let k = 0; k < 8; k++) {
      const lines: string[] = [];
      const out = new JobOutput(MASKS, (l) => lines.push(l), "text");
      let at = 0;
      while (at < text.length) {
        const len = 1 + rand(12);
        out.push(text.slice(at, at + len));
        at += len;
        cuts++;
      }
      out.end();
      expect([text, lines]).toEqual([text, expected]);
    }
  }
  expect(cuts).toBeGreaterThan(5000);
});

test("property: JSON events and text lines are two flows; a JSON line in the middle does not release the text", () => {
  // The text flow carries secrets of several lines, whose lines can be valid JSON themselves (`1234`).
  const secrets: [string, string][] = [
    ["abcd\n1234\nwxyz", "[secret:A]"],
    ["two\nlines", "[secret:B]"],
    ["tok_abc123", "[secret:C]"],
  ];
  const r = seeded(424242);
  const textPieces = ["abcd", "1234", "wxyz", "two", "lines", "tok_abc123", "plain", "[1]", "null", "x y"];
  const event = () =>
    JSON.stringify({ type: "result", result: r.pick(["ok", "tok_abc123", "two\nlines"], "value") });
  let cases = 0;
  for (let round = 0; round < 600; round++) {
    // Text lines with events put between them anywhere.
    const textLines = Array.from({ length: 1 + r.int(6, "textLines") }, () =>
      r.pick(textPieces, "textPiece"),
    );
    const all: string[] = [];
    for (const line of textLines) {
      while (r.int(3, "eventsBetween") === 0) all.push(event());
      all.push(line);
    }
    if (r.int(2)) all.push(event());
    const input = `${all.join("\n")}\n`;
    for (let k = 0; k < 8; k++) {
      const text: string[] = [];
      const events: string[] = [];
      const out = new JobOutput(secrets, (line, ev) => (ev ? events.push(line) : text.push(line)));
      let at = 0;
      while (at < input.length) {
        const len = 1 + r.int(16, "cut");
        out.push(input.slice(at, at + len));
        at += len;
      }
      out.end();
      // The text that went out is the mask of the text that came in, whatever events were in between.
      const expected = maskSecrets(`${textLines.join("\n")}\n`, secrets)
        .split("\n")
        .map((l) => l.trimEnd())
        .filter(Boolean);
      expect([input, text]).toEqual([input, expected]);
      // The events go to the runner raw, every one of them, in order.
      expect(events).toEqual(all.filter((l) => l.startsWith("{")));
      cases++;
    }
  }
  console.log(
    `[flows] ${cases} cases; cuts 1-16: ${JSON.stringify(r.spread("cut"))}; events between text lines: ${JSON.stringify(r.spread("eventsBetween"))}`,
  );
  expect(Math.min(...r.spread("cut"))).toBeGreaterThan(1000);
});
