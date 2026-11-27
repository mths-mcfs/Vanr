// Message values and how they become text. A message is a string with {name} placeholders, or a
// pair of forms picked by the `count` parameter with the language's plural rule.
import type { Locale } from "./locales.ts";

export type PluralMessage = { readonly one: string; readonly other: string };
export type Message = string | PluralMessage;
export type Catalog = Readonly<Record<string, Message>>;

/** A translation of `Source`: the same keys, each with the same kind of message. */
export type TranslationOf<Source extends Catalog> = {
  readonly [Key in keyof Source]: Source[Key] extends string ? string : PluralMessage;
};

type Placeholders<Text extends string> = Text extends `${string}{${infer Name}}${infer Rest}`
  ? Name | Placeholders<Rest>
  : never;

/** The parameter names a message takes. A plural message always takes `count`. */
export type ParamNames<M> = M extends string
  ? Placeholders<M>
  : M extends { one: infer One extends string; other: infer Other extends string }
    ? Placeholders<One> | Placeholders<Other> | "count"
    : never;

export type MessageParams = Readonly<Record<string, string | number>>;

/** `t(key)` for a message without placeholders, `t(key, { name })` for one with them. */
export type Translate<C extends Catalog> = <Key extends keyof C & string>(
  key: Key,
  ...params: [ParamNames<C[Key]>] extends [never] ? [] : [params: Record<ParamNames<C[Key]>, string | number>]
) => string;

const PLACEHOLDER = /\{([A-Za-z][A-Za-z0-9]*)\}/g;

/** The placeholder names in a message, sorted, for comparing translations. */
export function placeholdersOf(message: Message): string[] {
  const texts = typeof message === "string" ? [message] : [message.one, message.other];
  const names = new Set<string>();
  for (const text of texts) for (const match of text.matchAll(PLACEHOLDER)) names.add(match[1] ?? "");
  return [...names].sort();
}

export function formatMessage(message: Message, params: MessageParams | undefined, locale: Locale): string {
  let text: string;
  if (typeof message === "string") text = message;
  else {
    const count = Number(params?.count ?? 0);
    text = new Intl.PluralRules(locale).select(count) === "one" ? message.one : message.other;
  }
  return text.replace(PLACEHOLDER, (whole, name: string) => {
    const value = params?.[name];
    if (value === undefined) return whole;
    return typeof value === "number" ? new Intl.NumberFormat(locale).format(value) : value;
  });
}
