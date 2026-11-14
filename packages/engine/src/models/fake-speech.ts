// How the test model speaks. Without an Anthropic key it is the one answering in the product, so the
// speech has to be readable: short sentences about what it did, with no ids, no test directives and none
// of the raw text a tool returns to the model (with ids and internal formats).

/**
 * Per tool: what it is about to do (base form), what it did (past) and where the detail after the colon
 * comes from: a field of the request, `=` for the result, `^` for its first line.
 */
const SPEECH: Readonly<Record<string, readonly [doing: string, done: string, detail?: string]>> = {
  remember: ["save to memory", "Saved to memory", "text"],
  update_memory: ["update the memory", "Updated the memory", "text"],
  forget: ["remove from memory", "Removed from memory"],
  search: ["search", "Searched", "query"],
  react: ["react", "Reacted", "emoji"],
  schedule_reminder: ["set a reminder", "Set the reminder", "text"],
  list_reminders: ["check the reminders", "Checked the reminders", "="],
  cancel_reminder: ["cancel the reminder", "Canceled the reminder"],
  load_skill: ["open the skill", "Opened the skill", "name"],
  read_skill_file: ["read the skill file", "Read the skill file", "path"],
  ask_agent: ["ask another agent", "Asked another agent, and the answer was", "="],
  post_message: ["post in the channel", "Posted in the channel", "channel"],
  ask_user: ["ask you", "Asked, and the answer was", "="],
  propose_instruction_change: [
    "propose a change to the instructions",
    "Proposed a change to the instructions",
    "title",
  ],
  propose_context_change: ["propose a change to the context", "Proposed a change to the context", "title"],
  list_drive_files: ["look at the Drive", "Looked at the Drive"],
  read_drive_file: ["read the file", "Read the file"],
  create_drive_file: ["create the file", "Created the file", "title"],
  update_drive_file: ["save the file", "Saved a new version of the file"],
  share_drive_file: ["show the file here", "Showed the file here"],
  read_wiki_page: ["read the wiki page", "Read the wiki page", "slug"],
  create_wiki_page: ["create the wiki page", "Created the wiki page", "title"],
  update_wiki_page: ["update the wiki page", "Updated the wiki page", "slug"],
  link_to_wiki: ["link the wiki pages", "Linked the wiki pages"],
  list_issues: ["look at the issues", "Looked at the issues"],
  create_issue: ["create the issue", "Created the issue", "title"],
  update_issue: ["update the issue", "Updated the issue"],
  comment_issue: ["comment on the issue", "Commented on the issue", "text"],
  list_events: ["check the calendar", "Checked the calendar", "="],
  find_free_time: ["look for a free slot", "Looked for a free slot", "="],
  propose_event: ["propose the event", "Proposed the event", "title"],
  create_routine: ["create the routine", "Created the routine", "schedule"],
  list_routines: ["look at the routines", "Looked at the routines"],
  update_routine: ["update the routine", "Updated the routine"],
  open_debate: ["open the debate", "Opened the debate", "title"],
  read_debate: ["read the debate", "Read the debate"],
  post_in_debate: ["write in the debate", "Wrote in the debate", "body"],
  run_code: ["run the command", "Ran the command", "="],
  read_file: ["read the file", "Read the file", "path"],
  write_file: ["write the file", "Wrote the file", "path"],
  list_files: ["list the folder", "Listed the folder", "path"],
  export_file: ["save the file to the Drive", "Saved the file to the Drive", "path"],
  import_file: ["copy the file from the Drive", "Copied the file from the Drive", "path"],
  environment_status: ["check the environment", "Checked the environment"],
  environment_start: ["start the environment", "Started the environment"],
  environment_stop: ["stop the environment", "Stopped the environment"],
  request_secret: ["ask for a secret", "Asked for the secret", "name"],
  browser_open: ["open the site", "Opened the site", "^"],
  browser_read: ["read the page", "Read the page", "^"],
  browser_click: ["click on the page", "Clicked on the page", "^"],
  browser_fill: ["fill in the field", "Filled in the field", "^"],
  browser_select: ["pick the option", "Picked the option", "option"],
  browser_check: ["tick the option", "Ticked the option", "^"],
  browser_press: ["press a key", "Pressed", "key"],
  browser_scroll: ["scroll the page", "Scrolled the page", "^"],
  browser_back: ["go back a page", "Went back a page", "^"],
  browser_wait: ["wait for the page", "Waited for the page", "^"],
  browser_tabs: ["look at the tabs", "Looked at the tabs"],
  browser_upload: ["upload the file through the site", "Uploaded the file through the site", "path"],
  browser_type_secret: ["type the secret", "Typed the secret", "name"],
  browser_screenshot: ["take a screenshot of the page", "Took a screenshot of the page"],
  browser_ask_person: ["ask a person for help in the browser", "Asked a person for help in the browser", "="],
  browser_close: ["close the browser", "Closed the browser"],
  mail_folders: ["look at the mail folders", "Looked at the mail folders"],
  mail_search: ["search the email", "Searched the email"],
  mail_read: ["read the email", "Read the email"],
  mail_draft: ["save the draft", "Saved the draft", "subject"],
  mail_organize: ["organize the email", "Organized the email"],
  mail_send: ["send the email", "Sent the email", "subject"],
  mail_reply: ["reply to the email", "Replied to the email"],
  mail_forward: ["forward the email", "Forwarded the email"],
  mail_delete: ["delete the email", "Moved the email to the trash"],
  db_list_tables: ["look at the tables", "Looked at the tables", "database"],
  db_describe_table: ["look at the table", "Looked at the table", "table"],
  db_query: ["query the database", "Queried the database", "^"],
  update_plan: ["update the plan", "Updated the plan"],
  report: ["send the report", "Sent the report"],
  ask_decision: ["ask for a decision", "Asked for a decision", "="],
  request_review: ["ask for a review", "Asked for a review", "title"],
  request_approval: ["ask for approval", "Asked for approval", "="],
  upload_drive_file: ["save the file", "Saved the file", "title"],
  get_context: ["read the assignment context", "Read the assignment context"],
  start_job: ["start the job in the environment", "Started the job in the environment", "title"],
  complete_assignment: ["submit the assignment", "Submitted the assignment"],
  propose_assignment: ["propose the assignment", "Proposed the assignment", "title"],
};

const speechOf = (tool: string) => SPEECH[tool] ?? ([`use ${tool}`, `Used ${tool}`, "="] as const);

/** A note from whoever helped in the browser, in parentheses and without the final period (the sentence ends with one). */
const note = (text: string | undefined) => (text?.trim() ? ` (${text.trim().replace(/[.!]+$/, "")})` : "");

/** Known tool answers (written for the model) in the words of whoever reads them. */
const KNOWN_RESULTS: readonly [RegExp, (m: RegExpMatchArray) => string][] = [
  // `run_code` output: what the command printed, or the exit code and the error.
  // The text arrives trimmed: output with only whitespace leaves the marker (`stdout:`) with no newline after it.
  [
    /^exit code: (\S+)(?:\nstdout:(?:\n([\s\S]*?))?)?(?:\nstderr:(?:\n([\s\S]*?))?)?(?:\n\(output truncated on the environment\))?$/,
    (m) => {
      const out = (m[2] ?? "").trim();
      const err = (m[3] ?? "").trim();
      if (m[1] === "0") return out || "no output";
      const said = err || out;
      const why = m[1] === "timeout" ? "timed out" : `exited with code ${m[1]}`;
      return `${why}${said ? `: ${said}` : ""}`;
    },
  ],
  // Reminders (`<id> at <ISO>: text`, one per line): the text and, in parentheses, when.
  [
    /^\w+ at \d{4}-\d\d-\d\dT\S+: [^\n]*(?:\n\w+ at \d{4}-\d\d-\d\dT\S+: [^\n]*)*$/,
    (m) =>
      m[0]
        .split("\n")
        .map((line) => line.replace(/^\w+ at (\S+): (.*)$/, "$2 ($1)"))
        .join("\n"),
  ],
  [/^Answer: ([\s\S]*)$/, (m) => m[1] ?? ""],
  [/^The team chose: ([\s\S]*)$/, (m) => m[1] ?? ""],
  [/^Not approved: (.+?) rejected(?: \((.*)\))?\./, (m) => `${m[1]} rejected it${m[2] ? ` (${m[2]})` : ""}`],
  [/^Not approved: nobody decided/, () => "nobody decided within 24 hours"],
  [/^Not approved: the request was canceled/, () => "the request was canceled"],
  [/^Nobody answered in time/, () => "nobody answered in time"],
  [/^The person finished(?:: ([^\n]*))?/, (m) => `the person finished${note(m[1])}`],
  [
    /^The person did not finish(?: \([^)]*\))?(?:: ([^\n]*))?/,
    (m) => `the person did not finish${note(m[1])}`,
  ],
  [/^The run stopped before/, () => "the work stopped early"],
  [/^\(no answer\)$/, () => "no answer"],
  [
    /^(?:No \w+(?: \w+)? found|No events|No scheduled reminders|You have no routines|No tabs)\.?$/,
    () => "nothing",
  ],
];

/** The `fake.ts` directives (same grammar as `TOOL_RE` and `SLOW_RE`); a wiki `[[Page]]` stays. */
const DIRECTIVES = /\[\[(?:tool:[a-z_]+(?:\s+\{[^\n]*?\})?|slow:\d{1,5}|fail|silent|advise)\]\]/g;
/** A directive cut at the end of the line (the server cuts long excerpts), without the closing `]]`. */
const CUT_DIRECTIVES = /\[\[(?:tool:|slow:|fail|silent|t|s|f)(?:(?!\]\])[^\n])*$/gm;
/** A server ISO date (`2026-10-22T10:00:00.000Z`), in UTC as it came. */
const ISO_TIMES = /\b\d{4}-(\d\d)-(\d\d)T(\d\d):(\d\d)(?::\d\d(?:\.\d+)?)?Z\b/g;
/** Internal ids (`mem_x8…`, `toolu_fake_3`): for the model, not for the reader. */
const IDS = /\b(?:[a-z]{2,6}_[a-z0-9]{8,}|toolu_fake_\d+)\b/g;
/** A context prefix at the start of the line (`[#channel 2026-10-21T23:54]`). */
const LINE_TAGS = /^\[[^\]\n]*\]\s*/gm;

function cut(text: string, max: number): string {
  if (text.length <= max) return text;
  const head = text.slice(0, max - 1);
  // Only goes back to the last space if the word was cut in half.
  const whole = /\s/.test(text[max - 1] ?? "");
  const space = head.lastIndexOf(" ");
  const kept = whole || space <= max / 2 ? head : head.slice(0, space);
  return `${kept.replace(/[\s.,;:]+$/, "")}…`;
}

/** Outside text (a request or a result) cleaned up to appear in a sentence. */
export function tidy(text: string, max = 140): string {
  const raw = text.replace(DIRECTIVES, "").replace(CUT_DIRECTIVES, "").trim();
  let plain = raw;
  for (const [re, say] of KNOWN_RESULTS) {
    const m = raw.match(re);
    if (m) {
      plain = say(m);
      break;
    }
  }
  const lines = plain
    .replace(LINE_TAGS, "")
    .replace(IDS, "")
    .replace(ISO_TIMES, "$2/$1 $3:$4 UTC")
    .replace(/\(\s*\)/g, "")
    .split("\n")
    .map((l) => l.replace(/\s+/g, " ").trim())
    .filter(Boolean);
  return cut(lines.slice(0, 2).join("; "), max);
}

/** Ends the sentence with a period, unless it already ends in punctuation or an address (the period would stick to it). */
const sentence = (text: string) => (/[.!?…]$|https?:\/\/\S+$/.test(text) ? text : `${text}.`);

function inputText(input: unknown, field: string): string {
  if (typeof input !== "object" || input === null || !(field in input)) return "";
  const value: unknown = Reflect.get(input, field);
  return typeof value === "string" || typeof value === "number" ? tidy(String(value), 100) : "";
}

/** "a, b and c". */
function list(items: readonly string[]): string {
  if (items.length <= 1) return items[0] ?? "";
  return `${items.slice(0, -1).join(", ")} and ${items.at(-1)}`;
}

/** The speech before the tools: "I'll save to memory and search." */
export function aboutToUse(tools: readonly string[]): string {
  return sentence(`I'll ${list([...new Set(tools.map((t) => speechOf(t)[0]))])}`);
}

/** One line per tool that came back: what it did and the gist of the result, or what went wrong. */
export function afterTool(tool: string, input: unknown, result: string, isError: boolean): string {
  const [doing, done, detail] = speechOf(tool);
  if (isError) {
    const why = tidy(result);
    return sentence(why ? `I couldn't ${doing}: ${why}` : `I couldn't ${doing}`);
  }
  const shown =
    detail === "="
      ? tidy(result)
      : detail === "^"
        ? tidy(result.split("\n")[0] ?? "")
        : detail
          ? inputText(input, detail)
          : "";
  return sentence(shown ? `${done}: ${shown}` : done);
}

/** An answer without tools: repeats the request and says whose it is (the runtime puts "Name (@handle):" in front). */
export function echo(text: string): string {
  const from = /^([^\n:]{1,80}?) \(@[\w.-]+\):\s*/.exec(text);
  const asked = tidy(from ? text.slice(from[0].length) : text, 200);
  if (!asked) return "Hi! How can I help?";
  return sentence(from ? `Got the request from ${from[1]}: ${asked}` : `Got the request: ${asked}`);
}
