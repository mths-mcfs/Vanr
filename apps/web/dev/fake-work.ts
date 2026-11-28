// Issues, the calendar and routines for the fake server: the board's columns, the issues with their
// criteria and timeline, handing one to an agent; events (daily and weekly series), agents' proposals;
// routines, their runs, their webhook secret and a schedule read from plain words. The answers follow the
// server's rules: an issue of a private channel the caller isn't in is a missing one, only an agent the
// caller may talk to is handed work, and only an event's creator, its participants or an admin delete it,
// as only a routine's creator or an admin changes it. Never part of the production build.
import type * as T from "@vanr/contract";
import type { FilesHost, FilesReply } from "./fake-files.ts";

type Scope = { workspaceId: string; user: T.User; role: T.Role };
type Host = FilesHost & {
  /** The workspace's agents, as the caller sees them (with `reachable`). */
  agents: (workspaceId: string, userId: string) => T.Agent[];
  /** Whether the person reads the channel (public, or one they are in). */
  readsChannel: (userId: string, channelId: string) => boolean;
};
export type FakeIssue = T.Issue & { workspaceId: string };
type FakeColumn = T.IssueColumn & { workspaceId: string };
type FakeActivity = T.IssueActivity & { issueId: string };
/** An event as saved: a single one, or the first occurrence of a series with the ones it skips. */
export type FakeEvent = Omit<T.CalendarEvent, "instanceStart" | "seriesId"> & {
  workspaceId: string;
  exdates: string[];
  until: string | null;
};
export type FakeProposal = T.CalendarProposal & {
  workspaceId: string;
  status: "pending" | "confirmed" | "dismissed";
};
export type FakeRoutine = T.Routine & { workspaceId: string };
export type FakeRoutineRun = T.RoutineRun & { routineId: string };

const reply = (status: number, body: unknown): FilesReply => ({ status, body });
const fail = (status: number, code: string, message: string) => reply(status, { error: { code, message } });
const missing = () => fail(404, "not_found", "Issue not found");
const text = (value: unknown) => (typeof value === "string" ? value : undefined);
const STAGES: T.IssueStage[] = ["todo", "in_progress", "reviewing", "done", "canceled"];

export class FakeWork {
  columns: FakeColumn[] = [];
  issues: FakeIssue[] = [];
  activity: FakeActivity[] = [];
  events: FakeEvent[] = [];
  proposals: FakeProposal[] = [];
  routines: FakeRoutine[] = [];
  runs: FakeRoutineRun[] = [];
  /** The run-now keys already used. */
  runKeys = new Set<string>();

  constructor(private readonly host: Host) {}

  clear(): void {
    this.columns = [];
    this.issues = [];
    this.activity = [];
    this.events = [];
    this.proposals = [];
    this.routines = [];
    this.runs = [];
    this.runKeys = new Set();
  }

  /** The board every workspace starts with: one column per stage, named after it. */
  private board(workspaceId: string): FakeColumn[] {
    let own = this.columns.filter((column) => column.workspaceId === workspaceId);
    if (own.length === 0) {
      own = STAGES.map((stage, position) => ({
        id: `col_${workspaceId}_${stage}`,
        workspaceId,
        name: "",
        position,
        stage,
      }));
      this.columns.push(...own);
    }
    return own.sort((a, b) => a.position - b.position);
  }

  seed(): void {
    this.clear();
    const ws = "workspace_birchwood";
    const cols = this.board(ws);
    const col = (stage: T.IssueStage) => cols.find((column) => column.stage === stage)?.id ?? "";
    const ana: T.ActorRef = { type: "person", id: "usr_ana" };
    this.add(ws, {
      title: "Reprint the spring catalogue",
      description: "The paper stock changed. Check the proofs before **Friday**.",
      criteria: [
        { id: "crit_proofs", text: "Proofs approved", done: true },
        { id: "crit_order", text: "Paper ordered", done: false },
      ],
      columnId: col("todo"),
      priority: "high",
      assignee: { type: "person", id: "usr_jonas" },
      createdBy: ana,
    });
    this.add(ws, {
      title: "Draft the release notes",
      columnId: col("in_progress"),
      assignee: { type: "agent", id: "agt_scout" },
      createdBy: ana,
      work: { state: "working", reason: null, runId: null },
    });
    this.add(ws, {
      title: "Archive the old invoices",
      columnId: col("done"),
      createdBy: ana,
      priority: "low",
    });
    const first = this.issues.find((issue) => issue.number === 1);
    if (first !== undefined) first.dueDate = "2026-11-11";
    this.events = [
      this.event(ws, {
        id: "evt_review",
        title: "Print run review",
        start: "2026-11-12T14:00:00.000Z",
        end: "2026-11-12T15:00:00.000Z",
        createdBy: ana,
        location: "Press room",
      }),
    ];
    this.proposals = [
      {
        id: "prp_sync",
        workspaceId: ws,
        agentId: "agt_scout",
        title: "Paper supplier call",
        start: "2026-11-13T15:00:00.000Z",
        end: "2026-11-13T15:30:00.000Z",
        note: "They answer before noon on Fridays.",
        participants: [ana],
        status: "pending",
      },
    ];
    this.routines = [
      this.routine(ws, {
        id: "rtn_digest",
        name: "Morning digest",
        agentId: "agt_scout",
        createdBy: "usr_ana",
        prompt: "Sum up yesterday's print queue.",
        trigger: { kind: "schedule", rule: { freq: "daily", times: ["09:00"], timezone: "UTC" } },
        target: { kind: "dm" },
        active: true,
        nextFireAt: "2026-11-15T09:00:00.000Z",
        lastRun: { at: "2026-11-14T09:00:00.000Z", status: "ok" },
      }),
      this.routine(ws, {
        id: "rtn_invoices",
        name: "Invoice watcher",
        agentId: "agt_tally",
        createdBy: "usr_jonas",
        prompt: "File each invoice that arrives.",
        trigger: { kind: "webhook" },
        target: { kind: "channel", channelId: "ch_print" },
        active: false,
        webhookUrl: "https://vanr.test/api/v1/hooks/routines/rtn_invoices",
      }),
    ];
    this.runs = [
      {
        id: "rrun_1",
        routineId: "rtn_digest",
        at: "2026-11-14T09:00:00.000Z",
        attempt: 1,
        channelId: "ch_general",
        finishedAt: "2026-11-14T09:01:00.000Z",
        messageId: "msg_digest",
        notBefore: null,
        reason: null,
        runId: "run_digest",
        scheduledFor: "2026-11-14T09:00:00.000Z",
        startedAt: "2026-11-14T09:00:00.000Z",
        status: "ok",
        summary: "Three jobs printed, one waiting for paper.",
        summaryKey: null,
        summaryVars: null,
        threadId: "msg_digest",
        trigger: "schedule",
      },
    ];
  }

  event(
    workspaceId: string,
    fields: Partial<FakeEvent> & Pick<FakeEvent, "id" | "title" | "start" | "end" | "createdBy">,
  ): FakeEvent {
    return {
      workspaceId,
      allDay: false,
      description: null,
      endDate: null,
      location: null,
      participants: [],
      recurrence: null,
      rule: null,
      startDate: null,
      timezone: "UTC",
      exdates: [],
      until: null,
      ...fields,
    };
  }

  routine(
    workspaceId: string,
    fields: Partial<T.Routine> &
      Pick<T.Routine, "id" | "name" | "agentId" | "createdBy" | "prompt" | "trigger" | "target">,
  ): FakeRoutine {
    return {
      workspaceId,
      active: false,
      createdAt: this.host.now().toISOString(),
      lastRun: null,
      nextFireAt: null,
      pausedReason: null,
      policy: {
        missed: "once",
        missedWindowMin: 60,
        overlap: "skip",
        maxCostUsd: 2,
        maxSteps: 12,
        maxMinutes: 30,
        retries: 2,
        pauseAfterFailures: 3,
      },
      recentFires: [],
      running: false,
      webhookHasSecret: false,
      webhookUrl: null,
      ...fields,
    };
  }

  /** The occurrences of an event that touch [from, to): a single one, or a daily or weekly series by day. */
  private occurrences(event: FakeEvent, from: Date, to: Date): T.CalendarEvent[] {
    const length = Date.parse(event.end) - Date.parse(event.start);
    const one = (start: Date): T.CalendarEvent => {
      const { workspaceId: _w, exdates: _x, until: _u, ...rest } = event;
      return {
        ...rest,
        start: start.toISOString(),
        end: new Date(start.getTime() + length).toISOString(),
        // Each occurrence of a whole-day series carries its own days, shifted with it.
        ...(event.allDay &&
          event.startDate !== null && {
            startDate: new Date(
              Date.parse(`${event.startDate}T00:00:00Z`) + (start.getTime() - Date.parse(event.start)),
            )
              .toISOString()
              .slice(0, 10),
            endDate: new Date(
              Date.parse(`${event.endDate ?? event.startDate}T00:00:00Z`) +
                (start.getTime() - Date.parse(event.start)),
            )
              .toISOString()
              .slice(0, 10),
          }),
        seriesId: event.rule === null ? null : event.id,
        instanceStart: event.rule === null ? null : start.toISOString(),
      };
    };
    if (event.rule === null) {
      return Date.parse(event.end) > from.getTime() && Date.parse(event.start) < to.getTime()
        ? [one(new Date(event.start))]
        : [];
    }
    const codes = ["SU", "MO", "TU", "WE", "TH", "FR", "SA"];
    const out: T.CalendarEvent[] = [];
    for (
      let at = new Date(event.start);
      at < to && out.length < 500;
      at = new Date(at.getTime() + 86_400_000)
    ) {
      if (event.until !== null && at.toISOString() >= event.until) break;
      // The weekday where the rule lives, as the server reads it.
      const local = new Intl.DateTimeFormat("en-US", {
        weekday: "short",
        timeZone: event.rule.timezone || event.timezone,
      })
        .format(at)
        .slice(0, 2)
        .toUpperCase();
      const day = (codes.includes(local) ? local : codes[at.getUTCDay()]) as T.Weekday;
      const fits = event.rule.freq === "daily" || (event.rule.weekdays ?? []).includes(day);
      if (fits && !event.exdates.includes(at.toISOString()) && at.getTime() + length > from.getTime())
        out.push(one(at));
    }
    return out;
  }

  private seesEvent(scope: Scope, event: FakeEvent): boolean {
    const people = event.participants.filter((each) => each.type === "person");
    return (
      event.workspaceId === scope.workspaceId &&
      ((event.createdBy.type === "person" && event.createdBy.id === scope.user.id) ||
        people.length === 0 ||
        people.some((each) => each.id === scope.user.id))
    );
  }

  private viewRoutine(routine: FakeRoutine): T.Routine {
    const { workspaceId: _, ...rest } = routine;
    return rest;
  }

  private add(
    workspaceId: string,
    fields: Partial<T.Issue> & Pick<T.Issue, "title" | "columnId" | "createdBy">,
  ) {
    const at = this.host.now().toISOString();
    const number =
      Math.max(0, ...this.issues.filter((i) => i.workspaceId === workspaceId).map((i) => i.number)) + 1;
    const top = Math.min(
      1024,
      ...this.issues.filter((i) => i.columnId === fields.columnId).map((i) => i.boardPosition),
    );
    const issue: FakeIssue = {
      id: this.host.id("iss"),
      workspaceId,
      number,
      assignee: null,
      boardPosition: top - 1024,
      channelId: null,
      createdAt: at,
      criteria: [],
      debates: [],
      description: "",
      dueDate: null,
      files: [],
      labels: [],
      priority: "none",
      pullRequests: [],
      source: { kind: "manual" },
      status: "todo",
      subIssues: [],
      updatedAt: at,
      work: null,
      ...fields,
    };
    issue.status = this.stageOf(issue.columnId);
    this.issues.push(issue);
    this.log(issue, fields.createdBy, "created", "created the issue");
    return issue;
  }

  private stageOf(columnId: string): T.IssueStage {
    return this.columns.find((column) => column.id === columnId)?.stage ?? "todo";
  }

  private log(
    issue: FakeIssue,
    author: T.ActorRef,
    event: string,
    said: string,
    vars?: Record<string, string>,
  ) {
    this.activity.push({
      id: this.host.id("iact"),
      issueId: issue.id,
      attachments: [],
      author,
      auto: false,
      createdAt: this.host.now().toISOString(),
      event,
      kind: "event",
      text: said,
      textKey: `issues.activity.${event}`,
      textVars: vars ?? null,
    });
  }

  private sees(scope: Scope, issue: FakeIssue): boolean {
    return (
      issue.workspaceId === scope.workspaceId &&
      (issue.channelId === null || this.host.readsChannel(scope.user.id, issue.channelId))
    );
  }

  private view(issue: FakeIssue): T.Issue {
    const { workspaceId: _, ...rest } = issue;
    return { ...rest, status: this.stageOf(issue.columnId) };
  }

  operations(): Record<string, (params: Record<string, unknown>, session: string | undefined) => FilesReply> {
    const within =
      (handler: (scope: Scope, params: Record<string, unknown>) => FilesReply) =>
      (params: Record<string, unknown>, session: string | undefined) => {
        const scope = this.host.scope(params, session);
        return "status" in scope ? scope : handler(scope, params);
      };
    const withIssue = (
      handler: (scope: Scope, issue: FakeIssue, params: Record<string, unknown>) => FilesReply,
    ) =>
      within((scope, params) => {
        const issue = this.issues.find((each) => each.id === params.issueId);
        return issue === undefined || !this.sees(scope, issue) ? missing() : handler(scope, issue, params);
      });
    const me = (scope: Scope): T.ActorRef => ({ type: "person", id: scope.user.id });
    const talks = (scope: Scope, agentId: string) =>
      this.host
        .agents(scope.workspaceId, scope.user.id)
        .find((agent) => agent.id === agentId && agent.reachable);

    const configures = (scope: Scope) => scope.role === "admin" || scope.role === "owner";
    /** The server's `canSeeRoutine`: its creator, an admin, whoever reads its channel; Drive and debates for all. */
    const seesRoutine = (scope: Scope, routine: FakeRoutine) =>
      routine.createdBy === scope.user.id ||
      configures(scope) ||
      (routine.target.kind === "channel"
        ? this.host.readsChannel(scope.user.id, routine.target.channelId)
        : routine.target.kind === "file" || routine.target.kind === "debate");
    /** Whoever a proposal is for, or an admin; anyone else gets a missing one. */
    const answers = (scope: Scope, proposal: FakeProposal) =>
      configures(scope) ||
      proposal.participants.some((each) => each.type === "person" && each.id === scope.user.id);
    const withRoutine = (
      handler: (scope: Scope, routine: FakeRoutine, params: Record<string, unknown>) => FilesReply,
      edit = false,
    ) =>
      within((scope, params) => {
        const routine = this.routines.find(
          (each) => each.id === params.routineId && each.workspaceId === scope.workspaceId,
        );
        if (routine === undefined || !seesRoutine(scope, routine))
          return fail(404, "not_found", "Routine not found");
        if (edit && routine.createdBy !== scope.user.id && !configures(scope)) {
          return fail(403, "forbidden", "Only who created the routine or an admin can change it");
        }
        return handler(scope, routine, params);
      });

    const calendar = {
      getCalendar: within((scope, params) => {
        const from = new Date(String(params.from));
        const to = new Date(String(params.to));
        const events = this.events
          .filter((event) => this.seesEvent(scope, event))
          .flatMap((event) => this.occurrences(event, from, to))
          .sort((a, b) => a.start.localeCompare(b.start));
        const dueItems = this.issues
          .filter((issue) => this.sees(scope, issue) && issue.dueDate !== null)
          .filter(
            (issue) =>
              issue.dueDate !== null &&
              issue.dueDate >= String(params.from).slice(0, 10) &&
              issue.dueDate < String(params.to).slice(0, 10),
          )
          .map((issue) => ({
            issueId: issue.id,
            number: issue.number,
            title: issue.title,
            date: issue.dueDate ?? "",
          }));
        const routines = this.routines
          .filter(
            (routine) =>
              routine.workspaceId === scope.workspaceId &&
              routine.active &&
              routine.nextFireAt !== null &&
              seesRoutine(scope, routine),
          )
          .filter(
            (routine) =>
              routine.nextFireAt !== null &&
              Date.parse(routine.nextFireAt) >= from.getTime() &&
              Date.parse(routine.nextFireAt) < to.getTime(),
          )
          .map((routine) => ({
            routineId: routine.id,
            name: routine.name,
            at: routine.nextFireAt ?? "",
            agentId: routine.agentId,
            target: routine.target,
          }));
        const proposals = this.proposals
          .filter((proposal) => proposal.workspaceId === scope.workspaceId && proposal.status === "pending")
          .filter((proposal) =>
            proposal.participants.some((each) => each.type === "person" && each.id === scope.user.id),
          )
          .map(({ workspaceId: _w, status: _s, ...rest }) => rest);
        return reply(200, { events, dueItems, routines, proposals });
      }),
      createCalendarEvent: within((scope, params) => {
        const title = text(params.title)?.trim() ?? "";
        if (title === "" || title.length > 200)
          return fail(400, "invalid_request", "A title of 1 to 200 characters");
        if (Date.parse(String(params.end)) <= Date.parse(String(params.start))) {
          return fail(400, "calendar.end_before_start", "The event must end after it starts");
        }
        const rule = (params.rule as T.RecurrenceRule | null | undefined) ?? null;
        const event = this.event(scope.workspaceId, {
          id: this.host.id("evt"),
          title,
          start: new Date(String(params.start)).toISOString(),
          end: new Date(String(params.end)).toISOString(),
          allDay: params.allDay === true,
          // Whole days carry their first and last day (the last one inclusive), as the server answers them.
          ...(params.allDay === true && {
            startDate: String(params.start).slice(0, 10),
            endDate: new Date(Date.parse(String(params.end)) - 1).toISOString().slice(0, 10),
          }),
          rule,
          recurrence: rule?.freq ?? null,
          timezone: text(params.timezone) ?? "UTC",
          location: text(params.location) ?? null,
          description: text(params.description) ?? null,
          createdBy: { type: "person", id: scope.user.id },
        });
        this.events.push(event);
        // The first occurrence the rule allows, which may be days after the start (a weekday series from a Saturday).
        const [first] = this.occurrences(
          event,
          new Date(event.start),
          new Date(Date.parse(event.start) + 15 * 86_400_000),
        );
        return reply(201, first);
      }),
      deleteCalendarEvent: within((scope, params) => {
        const event = this.events.find((each) => each.id === params.eventId && this.seesEvent(scope, each));
        if (event === undefined) return fail(404, "not_found", "Event not found");
        const mine = event.createdBy.type === "person" && event.createdBy.id === scope.user.id;
        const taking = event.participants.some((each) => each.type === "person" && each.id === scope.user.id);
        if (!mine && !taking && !configures(scope))
          return fail(403, "forbidden", "Only who created the event can change it");
        const at = text(params.instanceStart);
        if (event.rule !== null && at !== undefined && params.scope === "this")
          event.exdates.push(new Date(at).toISOString());
        else if (event.rule !== null && at !== undefined && params.scope === "following")
          event.until = new Date(at).toISOString();
        else this.events = this.events.filter((each) => each !== event);
        return reply(204, null);
      }),
      confirmCalendarProposal: within((scope, params) => {
        const proposal = this.proposals.find(
          (each) => each.id === params.proposalId && each.workspaceId === scope.workspaceId,
        );
        if (proposal === undefined || !answers(scope, proposal))
          return fail(404, "not_found", "Proposal not found");
        if (proposal.status !== "pending")
          return fail(409, "calendar.proposal_closed", "This proposal was already answered");
        proposal.status = "confirmed";
        const event = this.event(scope.workspaceId, {
          id: this.host.id("evt"),
          title: proposal.title,
          start: proposal.start,
          end: proposal.end,
          participants: proposal.participants,
          description: proposal.note,
          createdBy: { type: "agent", id: proposal.agentId },
        });
        this.events.push(event);
        return reply(201, this.occurrences(event, new Date(event.start), new Date(event.end))[0]);
      }),
      dismissCalendarProposal: within((scope, params) => {
        const proposal = this.proposals.find(
          (each) => each.id === params.proposalId && each.workspaceId === scope.workspaceId,
        );
        if (proposal === undefined || !answers(scope, proposal))
          return fail(404, "not_found", "Proposal not found");
        if (proposal.status !== "pending")
          return fail(409, "calendar.proposal_closed", "This proposal was already answered");
        proposal.status = "dismissed";
        return reply(204, null);
      }),
    };

    const routines = {
      listRoutines: within((scope) =>
        reply(200, {
          routines: this.routines
            .filter((each) => each.workspaceId === scope.workspaceId && seesRoutine(scope, each))
            .map((each) => this.viewRoutine(each)),
        }),
      ),
      createRoutine: within((scope, params) => {
        const agentId = text(params.agentId) ?? "";
        if (talks(scope, agentId) === undefined)
          return fail(403, "forbidden", "You can't talk to this agent");
        const trigger = params.trigger as T.RoutineTrigger;
        const routine = this.routine(scope.workspaceId, {
          id: this.host.id("rtn"),
          name: text(params.name) ?? "Routine",
          agentId,
          createdBy: scope.user.id,
          prompt: text(params.prompt) ?? "",
          trigger,
          target: params.target as T.RoutineTarget,
          active: params.active === true,
          ...(params.policy !== undefined && { policy: params.policy as T.RoutinePolicy }),
          ...(trigger.kind === "webhook" && {
            webhookUrl: `https://vanr.test/api/v1/hooks/routines/${agentId}`,
          }),
        });
        this.routines.push(routine);
        return reply(201, this.viewRoutine(routine));
      }),
      updateRoutine: withRoutine((_scope, routine, params) => {
        if (typeof params.active === "boolean") {
          routine.active = params.active;
          if (params.active) routine.pausedReason = null;
        }
        return reply(200, this.viewRoutine(routine));
      }, true),
      deleteRoutine: withRoutine((_scope, routine) => {
        this.routines = this.routines.filter((each) => each !== routine);
        return reply(204, null);
      }, true),
      duplicateRoutine: withRoutine((scope, routine) => {
        // A copy runs as whoever makes it: an agent they may talk to, a channel they can write in.
        if (talks(scope, routine.agentId) === undefined)
          return fail(403, "forbidden", "You can't talk to this agent");
        if (
          routine.target.kind === "channel" &&
          !this.host.readsChannel(scope.user.id, routine.target.channelId)
        ) {
          return fail(404, "not_found", "Channel not found");
        }
        const copy = {
          ...routine,
          id: this.host.id("rtn"),
          name: `${routine.name} (copy)`,
          active: false,
          createdBy: scope.user.id,
        };
        this.routines.push(copy);
        return reply(201, this.viewRoutine(copy));
      }),
      runRoutine: withRoutine((_scope, routine, params) => {
        // The same key twice on one routine (a double click, a resend) runs once, as on the server.
        const given = text(params.key);
        const key = given === undefined ? undefined : `${routine.id}:${given}`;
        if (key !== undefined) {
          if (this.runKeys.has(key)) return reply(200, { ...this.viewRoutine(routine), running: true });
          this.runKeys.add(key);
        }
        const at = this.host.now().toISOString();
        this.runs.unshift({
          id: this.host.id("rrun"),
          routineId: routine.id,
          at,
          attempt: 1,
          channelId: "ch_general",
          finishedAt: at,
          messageId: null,
          notBefore: null,
          reason: null,
          runId: null,
          scheduledFor: null,
          startedAt: at,
          status: "ok",
          summary: "Done by hand.",
          summaryKey: null,
          summaryVars: null,
          threadId: null,
          trigger: "manual",
        });
        routine.lastRun = { at, status: "ok" };
        return reply(200, this.viewRoutine(routine));
      }, true),
      estimateRoutine: withRoutine(() =>
        reply(200, { calls: null, upToUsd: 2, recent: { runs: 3, avgUsd: 0.12, maxUsd: 0.3 } }),
      ),
      listRoutineRuns: withRoutine((_scope, routine) =>
        reply(200, {
          runs: this.runs
            .filter((run) => run.routineId === routine.id)
            .map(({ routineId: _, ...rest }) => rest),
        }),
      ),
      createRoutineWebhookSecret: withRoutine((_scope, routine) => {
        routine.webhookHasSecret = true;
        return reply(200, { secret: `whsec_${this.host.id("s")}`, url: routine.webhookUrl ?? "" });
      }, true),
      parseRoutineSchedule: within((_scope, params) => {
        const phrase = (text(params.phrase) ?? "").toLowerCase();
        const match = /^every day at (\d{1,2})(?::(\d{2}))?\s*(am|pm)?$/.exec(phrase.trim());
        if (match === null) {
          return reply(200, {
            ok: false,
            trigger: null,
            description: null,
            error: "rule.unknown",
            upcomingFireTimes: [],
          });
        }
        // A 12-hour time only with am or pm; otherwise the hour is taken as written (0 to 23).
        const raw = Number(match[1]);
        if ((match[3] === undefined ? raw > 23 : raw < 1 || raw > 12) || Number(match[2] ?? "0") > 59) {
          return reply(200, {
            ok: false,
            trigger: null,
            description: null,
            error: "rule.unknown",
            upcomingFireTimes: [],
          });
        }
        const hour = match[3] === undefined ? raw : (raw % 12) + (match[3] === "pm" ? 12 : 0);
        const time = `${String(hour).padStart(2, "0")}:${match[2] ?? "00"}`;
        const timezone = text(params.timezone) ?? "UTC";
        return reply(200, {
          ok: true,
          trigger: { kind: "schedule", rule: { freq: "daily", times: [time], timezone } },
          description: null,
          error: null,
          upcomingFireTimes: [
            new Date(Date.parse("2026-11-15T00:00:00.000Z") + hour * 3_600_000).toISOString(),
          ],
        });
      }),
    };

    return {
      ...calendar,
      ...routines,
      listIssueColumns: within((scope) =>
        reply(200, { columns: this.board(scope.workspaceId).map(({ workspaceId: _, ...c }) => c) }),
      ),
      listIssues: within((scope, params) => {
        this.board(scope.workspaceId);
        const q = text(params.q)?.trim().replace(/^#/, "").toLowerCase() ?? "";
        const found = this.issues
          .filter((issue) => this.sees(scope, issue))
          .filter(
            (issue) =>
              q === "" ||
              issue.title.toLowerCase().includes(q) ||
              issue.description.toLowerCase().includes(q) ||
              String(issue.number).includes(q),
          )
          .sort((a, b) => a.boardPosition - b.boardPosition || b.number - a.number);
        return reply(200, { issues: found.map((issue) => this.view(issue)) });
      }),
      getIssueBySeq: within((scope, params) => {
        const issue = this.issues.find(
          (each) => String(each.number) === params.issueSeq && this.sees(scope, each),
        );
        return issue === undefined ? missing() : reply(200, this.view(issue));
      }),
      createIssue: within((scope, params) => {
        const title = text(params.title)?.trim() ?? "";
        if (title === "" || title.length > 300)
          return fail(400, "invalid_request", "A title of 1 to 300 characters");
        const cols = this.board(scope.workspaceId);
        const column =
          cols.find((each) => each.id === params.columnId) ?? cols.find((each) => each.stage === "todo");
        if (column === undefined) return fail(404, "not_found", "Column not found");
        const assignee = (params.assignee as T.ActorRef | null | undefined) ?? null;
        if (assignee?.type === "agent" && talks(scope, assignee.id) === undefined) {
          return fail(403, "forbidden", "You can't talk to this agent");
        }
        const channelId = text(params.channelId) ?? null;
        if (channelId !== null && !this.host.readsChannel(scope.user.id, channelId)) {
          return fail(404, "not_found", "Channel not found");
        }
        const criteria = Array.isArray(params.criteria) ? params.criteria.map(String) : [];
        const issue = this.add(scope.workspaceId, {
          title,
          description: text(params.description) ?? "",
          criteria: criteria.map((each) => ({ id: this.host.id("crit"), text: each, done: false })),
          columnId: column.id,
          channelId,
          priority: (params.priority as T.IssuePriority | undefined) ?? "none",
          assignee,
          createdBy: me(scope),
          ...(assignee?.type === "agent" && { work: { state: "working", reason: null, runId: null } }),
        });
        return reply(201, this.view(issue));
      }),
      updateIssue: withIssue((scope, issue, params) => {
        const by = me(scope);
        if (typeof params.title === "string") issue.title = params.title;
        if (typeof params.description === "string") issue.description = params.description;
        if (typeof params.columnId === "string" && params.columnId !== issue.columnId) {
          const from = this.stageOf(issue.columnId);
          if (!this.columns.some((column) => column.id === params.columnId)) {
            return fail(404, "not_found", "Column not found");
          }
          issue.columnId = params.columnId;
          const to = this.stageOf(issue.columnId);
          if (from !== to) this.log(issue, by, "status", `moved from ${from} to ${to}`, { from, to });
        }
        if (typeof params.boardPosition === "number") issue.boardPosition = params.boardPosition;
        if ("assignee" in params) {
          issue.assignee = (params.assignee as T.ActorRef | null) ?? null;
          if (issue.assignee === null) this.log(issue, by, "unassigned", "removed the assignee");
          else this.log(issue, by, "assigned", "changed the assignee", { ...issue.assignee });
        }
        if (typeof params.priority === "string") {
          const from = issue.priority;
          issue.priority = params.priority as T.IssuePriority;
          this.log(issue, by, "priority", `set priority to ${issue.priority}`, { from, to: issue.priority });
        }
        if ("dueDate" in params) {
          issue.dueDate = (params.dueDate as string | null) ?? null;
          this.log(issue, by, "due", "changed the due date", { date: issue.dueDate ?? "" });
        }
        issue.status = this.stageOf(issue.columnId);
        issue.updatedAt = this.host.now().toISOString();
        return reply(200, this.view(issue));
      }),
      replaceIssueCriterion: withIssue((scope, issue, params) => {
        const criterion = issue.criteria.find((each) => each.id === params.criterionId);
        if (criterion === undefined) return fail(404, "not_found", "Criterion not found");
        criterion.done = params.done === true;
        this.log(issue, me(scope), criterion.done ? "criterion_done" : "criterion_undone", "", {
          text: criterion.text,
        });
        return reply(200, this.view(issue));
      }),
      getIssueActivity: withIssue((_scope, issue) =>
        reply(200, {
          activity: this.activity
            .filter((each) => each.issueId === issue.id)
            .map(({ issueId: _, ...rest }) => rest),
        }),
      ),
      createIssueComment: withIssue((scope, issue, params) => {
        const said = text(params.text)?.trim() ?? "";
        if (said === "" || said.length > 20_000)
          return fail(400, "invalid_request", "A comment of 1 to 20000 characters");
        const entry: FakeActivity = {
          id: this.host.id("iact"),
          issueId: issue.id,
          attachments: [],
          author: me(scope),
          auto: false,
          createdAt: this.host.now().toISOString(),
          event: null,
          kind: "comment",
          text: said,
          textKey: null,
          textVars: null,
        };
        this.activity.push(entry);
        const { issueId: _, ...shown } = entry;
        return reply(201, shown);
      }),
      askIssueAgent: withIssue((scope, issue, params) => {
        const agent = talks(scope, text(params.agentId) ?? "");
        if (agent === undefined) return fail(403, "forbidden", "You can't talk to this agent");
        issue.assignee = { type: "agent", id: agent.id };
        const working = this.columns.find(
          (c) => c.workspaceId === scope.workspaceId && c.stage === "in_progress",
        );
        if (this.stageOf(issue.columnId) === "todo" && working !== undefined) issue.columnId = working.id;
        issue.work = { state: "working", reason: null, runId: null };
        this.log(issue, me(scope), "assigned", "changed the assignee", { type: "agent", id: agent.id });
        return reply(200, this.view(issue));
      }),
    };
  }
}
