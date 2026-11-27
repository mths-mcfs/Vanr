// A new written document: a title and its text, created in the Drive and opened at once.
import { useApiMutation } from "@vanr/client/react";
import type { FileDetail } from "@vanr/contract";
import { Button, Callout, Dialog, DialogContent, Field, Input, Textarea } from "@vanr/ui";
import { useState } from "react";
import { useErrorMessage } from "../../../app/screens.tsx";
import { useMessages } from "../../../i18n/react.tsx";
import { DOCUMENT_MAX, TITLE_MAX } from "../shared.tsx";

export function NewDocumentDialog({
  workspaceId,
  onClose,
  onCreated,
}: {
  workspaceId: string;
  onClose: () => void;
  onCreated: (file: FileDetail) => void;
}) {
  const t = useMessages("files");
  const common = useMessages("common");
  const describe = useErrorMessage("files");
  const [title, setTitle] = useState("");
  const [markdown, setMarkdown] = useState("");
  const create = useApiMutation("createFile", {
    invalidates: () => [{ method: "listFiles", args: { workspaceId } }],
    onSuccess: onCreated,
  });
  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent
        title={t("drive.newDocument")}
        closeLabel={common("action.close")}
        footer={
          <>
            <Button variant="ghost" onClick={onClose}>
              {common("action.cancel")}
            </Button>
            <Button
              variant="primary"
              disabled={title.trim() === ""}
              loading={create.isPending}
              onClick={() =>
                create.mutate({
                  workspaceId,
                  body: { title: title.trim(), content: { kind: "document", markdown } },
                })
              }
            >
              {t("document.create")}
            </Button>
          </>
        }
      >
        <div className="files__stack">
          <Field label={t("document.title")} required>
            <Input value={title} maxLength={TITLE_MAX} onChange={(event) => setTitle(event.target.value)} />
          </Field>
          <Field label={t("document.text")}>
            <Textarea
              rows={10}
              value={markdown}
              maxLength={DOCUMENT_MAX}
              onChange={(event) => setMarkdown(event.target.value)}
            />
          </Field>
          {create.isError && (
            <Callout tone="danger" role="alert">
              {describe(create.error)}
            </Callout>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}
