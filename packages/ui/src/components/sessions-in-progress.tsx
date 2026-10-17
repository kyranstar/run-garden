/**
 * A SESSION LEFT IN PROGRESS STAYS REACHABLE (audit 2b-B C-1; ruling 2b-R16). Today's card lists the program's sessions
 * of today only. A session started in the evening and left — ✕ → Leave, the app killed, a flat battery — holds its
 * sets, and maybe its review, in IndexedDB; after midnight nothing on Today led back to it. Today now shows
 * "Session in progress" for each session in progress the device holds for the signed-in account, with Continue; the
 * day's own sessions keep their Continue on the card and are not listed twice.
 *
 * Read from the device (`live`, and the name Start kept beside the build) — and, before Continue is offered, the slot
 * as the server has it (ruling 2b-R18, re-review 2b-B N-3): a session played and saved on another device is done there,
 * and this device's copy is offered for Discard only ("Saved on another device"), never Continue — its save would be
 * a second session for the slot. A server that can't answer in time (offline, a slow network) leaves Continue to the
 * device, as offline play needs. For an account with no program there is never a session in progress, and nothing
 * renders.
 *
 * A quick start or template started offline (R11) is here too: in progress, with Continue (the server, which has nothing
 * under its provisional id, is never asked); saved and waiting for the network, by its name with "Done · N min · saved,
 * will sync" — the words a session saved offline has on Today's card — until the outbox records it. One refused waits
 * in Settings → Data, with Retry and Discard.
 */
import { useState } from "react";
import { Link } from "react-router-dom";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { api, type SessionDto } from "@rg/api-client";
import { ConfirmDialog, formatDayShort } from "../components.js";
import { loadBuild } from "../offline/builds.js";
import { offlineDb, type OfflineDb } from "../offline/idb.js";
import { liveSessions } from "../offline/live.js";
import { isLocalId, loadLocalStart } from "../offline/local-starts.js";
import { outboxEntries } from "../offline/outbox.js";
import { cuePlayer } from "../player/cue-player.js";
import { discardHere } from "../player/save.js";
import { loadExtras } from "../player/stored.js";

export interface SessionInProgress {
  workoutId: string;
  title: string;
  /** The build's day. */
  date: string | null;
  /** 1-based; null once ended (the review waits). */
  step: number | null;
  steps: number;
}

/** The device's sessions in progress for `userId`, oldest first. */
export async function sessionsInProgress(db: OfflineDb, userId: string): Promise<SessionInProgress[]> {
  const out: Array<SessionInProgress & { startedAt: number }> = [];
  for (const live of await liveSessions(db)) {
    const extras = await loadExtras(db, live.workoutId);
    // The signed-in account's own (ruling 2b-R6): Start, or the player, tagged it.
    if (!extras || extras.userId !== userId) continue;
    const stored = await loadBuild(db, live.workoutId);
    const recorder = live.recorder as { finished?: boolean; live?: { steps?: unknown[] } } | null;
    const steps = recorder?.live?.steps?.length ?? stored?.build.steps.length ?? 0;
    out.push({
      workoutId: live.workoutId,
      title: extras.title,
      date: stored?.build.date ?? null,
      step: recorder?.finished ? null : live.stepIndex + 1,
      steps,
      startedAt: live.startedAt,
    });
  }
  return out.sort((a, b) => a.startedAt - b.startedAt).map(({ startedAt: _startedAt, ...s }) => s);
}

/** A session started offline (R11), saved and waiting for the network. */
export interface SavingWhenOnline {
  workoutId: string;
  title: string;
  date: string;
  minutes: number;
}

/** The device's sessions started offline and saved, waiting for the outbox, for `userId` — oldest first. */
export async function savingWhenOnline(db: OfflineDb, userId: string): Promise<SavingWhenOnline[]> {
  const out: SavingWhenOnline[] = [];
  for (const e of await outboxEntries(db, userId)) {
    if (e.state !== "pending" || !isLocalId(e.payload.workoutId)) continue;
    const start = await loadLocalStart(db, e.payload.workoutId);
    out.push({ workoutId: e.payload.workoutId, title: start?.title ?? "Workout", date: e.payload.localDate, minutes: Math.max(1, Math.round(e.payload.seconds / 60)) });
  }
  return out;
}

export type SlotState = SessionDto["contentState"];

/** How long the line waits for the server before it leaves Continue to the device. */
export const SLOT_CHECK_WAIT_MS = 3_000;

/** The slot's state alone: never the whole session, its build and view (re-review 2b-B2 M-3). */
const askServer = async (workoutId: string): Promise<SlotState> => (await api.getSessionState(workoutId)).contentState;

/** What the server has each slot as — null where it can't say within `waitMs` (offline, slow, the slot gone). */
export async function slotStates(
  ids: readonly string[],
  ask: (workoutId: string) => Promise<SlotState>,
  waitMs: number,
): Promise<Record<string, SlotState | null>> {
  const one = async (id: string): Promise<SlotState | null> => {
    // Started offline (R11): the server has nothing under this id — the device's own to continue.
    if (isLocalId(id)) return null;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([ask(id), new Promise<null>((resolve) => (timer = setTimeout(() => resolve(null), waitMs)))]);
    } catch {
      return null;
    } finally {
      clearTimeout(timer);
    }
  };
  return Object.fromEntries(await Promise.all(ids.map(async (id) => [id, await one(id)] as const)));
}

export function SessionsInProgress({
  today,
  shown,
  userId,
  db = offlineDb,
  slotState = askServer,
  checkWaitMs = SLOT_CHECK_WAIT_MS,
}: {
  today: string;
  /** The sessions the Today card already shows, with their own Continue. */
  shown: readonly string[];
  /** The signed-in account; nothing is shown before it is known. */
  userId: string | null;
  db?: () => Promise<OfflineDb>;
  /** The slot as the server has it (`GET /api/sessions/:id/state`). */
  slotState?: (workoutId: string) => Promise<SlotState>;
  checkWaitMs?: number;
}) {
  const qc = useQueryClient();
  const [discarding, setDiscarding] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const q = useQuery({
    queryKey: ["live-sessions", userId],
    queryFn: async () => sessionsInProgress(await db(), userId!),
    enabled: !!userId,
    retry: false,
    staleTime: 0,
  });
  // Under ["outbox"]: every drain's answer reads it again (`afterDrain`), so a session recorded leaves the line.
  const saving = useQuery({
    queryKey: ["outbox", "saving-when-online", userId],
    queryFn: async () => savingWhenOnline(await db(), userId!),
    enabled: !!userId,
    retry: false,
    staleTime: 0,
  });
  const waiting = saving.data ?? [];
  const items = (q.data ?? []).filter((s) => !shown.includes(s.workoutId));
  const ids = items.map((s) => s.workoutId);
  const server = useQuery({
    queryKey: ["live-sessions-server", userId, ids],
    queryFn: () => slotStates(ids, slotState, checkWaitMs),
    enabled: ids.length > 0,
    retry: false,
    staleTime: 0,
    // Asked whatever the browser says of the network: a check that can't be answered leaves Continue to the device.
    networkMode: "always",
  });
  if (items.length === 0 && waiting.length === 0) return null;
  const checked = server.data;

  const discard = async (workoutId: string) => {
    setBusy(true);
    try {
      await discardHere(await db(), workoutId);
      setDiscarding(null);
      await qc.invalidateQueries({ queryKey: ["live-sessions", userId] });
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="dock-panel today-inprogress" aria-label="Session in progress">
      {items.map((s) => {
        const savedElsewhere = checked?.[s.workoutId] === "done";
        return (
          <div key={s.workoutId} className="today-inprogress-row">
            <div className="today-session-text">
              <span className="today-session-name">
                {savedElsewhere ? "Saved on another device" : "Session in progress"} · {s.title}
              </span>
              <span className="today-session-meta">
                {[s.date ? (s.date === today ? "Today" : formatDayShort(s.date)) : null, s.step === null ? "ready to save" : `step ${s.step} of ${s.steps}`]
                  .filter(Boolean)
                  .join(" · ")}
              </span>
            </div>
            {checked === undefined ? (
              // Not offered before the server has said whether the slot is still to be played (ruling 2b-R18).
              <button type="button" className="btn btn-primary" disabled>
                Continue
              </button>
            ) : savedElsewhere ? (
              <button type="button" className="btn" onClick={() => setDiscarding(s.workoutId)}>
                Discard
              </button>
            ) : (
              <Link className="btn btn-primary" to={`/session/${encodeURIComponent(s.workoutId)}`} onClick={() => cuePlayer.unlock()}>
                Continue
              </Link>
            )}
          </div>
        );
      })}
      {waiting.map((s) => (
        <div key={s.workoutId} className="today-inprogress-row">
          <div className="today-session-text">
            <span className="today-session-name">{s.title}</span>
            <span className="today-session-meta">
              {s.date === today ? "Today" : formatDayShort(s.date)} · Done · {s.minutes} min · saved, will sync
            </span>
          </div>
        </div>
      ))}
      <ConfirmDialog
        open={discarding !== null}
        onClose={() => setDiscarding(null)}
        title="Discard this device's copy?"
        confirmLabel="Discard this copy"
        busy={busy}
        onConfirm={() => {
          if (discarding) void discard(discarding);
        }}
      >
        This session was saved on another device. What this device kept of it won't be saved.
      </ConfirmDialog>
    </section>
  );
}
