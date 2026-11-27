// Beside a page, from its published version: the outline (when there is more than one heading), the
// pages that link here with a readable snippet, the pages that name it without a link, the links that
// leave it (marked when the page is missing, in the trash or the anchor is gone), and who reads it.
import { useApiQuery } from "@vanr/client/react";
import type { WikiPage } from "@vanr/contract";
import { Skeleton } from "@vanr/ui";
import type { ReactNode } from "react";
import { AppLink } from "../../../app/navigation.tsx";
import { useMessages } from "../../../i18n/react.tsx";
import { plainSnippet } from "../shared.tsx";

export function SidePanel({
  workspaceId,
  page,
  agentName,
  onHeading,
  onCreate,
  children,
}: {
  workspaceId: string;
  page: WikiPage;
  agentName: (id: string) => string | undefined;
  onHeading: (index: number) => void;
  onCreate: (target: string) => void;
  /** What goes first: the page's proposals and comments. */
  children?: ReactNode;
}) {
  const t = useMessages("wiki");
  // The panel follows the published version: asked again when a new one is out.
  const panel = useApiQuery("getWikiPagePanel", { workspaceId, pageId: page.slug });
  const readers = page.reads.agents.flatMap((id) => agentName(id) ?? []);

  return (
    <aside className="wiki-side" aria-label={t("side.label")}>
      {children}
      {panel.data === undefined ? (
        <div aria-busy="true">
          <Skeleton />
          <Skeleton />
        </div>
      ) : (
        <>
          {panel.data.outline.length > 1 && (
            <nav className="wiki-side__section" aria-labelledby="wiki-outline">
              <h2 id="wiki-outline" className="wiki-side__heading">
                {t("side.outline")}
              </h2>
              <ol className="wiki-side__outline">
                {panel.data.outline.map((heading, index) => (
                  <li
                    key={`${heading.line}`}
                    style={{ paddingInlineStart: `${(heading.level - 1) * 0.75}rem` }}
                  >
                    <button type="button" className="wiki-side__jump" onClick={() => onHeading(index)}>
                      {heading.text}
                    </button>
                  </li>
                ))}
              </ol>
            </nav>
          )}
          <section className="wiki-side__section" aria-labelledby="wiki-backlinks">
            <h2 id="wiki-backlinks" className="wiki-side__heading">
              {t("side.backlinks", { count: panel.data.inboundLinks.length })}
            </h2>
            {panel.data.inboundLinks.length === 0 ? (
              <p className="wiki-side__empty">{t("side.noBacklinks")}</p>
            ) : (
              <ul className="wiki-side__refs">
                {panel.data.inboundLinks.map((link) => (
                  <li key={link.slug}>
                    <AppLink route="wikiPage" params={{ workspaceId, pageId: link.slug }}>
                      {link.title}
                    </AppLink>
                    {link.count > 1 && <span className="wiki-side__count">×{link.count}</span>}
                    {link.snippet !== "" && (
                      <p className="wiki-side__snippet">{plainSnippet(link.snippet)}</p>
                    )}
                  </li>
                ))}
              </ul>
            )}
          </section>
          {panel.data.mentions.length > 0 && (
            <section className="wiki-side__section" aria-labelledby="wiki-mentions">
              <h2 id="wiki-mentions" className="wiki-side__heading">
                {t("side.mentions", { count: panel.data.mentions.length })}
              </h2>
              <ul className="wiki-side__refs">
                {panel.data.mentions.map((mention) => (
                  <li key={mention.slug}>
                    <AppLink route="wikiPage" params={{ workspaceId, pageId: mention.slug }}>
                      {mention.title}
                    </AppLink>
                    <p className="wiki-side__snippet">{plainSnippet(mention.snippet)}</p>
                  </li>
                ))}
              </ul>
            </section>
          )}
          <section className="wiki-side__section" aria-labelledby="wiki-outgoing">
            <h2 id="wiki-outgoing" className="wiki-side__heading">
              {t("side.outgoing", { count: panel.data.outgoing.length })}
            </h2>
            {panel.data.outgoing.length === 0 ? (
              <p className="wiki-side__empty">{t("side.noOutgoing")}</p>
            ) : (
              <ul className="wiki-side__refs">
                {panel.data.outgoing.map((link) => (
                  <li key={`${link.target}#${link.anchor ?? ""}`}>
                    {link.page === null ? (
                      <button
                        type="button"
                        className="wiki-side__missing"
                        onClick={() => onCreate(link.target)}
                      >
                        {link.label ?? link.target}
                      </button>
                    ) : (
                      <AppLink route="wikiPage" params={{ workspaceId, pageId: link.page.slug }}>
                        {link.label ?? link.page.title}
                      </AppLink>
                    )}
                    {link.state !== "ok" && (
                      <span className="wiki-side__state">{t(`side.state.${link.state}`)}</span>
                    )}
                  </li>
                ))}
              </ul>
            )}
          </section>
        </>
      )}
      <section className="wiki-side__section" aria-labelledby="wiki-reads">
        <h2 id="wiki-reads" className="wiki-side__heading">
          {t("side.reads")}
        </h2>
        <p>{t("side.readCount", { count: page.reads.total })}</p>
        {readers.length > 0 && <p className="wiki-side__snippet">{readers.join(", ")}</p>}
      </section>
    </aside>
  );
}
