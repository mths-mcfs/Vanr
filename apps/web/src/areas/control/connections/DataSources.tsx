// The Data sources section of the settings: the mailboxes and the customer databases agents may reach.
// A hosted mail sign-in comes back with its outcome in the address (through the Connectors section,
// where the server sends it), which is said once and cleared. Only someone who may configure the
// workspace opens this section.
import { useToast } from "@vanr/ui";
import { useEffect, useRef } from "react";
import { z } from "zod";
import { useGo, useRouteParams, useSearch } from "../../../app/navigation.tsx";
import { useMessages } from "../../../i18n/react.tsx";
import { Databases } from "./Databases.tsx";
import { MailAccounts } from "./Mail.tsx";

export function DataSourcesSection() {
  const { workspaceId } = useRouteParams("settings");
  return (
    <>
      <MailBack workspaceId={workspaceId} />
      <MailAccounts workspaceId={workspaceId} />
      <Databases workspaceId={workspaceId} />
    </>
  );
}

export const MailReturn = z.object({
  mail_connected: z.string().optional(),
  mail_error: z.string().optional(),
});
const NOTHING_BACK: z.infer<typeof MailReturn> = {};
// What the server's hosted-mail callback says (integrations/mail.ts, finishComposio).
const MAIL_FAILURES = ["state", "denied", "unverified"] as const;

function MailBack({ workspaceId }: { workspaceId: string }) {
  const t = useMessages("control");
  const toast = useToast();
  const go = useGo();
  const back = useSearch(MailReturn, NOTHING_BACK);
  const said = useRef(false);
  useEffect(() => {
    if (said.current || (back.mail_connected === undefined && back.mail_error === undefined)) return;
    said.current = true;
    if (back.mail_connected !== undefined) toast.push({ tone: "success", title: t("back.mail.connected") });
    if (back.mail_error !== undefined) {
      const known = MAIL_FAILURES.find((each) => each === back.mail_error) ?? "other";
      toast.push({ tone: "danger", title: t(`back.mail.${known}`) });
    }
    void go("settings", { workspaceId, section: "data-sources" }, { replace: true });
  }, [back, go, t, toast, workspaceId]);
  return null;
}
