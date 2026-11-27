// The rows of a view and how a row is saved. Rows come from the server's query for the view (its saved
// filter, order and group), page by page; a grouped query comes whole in one answer. A save shows at
// once in every open query of the same table, the server's answer replaces it, and a conflict or a
// failure puts the row back, reloads and says so.
import { useInfiniteQuery, useQueryClient } from "@tanstack/react-query";
import type { BaseQueryResult, BaseRowBody } from "@vanr/client";
import { prefixKey, queryKey, useVanrClient } from "@vanr/client/react";
import type { Base, BaseFilter, BaseRow, BaseTable, BaseView } from "@vanr/contract";
import { effectiveFilter, type ViewConfig } from "@vanr/engine/bases/view";
import type { PropDef } from "@vanr/engine/props";
import { useToast } from "@vanr/ui";
import { useCallback } from "react";
import { useErrorMessage } from "../../../app/screens.tsx";
import { useMessages } from "../../../i18n/react.tsx";

export const PAGE = 200;

/**
 * The rows of a view, page by page. The view's filter (with its quick filters), sorts and group go in
 * the query itself, from the view as this screen holds it: a change shows at once, without waiting for
 * the view to be saved, and an answer never reflects a setting the person already changed.
 */
export function useRows(workspaceId: string, base: Base, table: BaseTable, view: BaseView, search: string) {
  const client = useVanrClient();
  const args = {
    workspaceId,
    baseId: base.id,
    tableId: view.tableId,
    body: {
      viewId: view.id,
      limit: PAGE,
      filter:
        (effectiveFilter(view.config as ViewConfig, table.defs as PropDef[]) as BaseFilter | null) ?? null,
      sorts: view.config.sorts ?? [],
      groupBy: view.config.groupBy ?? null,
      ...(search !== "" && { search }),
    },
  };
  return useInfiniteQuery({
    queryKey: queryKey(client, "createBaseTableQuery", args),
    initialPageParam: null as string | null,
    queryFn: ({ pageParam, signal }) =>
      client.call("createBaseTableQuery", { ...args, body: { ...args.body, cursor: pageParam } }, { signal }),
    getNextPageParam: (last: BaseQueryResult) => last.nextCursor,
  });
}

type Pages = { pages: BaseQueryResult[]; pageParams: unknown[] };

/** Puts a row (or takes it out) in every open query of its table. */
export function useReplaceRow(workspaceId: string) {
  const client = useVanrClient();
  const queries = useQueryClient();
  return useCallback(
    (tableId: string, row: BaseRow | string) => {
      queries.setQueriesData<Pages>(
        { queryKey: prefixKey(client, { method: "createBaseTableQuery", args: { workspaceId, tableId } }) },
        (data) => {
          if (data?.pages === undefined) return data;
          return {
            ...data,
            pages: data.pages.map((page) => ({
              ...page,
              rows:
                typeof row === "string"
                  ? page.rows.filter((each) => each.id !== row)
                  : page.rows.map((each) => (each.id === row.id ? row : each)),
            })),
          };
        },
      );
    },
    [client, queries, workspaceId],
  );
}

/**
 * The saves of each row, one after the other, and the newest copy of the row the server gave back. A
 * second edit made while the first is on its way waits for it and goes with the version it produced,
 * so two quick edits of one row never conflict with each other.
 */
type Saves = { pending: Map<string, Promise<unknown>>; newest: Map<string, BaseRow> };
const savesByClient = new WeakMap<object, Saves>();
/** Kept per client, so another sign-in (a new client) starts with nothing. */
function savesOf(client: object): Saves {
  let saves = savesByClient.get(client);
  if (saves === undefined) {
    saves = { pending: new Map(), newest: new Map() };
    savesByClient.set(client, saves);
  }
  return saves;
}

/** Saves a row: shown at once, replaced by the server's answer; a conflict or failure undoes it and says why. */
export function useSaveRow(workspaceId: string, baseId: string) {
  const client = useVanrClient();
  const queries = useQueryClient();
  const replace = useReplaceRow(workspaceId);
  const toast = useToast();
  const t = useMessages("files");
  const describe = useErrorMessage("files");
  return useCallback(
    (row: BaseRow, patch: BaseRowBody): Promise<BaseRow | null> => {
      const { pending, newest } = savesOf(client);
      const refetch = () => {
        void queries.invalidateQueries({
          queryKey: prefixKey(client, {
            method: "createBaseTableQuery",
            args: { workspaceId, tableId: row.tableId },
          }),
        });
        void queries.invalidateQueries({
          queryKey: prefixKey(client, { method: "getBaseRow", args: { workspaceId, rowId: row.id } }),
        });
      };
      const latest = () => {
        const known = newest.get(row.id);
        return known !== undefined && known.version >= row.version ? known : row;
      };
      const before = latest();
      if (patch.props !== undefined)
        replace(row.tableId, { ...before, props: { ...before.props, ...patch.props } });
      const send = async (): Promise<BaseRow | null> => {
        const current = latest();
        try {
          const saved = await client.api.updateBaseRow({
            workspaceId,
            baseId,
            rowId: row.id,
            body: { ...patch, parentVersion: current.version },
          });
          newest.set(row.id, saved);
          replace(row.tableId, saved);
          refetch();
          return saved;
        } catch (error) {
          newest.delete(row.id);
          replace(row.tableId, current);
          refetch();
          toast.push({ tone: "danger", title: t("base.saveFailed"), description: describe(error) });
          return null;
        }
      };
      const next = (pending.get(row.id) ?? Promise.resolve()).then(send, send);
      pending.set(row.id, next);
      void next.finally(() => {
        if (pending.get(row.id) === next) pending.delete(row.id);
      });
      return next;
    },
    [client, queries, replace, toast, t, describe, workspaceId, baseId],
  );
}

/** Saves a text as a file on the person's machine (the exported CSV). A BOM keeps accents in spreadsheets. */
export function downloadText(fileName: string, text: string, type = "text/csv;charset=utf-8") {
  const url = URL.createObjectURL(new Blob(["﻿", text], { type }));
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = fileName;
  document.body.append(anchor);
  anchor.click();
  anchor.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
