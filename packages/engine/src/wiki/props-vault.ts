// Page properties ↔ Obsidian front matter, on top of the typed properties (props.ts). On export the key
// is the property name and the value goes out in YAML's natural type; on import the key finds the
// definition by name (without case) or creates one, with the type inferred from the value, as Obsidian does.
import { newId } from "../ids";
import {
  applyProps,
  COMPUTED_TYPES,
  isCalendarIso,
  isCheckboxWord,
  isChecked,
  type PropDef,
  type PropOption,
  type Props,
  type PropValue,
  parsePropText,
  propText,
} from "../props";
import type { FrontmatterData } from "./frontmatter";

/** Property value → YAML value. Computed types are left out. */
export function propsToFrontmatter(defs: readonly PropDef[], props: Props): FrontmatterData {
  const out: FrontmatterData = {};
  for (const def of defs) {
    const v = props[def.id];
    if (v === undefined || v === null || COMPUTED_TYPES.has(def.type)) continue;
    const name = (id: string) => def.options?.find((o) => o.id === id)?.name ?? id;
    switch (def.type) {
      case "number":
      case "checkbox":
      case "text":
      case "url":
        out[def.name] = v;
        break;
      case "select":
      case "status":
        out[def.name] = name(String(v));
        break;
      case "multi_select":
        out[def.name] = (v as string[]).map(name);
        break;
      case "date": {
        const d = v as { start: string; end?: string };
        out[def.name] = d.end ? propText(def, v) : d.start;
        break;
      }
      default:
        out[def.name] = propText(def, v);
    }
  }
  return out;
}

function inferType(value: unknown): PropDef["type"] {
  if (typeof value === "boolean") return "checkbox";
  if (typeof value === "number") return "number";
  if (Array.isArray(value)) return "multi_select";
  if (typeof value === "string" && isCalendarIso(value.trim())) return "date";
  if (typeof value === "string" && /^https?:\/\/\S+$/i.test(value.trim())) return "url";
  return "text";
}

const scalar = (v: unknown): string | null =>
  typeof v === "string" ? v.trim() : typeof v === "number" || typeof v === "boolean" ? String(v) : null;

/**
 * Front matter → property write. Returns the list of definitions (with the new ones and the new options),
 * the write `{ [propId]: value }` and the names of the properties created. A value that does not fit the
 * type of a property that already exists goes to `rejected` and is not written.
 */
export function frontmatterToProps(
  defs: readonly PropDef[],
  data: FrontmatterData,
): { defs: PropDef[]; write: Props; created: string[]; rejected: string[] } {
  const next: PropDef[] = defs.map((d) => (d.options ? { ...d, options: [...d.options] } : { ...d }));
  const write: Props = {};
  const created: string[] = [];
  const rejected: string[] = [];
  for (const [key, raw] of Object.entries(data)) {
    if (raw === null || raw === undefined) continue;
    let found = next.find((d) => d.name.toLowerCase() === key.toLowerCase());
    if (raw === "" && found?.type !== "text") continue;
    if (!found) {
      found = { id: newId("prop"), name: key.slice(0, 80), type: inferType(raw) };
      if (found.type === "multi_select") found.options = [];
      next.push(found);
      created.push(found.name);
    }
    const def: PropDef = found;
    if (COMPUTED_TYPES.has(def.type)) continue;
    const option = (name: string): string => {
      const hit = def.options?.find((o) => o.name.toLowerCase() === name.toLowerCase());
      if (hit) return hit.id;
      const opt: PropOption = { id: newId("opt"), name: name.slice(0, 100) };
      def.options = [...(def.options ?? []), opt];
      return opt.id;
    };
    let value: PropValue | undefined;
    switch (def.type) {
      case "text":
        value =
          typeof raw === "string"
            ? raw
            : Array.isArray(raw)
              ? raw.map(scalar).filter(Boolean).join(", ")
              : (scalar(raw) ?? undefined);
        break;
      case "url": {
        const s = scalar(raw);
        value = s && /^https?:\/\//i.test(s) ? s : undefined;
        break;
      }
      case "number": {
        const n = typeof raw === "number" ? raw : Number(String(raw).replace(",", "."));
        value = Number.isFinite(n) ? n : undefined;
        break;
      }
      case "checkbox":
        value =
          typeof raw === "boolean" ? raw : isCheckboxWord(String(raw)) ? isChecked(String(raw)) : undefined;
        break;
      case "date": {
        const s = scalar(raw);
        value = s ? parsePropText(def, s) : undefined;
        break;
      }
      case "select":
      case "status": {
        const s = scalar(Array.isArray(raw) ? raw[0] : raw);
        value = s ? option(s) : undefined;
        break;
      }
      case "multi_select": {
        const list = (Array.isArray(raw) ? raw : String(raw).split(","))
          .map(scalar)
          .filter((x): x is string => !!x);
        value = list.slice(0, 100).map(option);
        break;
      }
      case "person":
      case "file":
        value = typeof raw === "string" ? parsePropText(def, raw) : undefined;
        break;
      default:
        value = undefined;
    }
    if (value === undefined || !applyProps([def], {}, { [def.id]: value }).ok) rejected.push(key);
    else write[def.id] = value;
  }
  return { defs: next, write, created, rejected };
}
