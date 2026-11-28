// The workspace's own MCP servers: added by address, with a key or a sign-in on the server when it asks
// for one. A new server's tools stay off for agents until someone reviews them and saves what each one
// may do; the server's own hint is shown as the suggestion. Refresh asks the server for its tools again.
// The server never sends back an address's query string or sign-in part, which can hold a key; the row
// only says there is one.
import { useApiMutation, useApiQuery } from "@vanr/client/react";
import type { CustomServer, CustomServerTool, ToolAccess } from "@vanr/contract";
import {
  Button,
  Callout,
  Chip,
  ConfirmDialog,
  Dialog,
  DialogContent,
  EmptyState,
  Field,
  Icon,
  Input,
  Select,
  SelectItem,
} from "@vanr/ui";
import { Plus } from "lucide-react";
import { type ReactNode, useState } from "react";
import { useErrorMessage } from "../../../app/screens.tsx";
import { useMessages } from "../../../i18n/react.tsx";
import { useOutcome } from "../shared.tsx";
import {
  ADDRESS_MAX,
  Block,
  comeBackTo,
  isLost,
  KEY_MAX,
  leaveFor,
  PartError,
  PartLoading,
  SECRET,
  useForgetOnLoss,
  useForgetReadOnLoss,
  useLatch,
  useReturnFocus,
} from "./shared.tsx";

// The server's limits (routes/connectors.ts, customInput and toolsInput).
const NAME_MAX = 120;
/** From the least an agent may do with a tool to the most. */
export const TOOL_ACCESS = ["off", "read", "approval", "write"] as const satisfies readonly ToolAccess[];
const READS = ["getConnectorCustom"] as const;

export function OwnServers({
  workspaceId,
  reviewing,
  onReview,
}: {
  workspaceId: string;
  /** The server whose tools are open for review, if any. */
  reviewing: string | null;
  onReview: (serverId: string | null) => void;
}) {
  const t = useMessages("control");
  const outcome = useOutcome();
  const latch = useLatch();
  const focus = useReturnFocus(t("mcp.title"));
  const forget = useForgetOnLoss(workspaceId, READS);
  const servers = useApiQuery("getConnectorCustom", { workspaceId });
  const [adding, setAdding] = useState(false);
  const [removing, setRemoving] = useState<CustomServer | null>(null);
  const invalidates = () => [{ method: "getConnectorCustom" as const, args: { workspaceId } }];
  const refresh = useApiMutation("refreshConnectorCustom", { invalidates });
  const remove = useApiMutation("deleteConnectorCustom", { invalidates });
  useForgetReadOnLoss(workspaceId, READS, servers.error);
  // A server that is gone, or no longer the person's to see, closes its review. A passing failure keeps
  // the review and its drafts open; saving then says how it went.
  const open = isLost(servers.error) ? undefined : servers.data?.find((each) => each.id === reviewing);

  let body: ReactNode;
  if (servers.isPending) body = <PartLoading />;
  else if (servers.isError)
    body = <PartError title={t("mcp.failed")} error={servers.error} onRetry={() => void servers.refetch()} />;
  else if (servers.data.length === 0)
    body = <EmptyState title={t("mcp.none")} description={t("mcp.noneBody")} />;
  else
    body = (
      <ul className="wire-list" aria-label={t("mcp.title")}>
        {servers.data.map((server) => {
          const waiting = server.tools.filter((tool) => !tool.confirmed).length;
          return (
            <li key={server.id} className="wire-row" data-state={waiting > 0 ? "reauth_required" : "active"}>
              <div className="wire-row__who">
                <span className="wire-row__name">{server.label}</span>
                <span className="wire-row__address">{server.serverUrl}</span>
              </div>
              <div className="wire-row__chips">
                <Chip>{t("mcp.toolCount", { count: server.tools.length })}</Chip>
                {server.queryHidden && <Chip>{t("mcp.queryHidden")}</Chip>}
                {waiting > 0 && (
                  <Chip className="wire-chip--attention">{t("mcp.waiting", { count: waiting })}</Chip>
                )}
              </div>
              <div className="wire-row__actions">
                <Button
                  size="sm"
                  variant={waiting > 0 ? "primary" : "secondary"}
                  onClick={() => {
                    focus.remember();
                    onReview(server.id);
                  }}
                >
                  {t("mcp.review")}
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  aria-label={t("mcp.refreshNamed", { name: server.label })}
                  loading={refresh.isPending && refresh.variables?.customId === server.id}
                  disabled={refresh.isPending}
                  onClick={() =>
                    latch(() =>
                      refresh.mutateAsync({ workspaceId, customId: server.id }).then(
                        (fresh) =>
                          outcome.done(t("mcp.refreshed", { name: fresh.label, count: fresh.tools.length })),
                        (error: unknown) => {
                          forget(error);
                          outcome.failed(error);
                        },
                      ),
                    )
                  }
                >
                  {t("mcp.refresh")}
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  aria-label={t("mcp.removeNamed", { name: server.label })}
                  onClick={() => {
                    focus.remember();
                    setRemoving(server);
                  }}
                >
                  {t("mcp.remove")}
                </Button>
              </div>
            </li>
          );
        })}
      </ul>
    );

  return (
    <Block
      title={t("mcp.title")}
      lead={t("mcp.lead")}
      action={
        <Button
          icon={<Icon icon={Plus} />}
          onClick={() => {
            focus.remember();
            setAdding(true);
          }}
        >
          {t("mcp.add")}
        </Button>
      }
    >
      {body}
      {adding && (
        <AddServer
          key={workspaceId}
          workspaceId={workspaceId}
          onClose={() => setAdding(false)}
          onCloseAutoFocus={focus.onCloseAutoFocus}
          onAdded={(server) => {
            setAdding(false);
            onReview(server.id);
          }}
        />
      )}
      {open !== undefined && (
        <ReviewTools
          // The server's tools as they are now: a refresh that changes them, or another workspace, starts
          // the review over; the same tools keep what was typed.
          key={`${workspaceId}/${open.id}/${open.tools.map((tool) => tool.name).join(",")}`}
          workspaceId={workspaceId}
          server={open}
          onClose={() => onReview(null)}
          onCloseAutoFocus={focus.onCloseAutoFocus}
        />
      )}
      <ConfirmDialog
        returnFocus={focus.back}
        open={removing !== null}
        onOpenChange={(next) => {
          if (!next && !remove.isPending) setRemoving(null);
        }}
        tone="danger"
        title={t("mcp.removeTitle", { name: removing?.label ?? "" })}
        description={t("mcp.removeBody")}
        confirmLabel={t("mcp.remove")}
        cancelLabel={t("wire.keep")}
        confirming={remove.isPending}
        onConfirm={() => {
          const target = removing;
          if (target === null) return;
          latch(() =>
            remove.mutateAsync({ workspaceId, customId: target.id }).then(
              () => {
                setRemoving(null);
                outcome.done(t("mcp.removed", { name: target.label }));
              },
              (error: unknown) => {
                setRemoving(null);
                forget(error);
                outcome.failed(error);
              },
            ),
          );
        }}
      />
    </Block>
  );
}

/** Adds a server by its address. The key, when one is typed, lives only in this dialog. */
function AddServer({
  workspaceId,
  onClose,
  onCloseAutoFocus,
  onAdded,
}: {
  workspaceId: string;
  onClose: () => void;
  onCloseAutoFocus: (event: Event) => void;
  onAdded: (server: CustomServer) => void;
}) {
  const t = useMessages("control");
  const common = useMessages("common");
  const describe = useErrorMessage("control");
  const outcome = useOutcome();
  const latch = useLatch();
  const forget = useForgetOnLoss(workspaceId, READS);
  const [address, setAddress] = useState("");
  const [name, setName] = useState("");
  const [key, setKey] = useState("");
  const [askedForKey, setAskedForKey] = useState(false);
  const add = useApiMutation("createConnectorCustom", {
    ...SECRET,
    invalidates: () => [{ method: "getConnectorCustom" as const, args: { workspaceId } }],
  });
  const ready = address.trim() !== "" && (!askedForKey || key.trim() !== "");
  // Access lost while the dialog was open closes it and says why, as every other action here does.
  const lost = (error: unknown) => {
    forget(error);
    if (isLost(error)) {
      outcome.failed(error);
      onClose();
    }
  };
  return (
    <Dialog
      open
      onOpenChange={(next) => {
        if (!next && !add.isPending) onClose();
      }}
    >
      <DialogContent
        onCloseAutoFocus={onCloseAutoFocus}
        size="md"
        closeLabel={common("action.close")}
        title={t("mcp.addTitle")}
        description={t("mcp.addLead")}
      >
        <form
          className="section-form"
          aria-label={t("mcp.addTitle")}
          onSubmit={(event) => {
            event.preventDefault();
            if (!ready) return;
            latch(() =>
              add
                .mutateAsync({
                  workspaceId,
                  body: {
                    serverUrl: address.trim(),
                    nextPath: comeBackTo(workspaceId, "connectors"),
                    ...(name.trim() !== "" && { label: name.trim() }),
                    ...(key.trim() !== "" && { apiKey: key.trim() }),
                  },
                })
                .then((answer) => {
                  if (answer.status === "oauth") {
                    leaveFor(answer.consentUrl);
                    return;
                  }
                  if (answer.status === "key_missing") {
                    // A key that was typed and refused, or none at all: the server needs (another) one.
                    setAskedForKey(true);
                    setKey("");
                    return;
                  }
                  setKey("");
                  add.reset();
                  onAdded(answer.server);
                }, lost),
            );
          }}
        >
          <Field label={t("mcp.address")} hint={t("mcp.addressHint")} required>
            <Input
              type="url"
              value={address}
              maxLength={ADDRESS_MAX}
              autoComplete="off"
              placeholder="https://"
              disabled={add.isPending}
              onChange={(event) => {
                setAddress(event.target.value);
                // Another server may not want a key; its own answer says so if it does.
                setAskedForKey(false);
              }}
            />
          </Field>
          <Field label={t("mcp.name")} hint={t("mcp.nameHint")}>
            <Input
              value={name}
              maxLength={NAME_MAX}
              disabled={add.isPending}
              onChange={(event) => setName(event.target.value)}
            />
          </Field>
          {askedForKey && (
            <Callout tone="warning" role="status">
              {t("mcp.keyNeeded")}
            </Callout>
          )}
          <Field label={t("mcp.key")} hint={t("mcp.keyHint")} required={askedForKey}>
            <Input
              type="password"
              value={key}
              maxLength={KEY_MAX}
              autoComplete="off"
              spellCheck={false}
              disabled={add.isPending}
              onChange={(event) => setKey(event.target.value)}
            />
          </Field>
          {add.isError && !isLost(add.error) && (
            <Callout tone="danger" role="alert">
              {describe(add.error)}
            </Callout>
          )}
          <div className="section-form__actions">
            <Button variant="ghost" disabled={add.isPending} onClick={onClose}>
              {common("action.cancel")}
            </Button>
            <Button type="submit" variant="primary" disabled={!ready} loading={add.isPending}>
              {t("mcp.addAction")}
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}

type Draft = Pick<CustomServerTool, "name" | "access" | "label">;

/** What each of a server's tools may do, and the server's name. Saving confirms every tool shown. */
function ReviewTools({
  workspaceId,
  server,
  onClose,
  onCloseAutoFocus,
}: {
  workspaceId: string;
  server: CustomServer;
  onClose: () => void;
  onCloseAutoFocus: (event: Event) => void;
}) {
  const t = useMessages("control");
  const common = useMessages("common");
  const describe = useErrorMessage("control");
  const outcome = useOutcome();
  const latch = useLatch();
  const forget = useForgetOnLoss(workspaceId, READS);
  const [name, setName] = useState(server.label);
  const [drafts, setDrafts] = useState<Draft[]>(() =>
    server.tools.map((tool) => ({ name: tool.name, access: tool.access, label: tool.label })),
  );
  const save = useApiMutation("setConnectorCustomTools", {
    invalidates: () => [{ method: "getConnectorCustom" as const, args: { workspaceId } }],
  });
  const change = (toolName: string, patch: Partial<Draft>) =>
    setDrafts((all) => all.map((each) => (each.name === toolName ? { ...each, ...patch } : each)));
  const toolOf = (toolName: string) => server.tools.find((tool) => tool.name === toolName);
  return (
    <Dialog
      open
      onOpenChange={(next) => {
        if (!next && !save.isPending) onClose();
      }}
    >
      <DialogContent
        onCloseAutoFocus={onCloseAutoFocus}
        size="lg"
        closeLabel={common("action.close")}
        title={t("mcp.reviewTitle", { name: server.label })}
        description={t("mcp.reviewLead")}
      >
        <form
          className="section-form"
          aria-label={t("mcp.reviewTitle", { name: server.label })}
          onSubmit={(event) => {
            event.preventDefault();
            latch(() =>
              save
                .mutateAsync({
                  workspaceId,
                  customId: server.id,
                  body: {
                    label: name.trim(),
                    tools: drafts.map((each) => ({ ...each, label: each.label.trim(), confirmed: true })),
                  },
                })
                .then(
                  () => {
                    outcome.done(t("mcp.saved", { name: name.trim() || server.label }));
                    onClose();
                  },
                  (error: unknown) => {
                    forget(error);
                    if (isLost(error)) {
                      outcome.failed(error);
                      onClose();
                    }
                  },
                ),
            );
          }}
        >
          <Field label={t("mcp.name")}>
            <Input
              value={name}
              maxLength={NAME_MAX}
              disabled={save.isPending}
              onChange={(event) => setName(event.target.value)}
            />
          </Field>
          {drafts.length === 0 ? (
            <p className="page__muted">{t("mcp.noTools")}</p>
          ) : (
            <ul className="tool-review" aria-label={t("mcp.tools")}>
              {drafts.map((draft) => {
                const tool = toolOf(draft.name);
                return (
                  <li key={draft.name} className="tool-review__row">
                    <div className="tool-review__what">
                      <code className="tool-review__name">{draft.name}</code>
                      {tool?.description !== undefined && tool.description !== "" && (
                        <span className="page__muted">{tool.description}</span>
                      )}
                      {tool !== undefined && !tool.confirmed && (
                        <span className="tool-review__hint">
                          {t("mcp.suggested", { level: t(`mcp.access.${tool.proposedAccess}`) })}
                        </span>
                      )}
                    </div>
                    <Field label={t("mcp.toolLabel")} hint={t("mcp.toolLabelHint")}>
                      <Input
                        value={draft.label}
                        maxLength={NAME_MAX}
                        disabled={save.isPending}
                        aria-label={t("mcp.toolLabelFor", { tool: draft.name })}
                        onChange={(event) => change(draft.name, { label: event.target.value })}
                      />
                    </Field>
                    <Field label={t("mcp.toolAccess")}>
                      <Select
                        value={draft.access}
                        disabled={save.isPending}
                        aria-label={t("mcp.toolAccessFor", { tool: draft.name })}
                        onValueChange={(next) => {
                          const level = TOOL_ACCESS.find((each) => each === next);
                          if (level !== undefined) change(draft.name, { access: level });
                        }}
                      >
                        {TOOL_ACCESS.map((level) => (
                          <SelectItem key={level} value={level}>
                            {t(`mcp.access.${level}`)}
                          </SelectItem>
                        ))}
                      </Select>
                    </Field>
                  </li>
                );
              })}
            </ul>
          )}
          {save.isError && !isLost(save.error) && (
            <Callout tone="danger" role="alert">
              {describe(save.error)}
            </Callout>
          )}
          <div className="section-form__actions">
            <Button variant="ghost" disabled={save.isPending} onClick={onClose}>
              {common("action.cancel")}
            </Button>
            <Button type="submit" variant="primary" loading={save.isPending}>
              {t("mcp.save")}
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}
