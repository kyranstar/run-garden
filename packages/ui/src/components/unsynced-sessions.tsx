/**
 * "COULDN'T SYNC ONE SESSION" (Phase 2 spec §2b "Client storage"; plan 2b Task 7) — Settings → Data. A session the
 * server refused stays in the outbox, flagged, never silently dropped or written over: one quiet row each, for the
 * signed-in account's own (ruling 2b-R6). What it offers is the outbox's `entryActions` (audit 2b-A M-8): a `conflict`
 * (the same session saved elsewhere with other edits — the server keeps the first and refuses any other, every time;
 * or, reading "Saved on another device", another session of its slot saved first there — ruling 2b-R18) can only be
 * discarded; a `failed` one can be sent again (Retry) or discarded. Nothing renders when there is none. A session
 * played offline that joined today's same start on another device, which saved first (`done_today`, R11 fix round 1),
 * says so plainly — not saved, the workout already done that day — with Discard and "See it" (that workout's sheet).
 */
import { useState } from "react";
import { Link } from "react-router-dom";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "@rg/api-client";
import { ConfirmDialog, formatShortDate } from "../components.js";
import { offlineDb, type OfflineDb } from "../offline/idb.js";
import { localStarts } from "../offline/local-starts.js";
import { discardEntry, DONE_TODAY, drain, entryActions, outboxEntries, retryEntry, SLOT_DONE, type OutboxApi, type OutboxEntry } from "../offline/outbox.js";
import { SAVED_SESSION_QUERIES, useSignedInUserId } from "./outbox-sync.js";

/** The rows: the signed-in account's own refused sessions (ruling 2b-R6), those Settings can act on. */
export const refusedFor = (entries: readonly OutboxEntry[], userId: string | null): OutboxEntry[] =>
  entries.filter((e) => userId !== null && e.userId === userId && entryActions(e).length > 0);

export function UnsyncedSessions({
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
  const outbox = useQuery({ queryKey: ["outbox"], queryFn: async () => outboxEntries(await db()), retry: false });
  // The starts made offline (R11): a refused one's name, and the workout it joined (under ["outbox"]: read with it).
  const starts = useQuery({
    queryKey: ["outbox", "local-starts", userId],
    queryFn: async () => new Map((await localStarts(await db(), userId!)).map((s) => [s.localId, s] as const)),
    enabled: !!userId,
    retry: false,
  });
  const [discarding, setDiscarding] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const refused = refusedFor(outbox.data ?? [], userId);
  if (!userId || refused.length === 0) return null;

  const done = async (saved: boolean) => {
    await qc.invalidateQueries({ queryKey: ["outbox"] });
    if (saved) for (const k of SAVED_SESSION_QUERIES) void qc.invalidateQueries({ queryKey: [k] });
  };
  const retry = async (key: string) => {
    setBusy(true);
    try {
      const d = await db();
      await retryEntry(d, key);
      const result = await drain(d, client, { userId }).catch(() => null);
      await done(!!result && result.saved > 0);
    } finally {
      setBusy(false);
    }
  };
  const discard = async (key: string) => {
    setBusy(true);
    try {
      await discardEntry(await db(), key);
      setDiscarding(null);
      await done(false);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="stack unsynced">
      {refused.map((e) => (
        <div key={e.key} className="unsynced-row">
          <span>
            {e.lastError === DONE_TODAY
              ? `Not saved: ${(e.payload.workoutId && starts.data?.get(e.payload.workoutId)?.title) || "this workout"} was already done that day`
              : e.lastError === SLOT_DONE
                ? "Saved on another device"
                : "Couldn't sync one session"}{" "}
            · {formatShortDate(e.payload.localDate)}
          </span>
          <span className="btn-row">
            {e.lastError === DONE_TODAY && e.payload.workoutId && starts.data?.get(e.payload.workoutId)?.workoutId ? (
              <Link className="btn" to={`/plan?workout=${encodeURIComponent(starts.data.get(e.payload.workoutId)!.workoutId!)}`}>
                See it
              </Link>
            ) : null}
            {entryActions(e).includes("retry") ? (
              <button type="button" className="btn" disabled={busy} onClick={() => void retry(e.key)}>
                Retry
              </button>
            ) : null}
            <button type="button" className="btn" disabled={busy} onClick={() => setDiscarding(e.key)}>
              Discard
            </button>
          </span>
        </div>
      ))}
      <ConfirmDialog
        open={discarding !== null}
        onClose={() => setDiscarding(null)}
        title="Discard this session?"
        confirmLabel="Discard session"
        busy={busy}
        onConfirm={() => {
          if (discarding) void discard(discarding);
        }}
      >
        It won't be saved.
      </ConfirmDialog>
    </div>
  );
}
