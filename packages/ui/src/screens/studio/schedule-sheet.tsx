/**
 * SCHEDULE (Stage 2 spec §8: "a date (default today) and an optional time — Later today picks the next sensible slot
 * after now"; §10 `POST /api/workouts`).
 *
 *   Schedule                                                  ✕
 *   ◉ Later today                                [ 4:00 PM ]
 *   ○ Another day                  [ Oct 13 ]   [ --:-- ]
 *   ─────────────────────────────────────────────────────────
 *                                                 [ Schedule ]
 *
 * "Later today" is the athlete's usual time to train while it is still ahead, else the next whole hour and one more,
 * and the sheet says which; it is not offered once the day is out of hours. Another day's time is optional — left
 * empty, the server places it at the athlete's usual window. The workout is judged for the day chosen: an error that
 * day keeps Schedule off and says why; today, one a check could answer asks for the check instead.
 */
import { useId, useState, type ReactNode } from "react";
import { addDays } from "@rg/domain";
import { formatTime, Sheet } from "../../components.js";
import type { Judged } from "./build-model.js";

export interface ScheduleSheetProps {
  today: string;
  /** "Later today"'s slot, "HH:MM"; null once the day is out of hours. */
  later: string | null;
  /** The workout judged for a day. */
  judgeFor: (date: string) => Judged;
  checkLabel: (profileId: string) => string;
  onCheck: (profileId: string) => void;
  /** Schedule it; resolves with why it did not happen, or null. */
  onSchedule: (date: string, time: string | null) => Promise<string | null>;
  onClose: () => void;
}

export function ScheduleSheet({ today, later, judgeFor, checkLabel, onCheck, onSchedule, onClose }: ScheduleSheetProps) {
  const name = useId();
  const tomorrow = addDays(today, 1);
  const [choice, setChoice] = useState<"later" | "day">(later ? "later" : "day");
  const [laterTime, setLaterTime] = useState(later ?? "");
  const [date, setDate] = useState(tomorrow);
  const [dayTime, setDayTime] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const when = choice === "later" ? { date: today, time: laterTime || null } : { date: date || tomorrow, time: dayTime || null };
  const judged = judgeFor(when.date);
  const valid = choice === "later" ? /^\d{2}:\d{2}$/.test(laterTime) : /^\d{4}-\d{2}-\d{2}$/.test(date) && date >= today;
  const asking = when.date === today ? judged.checks : [];
  const disabled = busy || !valid || !!judged.blocked || asking.length > 0;

  const go = async () => {
    if (disabled) return;
    setBusy(true);
    setError(null);
    const why = await onSchedule(when.date, when.time);
    setBusy(false);
    if (why) setError(why);
  };

  const option = (k: "later" | "day", text: string, extra: ReactNode) => (
    <div className={`stu-add-opt${choice === k ? " stu-add-opt--on" : ""}`}>
      <label className="stu-add-choice">
        <input type="radio" name={name} value={k} checked={choice === k} onChange={() => setChoice(k)} />
        <span>{text}</span>
      </label>
      {extra}
    </div>
  );

  return (
    <Sheet
      open
      onClose={onClose}
      title="Schedule"
      footer={
        <div className="btn-row stu-sched-actions">
          <button type="button" className="btn btn-primary" disabled={disabled} onClick={() => void go()}>
            {busy ? "Scheduling…" : "Schedule"}
          </button>
        </div>
      }
    >
      <fieldset className="stu-add-targets">
        <legend className="visually-hidden">When</legend>
        {later
          ? option(
              "later",
              "Later today",
              <input
                type="time"
                className="stu-add-select stu-sched-input"
                aria-label="Time today"
                value={laterTime}
                onChange={(e) => {
                  setLaterTime(e.target.value);
                  setChoice("later");
                }}
              />,
            )
          : null}
        {option(
          "day",
          "Another day",
          <span className="stu-sched-day">
            <input
              type="date"
              className="stu-add-select stu-sched-input"
              aria-label="Day"
              min={today}
              value={date}
              onChange={(e) => {
                setDate(e.target.value);
                setChoice("day");
              }}
            />
            <input
              type="time"
              className="stu-add-select stu-sched-input"
              aria-label="Time (optional)"
              value={dayTime}
              onChange={(e) => {
                setDayTime(e.target.value);
                setChoice("day");
              }}
            />
          </span>,
        )}
      </fieldset>
      {choice === "later" && laterTime ? <p className="stu-sched-when">{`Today at ${formatTime(laterTime)}`}</p> : null}
      {asking.length ? (
        <div className="stu-sched-check">
          <p className="stu-build-why">{judged.notes.find((n) => n.check)?.message}</p>
          {asking.map((p) => (
            <button key={p} type="button" className="btn btn-small" onClick={() => onCheck(p)}>
              {checkLabel(p)}
            </button>
          ))}
        </div>
      ) : judged.blocked ? (
        <p className="stu-build-why" role="status">
          {judged.blocked}
        </p>
      ) : null}
      {error ? (
        <p className="stu-build-error" role="alert">
          {error}
        </p>
      ) : null}
    </Sheet>
  );
}
