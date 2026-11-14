import { describe, expect, test } from "bun:test";
import {
  afterRound,
  answerKey,
  assignPseudonyms,
  benchmarkDefault,
  majority,
  normalizeAnswer,
  pairedComparison,
  parseDivergenceSynthesis,
  parsePosition,
  seededRng,
  shuffled,
  voteSynthesis,
} from "./debate-protocol";

describe("draw", () => {
  test("same seed, same order; another seed, another order", () => {
    const items = Array.from({ length: 12 }, (_, i) => i);
    expect(shuffled(items, seededRng("a"))).toEqual(shuffled(items, seededRng("a")));
    expect(shuffled(items, seededRng("a"))).not.toEqual(shuffled(items, seededRng("b")));
    expect([...shuffled(items, seededRng("a"))].sort((x, y) => x - y)).toEqual(items);
  });

  test("pseudonyms are a permutation of the letters and do not follow the input order", () => {
    const ids = ["ag_1", "ag_2", "ag_3", "ag_4", "ag_5"];
    const firsts = new Set<string>();
    for (let s = 0; s < 40; s++) {
      const a = assignPseudonyms(ids, seededRng(`t${s}`));
      expect(Object.values(a).sort()).toEqual(["A", "B", "C", "D", "E"]);
      firsts.add(a.ag_1 as string);
    }
    // In 40 draws, the first agent does not always get "A".
    expect(firsts.size).toBeGreaterThan(2);
  });

  test("more than 26 participants get a suffix and stay unique", () => {
    const ids = Array.from({ length: 30 }, (_, i) => `x${i}`);
    const a = assignPseudonyms(ids, seededRng("big"));
    expect(new Set(Object.values(a)).size).toBe(30);
  });
});

describe("claim", () => {
  test("trailing JSON becomes the claim; the argument is left without the JSON", () => {
    const text =
      'Acho que o cache resolve.\n\n{"answer": "Usar cache", "confidence": 0.8, "reason": "", "evidence": ["p95 caiu 40%"]}';
    const { argument, position } = parsePosition(text);
    expect(argument).toBe("Acho que o cache resolve.");
    expect(position).toEqual({
      answer: "Usar cache",
      key: "usar cache",
      confidence: 0.8,
      reason: "",
      evidence: ["p95 caiu 40%"],
    });
  });

  test("confidence outside 0–1 is clamped; a non-number becomes null", () => {
    expect(parsePosition('{"answer":"x","confidence":7}').position.confidence).toBe(1);
    expect(parsePosition('{"answer":"x","confidence":-2}').position.confidence).toBe(0);
    expect(parsePosition('{"answer":"x","confidence":"alta"}').position.confidence).toBeNull();
  });

  test("without JSON, the first sentence is the answer and confidence stays null", () => {
    const { position, argument } = parsePosition("Vamos de Postgres. O resto depois.");
    expect(position.answer).toBe("Vamos de Postgres.");
    expect(position.confidence).toBeNull();
    expect(argument).toBe("Vamos de Postgres. O resto depois.");
  });

  test("uses the last JSON with answer (the argument may quote another one)", () => {
    const text = 'O exemplo {"answer": "errado"} não vale.\n{"answer": "certo", "confidence": 0.5}';
    expect(parsePosition(text).position.answer).toBe("certo");
  });

  test("JSON evidence strings keep nested braces, unmatched braces and escaped quotes", () => {
    for (const evidence of ['output: {"result":{"ok":true}}', "SyntaxError: expected }", 'quote: \\" {']) {
      const claim = { answer: "SQLite", confidence: 0.8, reason: "", evidence: [evidence] };
      const { position, argument } = parsePosition(
        `Analisei os resultados.\n\`\`\`json\n${JSON.stringify(claim)}\n\`\`\``,
        ["Postgres", "SQLite"],
      );
      expect(position).toEqual({ ...claim, key: "option:1" });
      expect(argument).toBe("Analisei os resultados.");
    }
  });

  test("quotes in the argument do not hide the final JSON", () => {
    const body = 'A tela mede 27".';
    const claim = { answer: "SQLite", confidence: 0.8, reason: "", evidence: [] };
    for (const fenced of [false, true]) {
      const json = JSON.stringify(claim);
      const text = `${body}\n${fenced ? `\`\`\`json\n${json}\n\`\`\`` : json}`;
      const { argument, position } = parsePosition(text, ["Postgres", "SQLite"]);
      expect(argument).toBe(body);
      expect(position).toEqual({ ...claim, key: "option:1" });
    }
  });

  test("normalizes numbers, accents and punctuation", () => {
    expect(normalizeAnswer("42.0")).toBe("42");
    expect(normalizeAnswer(" 1,000 ")).toBe("1000");
    expect(normalizeAnswer("1,000,000.5")).toBe("1000000.5");
    // A decimal comma does not glue the digits: 1,5 is not 15.
    expect(normalizeAnswer("1,5")).toBe("1.5");
    expect(normalizeAnswer("3,14")).toBe("3.14");
    expect(normalizeAnswer("-0,25")).toBe("-0.25");
    expect(normalizeAnswer("Ação!")).toBe("acao");
    expect(normalizeAnswer("Sim.")).toBe("sim");
  });

  test("with options, the answer becomes the option (equal, letter or quoted once)", () => {
    const opts = ["Postgres", "SQLite", "Mongo"];
    expect(answerKey("postgres", opts)).toBe("option:0");
    expect(answerKey("b)", opts)).toBe("option:1");
    expect(answerKey("Eu iria de Mongo pelo esquema", opts)).toBe("option:2");
    expect(answerKey("Postgres ou SQLite", opts)).toBe("other:postgres ou sqlite");
    // No answer, no vote: the key stays empty, with or without options.
    expect(answerKey("  ", opts)).toBe("");
    expect(answerKey("", [])).toBe("");
  });

  test("a mentioned option is not a prefix or unsigned part of another number or name", () => {
    expect(answerKey("Escolho 1.5", ["1", "1.5", "2"])).toBe("option:1");
    expect(answerKey("Escolho -1", ["1", "2"])).toBe("other:escolho -1");
    expect(answerKey("Escolho 1,5", ["1", "2"])).toBe("other:escolho 1,5");
    expect(answerKey("Escolho Node.js", ["Node", "Node.js"])).toBe("option:1");
  });
});

describe("simple majority", () => {
  const v = (member: string, key: string, confidence: number | null = null) => ({
    member,
    key,
    answer: key,
    confidence,
  });

  test("punctuation after a single option keeps its vote in the majority", () => {
    const options = ["Postgres", "SQLite", "Mongo"];
    const votes = ["Mongo", "Mongo, pelo esquema.", "Postgres"].map((answer, i) => ({
      member: String(i),
      answer,
      key: answerKey(answer, options),
      confidence: null,
    }));
    expect(majority(votes, options).winner).toBe("Mongo");
    expect(answerKey("Mongo, ou Postgres.", options)).toBe("other:mongo, ou postgres");
  });

  test("counts one vote per participant; confidence does not weigh", () => {
    // Two weak votes beat one vote with confidence 1.
    const m = majority([v("A", "x", 0.1), v("B", "x", 0.2), v("C", "y", 1)]);
    expect(m.winner).toBe("x");
    expect(m.groups.map((g) => [g.key, g.count, g.meanConfidence])).toEqual([
      ["x", 2, 0.15],
      ["y", 1, 1],
    ]);
    expect(m.unanimous).toBe(false);
  });

  test("a tie has no winner", () => {
    const m = majority([v("A", "x"), v("B", "y")]);
    expect(m.tie).toBe(true);
    expect(m.winner).toBeNull();
  });

  test("with options, the label is the option", () => {
    const m = majority(
      [
        { member: "A", key: "option:1", answer: "b", confidence: null },
        { member: "B", key: "option:1", answer: "SQLite", confidence: null },
      ],
      ["Postgres", "SQLite"],
    );
    expect(m.winner).toBe("SQLite");
    expect(m.unanimous).toBe(true);
  });
});

describe("stopping", () => {
  const map = (o: Record<string, string>) => new Map(Object.entries(o));

  test("round 0 without divergence goes straight to the synthesis", () => {
    expect(
      afterRound({
        round: 0,
        roundLimit: 2,
        current: map({ a: "x", b: "x" }),
        previous: null,
        budgetHit: false,
      }),
    ).toEqual({
      next: false,
      reason: "unanimous",
    });
  });

  test("round 0 with divergence continues; with 0 challenge rounds, it is a vote", () => {
    const current = map({ a: "x", b: "y" });
    expect(afterRound({ round: 0, roundLimit: 1, current, previous: null, budgetHit: false })).toEqual({
      next: true,
    });
    expect(afterRound({ round: 0, roundLimit: 0, current, previous: null, budgetHit: false })).toEqual({
      next: false,
      reason: "max_rounds",
    });
  });

  test("no claim changed: stop, even with rounds left", () => {
    const previous = map({ a: "x", b: "y" });
    expect(
      afterRound({ round: 1, roundLimit: 5, current: map({ a: "x", b: "y" }), previous, budgetHit: false }),
    ).toEqual({
      next: false,
      reason: "no_change",
    });
    expect(
      afterRound({ round: 1, roundLimit: 5, current: map({ a: "y", b: "x" }), previous, budgetHit: false }),
    ).toEqual({
      next: true,
    });
  });

  test("the debate cap beats everything", () => {
    expect(
      afterRound({
        round: 0,
        roundLimit: 3,
        current: map({ a: "x", b: "y" }),
        previous: null,
        budgetHit: true,
      }),
    ).toEqual({
      next: false,
      reason: "budget",
    });
  });
});

describe("divergence synthesis", () => {
  test("reads agreements, disagreements and what each side would have to prove", () => {
    const s = parseDivergenceSynthesis(
      JSON.stringify({
        summary: "S",
        decision: "D",
        agreements: ["a1"],
        disagreements: [
          {
            point: "custo",
            sides: [{ position: "barato", mustProve: "p95 abaixo de 1 s" }, { position: "caro" }],
          },
          { nope: 1 },
        ],
      }),
    );
    expect(s).toEqual({
      summary: "S",
      decision: "D",
      agreements: ["a1"],
      disagreements: [
        {
          point: "custo",
          sides: [
            { position: "barato", mustProve: "p95 abaixo de 1 s" },
            { position: "caro", mustProve: "" },
          ],
        },
      ],
    });
  });

  test("truncated JSON becomes a text summary", () => {
    expect(parseDivergenceSynthesis('{"summary": "meio')).toEqual({ summary: '{"summary": "meio' });
  });

  test("vote synthesis: the majority decides and the groups become sides", () => {
    const m = majority([
      { member: "A", key: "x", answer: "x", confidence: null },
      { member: "B", key: "x", answer: "x", confidence: null },
      { member: "C", key: "y", answer: "y", confidence: null },
    ]);
    const s = voteSynthesis(m);
    expect(s.decision).toBe("x");
    expect(s.disagreements?.[0]?.sides.map((x) => x.position)).toEqual(["x", "y"]);
  });
});

describe("benchmark: paired accuracy", () => {
  test("paired difference and interval", () => {
    const a = [true, true, true, false, true, true, false, true, true, true];
    const b = [true, false, true, false, true, false, false, true, true, true];
    const c = pairedComparison(a, b);
    expect(c.n).toBe(10);
    expect(c.accA).toBe(0.8);
    expect(c.accB).toBe(0.6);
    expect(c.diff).toBe(0.2);
    expect(c.discordant).toBe(2);
    // sd of the differences = 0.4216; half width = 1.96 × 0.4216 / √10 = 0.2613
    expect(c.ci95[0]).toBeCloseTo(-0.0613, 3);
    expect(c.ci95[1]).toBeCloseTo(0.4613, 3);
  });

  test("owner's rule: debate only with the whole interval above zero", () => {
    expect(
      benchmarkDefault({ n: 10, accA: 0.8, accB: 0.6, diff: 0.2, ci95: [-0.06, 0.46], discordant: 2 }),
    ).toBe("vote");
    expect(
      benchmarkDefault({ n: 300, accA: 0.8, accB: 0.7, diff: 0.1, ci95: [0.05, 0.15], discordant: 30 }),
    ).toBe("debate");
    expect(benchmarkDefault(pairedComparison([], []))).toBe("vote");
    // Two equal items give zero variance and the interval [1, 1]: a sample too small to decide.
    expect(pairedComparison([true, true], [false, false]).ci95).toEqual([1, 1]);
    expect(benchmarkDefault(pairedComparison([true, true], [false, false]))).toBe("vote");
    const many = Array.from({ length: 30 }, () => true);
    expect(
      benchmarkDefault(
        pairedComparison(
          many,
          many.map(() => false),
        ),
      ),
    ).toBe("debate");
  });

  test("samples of different sizes are an error", () => {
    expect(() => pairedComparison([true], [])).toThrow();
  });
});
