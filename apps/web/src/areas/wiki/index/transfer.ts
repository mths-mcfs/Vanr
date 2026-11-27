// Bringing notes into the wiki and taking it out. A zip is a vault: notes, folders, attachments, other
// titles, tags and properties in one call. Without a zip, the Markdown notes go in batches the server
// accepts, each with the path it had in the folder that was picked. A batch that fails stops the rest,
// but what the earlier ones made stays, and the tree is asked again either way. The export downloads
// the whole wiki as a zip.
import { useVanrClient } from "@vanr/client/react";
import type { Tone } from "@vanr/ui";
import { useState } from "react";
import { useErrorMessage } from "../../../app/screens.tsx";
import { useMessages } from "../../../i18n/react.tsx";
import { importBatches, useWikiRefresh } from "../shared.tsx";

export type TransferNotice = { tone: Tone; title: string; detail?: string };

/** Saves a blob as a file, through a link the browser follows once. */
function save(blob: Blob, name: string) {
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = name;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

export function useWikiTransfer(workspaceId: string) {
  const t = useMessages("wiki");
  const describe = useErrorMessage("wiki");
  const { api } = useVanrClient();
  const refresh = useWikiRefresh(workspaceId);
  const [importing, setImporting] = useState(false);
  const [notice, setNotice] = useState<TransferNotice | null>(null);

  const importVault = async (zip: File) => {
    const result = await api.importWikiVault({
      workspaceId,
      body: { file: { blob: zip, fileName: zip.name } },
    });
    const failed = result.failed.length;
    setNotice({
      tone: failed > 0 ? "warning" : "success",
      title: t("import.vaultDone", {
        created: result.created,
        skipped: result.skipped,
        attachments: result.attachments,
      }),
      ...(failed > 0 && { detail: t("import.failedCount", { count: failed }) }),
    });
  };

  const importNotes = async (files: File[]) => {
    const notes = files.filter((file) => file.name.toLowerCase().endsWith(".md"));
    if (notes.length === 0) {
      setNotice({ tone: "danger", title: t("import.none") });
      return;
    }
    const read = await Promise.all(
      notes.map(async (file) => ({ path: file.webkitRelativePath || file.name, text: await file.text() })),
    );
    const plan = importBatches(read);
    let created = 0;
    let skipped = files.length - notes.length + plan.skipped;
    let failed = plan.tooLarge.length;
    for (const batch of plan.batches) {
      const result = await api.importWiki({ workspaceId, body: { files: batch } });
      created += result.created;
      skipped += result.skipped;
      failed += result.failed.length;
    }
    setNotice({
      tone: failed > 0 ? "warning" : "success",
      title: t("import.done", { created, skipped }),
      ...(failed > 0 && { detail: t("import.failedCount", { count: failed }) }),
    });
  };

  const importFiles = async (files: File[]) => {
    setImporting(true);
    setNotice(null);
    try {
      const zip = files.find((file) => file.name.toLowerCase().endsWith(".zip"));
      await (zip === undefined ? importNotes(files) : importVault(zip));
    } catch (error) {
      setNotice({ tone: "danger", title: t("import.failed"), detail: describe(error) });
    } finally {
      setImporting(false);
      await refresh();
    }
  };

  const exportWiki = async () => {
    setNotice(null);
    try {
      const download = await api.exportWiki({ workspaceId });
      save(await download.blob(), download.fileName ?? "wiki.zip");
    } catch (error) {
      setNotice({ tone: "danger", title: t("export.failed"), detail: describe(error) });
    }
  };

  return { importing, notice, importFiles, exportWiki };
}
