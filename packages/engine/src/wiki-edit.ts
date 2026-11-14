// Safe text editing by snippet replacement (old_str/new_str), the format the agent uses on the wiki and
// in proposals: each snippet must appear exactly once in the current text (unless the request says "all").
// That way the replacement does not depend on line numbers or on the text being unchanged since it was
// read: if the snippet is still there, the replacement lands in the right place; if it is gone or became
// ambiguous, the edit is rejected.

export interface TextEdit {
  oldStr: string;
  newStr: string;
  /** Replaces every occurrence; without it, more than one is an error. */
  replaceAll?: boolean;
}

export type EditFailure =
  | { code: "empty_old"; index: number }
  | { code: "not_found"; index: number }
  | { code: "ambiguous"; index: number; matches: number }
  | { code: "no_change"; index: number };

export type EditOutcome = { ok: true; text: string; replaced: number } | ({ ok: false } & EditFailure);

function occurrences(text: string, needle: string): number {
  let count = 0;
  // Overlapping matches count too ("--" in "---" is two): a snippet like that is not unique.
  for (let at = text.indexOf(needle); at !== -1; at = text.indexOf(needle, at + 1)) count++;
  return count;
}

/** Applies the edits in order, each on the result of the previous one. All or nothing. */
export function applyEdits(text: string, edits: readonly TextEdit[]): EditOutcome {
  let out = text;
  let replaced = 0;
  for (const [index, edit] of edits.entries()) {
    if (edit.oldStr.length === 0) return { ok: false, code: "empty_old", index };
    if (edit.oldStr === edit.newStr) return { ok: false, code: "no_change", index };
    const matches = occurrences(out, edit.oldStr);
    if (matches === 0) return { ok: false, code: "not_found", index };
    if (matches > 1 && !edit.replaceAll) return { ok: false, code: "ambiguous", index, matches };
    // split/join is a literal replacement: `$&` and friends in the new text do not become patterns.
    const parts = out.split(edit.oldStr);
    out = parts.join(edit.newStr);
    replaced += parts.length - 1;
  }
  return { ok: true, text: out, replaced };
}

/** Short message for the model to fix its request. */
export function editFailureMessage(f: EditFailure): string {
  const which = `edit ${f.index + 1}`;
  switch (f.code) {
    case "empty_old":
      return `${which}: old_str is empty; quote the exact text to change.`;
    case "no_change":
      return `${which}: old_str and new_str are the same.`;
    case "not_found":
      return `${which}: old_str was not found in the current text. Read the page again and quote it exactly.`;
    case "ambiguous":
      return `${which}: old_str appears ${f.matches} times. Quote more surrounding text so it is unique, or set replace_all.`;
  }
}
