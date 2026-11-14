// Time, injected. The web uses the client's Clock everywhere (deadlines, reconnection and the
// countdowns on screen run on the same one), so tests move it by hand and never wait.
import { type Clock, systemClock } from "@vanr/client";
import { createContext, type ReactNode, useContext, useEffect, useState } from "react";

export { type Clock, systemClock };

const ClockContext = createContext<Clock>(systemClock);

export function ClockProvider({ clock, children }: { clock: Clock; children: ReactNode }) {
  return <ClockContext.Provider value={clock}>{children}</ClockContext.Provider>;
}

export function useClock(): Clock {
  return useContext(ClockContext);
}

/**
 * Whole seconds left until `until` (a clock time in ms), ticking down once a second; 0 when it has
 * passed or is undefined.
 */
export function useSecondsUntil(until: number | undefined): number {
  const clock = useClock();
  const left = () => (until === undefined ? 0 : Math.max(0, Math.ceil((until - clock.now()) / 1000)));
  const [seconds, setSeconds] = useState(left);
  useEffect(() => {
    if (until === undefined) {
      setSeconds(0);
      return;
    }
    let cancel = () => {};
    const tick = () => {
      const remaining = Math.max(0, Math.ceil((until - clock.now()) / 1000));
      setSeconds(remaining);
      if (remaining > 0) cancel = clock.setTimer(tick, 1000);
    };
    tick();
    return () => cancel();
  }, [until, clock]);
  return seconds;
}
