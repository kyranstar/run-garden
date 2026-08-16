import { useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api, type WorkoutDto } from "@rg/api-client";
import {
  Banner,
  formatDayShort,
  formatTime,
  Sheet,
  Spinner,
  useRevealInView,
} from "../components.js";

/**
 * The rescheduling transaction: at most three recommendations with one short
 * explanation each, plus "choose another time" and "skip". Approving a move
 * updates Run Garden + Calendar immediately and queues the COROS write —
 * status is shown, the UI never blocks on the Mac.
 */
export function MoveSheet({
  workout,
  open,
  onClose,
}: {
  workout: WorkoutDto;
  open: boolean;
  onClose: () => void;
}) {
  const qc = useQueryClient();
  const [custom, setCustom] = useState(false);
  const [customDate, setCustomDate] = useState(workout.effectiveDate);
  const [customTime, setCustomTime] = useState(workout.effectiveTime);
  const [result, setResult] = useState<string | null>(null);
  /* 207px of date and time fields inside a frozen frame: the sheet correctly
     refused to move, and the fields opened with their bottom 87.3px past the
     body's fold at 390 (86.7 at 1440) — the reader pressed a button and, as
     far as the screen was concerned, nothing happened. Growth a reader asked
     for has to be brought to the reader (System 4 R2). */
  const customRef = useRef<HTMLDivElement>(null);
  useRevealInView(custom, customRef);

  const candidates = useQuery({
    queryKey: ["candidates", workout.id],
    queryFn: () => api.candidates(workout.id),
    enabled: open,
    staleTime: 30_000,
  });
  // Move-time never-paired prompt (sync-transparency Task 12): when the
  // account-wide sync state is `not_synced`, a move here only ever touches
  // the app calendar — set expectations before the user picks a time.
  const syncStatus = useQuery({
    queryKey: ["sync-status"],
    queryFn: api.syncStatus,
    enabled: open,
  });

  const move = useMutation({
    mutationFn: ({ date, time }: { date: string; time: string }) => api.move(workout.id, date, time),
    onSuccess: (res, vars) => {
      const stateText =
        res.corosSyncState === "synced"
          ? "COROS synced"
          : res.corosSyncState === "syncing"
            ? "Syncing to COROS"
            : res.corosSyncState === "waiting_for_device"
              ? "Waiting for COROS — connect in Settings"
              : res.corosSyncState === "calendar_only"
                ? "In Calendar (watch not auto-updated)"
                : "COROS needs attention";
      setResult(`Moved to ${formatDayShort(vars.date)} · ${stateText}`);
      void qc.invalidateQueries({ queryKey: ["today"] });
      void qc.invalidateQueries({ queryKey: ["plan"] });
    },
  });

  const skip = useMutation({
    mutationFn: () => api.skip(workout.id),
    onSuccess: () => {
      setResult("Workout skipped — later workouts stay where they are.");
      void qc.invalidateQueries({ queryKey: ["today"] });
      void qc.invalidateQueries({ queryKey: ["plan"] });
    },
  });

  const close = () => {
    setResult(null);
    setCustom(false);
    onClose();
  };

  return (
    <Sheet open={open} onClose={close} title={`Move “${workout.title}”`}>
      {!result && syncStatus.data?.state === "not_synced" ? (
        <Banner kind="info">
          {syncStatus.data.registered
            ? "This will only change the app calendar — COROS updates are off."
            : "This will only change the app calendar — connect COROS in Settings to update your watch."}
        </Banner>
      ) : null}
      {result ? (
        <div className="stack">
          <Banner kind="info">{result}</Banner>
          <button className="btn btn-primary" onClick={close}>
            Done
          </button>
        </div>
      ) : candidates.isLoading ? (
        <Spinner label="Finding good times" />
      ) : candidates.data?.blockedReason ? (
        <Banner kind="warn">{candidates.data.blockedReason}</Banner>
      ) : (
        <div className="stack">
          {candidates.data?.busyChecked === false ? (
            <Banner kind="info">
              Couldn't check your Google Calendar just now — these times avoid your other workouts,
              but meetings weren't visible. Reconnect Google in Settings for conflict-aware
              suggestions.
            </Banner>
          ) : null}
          {(candidates.data?.candidates ?? []).map((cand) => (
            <button
              key={`${cand.date}-${cand.time}`}
              className="workout-row"
              disabled={move.isPending}
              onClick={() => move.mutate({ date: cand.date, time: cand.time })}
            >
              <div className="body">
                <div className="title">
                  {formatDayShort(cand.date)} at {formatTime(cand.time)}
                </div>
                <div className="meta">{cand.explanation}</div>
                {cand.warnings.length > 0 ? (
                  <div className="faint">{cand.warnings[0]}</div>
                ) : null}
              </div>
            </button>
          ))}
          {candidates.data && candidates.data.candidates.length === 0 ? (
            <p className="muted">No nearby open slots — pick a time yourself below.</p>
          ) : null}

          {/* A real toggle, and the fields come after it (System 4 D6). The
              button used to be REPLACED by the date/time fields: +164px inside
              the sheet, with the control that opened them gone from the DOM
              and nothing anywhere to shut them again. Same shape as Settings'
              "Show diagnostics", one screen over. */}
          <button
            className="btn"
            aria-expanded={custom}
            aria-controls="mv-custom"
            onClick={() => setCustom((v) => !v)}
          >
            Choose another time
          </button>
          <div id="mv-custom" className="disclosure-body">
            {custom ? (
              <div ref={customRef}>
                <div className="field">
                  <label htmlFor="mv-date">Date</label>
                  <input
                    id="mv-date"
                    type="date"
                    value={customDate}
                    onChange={(e) => setCustomDate(e.target.value)}
                  />
                </div>
                <div className="field">
                  <label htmlFor="mv-time">Start time</label>
                  <input
                    id="mv-time"
                    type="time"
                    value={customTime}
                    onChange={(e) => setCustomTime(e.target.value)}
                  />
                </div>
                <button
                  className="btn btn-primary"
                  disabled={move.isPending}
                  onClick={() => move.mutate({ date: customDate, time: customTime })}
                >
                  Move here
                </button>
              </div>
            ) : null}
          </div>

          <hr className="divider" />
          <button className="btn" disabled={skip.isPending} onClick={() => skip.mutate()}>
            Skip workout
          </button>
          <p className="faint">{candidates.data?.skipOption.explanation}</p>
          {move.isError ? <Banner kind="warn">The move failed — please try again.</Banner> : null}
        </div>
      )}
    </Sheet>
  );
}
