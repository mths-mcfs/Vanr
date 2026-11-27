// Relative dates in the interface language ("3 hours ago", "in 2 days"), kept current with the app's
// clock. Every area that shows when something happened uses these.
import { useEffect, useState } from "react";
import { useClock } from "../platform/clock.tsx";
import { useLocale } from "./react.tsx";

const UNITS: [Intl.RelativeTimeFormatUnit, number][] = [
  ["year", 365 * 86_400_000],
  ["month", 30 * 86_400_000],
  ["week", 7 * 86_400_000],
  ["day", 86_400_000],
  ["hour", 3_600_000],
  ["minute", 60_000],
];

/** "3 hours ago", "in 2 days": the distance from now in the largest unit that fits. */
export function relativeTime(iso: string, now: number, locale: string): string {
  const delta = Date.parse(iso) - now;
  const format = new Intl.RelativeTimeFormat(locale, { numeric: "auto" });
  for (const [unit, ms] of UNITS) {
    if (Math.abs(delta) >= ms) return format.format(Math.round(delta / ms), unit);
  }
  return format.format(0, "minute");
}

/** How often relative times are worked out again: their smallest unit is the minute. */
const RELATIVE_TICK_MS = 60_000;

/** The relative time of a date, kept current with the app's clock. */
export function useRelativeTime(): (iso: string) => string {
  const { locale } = useLocale();
  const clock = useClock();
  const [, setTick] = useState(0);
  useEffect(() => {
    let cancel = () => {};
    const schedule = () => {
      cancel = clock.setTimer(() => {
        setTick((tick) => tick + 1);
        schedule();
      }, RELATIVE_TICK_MS);
    };
    schedule();
    return () => cancel();
  }, [clock]);
  return (iso) => relativeTime(iso, clock.now(), locale);
}
