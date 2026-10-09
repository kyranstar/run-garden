/**
 * TODAY'S PROGRAM SESSION ON THE TODAY CARD (Phase 2a Task 6; mocks §1).
 *
 * The one Today card keeps its shape. When the day holds a run, the run keeps the title and its actions and each
 * program session is one line beside it — dot, name, mode · minutes · time, and its own action. On a program day
 * the program session takes the title, with what was built for it in one line. Start and Continue belong to the
 * player (`features.player`); until it exists, Open leads to the session sheet. Start opens the sheet (its pre-check,
 * a fresh build and the Start that locks it, online — ruling 2b-R1); Continue opens the player.
 *
 * AFTER A WATCH SESSION (Phase 3 Task 10; approved mocks §3): a session the watch did whose quick review is offered
 * (`today.watchReviews`, today's and yesterday's) offers "Log your session" — beside Done when it heads the card, in
 * place of Done on its line, and on a line of its own the next morning — which opens the review's sheet. Saved here
 * and waiting for the server, it says so instead.
 */
import { useState } from "react";
import { createPortal } from "react-dom";
import { Link } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import type { TodayResponse, WorkoutDto } from "@rg/api-client";
import { addDays, type SessionLead } from "@rg/domain";
import { CategoryDot, formatDayShort, formatMinutes, formatTime } from "../components.js";
import { features } from "../features.js";
import { IconWatch } from "../icons.js";
import { chimes } from "../player/audio.js";
import { offlineDb } from "../offline/idb.js";
import { outboxEntries } from "../offline/outbox.js";
import { useSignedInUserId } from "./outbox-sync.js";
import { WatchReviewSheet } from "./watch-review-sheet.js";

export type TodaySession = TodayResponse["todaySessions"][number];
/** A session the watch did whose quick review is offered (Phase 3). */
export type WatchReviewOffer = NonNullable<TodayResponse["watchReviews"]>[number];

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

/** A skipped session is not today's to-do: it says "Skipped" and offers nothing to play (ruling 2a-R15). */
export function sessionSkipped(w: WorkoutDto): boolean {
  return w.completionState === "skipped";
}

/**
 * Which session the card is titled by. A run still to do today keeps the title, whatever time the program session
 * is; without one, today's first program session that is not skipped takes it (the first one, as skipped, when every
 * one is); with neither, the next workout does, as before.
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
  const lead = app.find((s) => !sessionSkipped(s.workout)) ?? app[0]!;
  return { title: { kind: "program", session: lead }, lines: app.filter((s) => s !== lead) };
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

/**
 * Where each way in goes. Start opens the session's sheet: the pre-check, a fresh build and the Start that locks it all
 * happen there, online (ruling 2b-R1). Continue opens the player, which plays what Start left on the device.
 */
const playHref = (w: WorkoutDto, play: "Start" | "Continue") => (play === "Start" ? sheetHref(w) : playerHref(w));
/** Continue is a tap: audio unlocks inside it (the player's chimes). */
const unlockAudio = () => chimes.unlock();

/**
 * A started session stays playable while its save would be taken (ruling 2b-R16, after 2b-R7): on its day and the day
 * after — an evening session left at midnight is not lost to the new day.
 */
export function continuable(date: string, today: string): boolean {
  return date === today || date === addDays(today, -1);
}

/** The player's way in for this session, or null (no player yet, not its day, skipped, or nothing left to play). */
function playAction(w: WorkoutDto, today: string): "Start" | "Continue" | null {
  if (!features.player || w.completionState !== "scheduled" || sessionDone(w)) return null;
  if (w.contentState === "started") return continuable(w.effectiveDate, today) ? "Continue" : null;
  return w.effectiveDate === today ? "Start" : null;
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

/** A session saved on this device and waiting for the server: how long it ran. */
export interface PendingSave {
  minutes: number;
}

/**
 * The sessions saved on this device that the server has not taken yet, by slot (`["outbox"]`). Read only while the
 * day has an app session (`enabled`): an account with no program never opens the outbox here.
 */
export function usePendingSaves(enabled: boolean): Readonly<Record<string, PendingSave>> {
  const userId = useSignedInUserId();
  const outbox = useQuery({ queryKey: ["outbox"], queryFn: async () => outboxEntries(await offlineDb()), enabled, retry: false });
  const out: Record<string, PendingSave> = {};
  for (const e of outbox.data ?? []) {
    // The signed-in account's own (ruling 2b-R6); while it is not known (offline launch), this device's.
    if (userId && e.userId !== userId) continue;
    if (e.state === "pending" && e.payload.workoutId) out[e.payload.workoutId] = { minutes: Math.max(1, Math.round(e.payload.seconds / 60)) };
  }
  return out;
}

/**
 * The quick reviews this device saved that the server refused because the slot was saved first (409 `slot_done`: the
 * outbox's conflict, in Settings → Data), by slot. Today offers "Log your session" for none of them, whatever its last
 * answer said (audit 3-B UI-5) — the offer would open a review the server no longer has. Same read as `usePendingSaves`.
 */
export function useRefusedReviews(enabled: boolean): ReadonlySet<string> {
  const userId = useSignedInUserId();
  const outbox = useQuery({ queryKey: ["outbox"], queryFn: async () => outboxEntries(await offlineDb()), enabled, retry: false });
  const out = new Set<string>();
  for (const e of outbox.data ?? []) {
    if (userId && e.userId !== userId) continue;
    if (e.state === "conflict" && e.payload.source === "watch_review" && e.payload.workoutId) out.add(e.payload.workoutId);
  }
  return out;
}

/** "Log your session": opens the quick review's sheet (a sheet, not the full-screen review — owner call 11). */
export function LogYourSession({ offer, small = false }: { offer: WatchReviewOffer; small?: boolean }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button type="button" className={`btn btn-primary${small ? " btn-small" : ""}`} onClick={() => setOpen(true)}>
        Log your session
      </button>
      {/* Into the page's body: the card it is tapped on is the garden dock's panel from lg, whose box would hold a
          fixed sheet inside it. */}
      {open
        ? createPortal(
            <WatchReviewSheet workoutId={offer.workoutId} title={offer.title} onClose={() => setOpen(false)} onSaved={() => setOpen(false)} />,
            document.body,
          )
        : null}
    </>
  );
}

/** A sent session on the watch (Phase 3; approved mocks §2 "Today · a sent session"). */
function OnYourWatch() {
  return (
    <span className="today-on-watch">
      <IconWatch size={16} />
      On your watch
    </span>
  );
}

/** The program session as the card's title: a program day. */
export function TodayProgramLead({
  session,
  today,
  pending = null,
  offer = null,
}: {
  session: TodaySession;
  today: string;
  pending?: PendingSave | null;
  /** Its quick review, when offered (Phase 3). */
  offer?: WatchReviewOffer | null;
}) {
  const w = session.workout;
  const b = session.build;
  // Saved here and waiting for the server: done, as far as the athlete is concerned.
  const play = pending ? null : playAction(w, today);
  const done = !!pending || sessionDone(w);
  const skipped = !done && sessionSkipped(w);
  return (
    <>
      <h3 className="today-title">{programName(session)}</h3>
      <p className="today-meta">
        {pending
          ? `Done · ${pending.minutes} min · saved, will sync`
          : b
            ? [MODE_LABEL[b.mode], b.theme, `${b.minutes} min`, b.place].filter(Boolean).join(" · ")
            : `${formatTime(w.effectiveTime)} · ${formatMinutes(w.workoutSeconds)}`}
      </p>
      {!pending && b?.lead && b.lead.moves.length > 0 ? (
        <div className="today-structure">
          <LeadLine lead={b.lead} />
        </div>
      ) : null}
      <div className="btn-row today-actions">
        {done && !pending ? <span className="today-session-done">Done</span> : null}
        {skipped ? <span className="today-session-skipped">Skipped</span> : null}
        {offer && !pending ? <LogYourSession offer={offer} /> : null}
        {play ? (
          <Link className="btn btn-primary today-play" to={playHref(w, play)} onClick={play === "Continue" ? unlockAudio : undefined}>
            {play}
          </Link>
        ) : null}
        {!done && !skipped && session.onWatch ? <OnYourWatch /> : null}
        {/* Start already opens the sheet. */}
        {play === "Start" ? null : (
          <Link className={`btn${play || done || skipped ? "" : " btn-primary"}`} to={sheetHref(w)}>
            Open
          </Link>
        )}
      </div>
    </>
  );
}

/** A program session as one line under the day's run. */
export function TodayProgramLine({
  session,
  today,
  pending = null,
  offer = null,
}: {
  session: TodaySession;
  today: string;
  pending?: PendingSave | null;
  offer?: WatchReviewOffer | null;
}) {
  const w = session.workout;
  const b = session.build;
  const play = pending ? null : playAction(w, today);
  const time = formatTime(w.effectiveTime);
  const meta = b ? `${MODE_LABEL[b.mode]} · ${b.minutes} min · ${time}` : `${formatMinutes(w.workoutSeconds)} · ${time}`;
  return (
    <div className="today-session">
      <CategoryDot category={w.category} />
      <div className="today-session-text">
        <span className="today-session-name">{programName(session)}</span>
        <span className="today-session-meta">{meta}</span>
        {!pending && !sessionDone(w) && !sessionSkipped(w) && session.onWatch ? <OnYourWatch /> : null}
      </div>
      {pending ? (
        <span className="today-session-done">Done · will sync</span>
      ) : offer ? (
        <LogYourSession offer={offer} small />
      ) : sessionDone(w) ? (
        <span className="today-session-done">Done</span>
      ) : sessionSkipped(w) ? (
        // Skipped is not today's to-do, but Un-skip is one tap down (2a UI re-review U6).
        <span className="today-session-end">
          <span className="today-session-skipped">Skipped</span>
          <Link className="btn btn-small" to={sheetHref(w)}>
            Open
          </Link>
        </span>
      ) : play ? (
        <Link className="btn btn-small btn-primary" to={playHref(w, play)} onClick={play === "Continue" ? unlockAudio : undefined}>
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

/** Yesterday's session the watch did, the next morning: its program, the day and how long it ran, and Log your session. */
function WatchReviewLine({ offer, today, pending }: { offer: WatchReviewOffer; today: string; pending: PendingSave | null }) {
  const day = offer.date === today ? "Today" : offer.date === addDays(today, -1) ? "Yesterday" : formatDayShort(offer.date);
  return (
    <div className="today-session">
      <CategoryDot category={offer.category} />
      <div className="today-session-text">
        <span className="today-session-name">{offer.title}</span>
        <span className="today-session-meta">
          {day} · {Math.max(1, Math.round(offer.seconds / 60))} min
        </span>
      </div>
      {pending ? <span className="today-session-done">Done · will sync</span> : <LogYourSession offer={offer} small />}
    </div>
  );
}

/** The day's program sessions under its run — and a session of yesterday's the watch did, whose review is offered. */
export function TodayProgramLines({
  sessions,
  today,
  pending = {},
  offers = [],
  leadId = null,
}: {
  sessions: readonly TodaySession[];
  today: string;
  pending?: Readonly<Record<string, PendingSave>>;
  /** The quick reviews offered (Phase 3): each on its session's line, or a line of its own. */
  offers?: readonly WatchReviewOffer[];
  /** The session heading the card: its review is offered there, not here. */
  leadId?: string | null;
}) {
  const offerOf = (id: string) => offers.find((o) => o.workoutId === id) ?? null;
  const own = offers.filter((o) => o.workoutId !== leadId && !sessions.some((s) => s.workout.id === o.workoutId));
  if (sessions.length === 0 && own.length === 0) return null;
  return (
    <div className="today-sessions">
      {sessions.map((s) => (
        <TodayProgramLine key={s.workout.id} session={s} today={today} pending={pending[s.workout.id] ?? null} offer={offerOf(s.workout.id)} />
      ))}
      {own.map((o) => (
        <WatchReviewLine key={o.workoutId} offer={o} today={today} pending={pending[o.workoutId] ?? null} />
      ))}
    </div>
  );
}
