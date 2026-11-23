/**
 * WHAT A COURSE'S CARD SAYS OF ITS DATES (R1.6: the Next and Taken off lines; R1.7: the held-back lines). One place, so the
 * card change_plan stores, the card an approve builds again (m1), PATCH's answer and read_plans say the same words.
 *
 *  - Next: the next two sessions, as placement's preview has them, then its rhythm past the window: "Next Evening practice Mon 23 Nov,
 *    then Mon 7 Dec".
 *  - Held back (R1.7): each date of the rhythm a rule holds back, with the rule, at most two, then "+N more": "Not Mon 7 Dec:
 *    the week before your 10K time trial is kept quiet", "Not Mon 7 Dec: Evening practice is paused until Thu 10 Dec", "Not Sat 12 Dec:
 *    it's the day of your race". The race is named as the athlete's events name it on race day, else as its race session's
 *    title, else "your race" (`raceNameSql`).
 *  - Taken off: each placed session the change takes off, three by date, then "+N more".
 *
 * The model is told the same dates and words (`heldBackForModel`), each with its rule's code, so it can say why a date is
 * missing and never guess: on 23 Nov a coach that couldn't see the race's quiet days first guessed at a leftover skip, then
 * told the owner 7 Dec was scheduled.
 */
import { sql, type SQL } from "drizzle-orm";
import { addDays, clipWords, dayLabel, isoWeekday, onWeek, type CourseConfig, type UserPreferences } from "@rg/domain";
import type { Db } from "./db.js";
import { heldBackWhy, PREVIEW_STATEMENTS, previewPlacement, quietDaysOf, type HeldBackDate, type HeldBackReason } from "./program-slots.js";

/** A race's name on a card line: a line, not a whole label. */
export const RACE_NAME_MAX = 40;
/** Held-back lines a card shows before "+N more". */
export const HELD_BACK_SHOWN = 2;
/** Held-back dates the model is told one by one; the rest are counted. */
export const HELD_BACK_TOLD = 6;

/** What a held-back line needs besides the date: the plan's pause, its quiet days (none: null) and the race's name. */
export interface HeldBackWords {
  pausedUntil: string | null;
  quietDays: number | null;
  raceName: string | null;
}

/** "your 10K time trial", or "your race" when run-garden has no name for it. A leading article goes: "The Big Half" is "your Big Half". */
export function raceWords(name: string | null): string {
  const bare = (name ?? "").trim().replace(/^(the|my|a|an)\s+/i, "");
  return bare ? `your ${clipWords(bare, RACE_NAME_MAX)}` : "your race";
}

/** The quiet days before a race, in words: "the week before your 10K time trial is kept quiet". */
export function quietWindowWords(days: number, race: string): string {
  if (days === 1) return `the day before ${race} is kept quiet`;
  if (days === 7) return `the week before ${race} is kept quiet`;
  if (days === 14) return `the two weeks before ${race} are kept quiet`;
  if (days === 21) return `the three weeks before ${race} are kept quiet`;
  return `the ${days} days before ${race} are kept quiet`;
}

/** Why one date is held back, in the card's words. */
export function heldBackReasonWords(planName: string, reason: HeldBackReason, w: HeldBackWords): string {
  const race = raceWords(w.raceName);
  switch (reason) {
    case "paused":
      return `${planName} is paused until ${w.pausedUntil ? dayLabel(w.pausedUntil) : "further notice"}`;
    case "race_day":
      return `it's the day of ${race}`;
    case "race_quiet":
      return quietWindowWords(w.quietDays ?? 0, race);
  }
}

/** One held-back date's line: "Not Mon 7 Dec: the week before your 10K time trial is kept quiet". */
export const heldBackLine = (planName: string, h: HeldBackDate, w: HeldBackWords): string => `Not ${dayLabel(h.date)}: ${heldBackReasonWords(planName, h.reason, w)}`;

/** The card's held-back lines: the first two by date, then "+N more"; none when nothing is held back. */
export function heldBackLines(planName: string, held: readonly HeldBackDate[], w: HeldBackWords): string[] {
  const sorted = [...held].sort((a, b) => a.date.localeCompare(b.date));
  const more = sorted.length - HELD_BACK_SHOWN;
  return [...sorted.slice(0, HELD_BACK_SHOWN).map((h) => heldBackLine(planName, h, w)), ...(more > 0 ? [`+${more} more`] : [])];
}

/** A held-back date as the model is told it: the date, the rule's code and the card's words. */
export interface HeldBackTold {
  date: string;
  reason: HeldBackReason;
  line: string;
}

/** The held-back dates for the model, by date: the first HELD_BACK_TOLD in full, the rest counted. */
export function heldBackForModel(planName: string, held: readonly HeldBackDate[], w: HeldBackWords): { heldBack: HeldBackTold[]; heldBackMore?: number } {
  const sorted = [...held].sort((a, b) => a.date.localeCompare(b.date));
  const told = sorted.slice(0, HELD_BACK_TOLD).map((h) => ({ date: h.date, reason: h.reason, line: heldBackLine(planName, h, w) }));
  return sorted.length > HELD_BACK_TOLD ? { heldBack: told, heldBackMore: sorted.length - HELD_BACK_TOLD } : { heldBack: told };
}

/** The card's "Next" line (R1.6; fix round 2, the next two, said whenever its schedule changes, as they fall after it):
 * "Next Evening practice Mon 23 Nov, then Mon 7 Dec"; null with none ahead. */
const NEXT_SHOWN = 2;
export function courseNextLine(name: string, ahead: readonly string[]): string | null {
  const next = ahead.slice(0, NEXT_SHOWN);
  return next.length === 0 ? null : `Next ${name} ${next.map(dayLabel).join(", then ")}`;
}

/** The card's "Taken off" line (fix round 2): each placed session the change takes off — "Taken off: Mon 30 Nov" — the first
 * three by date and the rest counted ("… +4 more"); null when none does. A skipped one isn't placed: it was off already. */
const OFF_SHOWN = 3;
export function comesOffLine(off: readonly string[]): string | null {
  if (off.length === 0) return null;
  const more = off.length - OFF_SHOWN;
  return `Taken off: ${off.slice(0, OFF_SHOWN).map(dayLabel).join(" · ")}${more > 0 ? ` +${more} more` : ""}`;
}

/**
 * The race's name, as one scalar of a statement already being made (no statement of its own): the athlete's event of kind
 * "race" on race day (its label), else a live race session on that day (its title), else null. Race day is the preferences'.
 */
export function raceNameSql(userId: string): SQL {
  return sql`(select coalesce(
      (select json_extract(e.value, '$.label') from athlete_profiles ap, json_each(case when json_valid(ap.events) then ap.events else '[]' end) e
        where ap.user_id = ${userId} and json_extract(e.value, '$.kind') = 'race' and json_extract(e.value, '$.start') = rd.d
        order by cast(e.key as integer) limit 1),
      (select w.title from planned_workouts w where w.user_id = ${userId} and w.category = 'race' and w.effective_date = rd.d
        and w.archived_at is null order by w.id limit 1))
    from (select case when json_valid(up.prefs) then json_extract(up.prefs, '$.raceDate') end as d from user_preferences up where up.user_id = ${userId}) rd
    where rd.d is not null)`;
}

/** The race's name on its own (`raceNameSql`): one statement. */
export const RACE_NAME_STATEMENTS = 1;
export async function readRaceName(db: Db, userId: string): Promise<string | null> {
  const [row] = (await db.all(sql`select ${raceNameSql(userId)} as name`)) as Array<{ name: unknown }>;
  return typeof row?.name === "string" && row.name.trim() !== "" ? row.name : null;
}

/** How far ahead read_plans looks (R1.7): a race this near gives a course's quiet window, and a rule's held-back dates are listed. */
export const HELD_BACK_DAYS = 42;

/**
 * The dates of a course's rhythm a rule holds back from today, over HELD_BACK_DAYS (R1.7: read_plans'), by its settings alone:
 * its days in the weeks its rhythm uses, held back by its pause, race day or the race's quiet days (`heldBackWhy`), less the
 * dates `kept` (a session that stays there). No rows are read, so a day the athlete skipped is listed if a rule holds it too.
 */
export function rhythmHeldBack(config: CourseConfig, o: { today: string; pausedUntil: string | null; prefs: UserPreferences; kept?: ReadonlySet<string> }): HeldBackDate[] {
  const why = heldBackWhy({ pausedUntil: o.pausedUntil, quietDays: quietDaysOf(config), prefs: o.prefs });
  const out: HeldBackDate[] = [];
  for (let n = 0; n < HELD_BACK_DAYS; n++) {
    const date = addDays(o.today, n);
    if (!config.weekdays.includes(isoWeekday(date) - 1) || !onWeek(date, config) || o.kept?.has(date)) continue;
    const reason = why(date);
    if (reason) out.push({ date, reason });
  }
  return out;
}

/** What a course's card says of its dates, and what the model is told of them. */
export interface CoursePreview {
  /** Next, the held-back lines, Taken off: the card's computed lines, in that order. */
  lines: string[];
  heldBack: HeldBackTold[];
  heldBackMore?: number;
}

/** The statements `coursePreview` runs (the race's name is the caller's to read). */
export const COURSE_PREVIEW_STATEMENTS = PREVIEW_STATEMENTS;

/**
 * Where a course's sessions would fall with `config` in place of its own (placement's preview, written nowhere), as the card
 * says it: Next, the dates held back and why, what comes off.
 */
export async function coursePreview(
  db: Db,
  userId: string,
  plan: { id: string; name: string; status: string; disciplines: string[]; pausedUntil: string | null },
  config: CourseConfig,
  ctx: { today: string; prefs: UserPreferences; now: string; raceName: string | null },
): Promise<CoursePreview> {
  const preview = await previewPlacement(db, userId, { ...plan, kind: "course" }, config, ctx.today, ctx.prefs, ctx.now);
  const words: HeldBackWords = { pausedUntil: plan.pausedUntil, quietDays: quietDaysOf(config), raceName: ctx.raceName };
  const lines = [courseNextLine(plan.name, [...preview.after, ...preview.beyond].sort()), ...heldBackLines(plan.name, preview.heldBack, words), comesOffLine(preview.off)].filter(
    (l): l is string => l !== null,
  );
  return { lines, ...heldBackForModel(plan.name, preview.heldBack, words) };
}
