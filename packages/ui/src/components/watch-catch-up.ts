/**
 * THE WATCH CATCHES UP WHILE THE APP IS OPEN (the watch mirrors the plan §3.7, A5). The hourly runs one watch job an
 * hour; while a screen that shows the watch is open, the app drains what is waiting, one job a request
 * (`drainWatchUntilIdle`, at most six). Decided ONCE, when the screen's data first arrives: `waiting` is `undefined`
 * while it loads, then whether the watch has work waiting (the session sheet: its state `updating` or `sending`; Today:
 * a write queued). A state that turns to waiting later (after Send, say) is the action's own drain's, never this one's.
 * `after` runs when the chain ends having run something — read again what it changed.
 */
import { useEffect, useRef } from "react";
import { api } from "@rg/api-client";

export function useWatchCatchUp(waiting: boolean | undefined, after: () => void): void {
  const decided = useRef(false);
  const latest = useRef(after);
  latest.current = after;
  useEffect(() => {
    if (waiting === undefined || decided.current) return;
    decided.current = true;
    if (waiting) void api.drainWatchUntilIdle().then(({ ran }) => ran > 0 && latest.current());
  }, [waiting]);
}
