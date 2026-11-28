// A limit as a person types it, for the routines' limits and an assignment's: a count is digits only,
// and an amount is dollars with up to two decimals after "." or ",". So "1,000" is no amount at all
// rather than one dollar; neither is "0x10", "1e3" or "-1".

/** Its bounds, and whether it counts (`1`) or is money (`"any"`). */
export type Limit = { min: number; max: number; step: 1 | "any" };

/** The number typed, inside its bounds, or undefined. */
export function readLimit(text: string, limit: Limit): number | undefined {
  const typed = text.trim();
  if (!(limit.step === 1 ? /^\d+$/ : /^\d+([.,]\d{1,2})?$/).test(typed)) return undefined;
  const value = Number(typed.replace(",", "."));
  if (value < limit.min || value > limit.max) return undefined;
  return value;
}
