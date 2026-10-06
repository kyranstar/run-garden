/**
 * TODAY'S PROGRAM SESSION ON THE TODAY CARD (Phase 2a Task 6; mocks §1).
 *
 * The one Today card keeps its shape. When the day holds a run, the run keeps the title and its actions and each
 * program session is one line beside it — dot, name, mode · minutes · time, and its own action. On a program day
 * the program session takes the title, with what was built for it in one line. Start and Continue belong to the
 * player (`features.player`); until it exists, Open leads to the session sheet.
 */
import { Link } from "react-router-dom";
import type { TodayResponse, WorkoutDto } from "@rg/api-client";
import type { SessionLead } from "@rg/domain";
import { CategoryDot, formatMinutes, formatTime } from "../components.js";
import { features } from "../features.js";

export type TodaySession = TodayResponse["todaySessions"][number];

export type TodayCardTitle = { kind: "run"; workout: WorkoutDto } | { kind: "program"; session: TodaySession };

export interface TodayCardLayout {
  /** What the card is titled by; null = nothing to show. */
  title: TodayCardTitle | null;
  /** The program sessions shown as lines under the title. */
  lines: TodaySession[];
}

/** The app's own sessions — program slots and on-demand sessions — as opposed to a plan's runs. */
export function isAppSession(w: WorkoutDto): boolean {
  return w.origin === "program" || w.origin === "on_demand";
}

export const MODE_LABEL: Record<"recovery" | "consistent" | "build", string> = {
  recovery: "Recovery",
  consistent: "Consistent",
  build: "Build",
};

/**
 * Which session the card is titled by. A run still to do today keeps the title, whatever time the program session
 * is; without one, today's first program session takes it; with neither, the next workout does, as before.
 */
export function todayCardLayout(next: WorkoutDto | null, sessions: readonly TodaySession[]): TodayCardLayout {
  const app = sessions.filter((s) => isAppSession(s.workout));
  // No app session today: exactly the card as before, titled by the next workout (two runs at the same minute would
  // otherwise tie-break differently from `nextWorkout`; audit 2a-UI M12).
  if (app.length === 0) return { title: next ? { kind: "run", workout: next } : null, lines: [] };
  const run = sessions.find(
    (s) => !isAppSession(s.workout) && s.workout.category !== "rest" && s.workout.completionState === "scheduled",
  );
  if (run) return { title: { kind: "run", workout: run.workout }, lines: app };
  if (app.length > 0) return { title: { kind: "program", session: app[0]! }, lines: app.slice(1) };
  return { title: next ? { kind: "run", workout: next } : null, lines: [] };
}

/** The program's name: the row's title without the theme a build appends (" · Hips & posture"). */
export function programName(session: TodaySession): string {
  const title = session.workout.title;
  const theme = session.build?.theme;
  const suffix = theme ? ` · ${theme}` : null;
  return suffix && title.endsWith(suffix) ? title.slice(0, -suffix.length) : title;
}

export function sessionDone(w: WorkoutDto): boolean {
  return w.contentState === "done" || w.completionState === "completed";
}

/** The workout sheet for this session (the session sheet, for an app session). */
export const sheetHref = (w: WorkoutDto) => `/plan?workout=${encodeURIComponent(w.id)}`;
/** The player (Phase 2b). */
export const playerHref = (w: WorkoutDto) => `/session/${encodeURIComponent(w.id)}`;

/** The player's way in for this session today, or null (no player yet, not today, or nothing left to play). */
function playAction(w: WorkoutDto, today: string): "Start" | "Continue" | null {
  if (!features.player || w.effectiveDate !== today || sessionDone(w)) return null;
  return w.contentState === "started" ? "Continue" : "Start";
}

/** "Goblet squat 3 × 6 @ 30 lb ↑ · KB deadlift 3 × 8 · 12 more" */
export function LeadLine({ lead }: { lead: SessionLead }) {
  return (
    <>
      {lead.moves.map((m, i) => (
        <span key={`${i}-${m.name}`}>
          {i > 0 ? " · " : ""}
          {m.name} {m.dose}
          {m.up ? (
            <>
              {" "}
              <span className="dose-up" title="Goes up today">
                ↑
              </span>
            </>
          ) : null}
        </span>
      ))}
      {lead.more > 0 ? ` · ${lead.more} more` : ""}
    </>
  );
}

/** The program session as the card's title: a program day. */
export function TodayProgramLead({ session, today }: { session: TodaySession; today: string }) {
  const w = session.workout;
  const b = session.build;
  const play = playAction(w, today);
  const done = sessionDone(w);
  return (
    <>
      <h3 className="today-title">{programName(session)}</h3>
      <p className="today-meta">
        {b
          ? [MODE_LABEL[b.mode], b.theme, `${b.minutes} min`, b.place].filter(Boolean).join(" · ")
          : `${formatTime(w.effectiveTime)} · ${formatMinutes(w.workoutSeconds)}`}
      </p>
      {b?.lead && b.lead.moves.length > 0 ? (
        <div className="today-structure">
          <LeadLine lead={b.lead} />
        </div>
      ) : null}
      <div className="btn-row today-actions">
        {done ? <span className="today-session-done">Done</span> : null}
        {play ? (
          <Link className="btn btn-primary today-play" to={playerHref(w)}>
            {play}
          </Link>
        ) : null}
        <Link className={`btn${play || done ? "" : " btn-primary"}`} to={sheetHref(w)}>
          Open
        </Link>
      </div>
    </>
  );
}

/** A program session as one line under the day's run. */
export function TodayProgramLine({ session, today }: { session: TodaySession; today: string }) {
  const w = session.workout;
  const b = session.build;
  const play = playAction(w, today);
  const time = formatTime(w.effectiveTime);
  const meta = b ? `${MODE_LABEL[b.mode]} · ${b.minutes} min · ${time}` : `${formatMinutes(w.workoutSeconds)} · ${time}`;
  return (
    <div className="today-session">
      <CategoryDot category={w.category} />
      <div className="today-session-text">
        <span className="today-session-name">{programName(session)}</span>
        <span className="today-session-meta">{meta}</span>
      </div>
      {sessionDone(w) ? (
        <span className="today-session-done">Done</span>
      ) : play ? (
        <Link className="btn btn-small btn-primary" to={playerHref(w)}>
          {play}
        </Link>
      ) : (
        <Link className="btn btn-small" to={sheetHref(w)}>
          Open
        </Link>
      )}
    </div>
  );
}

/** The day's program sessions under its run. */
export function TodayProgramLines({ sessions, today }: { sessions: readonly TodaySession[]; today: string }) {
  if (sessions.length === 0) return null;
  return (
    <div className="today-sessions">
      {sessions.map((s) => (
        <TodayProgramLine key={s.workout.id} session={s} today={today} />
      ))}
    </div>
  );
}
