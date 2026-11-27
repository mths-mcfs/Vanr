// A new page: its title, its folder and a first body in Markdown. Opened from a [[link]] with no page,
// the link's path fills the folder and the title ("Folder/Sub/Title").
import { useApiMutation } from "@vanr/client/react";
import { Button, Callout, Dialog, DialogContent, Field, Input, Textarea } from "@vanr/ui";
import { useState } from "react";
import { useErrorMessage } from "../../../app/screens.tsx";
import { useMessages } from "../../../i18n/react.tsx";
import { BODY_MAX, FOLDER_MAX, splitPath, TITLE_MAX } from "../shared.tsx";

export function CreatePageDialog({
  workspaceId,
  initial,
  onClose,
  onCreated,
}: {
  workspaceId: string;
  initial: string;
  onClose: () => void;
  onCreated: (slug: string) => void;
}) {
  const t = useMessages("wiki");
  const common = useMessages("common");
  const describe = useErrorMessage("wiki");
  const start = splitPath(initial);
  const [title, setTitle] = useState(start.title);
  const [folder, setFolder] = useState(start.folder);
  const [body, setBody] = useState("");
  const create = useApiMutation("createWikiPage", {
    invalidates: () => [{ method: "listWikiPages", args: { workspaceId } }],
    onSuccess: (page) => onCreated(page.slug),
  });
  const submit = () => {
    if (title.trim() === "" || create.isPending) return;
    create.mutate({
      workspaceId,
      body: { title: title.trim(), body, ...(folder.trim() !== "" && { folder: folder.trim() }) },
    });
  };
  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent
        title={t("create.title")}
        closeLabel={common("action.close")}
        footer={
          <>
            <Button variant="ghost" onClick={onClose}>
              {common("action.cancel")}
            </Button>
            <Button
              variant="primary"
              type="submit"
              form="wiki-create-page"
              disabled={title.trim() === ""}
              loading={create.isPending}
            >
              {t("create.submit")}
            </Button>
          </>
        }
      >
        <form
          id="wiki-create-page"
          className="wiki-form"
          onSubmit={(event) => {
            event.preventDefault();
            submit();
          }}
          // Enter in the title or the folder creates the page: the form has two text fields and its
          // button sits in the dialog's footer, so the browser would not submit on its own.
          onKeyDown={(event) => {
            if (event.key === "Enter" && event.target instanceof HTMLInputElement) {
              event.preventDefault();
              submit();
            }
          }}
        >
          <Field label={t("create.pageTitle")} required>
            <Input
              value={title}
              maxLength={TITLE_MAX}
              autoFocus
              onChange={(event) => setTitle(event.target.value)}
            />
          </Field>
          <Field label={t("create.folder")} hint={t("create.folderHint")}>
            <Input
              value={folder}
              maxLength={FOLDER_MAX}
              onChange={(event) => setFolder(event.target.value)}
            />
          </Field>
          <Field label={t("create.body")} hint={t("create.bodyHint", { count: body.length, max: BODY_MAX })}>
            <Textarea
              rows={10}
              value={body}
              maxLength={BODY_MAX}
              onChange={(event) => setBody(event.target.value)}
            />
          </Field>
          {create.isError && (
            <Callout tone="danger" role="alert">
              {describe(create.error)}
            </Callout>
          )}
        </form>
      </DialogContent>
    </Dialog>
  );
}
