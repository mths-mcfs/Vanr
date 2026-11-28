// The two dialogs of a decision: rejecting with an optional reason (with ready ones to pick), and
// editing the fields the gate lets change before approving. Each only collects; the card decides.
import type { Approval } from "@vanr/contract";
import { Button, Dialog, DialogContent, Field, Textarea } from "@vanr/ui";
import { useState } from "react";
import { useLookup, useMessages } from "../../../i18n/react.tsx";

/** The server's limit for a reason. */
export const REASON_MAX = 1000;
const SUGGESTIONS = ["later", "review", "tests", "smaller"] as const;

export function RejectDialog({
  busy,
  onReject,
  onClose,
}: {
  busy: boolean;
  onReject: (reason: string | undefined) => void;
  onClose: () => void;
}) {
  const t = useMessages("control");
  const common = useMessages("common");
  const [reason, setReason] = useState("");
  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent
        title={t("reject.title")}
        closeLabel={common("action.close")}
        footer={
          <>
            <Button variant="ghost" onClick={onClose}>
              {common("action.cancel")}
            </Button>
            <Button variant="danger" type="submit" form="control-reject" loading={busy}>
              {t("reject.submit")}
            </Button>
          </>
        }
      >
        <form
          id="control-reject"
          className="control-form"
          onSubmit={(event) => {
            event.preventDefault();
            onReject(reason.trim() === "" ? undefined : reason.trim());
          }}
        >
          <Field label={t("reject.reason")} hint={t("reject.hint", { max: REASON_MAX })}>
            <Textarea
              rows={3}
              value={reason}
              maxLength={REASON_MAX}
              autoFocus
              onChange={(event) => setReason(event.target.value)}
            />
          </Field>
          <fieldset className="control-suggest">
            <legend className="control-block__label">{t("reject.suggestions")}</legend>
            {SUGGESTIONS.map((key) => (
              <Button key={key} size="sm" variant="secondary" onClick={() => setReason(t(`suggest.${key}`))}>
                {t(`suggest.${key}`)}
              </Button>
            ))}
          </fieldset>
        </form>
      </DialogContent>
    </Dialog>
  );
}

/** A field's value as the text to edit: a list of addresses reads "a, b". */
const fieldText = (value: unknown) =>
  Array.isArray(value)
    ? value.join(", ")
    : typeof value === "string"
      ? value
      : value === undefined
        ? ""
        : JSON.stringify(value);

/** Only the fields that changed, each back in its own shape (a list stays a list). */
export function editedInput(
  original: Record<string, unknown>,
  editable: readonly string[],
  values: Record<string, string>,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const key of editable) {
    const text = values[key] ?? "";
    if (text === fieldText(original[key])) continue;
    out[key] = Array.isArray(original[key])
      ? text
          .split(",")
          .map((part) => part.trim())
          .filter((part) => part !== "")
      : text;
  }
  return out;
}

export function EditDialog({
  approval,
  busy,
  onSave,
  onClose,
}: {
  approval: Approval;
  busy: boolean;
  onSave: (input: Record<string, unknown>) => void;
  onClose: () => void;
}) {
  const t = useMessages("control");
  const lookup = useLookup("control");
  const common = useMessages("common");
  const original = approval.input ?? {};
  const [values, setValues] = useState<Record<string, string>>(() =>
    Object.fromEntries(approval.editable.map((key) => [key, fieldText(original[key])])),
  );
  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent
        title={t("edit.title")}
        description={t("edit.help")}
        closeLabel={common("action.close")}
        footer={
          <>
            <Button variant="ghost" onClick={onClose}>
              {common("action.cancel")}
            </Button>
            <Button variant="primary" type="submit" form="control-edit" loading={busy}>
              {t("edit.submit")}
            </Button>
          </>
        }
      >
        <form
          id="control-edit"
          className="control-form"
          onSubmit={(event) => {
            event.preventDefault();
            onSave(editedInput(original, approval.editable, values));
          }}
        >
          {approval.editable.map((key, index) => (
            <Field
              key={key}
              label={lookup(`field.${key}`) ?? key}
              {...(Array.isArray(original[key]) && { hint: t("edit.listHint") })}
            >
              <Textarea
                rows={key === "text" || key === "body" ? 8 : 2}
                value={values[key] ?? ""}
                autoFocus={index === 0}
                onChange={(event) => setValues((all) => ({ ...all, [key]: event.target.value }))}
              />
            </Field>
          ))}
        </form>
      </DialogContent>
    </Dialog>
  );
}
