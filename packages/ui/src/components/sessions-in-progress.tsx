/**
 * A SESSION LEFT IN PROGRESS STAYS REACHABLE (audit 2b-B C-1; ruling 2b-R16). Today's card lists the program's sessions
 * of today only. A session started in the evening and left — ✕ → Leave, the app killed, a flat battery — holds its
 * sets, and maybe its review, in IndexedDB; after midnight nothing on Today led back to it. Today now shows
 * "Session in progress" for each session in progress the device holds for the signed-in account, with Continue; the
 * day's own sessions keep their Continue on the card and are not listed twice.
 *
 * Read from the device only (`live`, and the name Start kept beside the build): for an account with no program there is
 * never a session in progress, and nothing renders.
 */
import { Link } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { formatDayShort } from "../components.js";
import { loadBuild } from "../offline/builds.js";
import { offlineDb, type OfflineDb } from "../offline/idb.js";
import { liveSessions } from "../offline/live.js";
import { chimes } from "../player/audio.js";
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

export function SessionsInProgress({
  today,
  shown,
  userId,
  db = offlineDb,
}: {
  today: string;
  /** The sessions the Today card already shows, with their own Continue. */
  shown: readonly string[];
  /** The signed-in account; nothing is shown before it is known. */
  userId: string | null;
  db?: () => Promise<OfflineDb>;
}) {
  const q = useQuery({
    queryKey: ["live-sessions", userId],
    queryFn: async () => sessionsInProgress(await db(), userId!),
    enabled: !!userId,
    retry: false,
    staleTime: 0,
  });
  const items = (q.data ?? []).filter((s) => !shown.includes(s.workoutId));
  if (items.length === 0) return null;
  return (
    <section className="dock-panel today-inprogress" aria-label="Session in progress">
      {items.map((s) => (
        <div key={s.workoutId} className="today-inprogress-row">
          <div className="today-session-text">
            <span className="today-session-name">Session in progress · {s.title}</span>
            <span className="today-session-meta">
              {[s.date ? (s.date === today ? "Today" : formatDayShort(s.date)) : null, s.step === null ? "ready to save" : `step ${s.step} of ${s.steps}`]
                .filter(Boolean)
                .join(" · ")}
            </span>
          </div>
          <Link className="btn btn-primary" to={`/session/${encodeURIComponent(s.workoutId)}`} onClick={() => chimes.unlock()}>
            Continue
          </Link>
        </div>
      ))}
    </section>
  );
}
