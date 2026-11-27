// What every settings section of the shell shares: the caller's role in the open workspace, the
// section's own loading and failed states (a section sits inside the settings page, so it does not
// draw a page of its own), and the confirmation a change leaves behind.
import { can, type Role } from "@vanr/contract";
import { Button, ErrorState, Skeleton, useToast } from "@vanr/ui";
import { useRouteParams } from "../../../app/navigation.tsx";
import { useErrorMessage } from "../../../app/screens.tsx";
import { useMessages } from "../../../i18n/react.tsx";
import { useSession } from "../../../session/react.tsx";

export type Permission = Parameters<typeof can>[1];

/** The open workspace and what the signed-in person may do in it. The server decides; this hides controls. */
export function useWorkspaceAccess(): {
  workspaceId: string;
  role: Role;
  may: (permission: Permission) => boolean;
} {
  const { workspaceId } = useRouteParams("settings");
  const { me } = useSession();
  const role = me?.workspaces.find((workspace) => workspace.id === workspaceId)?.role ?? "member";
  return { workspaceId, role, may: (permission) => can(role, permission) };
}

export function SectionLoading() {
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

export function SectionError({
  title,
  error,
  onRetry,
}: {
  title: string;
  error: unknown;
  onRetry: () => void;
}) {
  const common = useMessages("common");
  const describe = useErrorMessage("settings");
  return (
    <ErrorState
      title={title}
      description={describe(error)}
      action={<Button onClick={onRetry}>{common("action.retry")}</Button>}
    />
  );
}

/** Says a change went through, or why it did not, in a toast. */
export function useOutcome(namespace: "settings" | "inbox" = "settings") {
  const toast = useToast();
  const describe = useErrorMessage(namespace);
  return {
    done: (title: string) => toast.push({ tone: "success", title }),
    failed: (error: unknown) => toast.push({ tone: "danger", title: describe(error) }),
  };
}

/** Whether a time zone name is one the browser (and so the server's runtime) knows. */
export function isTimeZone(name: string): boolean {
  if (name.trim() === "") return false;
  try {
    new Intl.DateTimeFormat("en", { timeZone: name });
    return true;
  } catch {
    return false;
  }
}

/** The time zones to suggest while typing one. */
export function timeZones(): readonly string[] {
  return typeof Intl.supportedValuesOf === "function" ? Intl.supportedValuesOf("timeZone") : [];
}
