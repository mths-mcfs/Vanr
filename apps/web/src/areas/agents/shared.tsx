// What the agents area shares: what the signed-in person may do with an agent, the limits the server
// checks, the roles and appearance choices, and the small blocks every agent screen draws (a titled
// section, its loading and failed states, the toast a change leaves).
import { type Agent, type AgentAppearance, type AgentRole, can, type Role } from "@vanr/contract";
import { Button, ErrorState, Skeleton, useToast } from "@vanr/ui";
import type { ReactNode } from "react";
import { useErrorMessage } from "../../app/screens.tsx";
import { useMessages } from "../../i18n/react.tsx";
import { useSession } from "../../session/react.tsx";

/** The server's own limits: the forms stop at them instead of sending what it would refuse. */
export const NAME_MAX = 60;
export const INSTRUCTIONS_MAX = 20_000;
export const DESCRIPTION_MAX = 2_000;
export const REASON_MAX = 500;
export const HANDLE_MAX = 32;
export const HANDLE_RE = /^[a-z0-9][a-z0-9_-]{1,31}$/;
export const SKILL_NAME_MAX = 120;
export const SKILL_DESCRIPTION_MAX = 1000;
export const SKILL_BODY_MAX = 100_000;
export const SKILL_NAME_RE = /^[\p{L}\p{N}][\p{L}\p{N} _.-]*$/u;

export const ROLES = [
  "assistant",
  "support",
  "sales",
  "marketing",
  "content",
  "research",
  "data",
  "dev",
  "qa",
  "ops",
  "pm",
  "finance",
  "people",
  "custom",
] as const satisfies readonly AgentRole[];

/** The appearance choices offered here. The server takes any short word; drawing them is the shell's. */
export const COLORS = ["teal", "cobalt", "amber", "rose", "violet", "moss"] as const;
export const EYES = ["dots", "round", "sleepy", "wink"] as const;
export const ADORNMENTS = ["none", "antenna", "halo", "leaf", "crown"] as const;

const pick = <T,>(list: readonly T[], random: () => number): T =>
  list[Math.floor(random() * list.length) % list.length] as T;

export function randomAppearance(random: () => number = Math.random): AgentAppearance {
  return { color: pick(COLORS, random), eyes: pick(EYES, random), adornment: pick(ADORNMENTS, random) };
}

/** A handle from a name: no accents, lowercase, words joined by a hyphen, at most 32 characters. */
export function handleFromName(name: string): string {
  return name
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/^[-_]+|-+$/g, "")
    .slice(0, HANDLE_MAX)
    .replace(/-+$/, "");
}

export type AgentRights = {
  role: Role;
  userId: string | undefined;
  /** Creates, archives and changes everything of every agent (`manage_agents`). */
  manage: boolean;
  /** Changes everything of this agent: whoever manages agents, unless it is archived. */
  editAll: boolean;
  /** Changes what the owner also may (appearance, audience, channels, skills, harness): unless archived. */
  editLook: boolean;
  /** Sees the owner's tools (the lab's cases, the agent's skills), archived or not. */
  editor: boolean;
};

/** What the signed-in person may do in a workspace, and with one agent of it. The server decides; this hides. */
export function useAgentRights(
  workspaceId: string,
  agent?: Pick<Agent, "ownerUserId" | "archivedAt"> | undefined,
): AgentRights {
  const { me } = useSession();
  const role = me?.workspaces.find((workspace) => workspace.id === workspaceId)?.role ?? "member";
  const manage = can(role, "manage_agents");
  const owner = agent !== undefined && me?.user.id === agent.ownerUserId;
  const live = agent?.archivedAt === null || agent?.archivedAt === undefined;
  return {
    role,
    userId: me?.user.id,
    manage,
    editAll: manage && live,
    editLook: (manage || owner) && live,
    editor: manage || owner,
  };
}

/** A block of a screen with its own heading, and an optional line under it. */
export function Section({
  title,
  help,
  action,
  children,
}: {
  title: string;
  help?: ReactNode;
  action?: ReactNode;
  children: ReactNode;
}) {
  return (
    <section className="agent-section" aria-label={title}>
      <header className="agent-section__head">
        <div>
          <h2 className="page__heading">{title}</h2>
          {help !== undefined && <p className="page__muted">{help}</p>}
        </div>
        {action}
      </header>
      {children}
    </section>
  );
}

/** A part of a screen whose data is on its way. */
export function PartLoading() {
  const common = useMessages("common");
  return (
    <div className="page__loading" aria-busy="true">
      <span className="vr-visually-hidden" role="status">
        {common("state.loading")}
      </span>
      <Skeleton shape="block" />
      <Skeleton />
    </div>
  );
}

/** A part of a screen that did not load: what, why, and a retry. */
export function PartError({ title, error, onRetry }: { title: string; error: unknown; onRetry: () => void }) {
  const common = useMessages("common");
  const describe = useErrorMessage("agents");
  return (
    <ErrorState
      title={title}
      description={describe(error)}
      action={<Button onClick={onRetry}>{common("action.retry")}</Button>}
    />
  );
}

/** Says a change went through, or why it did not, in a toast. */
export function useOutcome() {
  const toast = useToast();
  const describe = useErrorMessage("agents");
  return {
    done: (title: string) => toast.push({ tone: "success", title }),
    failed: (error: unknown) => toast.push({ tone: "danger", title: describe(error) }),
  };
}

/** Snippets typed one per line, trimmed, without blanks or repeats. */
export function lines(text: string): string[] {
  return [...new Set(text.split("\n").map((line) => line.trim()))].filter((line) => line !== "");
}
