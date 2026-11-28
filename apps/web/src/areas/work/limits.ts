// A limit as a person types it, for the routines' limits, an assignment's and a channel's budget: a
// count is digits only, and an amount is dollars with up to two decimals after the language's own
// decimal mark ("." in English, "," in Portuguese). The other mark, and any thousands separator, is no
// amount at all: "10,000" in English is not ten dollars, nor is "1.000" in Portuguese one. Neither is
// "0x10", "1e3" or "-1".

/** Its bounds, and whether it counts (`1`) or is money (`"any"`). */
export type Limit = { min: number; max: number; step: 1 | "any" };

/** The mark between whole dollars and cents in a language. */
export type DecimalMark = "." | ",";

/** The decimal mark the language writes: "," in Portuguese, "." in English. */
export function decimalMark(locale: string): DecimalMark {
  const mark = new Intl.NumberFormat(locale).formatToParts(1.5).find((part) => part.type === "decimal");
  return mark?.value === "," ? "," : ".";
}

const AMOUNT: Record<DecimalMark, RegExp> = { ".": /^\d+(\.\d{1,2})?$/, ",": /^\d+(,\d{1,2})?$/ };

/** The number typed, inside its bounds, or undefined. */
export function readLimit(text: string, limit: Limit, mark: DecimalMark): number | undefined {
  const typed = text.trim();
  if (!(limit.step === 1 ? /^\d+$/ : AMOUNT[mark]).test(typed)) return undefined;
  const value = Number(typed.replace(",", "."));
  if (value < limit.min || value > limit.max) return undefined;
  return value;
}

/** A limit as the person would type it in their language, to start a field from. */
export function formatLimit(value: number, mark: DecimalMark): string {
  return String(value).replace(".", mark);
}
