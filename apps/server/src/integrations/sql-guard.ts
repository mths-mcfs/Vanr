// Guard of the queries an agent runs on a connected database. It does not interpret SQL: it asks Postgres
// itself for the plan (EXPLAIN VERBOSE, FORMAT JSON) and checks what it will read. Pure functions.
import { z } from "zod";

export type GuardFailure =
  | { reason: "multiple_statements" }
  | { reason: "statement"; keyword: string }
  | { reason: "malformed" }
  | { reason: "ambiguous" }
  | { reason: "write" }
  | { reason: "table"; table: string }
  | { reason: "column"; column: string }
  | { reason: "function"; name: string };

// The lexer below follows the lexical structure of Postgres (src/backend/parser/scan.l) for everything that
// decides where a command ends: whitespace and `--` comments end at `\n` or `\r`, block comments nest, string
// constants ('…', E'…', U&'…', B'…', X'…', N'…') with their escapes and their continuation across a newline,
// dollar quotes, quoted identifiers, identifiers (where `$` is a name character) and numbers (after which `$` opens
// a dollar quote). Reading any of these differently lets a second command hide in what the guard took for a
// comment or a string.

type TokenKind = "word" | "quoted" | "literal" | "number" | "semicolon" | "punct";
interface Token {
  kind: TokenKind;
  start: number;
  end: number;
}

const SPACE = /[ \t\n\r\f\v]/;
const IDENT_START = /[A-Za-z_\u0080-￿]/;
const IDENT_CHAR = /[A-Za-z0-9_$\u0080-￿]/;
/** `$tag$`, at the current position. */
const DOLLAR_TAG = /\$(?:[A-Za-z_\u0080-￿][A-Za-z0-9_\u0080-￿]*)?\$/y;
/** A number, with what Postgres takes into the same token. */
const NUMBER =
  /(?:0[xXoObB][0-9A-Fa-f_]+|[0-9][0-9_]*(?:\.[0-9_]*)?(?:[eE][+-]?[0-9]+)?|\.[0-9][0-9_]*(?:[eE][+-]?[0-9]+)?)/y;
/**
 * What glues the next string constant to the one that just closed: horizontal space or `--` comments, at least
 * one newline, then space or comments ending in a newline, then the quote. The glued part keeps the first part's
 * kind (its backslashes still escape after an E'…').
 */
const CONTINUATION = /(?:[ \t\f\v]|--[^\n\r]*)*[\n\r](?:[ \t\n\r\f\v]|--[^\n\r]*[\n\r])*'/y;

type StringKind = "plain" | "escape" | "unicode" | "bits";

/**
 * Tokens of the text, or null when Postgres would reject it as it stands (an unterminated comment, string,
 * dollar quote or quoted identifier, a NUL byte, junk after a number): nothing of it would run.
 * `standardStrings` is the server's `standard_conforming_strings`: off, a backslash escapes in a plain '…' too.
 */
function lex(sql: string, standardStrings: boolean): Token[] | null {
  const n = sql.length;
  const tokens: Token[] = [];
  let i = 0;
  const at = (re: RegExp, pos: number) => {
    re.lastIndex = pos;
    return re.exec(sql);
  };
  /** Index just past the string constant whose opening quote is at `q`, continuations included; -1 if open. */
  const stringEnd = (q: number, kind: StringKind): number => {
    const backslash = kind === "escape" || (kind === "plain" && !standardStrings);
    let j = q + 1;
    for (;;) {
      if (j >= n) return -1;
      const ch = sql[j];
      if (backslash && ch === "\\") {
        j += 2;
        continue;
      }
      if (ch !== "'") {
        j++;
        continue;
      }
      if (kind !== "bits" && sql[j + 1] === "'") {
        j += 2;
        continue;
      }
      const glued = at(CONTINUATION, j + 1);
      if (!glued) return j + 1;
      j = j + 1 + glued[0].length;
    }
  };
  const push = (kind: TokenKind, start: number, end: number) => tokens.push({ kind, start, end });
  while (i < n) {
    const ch = sql[i] ?? "";
    const next = sql[i + 1];
    if (ch === "\0") return null;
    if (SPACE.test(ch)) {
      i++;
      continue;
    }
    if (ch === "-" && next === "-") {
      while (i < n && sql[i] !== "\n" && sql[i] !== "\r") i++;
      continue;
    }
    if (ch === "/" && next === "*") {
      let depth = 0;
      let j = i;
      do {
        if (j >= n) return null;
        if (sql[j] === "/" && sql[j + 1] === "*") {
          depth++;
          j += 2;
        } else if (sql[j] === "*" && sql[j + 1] === "/") {
          depth--;
          j += 2;
        } else j++;
      } while (depth > 0);
      i = j;
      continue;
    }
    let quote = -1;
    let kind: StringKind = "plain";
    if (ch === "'") quote = i;
    else if (/[eE]/.test(ch) && next === "'") [quote, kind] = [i + 1, "escape"];
    else if (/[bBxX]/.test(ch) && next === "'") [quote, kind] = [i + 1, "bits"];
    else if (/[nN]/.test(ch) && next === "'") quote = i + 1;
    else if (/[uU]/.test(ch) && next === "&" && sql[i + 2] === "'") [quote, kind] = [i + 2, "unicode"];
    if (quote >= 0) {
      const end = stringEnd(quote, kind);
      if (end < 0) return null;
      push("literal", i, end);
      i = end;
      continue;
    }
    const identQuote = ch === '"' ? i : /[uU]/.test(ch) && next === "&" && sql[i + 2] === '"' ? i + 2 : -1;
    if (identQuote >= 0) {
      let j = identQuote + 1;
      for (;;) {
        if (j >= n) return null;
        if (sql[j] === '"') {
          if (sql[j + 1] !== '"') break;
          j++;
        }
        j++;
      }
      push("quoted", i, j + 1);
      i = j + 1;
      continue;
    }
    if (ch === "$") {
      const tag = at(DOLLAR_TAG, i)?.[0];
      if (tag) {
        const close = sql.indexOf(tag, i + tag.length);
        if (close < 0) return null;
        push("literal", i, close + tag.length);
        i = close + tag.length;
        continue;
      }
    }
    if (IDENT_START.test(ch)) {
      let j = i + 1;
      while (j < n && IDENT_CHAR.test(sql[j] ?? "")) j++;
      push("word", i, j);
      i = j;
      continue;
    }
    const number = /[0-9.]/.test(ch) ? at(NUMBER, i)?.[0] : undefined;
    if (number) {
      const end = i + number.length;
      if (IDENT_START.test(sql[end] ?? "")) return null;
      push("number", i, end);
      i = end;
      continue;
    }
    push(ch === ";" ? "semicolon" : "punct", i, i + 1);
    i++;
  }
  return tokens;
}

/** Characters an operator name is made of (Postgres' `Op` in scan.l). */
const OPERATOR_CHAR = /[+\-*/<>=~!@#%^&|`?]/;

/**
 * The names a statement could call and the operators it writes: identifiers folded to lower case (a quoted one
 * as written) and runs of operator characters. Literals and comments don't count. For the catalog lookup of
 * the customer's code (`sql-identity.ts`), done before the statement is planned.
 */
export function lexWords(sql: string): { words: string[]; operators: string[] } {
  const tokens = lex(sql, true) ?? [];
  const words: string[] = [];
  const operators: string[] = [];
  let run = "";
  let runEnd = -1;
  const flush = () => {
    if (run) operators.push(run);
    run = "";
  };
  for (const t of tokens) {
    const text = sql.slice(t.start, t.end);
    if (t.kind === "punct" && OPERATOR_CHAR.test(text)) {
      if (t.start !== runEnd) flush();
      run += text;
      runEnd = t.end;
      continue;
    }
    flush();
    if (t.kind === "word") words.push(text.toLowerCase());
    else if (t.kind === "quoted")
      words.push(
        text
          .replace(/^[uU]&/, "")
          .slice(1, -1)
          .replace(/""/g, '"'),
      );
  }
  flush();
  return { words, operators };
}

const sameTokens = (a: readonly Token[], b: readonly Token[]) =>
  a.length === b.length &&
  a.every((t, k) => t.kind === b[k]?.kind && t.start === b[k]?.start && t.end === b[k]?.end);

/** What a statement may start with: a query that only reads. */
const READ_KEYWORDS = new Set(["select", "with", "values", "table"]);
/** Data-modifying commands, which can sit inside a WITH or after it. */
const WRITE_KEYWORDS = new Set(["insert", "update", "delete", "merge"]);
/** `FOR UPDATE`, `FOR NO KEY UPDATE`, `FOR SHARE`, `FOR KEY SHARE`: row locks are writes. */
const LOCK_KEYWORDS = new Set(["update", "share", "no", "key"]);

/**
 * The statement an agent may send, decided before anything reaches the database: the text is ONE command that
 * only reads. Rejected: more than one command; a text Postgres would not even parse; a text whose command
 * boundary depends on `standard_conforming_strings` (the customer's server may have it off, and then a backslash
 * escapes a quote in a plain string); a command that is not a query (`SET`, `BEGIN`, `COMMIT`, `COPY`, `EXPLAIN`...,
 * which could undo the read-only transaction or its timeout); and a write inside a query (a data-modifying
 * WITH, `SELECT … INTO`, `FOR UPDATE`/`FOR SHARE`). The plan check still runs after this, as the second layer.
 */
export function guardStatement(sql: string): { statement: string } | { failure: GuardFailure } {
  const tokens = lex(sql, true);
  const loose = lex(sql, false);
  if (!tokens) return { failure: { reason: "malformed" } };
  if (!loose || !sameTokens(tokens, loose)) return { failure: { reason: "ambiguous" } };
  const code = tokens.filter((t) => t.kind !== "semicolon");
  const lastCode = code.at(-1);
  if (lastCode && tokens.some((t) => t.kind === "semicolon" && t.start < lastCode.start))
    return { failure: { reason: "multiple_statements" } };
  const text = (t: Token | undefined) => (t ? sql.slice(t.start, t.end).toLowerCase() : "");
  const isWord = (t: Token | undefined, words: ReadonlySet<string>) =>
    t?.kind === "word" && words.has(text(t));
  const first = code.findIndex((t) => !(t.kind === "punct" && text(t) === "("));
  const keyword = code[first]?.kind === "word" ? text(code[first]) : "";
  if (!lastCode || !READ_KEYWORDS.has(keyword)) return { failure: { reason: "statement", keyword } };
  for (let k = 0; k < code.length; k++) {
    const t = code[k];
    // A schema-qualified call (`pg_catalog.lower(…)`, `extra.fn(…)`): rejected as written, even when the plan
    // would print it without the schema.
    if (t?.kind === "punct" && text(t) === "(" && text(code[k - 2]) === ".") {
      const fn = code[k - 1];
      if (fn?.kind === "word" || fn?.kind === "quoted")
        return { failure: { reason: "function", name: `${text(code[k - 3])}.${text(fn)}` } };
    }
    if (t?.kind !== "word") continue;
    const word = text(t);
    const before = code[k - 1];
    const opensCommand =
      !before || (before.kind === "punct" && (text(before) === "(" || text(before) === ")"));
    // Conservatively reject CTE suffixes whose end is not a closing parenthesis.
    if ((word === "search" || word === "cycle") && before?.kind === "punct" && text(before) === ")")
      return { failure: { reason: "write" } };
    if (word === "into" || (WRITE_KEYWORDS.has(word) && opensCommand))
      return { failure: { reason: "write" } };
    if (word === "for" && isWord(code[k + 1], LOCK_KEYWORDS)) return { failure: { reason: "write" } };
  }
  return { statement: sql.slice(0, lastCode.end).replace(/^[ \t\n\r\f\v]+/, "") };
}

interface PlanNode {
  "Node Type"?: string;
  "Relation Name"?: string;
  Schema?: string;
  Alias?: string;
  "Parent Relationship"?: string;
  "Function Name"?: string;
  Plans?: PlanNode[];
  [key: string]: unknown;
}

/** EXPLAIN's JSON, checked before it is read: anything off this shape fails closed. */
const planNode: z.ZodType<PlanNode> = z.lazy(() =>
  z
    .object({
      "Node Type": z.string().optional(),
      "Relation Name": z.string().optional(),
      Schema: z.string().optional(),
      Alias: z.string().optional(),
      "Parent Relationship": z.string().optional(),
      "Function Name": z.string().optional(),
      Plans: z.array(planNode).optional(),
    })
    .catchall(z.unknown()),
);
const explainRoot = z.object({ Plan: planNode }).catchall(z.unknown());
const explainOutput = z.union([z.array(explainRoot).min(1), explainRoot]);

/** Normalizes `table` and `schema.table` to `schema.table` (public when missing). */
export const qualified = (name: string) => (name.includes(".") ? name : `public.${name}`).toLowerCase();

/**
 * Functions that read outside the allowed tables, by family: the system ones (`pg_*`: files, other
 * sessions, configuration), the ones that run SQL passed as text (`ts_stat`, `ts_rewrite`,
 * `*_to_xml`), large objects, other databases and the session configuration. The text passed to them
 * becomes a literal and drops out of the column check, so they cannot run. `nextval` and `setval` change a
 * sequence: the read-only transaction already rejects them, and this keeps a second layer.
 */
const BLOCKED_FUNCTION =
  /\b(pg_\w+|lo_\w+|dblink\w*|nextval|setval|set_config|current_setting|ts_stat|ts_rewrite|inet_(?:server|client)_\w+|(?:query|cursor|table|schema|database)_to_xml\w*)\s*\(/i;

/**
 * The functions a query may call: built-ins that only compute on what they receive, by family. A name outside
 * this list (a function of the customer's own, which can read any table; `xpath`; `xmltable`) is rejected: a
 * function the guard doesn't know reads what the plan doesn't show. The names come from what the tests and the
 * data sources of the origin use, plus the rest of each family.
 * The plan prints a function by name only: that the name is pg_catalog's own function is proven before planning,
 * by `guardedQuery` (sql-identity.ts), the only way a caller may run an agent's query.
 */
const ALLOWED_FUNCTIONS = new Set([
  // aggregates
  ...["count", "sum", "avg", "min", "max", "bool_and", "bool_or", "every", "string_agg", "array_agg"],
  ...["json_agg", "jsonb_agg", "json_object_agg", "jsonb_object_agg", "stddev", "stddev_pop"],
  ...["stddev_samp", "variance", "var_pop", "var_samp", "percentile_cont", "percentile_disc", "mode"],
  ...["corr", "covar_pop", "covar_samp", "regr_slope", "regr_intercept", "regr_count", "grouping"],
  // window
  ...["row_number", "rank", "dense_rank", "percent_rank", "cume_dist", "ntile", "lag", "lead"],
  ...["first_value", "last_value", "nth_value"],
  // text
  ...["lower", "upper", "initcap", "length", "char_length", "character_length", "octet_length"],
  ...["bit_length", "substring", "substr", "position", "strpos", "trim", "btrim", "ltrim", "rtrim"],
  ...["lpad", "rpad", "replace", "translate", "concat", "concat_ws", "left", "right", "repeat"],
  ...["reverse", "split_part", "starts_with", "format", "regexp_replace", "regexp_match"],
  ...["regexp_matches", "regexp_split_to_array", "regexp_split_to_table", "regexp_count"],
  ...["regexp_instr", "regexp_like", "regexp_substr", "to_char", "to_number", "to_date"],
  ...["to_timestamp", "ascii", "chr", "encode", "decode", "overlay", "string_to_array"],
  ...["string_to_table", "array_to_string", "md5", "quote_literal", "quote_ident", "quote_nullable"],
  ...["normalize", "unistr", "like_escape", "textlen"],
  // full-text search on what the query passes
  ...["to_tsvector", "to_tsquery", "plainto_tsquery", "phraseto_tsquery", "websearch_to_tsquery"],
  ...["ts_rank", "ts_rank_cd", "ts_headline", "setweight", "strip", "numnode", "querytree"],
  // date and time
  ...["now", "date_trunc", "date_part", "extract", "age", "make_date", "make_time", "make_timestamp"],
  ...["make_timestamptz", "make_interval", "justify_days", "justify_hours", "justify_interval"],
  ...["isfinite", "timezone", "date_bin", "date_add", "date_subtract", "current_date"],
  ...["current_time", "current_timestamp", "localtime", "localtimestamp", "statement_timestamp"],
  ...["transaction_timestamp", "clock_timestamp", "timeofday"],
  // math
  ...["abs", "ceil", "ceiling", "floor", "round", "trunc", "sign", "sqrt", "cbrt", "power", "pow"],
  ...["exp", "ln", "log", "log10", "mod", "div", "pi", "degrees", "radians", "sin", "cos", "tan"],
  ...["asin", "acos", "atan", "atan2", "cot", "sinh", "cosh", "tanh", "width_bucket", "random"],
  ...["gcd", "lcm", "factorial", "scale", "min_scale", "trim_scale", "numeric"],
  // conditionals
  ...["coalesce", "nullif", "greatest", "least"],
  // json
  ...["json_build_object", "jsonb_build_object", "json_build_array", "jsonb_build_array", "to_json"],
  ...["to_jsonb", "json_array_length", "jsonb_array_length", "json_extract_path", "jsonb_extract_path"],
  ...["json_extract_path_text", "jsonb_extract_path_text", "jsonb_set", "jsonb_set_lax", "jsonb_insert"],
  ...["json_strip_nulls", "jsonb_strip_nulls", "jsonb_pretty", "json_typeof", "jsonb_typeof"],
  ...["jsonb_path_exists", "jsonb_path_match", "jsonb_path_query", "jsonb_path_query_array"],
  ...["jsonb_path_query_first", "json_array_elements", "jsonb_array_elements", "json_object"],
  ...["json_array_elements_text", "jsonb_array_elements_text", "json_each", "jsonb_each", "json_array"],
  ...["json_each_text", "jsonb_each_text", "json_object_keys", "jsonb_object_keys", "json_to_record"],
  ...["jsonb_to_record", "json_to_recordset", "jsonb_to_recordset", "json_populate_record"],
  ...["jsonb_populate_record", "json_populate_recordset", "jsonb_populate_recordset", "row_to_json"],
  ...["array_to_json", "jsonb_object", "json_scalar", "json_serialize"],
  // arrays and sets
  ...["array_length", "array_upper", "array_lower", "array_ndims", "array_dims", "cardinality"],
  ...["array_position", "array_positions", "array_append", "array_prepend", "array_cat"],
  ...["array_remove", "array_replace", "array_fill", "trim_array", "unnest", "generate_series"],
  ...["generate_subscripts", "num_nulls", "num_nonnulls"],
]);

/** SQL keywords that come before a parenthesis without being a call (`IN (…)`, `OVER (…)`, `ROW(…)`). */
const NOT_A_CALL = new Set([
  ...["and", "or", "not", "any", "all", "some", "in", "exists", "array", "row", "filter", "over"],
  ...["group", "within", "distinct", "from", "where", "when", "then", "else", "case", "end", "is"],
  ...["as", "between", "like", "ilike", "similar", "using", "on", "by", "order", "partition"],
  ...["rows", "range", "groups", "values", "operator", "cast", "escape", "with", "ordinality"],
  ...["lateral", "select", "sets", "rollup", "cube", "nulls", "asc", "desc", "collate", "for"],
]);

/**
 * The first function call of a plan expression (its literals already blanked) that the list doesn't allow,
 * or null. Rejected as they stand: a schema-qualified name (`pg_catalog.lower(…)`) and a quoted one, except the
 * quoted form of an allowed name, which is how Postgres itself prints a function named like a keyword
 * (`"left"(…)`). A type with a modifier after `::` or `AS` (`::numeric(10,2)`) is not a call. An expression
 * that doesn't lex counts as rejected.
 */
function disallowedCall(text: string): string | null {
  const tokens = lex(text, true);
  if (!tokens) return "unreadable expression";
  const word = (t: Token | undefined) =>
    t?.kind === "word" ? text.slice(t.start, t.end).toLowerCase() : null;
  const isPunct = (t: Token | undefined, c: string) => t?.kind === "punct" && text[t.start] === c;
  const castAt = (j: number) =>
    (isPunct(tokens[j - 1], ":") && isPunct(tokens[j - 2], ":")) || word(tokens[j - 1]) === "as";
  for (let k = 0; k + 1 < tokens.length; k++) {
    if (!isPunct(tokens[k + 1], "(")) continue;
    const t = tokens[k] as Token;
    const raw = text.slice(t.start, t.end);
    const qualifiedCall = isPunct(tokens[k - 1], ".");
    if (t.kind === "quoted") {
      const name = raw.slice(1, -1).replace(/""/g, '"');
      if (qualifiedCall || !ALLOWED_FUNCTIONS.has(name)) return raw;
      continue;
    }
    const name = word(t);
    if (!name) continue;
    if (qualifiedCall) {
      const owner = tokens[k - 2];
      return `${owner ? text.slice(owner.start, owner.end) : ""}.${raw}`.toLowerCase();
    }
    if (NOT_A_CALL.has(name)) continue;
    // `::numeric(10,2)`, `AS varchar(20)`, `::character varying(20)`, `::bit varying(8)`.
    if (
      castAt(k) ||
      (name === "varying" && /^(character|bit)$/.test(word(tokens[k - 1]) ?? "") && castAt(k - 1))
    )
      continue;
    if (!ALLOWED_FUNCTIONS.has(name)) return name;
  }
  return null;
}

/** In FROM (Function Scan), only set-returning functions that work on what they receive. */
const SAFE_SET_FUNCTION =
  /^(generate_series|generate_subscripts|unnest|string_to_table|regexp_matches|regexp_split_to_table|jsonb_path_query|jsonb?_(?:array_elements(?:_text)?|each(?:_text)?|object_keys|to_record(?:set)?|populate_record(?:set)?))$/i;

/** Node fields that are metadata, not expressions: index names and aliases do not count as reads. */
const META_KEYS = new Set([
  "Node Type",
  "Relation Name",
  "Schema",
  "Alias",
  "Index Name",
  "Parent Relationship",
  "Subplan Name",
  "Scan Direction",
  "Strategy",
  "Partial Mode",
  "Join Type",
  "CTE Name",
  "Function Name",
]);

function expressions(node: PlanNode): string[] {
  const out: string[] = [];
  for (const [key, value] of Object.entries(node)) {
    if (key === "Plans" || META_KEYS.has(key)) continue;
    if (typeof value === "string") out.push(value);
    else if (Array.isArray(value)) for (const v of value) if (typeof v === "string") out.push(v);
  }
  // Literals read nothing: 'ssn' inside a string is not the ssn column.
  return out.map((t) =>
    (lex(t, true) ?? [])
      .filter((token) => token.kind === "literal")
      .reverse()
      .reduce((text, token) => `${text.slice(0, token.start)}''${text.slice(token.end)}`, t),
  );
}

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * Checks the plan against the policy: no writes, only allowed tables, no hidden column
 * read (not even the whole row of a table that has a hidden column) and no function
 * that reads outside the database. `maskedColumns` comes as `table.column` or `schema.table.column`.
 *
 * How the plan shows the columns: with a single table, EXPLAIN does not qualify them (`ssn`); with more
 * than one, it qualifies by alias (`c.ssn`). Under a join, the scan may return every column of
 * the table even when unused ("physical tlist"); that is why the `Output` of an Outer/Inner child
 * does not count as a read: what the node above uses shows in its own expressions.
 */
export function checkPlan(
  explain: unknown,
  policy: { tables: readonly string[]; maskedColumns: readonly string[] },
): GuardFailure | null {
  const parsed = explainOutput.safeParse(explain);
  if (!parsed.success) return { reason: "write" };
  const root = Array.isArray(parsed.data) ? parsed.data[0] : parsed.data;
  if (!root) return { reason: "write" };
  const allowed = new Set(policy.tables.map(qualified));
  const hiddenByTable = new Map<string, string[]>();
  for (const col of policy.maskedColumns) {
    const parts = col.toLowerCase().split(".");
    const column = parts.pop();
    if (!column || parts.length === 0) continue;
    const table = qualified(parts.join("."));
    hiddenByTable.set(table, [...(hiddenByTable.get(table) ?? []), column]);
  }

  const nodes: PlanNode[] = [];
  const collect = (node: PlanNode) => {
    nodes.push(node);
    for (const child of node.Plans ?? []) collect(child);
  };
  collect(root.Plan);

  // 1st pass: writes, functions and tables; builds alias → hidden columns.
  const byAlias = new Map<string, { table: string; column: string }[]>();
  const bare = new Map<string, string>(); // hidden column → table, for the case without an alias
  for (const node of nodes) {
    const type = node["Node Type"] ?? "";
    if (type === "ModifyTable" || type === "LockRows") return { reason: "write" };
    // XMLTABLE and JSON_TABLE: their own node, with the call outside the expressions.
    if (type === "Table Function Scan") return { reason: "function", name: "table function" };
    if (type === "Function Scan") {
      const name = node["Function Name"];
      if (typeof name !== "string" || !SAFE_SET_FUNCTION.test(name))
        return { reason: "function", name: typeof name === "string" ? name.toLowerCase() : "rows from" };
    }
    for (const text of expressions(node)) {
      const fn = BLOCKED_FUNCTION.exec(text);
      if (fn?.[1]) return { reason: "function", name: fn[1].toLowerCase() };
      const unknown = disallowedCall(text);
      if (unknown) return { reason: "function", name: unknown };
    }
    const rel = node["Relation Name"];
    if (!rel) continue;
    const table = qualified(`${node.Schema ?? "public"}.${rel}`);
    if (!allowed.has(table)) return { reason: "table", table };
    const alias = (node.Alias ?? rel).toLowerCase();
    for (const column of hiddenByTable.get(table) ?? []) {
      byAlias.set(alias, [...(byAlias.get(alias) ?? []), { table, column }]);
      bare.set(column, table);
    }
  }
  if (bare.size === 0) return null;

  // 2nd pass: does any expression read a hidden column?
  const checks: { re: RegExp; column: string }[] = [];
  for (const [alias, cols] of byAlias) {
    const a = escapeRe(alias);
    checks.push({ re: new RegExp(`(^|[^\\w.])"?${a}"?\\.\\*`, "i"), column: `${cols[0]?.table}.*` });
    for (const { table, column } of cols) {
      checks.push({
        re: new RegExp(`(^|[^\\w.])"?${a}"?\\.("?)${escapeRe(column)}\\2(?![\\w(])`, "i"),
        column: `${table}.${column}`,
      });
    }
  }
  for (const [column, table] of bare) {
    checks.push({
      re: new RegExp(`(^|[^\\w."])("?)${escapeRe(column)}\\2(?![\\w(.])`, "i"),
      column: `${table}.${column}`,
    });
  }
  for (const node of nodes) {
    const rel = node["Parent Relationship"];
    const skipOutput = rel === "Outer" || rel === "Inner";
    const texts = expressions(skipOutput ? { ...node, Output: undefined } : node);
    for (const text of texts) {
      for (const { re, column } of checks) if (re.test(text)) return { reason: "column", column };
    }
  }
  return null;
}
