/**
 * THE OUTBOX, DRAINING FOR THE LIFE OF THE APP (Phase 2 spec §2b "Client storage"; plan 2b Task 7). Mounted once by
 * the app: once the signed-in account is known (the `["me"]` answer any screen asked for), the outbox sends that
 * account's saved sessions at once, on `online`, whenever the page becomes visible and when a backoff is up
 * (`startOutboxSync`; ruling 2b-R6: only the signed-in account's). A session that reached the server refreshes Today,
 * Plan and the garden.
 *
 * With nothing in the outbox (every account without a program) it reads IndexedDB and sends nothing.
 */
import { useEffect } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { api, type MeResponse } from "@rg/api-client";
import { offlineDb, type OfflineDb } from "../offline/idb.js";
import { startOutboxSync, type OutboxApi } from "../offline/outbox.js";

/** What a saved session changes on screen. */
export const SAVED_SESSION_QUERIES = ["today", "plan", "plan-week", "programs", "garden", "runs"] as const;

/** The signed-in account, as the screens last heard it (never asked for here). */
export function useSignedInUserId(): string | null {
  const me = useQuery<MeResponse>({ queryKey: ["me"], enabled: false });
  return me.data?.userId ?? null;
}

export function OutboxSync({
  db = offlineDb,
  api: client = api,
  userId: given,
}: {
  db?: () => Promise<OfflineDb>;
  api?: OutboxApi;
  /** Who is signed in; by default the `["me"]` answer. */
  userId?: string | null;
}) {
  const qc = useQueryClient();
  const heard = useSignedInUserId();
  const userId = given === undefined ? heard : given;
  useEffect(() => {
    if (!userId) return;
    return startOutboxSync({
      db,
      api: client,
      userId,
      onDrained: (result) => {
        void qc.invalidateQueries({ queryKey: ["outbox"] });
        if (result.saved > 0) for (const k of SAVED_SESSION_QUERIES) void qc.invalidateQueries({ queryKey: [k] });
      },
    });
  }, [db, client, qc, userId]);
  return null;
}
