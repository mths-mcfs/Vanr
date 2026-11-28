// The work area's pure rules: a description's list lines as criteria, a card's place between two others,
// and the formatted text people write.
import { describe, expect, test } from "bun:test";
import { positionBetween, splitCriteria } from "./issues/shared.tsx";
import { blocksOf, safeHref } from "./RichText.tsx";
import { addDays, describeRule, type RuleWords, startOfDay } from "./time.ts";

describe("criteria from a description", () => {
  test("list lines and boxes become criteria, the rest stays, and a bare marker is dropped", () => {
    expect(splitCriteria("Intro\n- one\n* two\n[ ] three\n- [x] four\n-\n[ ]\n\nOutro")).toEqual({
      description: "Intro\n\nOutro",
      criteria: ["one", "two", "three", "four"],
    });
    expect(splitCriteria("no list here")).toEqual({ description: "no list here", criteria: [] });
    expect(splitCriteria("-dash glued to a word")).toEqual({
      description: "-dash glued to a word",
      criteria: [],
    });
  });
});

describe("a place on the board", () => {
  test("between two neighbours, before the first, after the last, or alone", () => {
    expect(positionBetween(10, 20)).toBe(15);
    expect(positionBetween(undefined, 20)).toBe(20 - 1024);
    expect(positionBetween(10, undefined)).toBe(10 + 1024);
    expect(positionBetween(undefined, undefined)).toBe(0);
  });
});

describe("formatted text", () => {
  test("only http and https open as links", () => {
    expect(safeHref("https://git.example/pr/7")).toBe("https://git.example/pr/7");
    expect(safeHref("http://a.example")).toBe("http://a.example/");
    for (const bad of ["javascript:alert(1)", "data:text/html,x", "/relative", "ftp://x.example"]) {
      expect(safeHref(bad)).toBe(undefined);
    }
  });

  test("headings, lists, quotes, code and paragraphs become blocks", () => {
    const kinds = blocksOf(
      "# Title\n\nA line\nand more\n\n- a\n- b\n\n1. one\n\n> said\n\n```\ncode\n```",
    ).map((block) => block.kind);
    expect(kinds).toEqual(["heading", "paragraph", "list", "list", "quote", "code"]);
  });
});

describe("a repeating rule in words", () => {
  const words: RuleWords = {
    daily: (count) => `every ${count} day`,
    weekdays: () => "every weekday",
    weekly: (count, days) => `every ${count} week on ${days}`,
    hourly: (count) => `every ${count} hour`,
    minutely: (count) => `every ${count} minute`,
    monthly: (count, days) => `every ${count} month on ${days}`,
    yearly: () => "every year",
    at: (rule, times) => `${rule} at ${times}`,
  };
  test("the days a daily or weekly rule is limited to decide how it reads", () => {
    const say = (rule: Parameters<typeof describeRule>[0]) => describeRule(rule, words, "en");
    expect(
      say({ freq: "daily", weekdays: ["MO", "TU", "WE", "TH", "FR"], times: ["09:00"], timezone: "UTC" }),
    ).toBe("every weekday at 09:00");
    expect(say({ freq: "daily", weekdays: ["MO", "WE"], timezone: "UTC" })).toBe(
      "every 1 week on Monday and Wednesday",
    );
    expect(say({ freq: "daily", times: ["08:00"], timezone: "UTC" })).toBe("every 1 day at 08:00");
    expect(
      say({ freq: "daily", weekdays: ["SU", "MO", "TU", "WE", "TH", "FR", "SA"], timezone: "UTC" }),
    ).toBe("every 1 day");
    expect(describeRule({ freq: "daily", weekdays: ["MO", "WE"], timezone: "UTC" }, words, "pt-BR")).toBe(
      "every 1 week on segunda-feira e quarta-feira",
    );
  });
});

describe("days across a change of clocks", () => {
  test("the day after one whose midnight is skipped starts at midnight again", () => {
    const zone = process.env.TZ;
    // Santiago skips from 00:00 to 01:00 on 6 September 2026.
    process.env.TZ = "America/Santiago";
    try {
      const skipped = startOfDay(new Date(2026, 8, 6, 12));
      expect(skipped.getHours()).toBe(1);
      expect(addDays(skipped, 1).getHours()).toBe(0);
      expect(addDays(skipped, 7).getHours()).toBe(0);
    } finally {
      if (zone === undefined) delete process.env.TZ;
      else process.env.TZ = zone;
    }
  });
});
