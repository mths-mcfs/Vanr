import { expect, test } from "bun:test";
import { JobOutput, maskValue } from "./jobs";
import { maskSecrets } from "./secrets";

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

test("property (JSON lines): raw lines go to the runner unchanged and every string of the event is masked, for any cut", () => {
  const secrets: [string, string][] = [
    ['q"uo\\te', "[secret:Q]"],
    ["two\nlines", "[secret:L]"],
    ["system", "[secret:S]"],
  ];
  let seed = 3;
  const rand = (n: number) => {
    seed = (Math.imul(seed, 1103515245) + 12345) & 0x7fffffff;
    return seed % n;
  };
  const strings = ['q"uo\\te', "two\nlines", "system", "plain", "x two\nlines y", ""];
  const event = () =>
    rand(4) === 0
      ? "not json two"
      : JSON.stringify({
          type: strings[rand(strings.length)],
          [strings[rand(strings.length)] || "k"]: [
            strings[rand(strings.length)],
            { t: strings[rand(strings.length)] },
          ],
        });
  let cuts = 0;
  for (let round = 0; round < 700; round++) {
    const lines = Array.from({ length: 1 + rand(5) }, event);
    const text = `${lines.join("\n")}\n`;
    const got: [string, unknown][] = [];
    const out = new JobOutput(secrets, (line, masked) => got.push([line, masked]));
    let at = 0;
    while (at < text.length) {
      const len = 1 + rand(10);
      out.push(text.slice(at, at + len));
      at += len;
      cuts++;
    }
    out.end();
    const expected = lines.map((l): [string, unknown] => {
      try {
        const v: unknown = JSON.parse(l);
        return [l, maskValue(v, secrets)];
      } catch {
        return [maskSecrets(l, secrets), undefined];
      }
    });
    expect(got).toEqual(expected);
    for (const [, masked] of got)
      if (masked !== undefined)
        for (const [v] of secrets)
          expect(JSON.stringify(masked)).not.toContain(JSON.stringify(v).slice(1, -1));
  }
  expect(cuts).toBeGreaterThan(5000);
});
