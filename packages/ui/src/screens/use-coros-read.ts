import { useEffect, useRef } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "@rg/api-client";

export type CorosCheckState =
  | "idle"
  | "checking"
  | "ok"
  | "still_syncing"
  | "not_connected"
  | "bad_credentials"
  | "coros_unreachable";

const BUSY_RETRY_MS = 2500;
const BUSY_RETRY_MAX = 3;

/**
 * App-open COROS pull (cloud-direct spec §3), modelled as a QUERY, not a
 * mutation: the server single-flights and has a 90s freshness window, so
 * "fetch on mount" is exactly right — and TanStack queries are StrictMode-
 * safe where an effect-fired mutation wedges in dev. The OUTCOME is part of
 * the return — a failed or unconnected pull must be said out loud, never a
 * pill that flashes and vanishes (live user report, 2026-08-12).
 *
 * "busy" means another pull (connect's first pull, a second tab, the cron
 * sweep) holds the lock. This tab still owes the user fresh data, so it
 * refetches a few times and invalidates once the other pull lands —
 * otherwise the exact connect-then-open-plan journey shows stale data until
 * a manual refresh.
 */
export function useCorosReadNow(): { state: CorosCheckState } {
  const qc = useQueryClient();
  const busySeen = useRef(0);
  const read = useQuery({
    queryKey: ["coros-read-now"],
    queryFn: api.corosReadNow,
    enabled: typeof document === "undefined" || document.visibilityState === "visible",
    staleTime: 30_000,
    retry: false,
    refetchOnWindowFocus: false,
    refetchInterval: (q) =>
      q.state.data?.status === "busy" && busySeen.current < BUSY_RETRY_MAX ? BUSY_RETRY_MS : false,
  });

  const data = read.data;
  useEffect(() => {
    if (!data) return;
    if (data.status === "busy") {
      busySeen.current += 1;
      return;
    }
    const ingestedNow = data.status === "ok" && (data.ingested ?? 0) > 0;
    // "fresh" after a busy race: the OTHER pull just finished — this tab
    // doesn't know what it ingested, so refresh to be safe.
    const racedAndLost = data.status === "fresh" && busySeen.current > 0;
    if (ingestedNow || racedAndLost) {
      busySeen.current = 0;
      for (const k of ["plan", "plan-week", "today", "garden", "activities", "runs", "sync-status"]) {
        void qc.invalidateQueries({ queryKey: [k] });
      }
    }
  }, [data, qc]);

  if (read.isLoading) return { state: "checking" };
  if (read.isError) return { state: "coros_unreachable" };
  const s = data?.status;
  if (s === "not_connected") return { state: "not_connected" };
  if (s === "bad_credentials") return { state: "bad_credentials" };
  if (s === "coros_unreachable") return { state: "coros_unreachable" };
  if (s === "busy" && busySeen.current < BUSY_RETRY_MAX) return { state: "checking" };
  // Retries exhausted while another pull still holds the lock: say so —
  // "silence is only allowed for success" (audit finding 11).
  if (s === "busy") return { state: "still_syncing" };
  if (s === "ok" || s === "fresh") return { state: "ok" };
  return { state: "idle" };
}
