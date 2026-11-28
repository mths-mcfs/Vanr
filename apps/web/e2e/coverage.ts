// Which journey covers each of the product's 31 end-to-end journeys, by file and test title. A journey
// that is only partly covered names what still has to cover the rest: a later box of #40 (P28 to P35),
// or an issue. `coverage.test.ts` fails when a file or a title listed here does not exist.

/** One test: its file in this folder, and its own title as written in `test("…")`. */
export interface JourneyTest {
  readonly file: `${string}.e2e.ts`;
  readonly test: string;
}

/** What brings the rest of a journey: a later box of #40, or an issue of this repository. */
export type Pending = "P28" | "P29" | "P30" | "P31" | "P32" | "P33" | "P34" | "P35" | `#${number}`;

export type Coverage =
  | { readonly status: "covered"; readonly by: readonly JourneyTest[] }
  | { readonly status: "partial"; readonly by: readonly JourneyTest[]; readonly rest: Pending }
  | { readonly status: "pending"; readonly rest: Pending };

export type Journey = { readonly journey: number; readonly name: string } & Coverage;

export const COVERAGE: readonly Journey[] = [
  {
    journey: 1,
    name: "Create an agent, talk to it, use a tool and stop a run",
    status: "partial",
    by: [
      {
        file: "agents.e2e.ts",
        test: "an owner creates an agent step by step, and a member sees it after a reload",
      },
      {
        file: "chat.e2e.ts",
        test: "message an agent, watch the reply stream in, and open the result of the tool it used",
      },
    ],
    rest: "#159",
  },
  { journey: 2, name: "The handle of an archived agent", status: "pending", rest: "#159" },
  {
    journey: 3,
    name: "Sign up and come back",
    status: "covered",
    by: [
      {
        file: "account.e2e.ts",
        test: "sign up: a new person creates an account and is asked to name a workspace",
      },
      { file: "account.e2e.ts", test: "sign in: a member signs out, then signs back in to the workspace" },
    ],
  },
  {
    journey: 4,
    name: "A wrong password",
    status: "covered",
    by: [
      {
        file: "account.e2e.ts",
        test: "sign in with a wrong password: the person is told, and stays on the sign-in page",
      },
    ],
  },
  {
    journey: 5,
    name: "A protected route sends to sign-in and back",
    status: "covered",
    by: [
      { file: "account.e2e.ts", test: "sign in: a member signs out, then signs back in to the workspace" },
    ],
  },
  {
    journey: 6,
    name: "The language before signing in",
    status: "covered",
    by: [
      {
        file: "account.e2e.ts",
        test: "the language picked before signing in changes the page and the document's language",
      },
    ],
  },
  {
    journey: 7,
    name: "An invitation already accepted",
    status: "covered",
    by: [
      {
        file: "account.e2e.ts",
        test: "an invitation already accepted leads its member in and is closed to a visitor",
      },
    ],
  },
  {
    journey: 8,
    name: "A base edited together",
    status: "partial",
    by: [
      {
        file: "bases.e2e.ts",
        test: "bases: a relation links projects to tasks and a rollup adds up their hours",
      },
    ],
    rest: "#160",
  },
  { journey: 9, name: "Import a CSV and a linked view", status: "pending", rest: "#160" },
  {
    journey: 10,
    name: "A live channel",
    status: "partial",
    by: [
      { file: "channels.e2e.ts", test: "a public channel made by one person is found and joined by another" },
      {
        file: "threads.e2e.ts",
        test: "reply in a thread, get an agent's answer there, find it in the list and close it",
      },
    ],
    rest: "#159",
  },
  { journey: 11, name: "Read only once the tab is visible", status: "pending", rest: "#159" },
  {
    journey: 12,
    name: "A private channel",
    status: "covered",
    by: [{ file: "channels.e2e.ts", test: "a private channel shows to a person once they are added" }],
  },
  {
    journey: 13,
    name: "Pair a runner and run a command on it",
    status: "partial",
    by: [
      {
        file: "runners.e2e.ts",
        test: "an owner pairs a runner by code, and the runner receives its credential",
      },
      {
        file: "integrated.e2e.ts",
        test: "from sign-up to a paired runner: an owner and a member work across the areas with an agent",
      },
    ],
    rest: "P33",
  },
  {
    journey: 14,
    name: "Live view of an agent's browser, and taking it over",
    status: "pending",
    rest: "P31",
  },
  {
    journey: 15,
    name: "An assignment from start to done",
    status: "covered",
    by: [
      { file: "assignments.e2e.ts", test: "an assignment goes from a goal to done" },
      { file: "assignments.e2e.ts", test: "a decision and a review wait on the owner, who answers them" },
    ],
  },
  {
    journey: 16,
    name: "Pair by a code typed by hand",
    status: "covered",
    by: [
      {
        file: "runners.e2e.ts",
        test: "a code typed by hand that was already used is refused and can be typed again",
      },
    ],
  },
  {
    journey: 17,
    name: "A mention notification",
    status: "covered",
    by: [
      {
        file: "inbox.e2e.ts",
        test: "a mention arrives in the inbox; opening it reads it and snoozing it mutes it",
      },
    ],
  },
  {
    journey: 18,
    name: "A file and its versions",
    status: "partial",
    by: [{ file: "files.e2e.ts", test: "upload a file, then a new version of it" }],
    rest: "#161",
  },
  {
    journey: 19,
    name: "A wiki page written together",
    status: "partial",
    by: [
      {
        file: "wiki.e2e.ts",
        test: "edit a page together: each sees the other's change before it is published",
      },
    ],
    rest: "#162",
  },
  {
    journey: 20,
    name: "Issues on the board",
    status: "covered",
    by: [{ file: "issues.e2e.ts", test: "write an issue, drag it, move it from the keyboard and open it" }],
  },
  { journey: 21, name: "A debate an agent suggests in chat", status: "pending", rest: "#163" },
  {
    journey: 22,
    name: "A blind debate with a person at the table",
    status: "covered",
    by: [
      {
        file: "debates.e2e.ts",
        test: "two agents and a person argue a vote and the owner reads and accepts the verdict",
      },
    ],
  },
  {
    journey: 23,
    name: "A routine and the calendar",
    status: "partial",
    by: [
      {
        file: "calendar-routines.e2e.ts",
        test: "a weekly series shows a week later, and is cut from that occurrence on",
      },
      {
        file: "calendar-routines.e2e.ts",
        test: "a routine written here runs by hand and shows its finished run",
      },
    ],
    rest: "P32",
  },
  {
    journey: 24,
    name: "Approvals and actions that can be undone",
    status: "partial",
    by: [
      {
        file: "control.e2e.ts",
        test: "approve an agent's post, then undo it from the receipt before it goes out",
      },
      {
        file: "control.e2e.ts",
        test: "always allow: the rule shows in the panel and the next post does not ask",
      },
      { file: "control.e2e.ts", test: "a member sees the request and who decides it, without the decision" },
      {
        file: "chat.e2e.ts",
        test: "approve an agent's post from the card in the conversation, then withdraw it from its receipt",
      },
    ],
    rest: "#163",
  },
  {
    journey: 25,
    name: "An MCP server an agent uses",
    status: "partial",
    by: [
      {
        file: "connectors.e2e.ts",
        test: "an owner adds an MCP server, reviews what each tool may do, and the decision holds",
      },
      {
        file: "agent-reach.e2e.ts",
        test: "an owner sets an agent's access to a connection and its channel access",
      },
    ],
    rest: "P30",
  },
  {
    journey: 26,
    name: "From sign-up to a paired runner",
    status: "covered",
    by: [
      {
        file: "integrated.e2e.ts",
        test: "from sign-up to a paired runner: an owner and a member work across the areas with an agent",
      },
    ],
  },
  {
    journey: 27,
    name: "Notifications and the installable app",
    status: "partial",
    by: [
      {
        file: "inbox.e2e.ts",
        test: "a mention arrives in the inbox; opening it reads it and snoozing it mutes it",
      },
      { file: "inbox.e2e.ts", test: "a channel muted in the preferences stays muted" },
    ],
    rest: "#164",
  },
  { journey: 28, name: "Every route opens", status: "pending", rest: "#164" },
  {
    journey: 29,
    name: "Search with sources",
    status: "partial",
    by: [{ file: "files.e2e.ts", test: "search: find a document by a word inside it and open it" }],
    rest: "#161",
  },
  { journey: 30, name: "Editing a wiki page and its history", status: "pending", rest: "#162" },
  { journey: 31, name: "A wiki vault in and out", status: "pending", rest: "#162" },
];
