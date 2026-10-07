/**
 * "COULDN'T SYNC ONE SESSION" (Phase 2 spec §2b "Client storage"; plan 2b Task 7) — Settings → Data. A session the
 * server refused (`409 conflict`: the same session saved elsewhere with other edits; or a refusal retrying cannot
 * fix) stays in the outbox, flagged, never silently dropped or written over. One quiet row each, with Retry (send it
 * once more) and Discard. Nothing renders when there is none.
 */
import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "@rg/api-client";
import { ConfirmDialog, formatShortDate } from "../components.js";
import { offlineDb, type OfflineDb } from "../offline/idb.js";
import { discardEntry, drain, outboxEntries, retryEntry, type OutboxApi } from "../offline/outbox.js";
import { SAVED_SESSION_QUERIES } from "./outbox-sync.js";

export function UnsyncedSessions({ db = offlineDb, api: client = api }: { db?: () => Promise<OfflineDb>; api?: OutboxApi }) {
  const qc = useQueryClient();
  const outbox = useQuery({ queryKey: ["outbox"], queryFn: async () => outboxEntries(await db()), retry: false });
  const [discarding, setDiscarding] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const refused = (outbox.data ?? []).filter((e) => e.state !== "pending");
  if (refused.length === 0) return null;

  const done = async (saved: boolean) => {
    await qc.invalidateQueries({ queryKey: ["outbox"] });
    if (saved) for (const k of SAVED_SESSION_QUERIES) void qc.invalidateQueries({ queryKey: [k] });
  };
  const retry = async (key: string) => {
    setBusy(true);
    try {
      const d = await db();
      await retryEntry(d, key);
      const result = await drain(d, client).catch(() => null);
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
            Couldn't sync one session · {formatShortDate(e.payload.localDate)}
          </span>
          <span className="btn-row">
            <button type="button" className="btn" disabled={busy} onClick={() => void retry(e.key)}>
              Retry
            </button>
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
