import { expect, test } from "bun:test";
import { aboutToUse, afterTool, echo, tidy } from "./fake-speech";

test("the answer after the tools shows no id, directive or internal format", () => {
  // The screenshot case: save and search the history, with the request full of test directives.
  const remembered = afterTool(
    "remember",
    { text: "Trip to Chicago in November" },
    "Saved memory mem_dee0x08er5xm8spo.",
    false,
  );
  const found = afterTool(
    "list_events",
    { query: "trip" },
    '[DM 2026-10-21T23:54] Note that the trip is in November and look up the context. [[slow:300]] [[tool:remember {"text":"Trip to Chicago in November"}]] [[tool:s',
    false,
  );
  expect(remembered).toBe("Saved to memory: Trip to Chicago in November.");
  expect(found).toBe("Checked the calendar: Note that the trip is in November and look up the context.");
  expect(
    afterTool("search", { query: "trip from:@ana" }, "[1] message · DM · 2026-10-21 · /x\ntext", false),
  ).toBe("Searched: trip from:@ana.");
});

test("known answers are reworded for the reader; the rest is only cleaned up", () => {
  expect(afterTool("ask_user", { question: "Color?" }, "Answer: Blue", false)).toBe(
    "Asked, and the answer was: Blue.",
  );
  expect(
    afterTool(
      "post_message",
      { channel: "general", text: "hi" },
      "Not approved: Ana rejected (not now). Do not try again unless asked.",
      true,
    ),
  ).toBe("I couldn't post in the channel: Ana rejected it (not now).");
  expect(afterTool("search", { query: "vacation" }, "No results.", false)).toBe("Searched: vacation.");
  expect(afterTool("list_events", {}, "No events.", false)).toBe("Checked the calendar: nothing.");
  expect(
    afterTool("browser_navigate", { url: "airbnb.com" }, "Airbnb — https://airbnb.com/\n\nLong text", false),
  ).toBe("Went to the site: Airbnb — https://airbnb.com/");
  // A command: what it printed; on error, the code and the stderr.
  expect(afterTool("execute_code", { command: "echo hi" }, "exit code: 0\nstdout:\nhi\n", false)).toBe(
    "Ran the command: hi.",
  );
  expect(afterTool("execute_code", { command: "false" }, "exit code: 2\nstderr:\nboom", true)).toBe(
    "I couldn't run the command: exited with code 2: boom.",
  );
  expect(
    afterTool("browser_ask_person", {}, "The person did not finish (failed): nothing showed up.", true),
  ).toBe("I couldn't ask a person for help in the browser: the person did not finish (nothing showed up).");
  expect(
    afterTool(
      "browser_ask_person",
      {},
      "The person finished: I logged in.\n\nDashboard — https://a.test/",
      false,
    ),
  ).toBe("Asked a person for help in the browser: the person finished (I logged in).");
  // A tool the table does not know: says the name and the cleaned-up result.
  expect(afterTool("github_open_pr", {}, "Opened PR pr_abcdefgh12 on repo", false)).toBe(
    "Used github_open_pr: Opened PR on repo.",
  );
});

test("the speech before the tools and the echo without tools", () => {
  expect(aboutToUse(["remember", "search", "remember"])).toBe("I'll save to memory and search.");
  expect(echo("Wesley (@wesley): [[slow:120]] word0 word1")).toBe(
    "Got the request from Wesley: word0 word1.",
  );
  expect(echo("Ana Prado (@ana-prado): @lia what are the Saturday hours?")).toBe(
    "Got the request from Ana Prado: @lia what are the Saturday hours?",
  );
  expect(echo("Turn requested in round 1 of 2.")).toBe("Got the request: Turn requested in round 1 of 2.");
  expect(echo("[[slow:50]]")).toBe("Hi! How can I help?");
  expect(tidy("a ".repeat(200), 20)).toBe("a a a a a a a a a a…");
});

test("review: a directive with a list, a directive cut in the middle, empty output, a timeout and reminders", () => {
  // A directive with `]` inside the JSON (the ask_user choices) and a directive cut before another line.
  expect(
    afterTool(
      "list_events",
      {},
      'Ask [[tool:ask_user {"question":"Which?","choices":["yes","no"]}]] this\nNote [[tool:remember {"text":"call the cli…\nSomething else',
      false,
    ),
  ).toBe("Checked the calendar: Ask this; Note.");
  // A wiki link is not a directive: it stays.
  expect(echo("see [[Vacation]] and tell me")).toBe("Got the request: see [[Vacation]] and tell me.");
  // `echo $EMPTY`: the marker has no content after trimming.
  expect(afterTool("execute_code", {}, "exit code: 0\nstdout:\n\n", false)).toBe(
    "Ran the command: no output.",
  );
  expect(afterTool("execute_code", {}, "exit code: 2\nstderr:\n\n", true)).toBe(
    "I couldn't run the command: exited with code 2.",
  );
  expect(afterTool("execute_code", {}, "exit code: timeout\nstdout:\nx", true)).toBe(
    "I couldn't run the command: timed out: x.",
  );
  expect(
    afterTool(
      "list_reminders",
      {},
      "rem_ab12cd34ef at 2026-10-22T10:00:00.000Z: call\nrem_zz12cd34ef at 2026-10-23T09:30:00.000Z: pay the bill",
      false,
    ),
  ).toBe("Checked the reminders: call (22/10 10:00 UTC); pay the bill (23/10 09:30 UTC).");
  expect(
    afterTool("find_available_time", {}, "2026-10-23T13:00:00.000Z → 2026-10-23T14:00:00.000Z", false),
  ).toBe("Looked for an available time: 23/10 13:00 UTC → 23/10 14:00 UTC.");
});

test("a tool named like an inherited object property gets the generic speech", () => {
  expect(aboutToUse(["constructor"])).toBe("I'll use constructor.");
  expect(afterTool("toString", {}, "done", false)).toBe("Used toString: done.");
  expect(afterTool("__proto__", {}, "boom", true)).toBe("I couldn't use __proto__: boom.");
});
