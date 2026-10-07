/**
 * THE OUTBOX, DRAINING FOR THE LIFE OF THE APP (Phase 2 spec §2b "Client storage"; plan 2b Task 7). Mounted once by
 * the app: the outbox sends what Save left in it at app start, on `online`, whenever the page becomes visible and when
 * a backoff is up (`startOutboxSync`). A session that reached the server refreshes Today, Plan and the garden.
 *
 * With nothing in the outbox (every account without a program) it reads IndexedDB and sends nothing.
 */
import { useEffect } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { api } from "@rg/api-client";
import { offlineDb, type OfflineDb } from "../offline/idb.js";
import { startOutboxSync, type OutboxApi } from "../offline/outbox.js";

/** What a saved session changes on screen. */
export const SAVED_SESSION_QUERIES = ["today", "plan", "plan-week", "programs", "garden", "runs"] as const;

export function OutboxSync({ db = offlineDb, api: client = api }: { db?: () => Promise<OfflineDb>; api?: OutboxApi }) {
  const qc = useQueryClient();
  useEffect(
    () =>
      startOutboxSync({
        db,
        api: client,
        onDrained: (result) => {
          void qc.invalidateQueries({ queryKey: ["outbox"] });
          if (result.saved > 0) for (const k of SAVED_SESSION_QUERIES) void qc.invalidateQueries({ queryKey: [k] });
        },
      }),
    [db, client, qc],
  );
  return null;
}
