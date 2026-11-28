// The notices an agent leaves for the author alone: called, but unable to take the message.
import { useLookup, useMessages } from "../../i18n/react.tsx";
import { useConversation } from "./context.tsx";
import { useAgentNotices } from "./hooks.ts";

/** Agents the person called that can't take their message, each with why. The code never shows. */
export function AgentNotices({ thread = null }: { thread?: string | null }) {
  const t = useMessages("chat");
  const lookup = useLookup("chat");
  const { channelId, directory } = useConversation();
  const { notices, dismiss } = useAgentNotices(channelId);
  const here = notices.filter((notice) => notice.threadId === thread);
  if (here.length === 0) return null;
  return (
    <div className="chat__notices">
      {here.map((notice) => {
        const agent = directory.agentName(notice.agentId);
        const text =
          lookup(`blocked.${notice.reason}`, { agent }) ??
          (notice.text !== "" ? notice.text : t("blocked.other", { agent }));
        return (
          <p key={notice.key} className="chat-note chat-note--warning" role="status">
            <span>{text}</span>
            <button type="button" className="app-link-button" onClick={() => dismiss(notice.key)}>
              {t("blocked.dismiss")}
            </button>
          </p>
        );
      })}
    </div>
  );
}
