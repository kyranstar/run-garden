/**
 * THE COACH NOTICES (stream H, 2026-10-19): the opening screen's own line, when the coach has something to say before
 * the athlete does — free, from what the app already has, never a model call.
 *
 *   On Monday   the weekly review the Monday cron already paid for (its first sentence), with "Plan this week";
 *   After a     a session finished today or yesterday — in the app, or a watch activity — said plainly in the athlete's
 *   session     units: "Saturday's long run is in — 16 km at 5:40 /km, mostly easy." / "Today's strength session is
 *               done — 42 min, all 18 sets in." Or, when the coach's ambient read of it is already paid for (coach-reads,
 *               Growth's feed shows it), its glance: "Saturday's long run: HR drifted late — fueling, not fitness." With
 *               "Plan tomorrow around it" (or today, for yesterday's); the screen adds "Log how it felt" when the app has
 *               a place to record it (the quick review after a watch session).
 *
 * This module only words them (pure); which one, and when, is the opening read's (coach-nudges.ts `readCoachOpening`).
 * Every text here is the app's; a review's sentence and a read's glance were written by a model for the athlete to read
 * and are shown as text.
 */
import { addDays, formatDurationShort, type LocalDate } from "@rg/domain";
import { FIT_SAVES_REQUEST } from "@rg/saves";
import { clipProse } from "./design-prose.js";
import { paceWords } from "./design-tools/read-common.js";

/** A chip: its words, and what a tap sends as the athlete's (the "needs you" chips' shape). */
export interface OpeningChip {
  id: string;
  label: string;
  request: string;
  /** A chip that only navigates (its `request` is empty and starts nothing). */
  href?: string;
  /** A chip that saves this batch of the athlete's saves first, then sends its `request`. */
  saveBatchId?: string;
}

/** The opening's own line: what the coach noticed, before the athlete says anything. */
export interface CoachOpeningLine {
  /** Stable while it holds: `review:<weekStart>` or `session:<activityId>`. The screen keeps the ones it has shown. */
  id: string;
  /** One line, the coach's. */
  line: string;
  /** `review`: the weekly review's; `session`: the app's own words about a session; `read`: the coach's read of it;
   * `saves`: a released batch of the athlete's saves. */
  source: "review" | "session" | "read" | "saves";
  /** What a tap sends (first among the chips). */
  chips: OpeningChip[];
  /** The planned session the finished one completed: the screen finds its quick review by it. */
  workoutId?: string;
  /** The review's whole text, its week (a review's): "Read it all" opens it from the opening — never the activity feed,
   * which may hold none of that week. */
  review?: { weekStart: LocalDate; narrative: string };
}

/** A session the athlete finished, as the opening reads it (an activity row, its plan session, what was logged). */
export interface FinishedSession {
  activityId: string;
  /** Its local day. */
  date: LocalDate;
  sport: string;
  seconds: number;
  meters: number | null;
  paceSecPerKm: number | null;
  /** The watch's time in each heart-rate zone, zone 1 first. */
  hrZones: ReadonlyArray<{ seconds: number }> | null;
  /** Its noun ("long run", "tempo", "strength session"). */
  noun: string;
  workoutId: string | null;
  /** The sets logged against it: done, all, and whether the session was played to its end. */
  sets: { done: number; total: number; completed: boolean } | null;
  /** The coach's ambient read of it, paid for already: its glance. */
  glance: string | null;
}

/** The review's sentence, at most. */
export const REVIEW_LINE_MAX = 220;
/** A believable running pace, s/km (a broken record says nothing). */
const PACE_MIN = 120;
const PACE_MAX = 1200;
/** No band with more than half of the time in zone. */
export const MIXED_EFFORT = "a mix of easy and harder running";

const METERS_PER_MILE = 1609.344;

/** A local date's weekday, the same in every zone. */
function weekdayOf(date: LocalDate): string {
  return new Date(`${date}T12:00:00Z`).toLocaleDateString("en-US", { weekday: "long", timeZone: "UTC" });
}

/** "Today's" / "Saturday's" — a sentence's first word. */
const dayHead = (date: LocalDate, today: LocalDate): string => (date === today ? "Today's" : `${weekdayOf(date)}'s`);

/** "16 km", "10.4 km", "6.2 mi": a tenth, a whole number said whole. */
export function distanceIn(meters: number, units: "km" | "mi"): string {
  const v = Math.round((meters / (units === "mi" ? METERS_PER_MILE : 1000)) * 10) / 10;
  return `${v} ${units}`;
}

/**
 * How hard it was, by the watch's own time in zone: "mostly" only for a band with more than half of the time — easy
 * (zones 1–2), steady (zone 3), hard (zones 4–5) — else a mix. Null with no time in zone (nothing to say).
 */
export function effortWords(zones: ReadonlyArray<{ seconds: number }> | null | undefined): string | null {
  const z = zones ?? [];
  const at = (i: number) => Math.max(0, z[i]?.seconds ?? 0);
  const total = z.reduce((s, _, i) => s + at(i), 0);
  if (total <= 0) return null;
  const most = (seconds: number) => seconds * 2 > total;
  if (most(at(0) + at(1))) return "mostly easy";
  if (most(at(2))) return "mostly steady";
  if (most(at(3) + at(4))) return "mostly hard";
  return MIXED_EFFORT;
}

/** What it was, in figures: "16 km at 5:40 /km, mostly easy" for a run; "42 min, all 18 sets in" for a session. */
export function sessionFacts(s: FinishedSession, units: "km" | "mi"): string {
  const time = formatDurationShort(s.seconds);
  if (s.sport === "run") {
    if (!(s.meters && s.meters >= 100)) return [time, effortWords(s.hrZones)].filter(Boolean).join(", ");
    const pace = s.paceSecPerKm && s.paceSecPerKm > 0 ? s.paceSecPerKm : s.seconds / (s.meters / 1000);
    const at = pace >= PACE_MIN && pace <= PACE_MAX ? ` at ${paceWords(pace, units)}` : "";
    return [`${distanceIn(s.meters, units)}${at}`, effortWords(s.hrZones)].filter(Boolean).join(", ");
  }
  const sets = s.sets;
  const logged =
    !sets || sets.done <= 0
      ? null
      : sets.completed && sets.done >= sets.total
        ? `all ${sets.done} sets in`
        : sets.total > sets.done
          ? `${sets.done} of ${sets.total} sets`
          : `${sets.done} sets`;
  const distance = s.sport !== "strength" && s.sport !== "yoga" && s.meters && s.meters >= 100 ? distanceIn(s.meters, units) : null;
  return [distance, time, logged].filter(Boolean).join(", ");
}

/** A line ends as a sentence does. */
const asSentence = (t: string): string => (/[.!?…]$/.test(t) ? t : `${t}.`);

/** The opening after a session (`today` the athlete's): its line, and the chip that plans around it. */
export function sessionOpening(s: FinishedSession, today: LocalDate, units: "km" | "mi"): CoachOpeningLine {
  const facts = sessionFacts(s, units);
  const head = `${dayHead(s.date, today)} ${s.noun}`;
  const glance = s.glance?.trim();
  const line = glance ? asSentence(`${head}: ${glance}`) : `${head} ${s.sport === "run" ? "is in" : "is done"} — ${facts}.`;
  const when = s.date === today ? "tomorrow" : "today";
  const label = `Plan ${when} around it`;
  const subject = `${s.date === today ? "today's" : `${weekdayOf(s.date)}'s`} ${s.noun}`;
  return {
    id: `session:${s.activityId}`,
    line,
    source: glance ? "read" : "session",
    chips: [{ id: `session:${s.activityId}`, label, request: `Plan ${when} around ${subject} — ${facts}.` }],
    ...(s.workoutId ? { workoutId: s.workoutId } : {}),
  };
}

/** The first sentence of a text, clipped to `max`. */
export function firstSentence(text: string, max = REVIEW_LINE_MAX): string {
  const t = text.trim().replace(/\s+/g, " ");
  const end = t.search(/[.!?](\s|$)/);
  return clipProse(end >= 0 ? t.slice(0, end + 1) : t, max);
}

/** The words "Plan this week" sends: the coach reads last week itself. */
export const REVIEW_REQUEST = "Plan my week around how last week went.";

/** The opening on Monday (and until the athlete has opened the coach that week): the review's first sentence. */
export function reviewOpening(r: { weekStart: LocalDate; narrative: string | null }): CoachOpeningLine | null {
  const sentence = r.narrative ? firstSentence(r.narrative) : "";
  if (!r.narrative || !sentence) return null;
  return {
    id: `review:${r.weekStart}`,
    // In the coach's voice (the weekly prompt asks a first sentence that starts "Last week", whole on its own: llm.ts),
    // the coach says it as it is; one written before keeps its frame — it may say "This week" and mean last week.
    line: /^last week\b/i.test(sentence) ? sentence : `From last week's review: ${sentence}`,
    source: "review",
    chips: [{ id: `review:${r.weekStart}`, label: "Plan this week", request: REVIEW_REQUEST }],
    review: { weekStart: r.weekStart, narrative: r.narrative },
  };
}

/** The words "Fit these in" sends, once the batch is saved (@rg/saves: the batch page sends the same). */
export { FIT_SAVES_REQUEST };

/** The opening for a released batch of the athlete's saves: its notice as it was worded, and the two chips. */
export function savesOpening(b: { id: string; notice: string; releasedAt: string }): CoachOpeningLine {
  return {
    id: `saves:${b.id}`,
    line: b.notice,
    source: "saves",
    chips: [
      { id: "saves-see", label: "See them", request: "", href: `/studio/saves/${b.id}` },
      { id: "saves-fit", label: "Fit these in", request: FIT_SAVES_REQUEST, saveBatchId: b.id },
    ],
  };
}

/** The days a finished session is still news: today and yesterday. */
export const sessionDays = (today: LocalDate): LocalDate[] => [today, addDays(today, -1)];

/** An opening the screen has shown: `review:…`, `session:…` or `saves:…` (the `?seen=` list, at most this many). */
export const SEEN_MAX = 8;
const SEEN_ID = /^(review|session|saves):[A-Za-z0-9_.:-]{1,100}$/;

/** The `?seen=` list: openings this device has shown, comma-separated; anything else is left out. */
export function parseSeen(raw: string | null | undefined): Set<string> {
  return new Set(
    (raw ?? "")
      .split(",")
      .map((s) => s.trim())
      .filter((s) => SEEN_ID.test(s))
      .slice(0, SEEN_MAX),
  );
}
