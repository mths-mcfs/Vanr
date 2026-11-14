// Page properties ↔ Obsidian front matter, on top of the typed properties (props.ts). On export the key
// is the property name and the value goes out in YAML's natural type; on import the key finds the
// definition by name (without case) or creates one, with the type inferred from the value, as Obsidian does.
import { newId } from "../ids";
import {
  COMPUTED_TYPES,
  isChecked,
  type PropDef,
  type PropOption,
  type Props,
  type PropValue,
  propText,
} from "../props";
import type { FrontmatterData } from "./frontmatter";

/** The caps of the wiki's property route: definitions in the schema, options in one definition. */
export const WIKI_PROP_LIMITS = { defs: 100, options: 200 } as const;

// The same format the typed properties accept: a date, or a date and time with an offset.
const ISO_DATE = /^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:\d{2}))?$/;

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
  if (typeof value === "string" && ISO_DATE.test(value.trim())) return "date";
  if (typeof value === "string" && /^https?:\/\/\S+$/i.test(value.trim())) return "url";
  return "text";
}

const scalar = (v: unknown): string | null =>
  typeof v === "string" ? v.trim() : typeof v === "number" || typeof v === "boolean" ? String(v) : null;

/**
 * Front matter → property write. Returns the list of definitions (with the new ones and the new options),
 * the write `{ [propId]: value }` and the names of the properties created. A value that does not fit the
 * type of a property that already exists goes to `rejected` and is not written, and so does one that would
 * need a definition or an option past WIKI_PROP_LIMITS (also listed in `overLimit`).
 */
export function frontmatterToProps(
  defs: readonly PropDef[],
  data: FrontmatterData,
): { defs: PropDef[]; write: Props; created: string[]; rejected: string[]; overLimit: string[] } {
  const next: PropDef[] = defs.map((d) => (d.options ? { ...d, options: [...d.options] } : { ...d }));
  const write: Props = {};
  const created: string[] = [];
  const rejected: string[] = [];
  const overLimit: string[] = [];
  for (const [key, raw] of Object.entries(data)) {
    if (raw === null || raw === undefined || raw === "") continue;
    let found = next.find((d) => d.name.toLowerCase() === key.toLowerCase());
    if (!found) {
      if (next.length >= WIKI_PROP_LIMITS.defs) {
        rejected.push(key);
        overLimit.push(key);
        continue;
      }
      found = { id: newId("prop"), name: key.slice(0, 80), type: inferType(raw) };
      if (found.type === "multi_select") found.options = [];
      next.push(found);
      created.push(found.name);
    }
    const def: PropDef = found;
    if (COMPUTED_TYPES.has(def.type)) continue;
    let full = false;
    const option = (name: string): string | undefined => {
      const hit = def.options?.find((o) => o.name.toLowerCase() === name.toLowerCase());
      if (hit) return hit.id;
      if ((def.options?.length ?? 0) >= WIKI_PROP_LIMITS.options) {
        full = true;
        return undefined;
      }
      const opt: PropOption = { id: newId("opt"), name: name.slice(0, 100) };
      def.options = [...(def.options ?? []), opt];
      return opt.id;
    };
    let value: PropValue | undefined;
    switch (def.type) {
      case "text":
        value = Array.isArray(raw) ? raw.map(scalar).filter(Boolean).join(", ") : (scalar(raw) ?? undefined);
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
        value = typeof raw === "boolean" ? raw : isChecked(String(raw));
        break;
      case "date": {
        const s = scalar(raw);
        value = s && ISO_DATE.test(s) ? { start: s } : undefined;
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
        const ids = list.slice(0, 100).map(option);
        value = full ? undefined : (ids as string[]);
        break;
      }
      default:
        value = undefined;
    }
    if (full) overLimit.push(key);
    if (value === undefined) rejected.push(key);
    else write[def.id] = value;
  }
  return { defs: next, write, created, rejected, overLimit };
}
