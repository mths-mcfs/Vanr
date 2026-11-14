import { describe, expect, test } from "bun:test";
import { maskSecrets, StreamMasker } from "./secrets";

// Mask of the live output: a secret cut between pieces, and a multi-line secret that comes back from a
// terminal with `\r\n`, never show up in clear.
const PEM = "-----BEGIN KEY-----\nAAAASECRETLINE1\nBBBBSECRETLINE2\n-----END KEY-----";
const masks: [string, string][] = [
  [PEM, "[secret PEM]"],
  ["tok_abc123", "[secret TOKEN]"],
];

function stream(chunks: string[], m: [string, string][] = masks): string {
  const masker = new StreamMasker(m);
  return chunks.map((c) => masker.push(c)).join("") + masker.end();
}

test("a secret cut at any point between two pieces comes out masked", () => {
  const text = `before tok_abc123 middle\n${PEM}\nend`;
  for (let i = 0; i <= text.length; i++) {
    const out = stream([text.slice(0, i), text.slice(i)]);
    expect(out).toBe("before [secret TOKEN] middle\n[secret PEM]\nend");
  }
});

test("in a terminal \\n becomes \\r\\n and the secret stays masked, even one character at a time", () => {
  const crlf = `x ${PEM.replace(/\n/g, "\r\n")}\r\n`;
  expect(stream([crlf])).toBe("x [secret PEM]\r\n");
  expect(stream([...crlf])).toBe("x [secret PEM]\r\n");
});

test("without secrets the text goes out at once; what was held goes out at the end", () => {
  const none = new StreamMasker([]);
  expect(none.push("abc")).toBe("abc");
  const m = new StreamMasker(masks);
  const first = m.push("partial tok_ab");
  expect(first + m.end()).toBe("partial tok_ab");
  expect(first.includes("tok_ab")).toBe(false);
});

describe("edge cases", () => {
  test("the end of the stream releases what is held, masked or in clear, and nothing stays held", () => {
    const m = new StreamMasker([["abcdEFGH", "[S]"]]);
    // It holds the longest secret minus one character: " abcdEF" could still become one.
    expect(m.push("xx abcdEF")).toBe("xx");
    expect(m.end()).toBe(" abcdEF");
    expect(m.end()).toBe("");
    expect(m.push("abcdEFGH")).toBe("");
    expect(m.end()).toBe("[S]");
  });

  test("a secret that is the prefix of another: each one is masked, the longer one whole", () => {
    const m: [string, string][] = [
      ["abcd", "[A]"],
      ["abcdEFGH", "[B]"],
    ];
    expect(stream(["x abc", "dEFGH y abcd z"], m)).toBe("x [B] y [A] z");
    expect(stream(["abcd", "EF", "GH"], m)).toBe("[B]");
    expect(stream(["abcd", "EF"], m)).toBe("[A]EF");
  });

  test("secrets of 1 and 2 characters are masked and hold at most one character", () => {
    const m: [string, string][] = [
      ["q", "[Q]"],
      ["zz", "[Z]"],
    ];
    const masker = new StreamMasker(m);
    expect(masker.push("aqz")).toBe("a[Q]");
    expect(masker.push("z!")).toBe("[Z]");
    expect(masker.end()).toBe("!");
  });

  test("several secrets in one piece and across pieces", () => {
    const m: [string, string][] = [
      ["s3cr3t-one", "[1]"],
      ["other-secret", "[2]"],
    ];
    expect(stream(["a s3cr3t-o", "ne b other-sec", "ret c s3cr3t-one"], m)).toBe("a [1] b [2] c [1]");
  });
});

test("property: for any cut of the output into pieces, the stream equals the mask of the whole output", () => {
  const secrets: [string, string][] = [
    ["abcdEFGH", "[S1]"],
    ["abcd", "[S2]"],
    ["EF\nGH", "[S3]"],
    ["ba", "[S4]"],
    ["x", "[S5]"],
  ];
  // What the mask of the whole output is: the same masks, longest first, plus the \r\n form of the multi-line one.
  const ordered: [string, string][] = [...secrets, ["EF\r\nGH", "[S3]"] as [string, string]].sort(
    (a, b) => b[0].length - a[0].length,
  );
  let seed = 12345;
  const rand = (n: number) => {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    return seed % n;
  };
  const alphabet = [
    "a",
    "b",
    "c",
    "d",
    "E",
    "F",
    "G",
    "H",
    "\n",
    "\r",
    " ",
    "x",
    "abcdEFGH",
    "EF\nGH",
    "EF\r\nGH",
  ];
  let cuts = 0;
  for (let round = 0; round < 1000; round++) {
    let text = "";
    const parts = 5 + rand(40);
    for (let i = 0; i < parts; i++) text += alphabet[rand(alphabet.length)];
    const expected = maskSecrets(text, ordered);
    for (let k = 0; k < 5; k++) {
      const chunks: string[] = [];
      let at = 0;
      while (at < text.length) {
        const len = 1 + rand(8);
        chunks.push(text.slice(at, at + len));
        at += len;
        cuts++;
      }
      expect([text, stream(chunks, secrets)]).toEqual([text, expected]);
    }
  }
  expect(cuts).toBeGreaterThan(5000);
});
