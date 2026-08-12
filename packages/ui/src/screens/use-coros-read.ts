import { useEffect, useRef } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { api } from "@rg/api-client";

/**
 * App-open COROS pull (cloud-direct spec §3): fired once per mount, only
 * when the page is visible; the server's 90s freshness window makes repeats
 * free. Returns `checking` for the "Checking COROS…" pill. When the pull
 * ingested anything, every training-data query refreshes.
 */
export function useCorosReadNow(): { checking: boolean } {
  const qc = useQueryClient();
  const fired = useRef(false);
  const read = useMutation({
    mutationFn: api.corosReadNow,
    onSuccess: (res) => {
      if (res.status === "ok" && (res.ingested ?? 0) > 0) {
        for (const k of ["plan", "plan-week", "today", "garden", "activities", "runs", "sync-status"]) {
          void qc.invalidateQueries({ queryKey: [k] });
        }
      }
    },
  });
  const { mutate } = read;
  useEffect(() => {
    if (fired.current) return;
    if (typeof document !== "undefined" && document.visibilityState !== "visible") return;
    fired.current = true;
    mutate();
  }, [mutate]);
  return { checking: read.isPending };
}
