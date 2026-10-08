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
import { useQuery, useQueryClient, type QueryClient } from "@tanstack/react-query";
import { api, type MeResponse } from "@rg/api-client";
import { offlineDb, type OfflineDb } from "../offline/idb.js";
import { meWithOfflineFallback } from "../offline/me.js";
import { startOutboxSync, type DrainResult, type OutboxApi } from "../offline/outbox.js";

/** What a saved session changes on screen. */
export const SAVED_SESSION_QUERIES = ["today", "plan", "plan-week", "programs", "garden", "runs"] as const;

/**
 * The signed-in account, as the screens last heard it: never asked for here (`enabled: false`), but with the same
 * question the app's screens ask, so a refetch through any of them asks it the same way.
 */
export function useSignedInUserId(): string | null {
  const me = useQuery<MeResponse>({
    queryKey: ["me"],
    queryFn: () => meWithOfflineFallback(),
    enabled: false,
    retry: false,
    networkMode: "online",
  });
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
      onDrained: (result) => afterDrain(qc, result),
    });
  }, [db, client, qc, userId]);
  return null;
}

/**
 * What a drain changes on screen: the outbox's own lines; Today, Plan and the garden once a session reached the server;
 * and, when the server said the sign-in has expired, who is signed in — asked again, so the app goes to sign-in rather
 * than reading "Couldn't load the garden" over a session waiting to sync (audit 2b-B M-3).
 */
export function afterDrain(qc: QueryClient, result: Pick<DrainResult, "saved" | "signedOut" | "unstarted"> | null): void {
  void qc.invalidateQueries({ queryKey: ["outbox"] });
  if (!result) return;
  if (result.saved > 0) for (const k of SAVED_SESSION_QUERIES) void qc.invalidateQueries({ queryKey: [k] });
  // A Discard made offline reached the server: the slot is built again, and Today offers Start (ruling 2b-R9).
  else if ((result.unstarted ?? 0) > 0) for (const k of ["today", "plan", "plan-week", "programs"]) void qc.invalidateQueries({ queryKey: [k] });
  if (result.signedOut) void qc.invalidateQueries({ queryKey: ["me"] });
}
