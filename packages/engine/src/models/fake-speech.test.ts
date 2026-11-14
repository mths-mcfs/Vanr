import { expect, test } from "bun:test";
import { aboutToUse, afterTool, echo, tidy } from "./fake-speech";

test("the answer after the tools shows no id, directive or internal format", () => {
  // The screenshot case: save and search the history, with the request full of test directives.
  const remembered = afterTool(
    "remember",
    { text: "Viagem para Chicago em novembro" },
    "Saved memory mem_dee0x08er5xm8spo.",
    false,
  );
  const found = afterTool(
    "list_events",
    { query: "viagem" },
    '[DM 2026-10-21T23:54] Anota que a viagem é em novembro e procura o contexto. [[slow:300]] [[tool:remember {"text":"Viagem para Chicago em novembro"}]] [[tool:s',
    false,
  );
  expect(remembered).toBe("Saved to memory: Viagem para Chicago em novembro.");
  expect(found).toBe("Checked the calendar: Anota que a viagem é em novembro e procura o contexto.");
  expect(
    afterTool("search", { query: "viagem from:@ana" }, "[1] message · DM · 2026-10-21 · /x\ntexto", false),
  ).toBe("Searched: viagem from:@ana.");
});

test("known answers are reworded for the reader; the rest is only cleaned up", () => {
  expect(afterTool("ask_user", { question: "Cor?" }, "Answer: Azul", false)).toBe(
    "Asked, and the answer was: Azul.",
  );
  expect(
    afterTool(
      "post_message",
      { channel: "general", text: "oi" },
      "Not approved: Ana rejected (agora não). Do not try again unless asked.",
      true,
    ),
  ).toBe("I couldn't post in the channel: Ana rejected it (agora não).");
  expect(afterTool("search", { query: "férias" }, "No results.", false)).toBe("Searched: férias.");
  expect(afterTool("list_events", {}, "No events.", false)).toBe("Checked the calendar: nothing.");
  expect(
    afterTool("browser_open", { url: "airbnb.com" }, "Airbnb — https://airbnb.com/\n\nTexto longo", false),
  ).toBe("Opened the site: Airbnb — https://airbnb.com/");
  // A command: what it printed; on error, the code and the stderr.
  expect(afterTool("run_code", { command: "echo oi" }, "exit code: 0\nstdout:\noi\n", false)).toBe(
    "Ran the command: oi.",
  );
  expect(afterTool("run_code", { command: "false" }, "exit code: 2\nstderr:\nboom", true)).toBe(
    "I couldn't run the command: exited with code 2: boom.",
  );
  expect(
    afterTool("browser_ask_person", {}, "The person did not finish (failed): não apareceu nada.", true),
  ).toBe("I couldn't ask a person for help in the browser: the person did not finish (não apareceu nada).");
  expect(
    afterTool("browser_ask_person", {}, "The person finished: entrei.\n\nPainel — https://a.test/", false),
  ).toBe("Asked a person for help in the browser: the person finished (entrei).");
  // A tool the table does not know: says the name and the cleaned-up result.
  expect(afterTool("github_open_pr", {}, "Opened PR pr_abcdefgh12 on repo", false)).toBe(
    "Used github_open_pr: Opened PR on repo.",
  );
});

test("the speech before the tools and the echo without tools", () => {
  expect(aboutToUse(["remember", "search", "remember"])).toBe("I'll save to memory and search.");
  expect(echo("Wesley (@wesley): [[slow:120]] palavra0 palavra1")).toBe(
    "Got the request from Wesley: palavra0 palavra1.",
  );
  expect(echo("Ana Prado (@ana-prado): @lia qual o horário de sábado?")).toBe(
    "Got the request from Ana Prado: @lia qual o horário de sábado?",
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
      'Pergunta [[tool:ask_user {"question":"Qual?","choices":["sim","não"]}]] isso\nAnota [[tool:remember {"text":"ligar pro cli…\nOutra coisa',
      false,
    ),
  ).toBe("Checked the calendar: Pergunta isso; Anota.");
  // A wiki link is not a directive: it stays.
  expect(echo("veja [[Férias]] e me diga")).toBe("Got the request: veja [[Férias]] e me diga.");
  // `echo $EMPTY`: the marker has no content after trimming.
  expect(afterTool("run_code", {}, "exit code: 0\nstdout:\n\n", false)).toBe("Ran the command: no output.");
  expect(afterTool("run_code", {}, "exit code: 2\nstderr:\n\n", true)).toBe(
    "I couldn't run the command: exited with code 2.",
  );
  expect(afterTool("run_code", {}, "exit code: timeout\nstdout:\nx", true)).toBe(
    "I couldn't run the command: timed out: x.",
  );
  expect(
    afterTool(
      "list_reminders",
      {},
      "rem_ab12cd34ef at 2026-10-22T10:00:00.000Z: ligar\nrem_zz12cd34ef at 2026-10-23T09:30:00.000Z: pagar boleto",
      false,
    ),
  ).toBe("Checked the reminders: ligar (22/10 10:00 UTC); pagar boleto (23/10 09:30 UTC).");
  expect(afterTool("find_free_time", {}, "2026-10-23T13:00:00.000Z → 2026-10-23T14:00:00.000Z", false)).toBe(
    "Looked for a free slot: 23/10 13:00 UTC → 23/10 14:00 UTC.",
  );
});

test("a tool named like an inherited object property gets the generic speech", () => {
  expect(aboutToUse(["constructor"])).toBe("I'll use constructor.");
  expect(afterTool("toString", {}, "done", false)).toBe("Used toString: done.");
  expect(afterTool("__proto__", {}, "boom", true)).toBe("I couldn't use __proto__: boom.");
});
