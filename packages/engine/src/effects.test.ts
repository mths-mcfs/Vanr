import { describe, expect, test } from "bun:test";
import type { EffectClass, GateReason, RiskReason } from "@vanr/contract";
import {
  approvalMatches,
  breakerOpen,
  canonicalJson,
  type Destination,
  EFFECT_CLASSES,
  type GateCall,
  gate,
  payloadHash,
  RiskTracker,
  rememberable,
  reviewable,
} from "./effects";

const NONE: Destination = { kind: "none" };
const INTERNAL: Destination = { kind: "internal" };
const PUBLIC: Destination = { kind: "internal", public: true };
const ALLOWED: Destination = { kind: "external", allowed: true, target: "ana@org.com" };
const STRANGER: Destination = { kind: "external", allowed: false, target: "x@fora.com" };

const A: RiskReason = { flag: "A", source: "browser_read https://fora.com" };
const B: RiskReason = { flag: "B", source: "browser_type_secret banco" };

function call(effect: EffectClass, destination: Destination, raises: RiskReason[] = []): GateCall {
  return { tool: "t", effect, destination, raises, input: { x: 1 }, preview: { title: "t" } };
}
const run = (...r: RiskReason[]) => new RiskTracker(r);

describe("gate: class × flags × destination table", () => {
  const cases: [string, RiskReason[], GateCall, "allow" | "ask" | "deny", GateReason?][] = [
    ["clean K0", [], call("K0", NONE), "allow"],
    ["clean K1", [], call("K1", INTERNAL), "allow"],
    ["K1 with A to an internal destination", [A], call("K1", INTERNAL), "allow"],
    ["K1 with A to a public destination", [A], call("K1", PUBLIC), "ask", "untrusted_public"],
    ["K2 to an allowed destination", [], call("K2", ALLOWED), "allow"],
    ["K2 with A only", [A], call("K2", ALLOWED), "allow"],
    ["K2 with B only", [B], call("K2", ALLOWED), "allow"],
    ["K2 with A and B: rule of two", [A, B], call("K2", ALLOWED), "ask", "rule_of_two"],
    ["K2 to a stranger, without A", [], call("K2", STRANGER), "ask", "destination_not_allowed"],
    ["K2 to a stranger with A: exfiltration", [A], call("K2", STRANGER), "deny", "untrusted_to_external"],
    ["clean K3", [], call("K3", ALLOWED), "ask", "irreversible"],
    ["internal K3", [], call("K3", INTERNAL), "ask", "irreversible"],
    ["K3 to a stranger with A", [A], call("K3", STRANGER), "deny", "untrusted_to_external"],
    ["K1 going outside with A", [A], call("K1", ALLOWED), "ask", "untrusted_public"],
    ["K1 going outside without A", [], call("K1", ALLOWED), "allow"],
    ["workspace rule asks on a clean K1", [], { ...call("K1", INTERNAL), policy: "ask" }, "ask", "policy"],
    [
      "a workspace rule does not remove the deny",
      [A],
      { ...call("K2", STRANGER), policy: "ask" },
      "deny",
      "untrusted_to_external",
    ],
    [
      "K3 with a workspace rule: the reason is the class",
      [],
      { ...call("K3", INTERNAL), policy: "ask" },
      "ask",
      "irreversible",
    ],
  ];
  for (const [name, flags, c, kind, reason] of cases) {
    test(name, () => {
      const d = gate(run(...flags), c);
      expect(d.kind).toBe(kind);
      if (reason && d.kind !== "allow") expect(d.reason).toBe(reason);
    });
  }

  test("browser: an outside read that closes the rule of two asks a person", () => {
    // It already has a login (B) and already acted outside (C); reading external content now would join all three.
    const r = run(B, { flag: "C", source: "browser_click" });
    const d = gate(r, call("K0", NONE, [A]));
    expect(d.kind).toBe("ask");
    if (d.kind === "ask") expect(d.reason).toBe("rule_of_two");
  });

  test("ask carries the preview and the hash of the exact payload", () => {
    const c = call("K3", ALLOWED);
    const d = gate(run(), c);
    expect(d.kind).toBe("ask");
    if (d.kind !== "ask") return;
    expect(d.preview).toEqual({ title: "t" });
    expect(d.payloadHash).toBe(payloadHash("t", { x: 1 }));
    expect(d.flags).toEqual(["C"]);
  });
});

describe("RiskTracker", () => {
  test("flags only grow and keep the reason without repeating", () => {
    const t = new RiskTracker();
    t.raise(A);
    t.raise(A);
    t.record(call("K2", ALLOWED, [B]));
    expect([...t.flags].sort()).toEqual(["A", "B", "C"]);
    expect(t.reasons.map((r) => r.flag)).toEqual(["A", "B", "C"]);
  });

  test("a read without destination does not raise C", () => {
    const t = new RiskTracker();
    t.record(call("K0", NONE));
    expect(t.flags.has("C")).toBe(false);
  });
});

describe("payload hash", () => {
  test("key order does not change the hash; the value does", () => {
    expect(canonicalJson({ b: 1, a: [1, { d: 2, c: 3 }] })).toBe('{"a":[1,{"c":3,"d":2}],"b":1}');
    expect(payloadHash("mail_send", { to: "a", body: "x" })).toBe(
      payloadHash("mail_send", { body: "x", to: "a" }),
    );
    expect(payloadHash("mail_send", { to: "a", body: "x" })).not.toBe(
      payloadHash("mail_send", { to: "a", body: "y" }),
    );
    expect(payloadHash("mail_send", { to: "a" })).not.toBe(payloadHash("mail_reply", { to: "a" }));
  });

  test("approving one email and sending another does not pass", () => {
    const approved = payloadHash("mail_send", { to: "ana@org.com", body: "oi" });
    expect(approvalMatches(approved, "mail_send", { to: "ana@org.com", body: "oi" })).toBe(true);
    expect(approvalMatches(approved, "mail_send", { to: "ana@org.com", body: "oi", bcc: "x@fora.com" })).toBe(
      false,
    );
  });

  test("a non-finite number is rejected (it does not silently become null)", () => {
    expect(() => canonicalJson({ x: Number.NaN })).toThrow();
  });
});

describe("request shortcuts: always allow and reviewer", () => {
  // Every combination of class × run flags × destination × workspace rule.
  const flagSets: RiskReason[][] = [[], [A], [B], [A, B]];
  const dests = [NONE, INTERNAL, PUBLIC, ALLOWED, STRANGER];
  const all = EFFECT_CLASSES.flatMap((effect) =>
    flagSets.flatMap((flags) =>
      dests.flatMap((destination) =>
        [undefined, "ask" as const].map((policy) => {
          const decision = gate(run(...flags), { ...call(effect, destination), policy });
          return { effect, flags, destination, policy, decision };
        }),
      ),
    ),
  );

  test("nothing in K3, nothing the gate denies or lets pass, becomes a shortcut", () => {
    for (const c of all) {
      if (c.effect === "K3" || c.decision.kind !== "ask") {
        expect(rememberable(c.decision)).toBe(false);
        expect(reviewable(c.decision)).toBe(false);
      }
    }
  });

  test("always allow: only a workspace request, without A in the run; reviewer: only rule of two and A to public", () => {
    for (const c of all) {
      if (rememberable(c.decision)) {
        expect(c.decision).toMatchObject({ kind: "ask", reason: "policy" });
        expect(c.decision.flags).not.toContain("A");
      }
      if (reviewable(c.decision)) {
        expect(["rule_of_two", "untrusted_public"]).toContain((c.decision as { reason: string }).reason);
        expect(["K1", "K2"]).toContain(c.effect);
      }
      // The two shortcuts never both apply to the same request.
      expect(rememberable(c.decision) && reviewable(c.decision)).toBe(false);
    }
    // There are cases of each (the sweep is not empty).
    expect(all.some((c) => rememberable(c.decision))).toBe(true);
    expect(all.some((c) => reviewable(c.decision))).toBe(true);
  });

  test("breaker: 3 person requests in a row or 10 in the last 50", () => {
    expect(breakerOpen([])).toBe(false);
    expect(breakerOpen(["ask", "ask", "allow"])).toBe(false);
    expect(breakerOpen(["ask", "ask", "ask", "allow"])).toBe(true);
    const spread = Array.from({ length: 50 }, (_, i) => (i % 5 === 0 ? "ask" : "allow") as "ask" | "allow");
    expect(breakerOpen(spread)).toBe(true);
    expect(breakerOpen(spread.slice(0, 45))).toBe(false);
    // A request older than 50 verdicts does not count.
    expect(breakerOpen([...Array(50).fill("allow"), ...Array(20).fill("ask")])).toBe(false);
  });
});
