/**
 * A CONDITION'S DAYTIME CUE ON THE CALENDAR (condition care gaps, Task 3). The app sends no notifications of its own,
 * so a cue is a few recurring events on the athlete's Google Calendar, and their phone gives the reminder: one event per
 * time of day the athlete chose, at most four, on the calendar they chose for the app's events (`calendarId`, where the
 * sessions go — the one place they agreed the app may write). The event is `@rg/calendar`'s `buildCueEvent`; its words
 * are the profile's (condition-words.ts). The events' ids are kept in the preferences, by profile
 * (`conditionCues[profileId]`), with each one's time, calendar and zone, and when this account last settled the list.
 *
 * What the calendar sync owns: an event carrying `rgWorkoutId`, and nothing else — it lists the whole window of the
 * chosen calendar and drops every other event before it decides anything, and the post-restore sweep deletes only
 * events with this app's origin AND a workout id naming no row. A cue carries `rgCue`, never `rgWorkoutId`, so no sync
 * moves, re-times or deletes one (condition-cues.test.ts pins it on every kind of read).
 *
 *  - The same times on a settled list change nothing and make no call.
 *  - Other times: the events no longer wanted go first, then the new ones are made; a time in both is kept. An event in
 *    another calendar or zone than the athlete's now is replaced.
 *  - A call that fails stops the change. The list is then what is there: an event Google refused to make is not on it,
 *    one it made is, one it deleted (or already had gone: 404, 410) is off. A create whose answer can't be trusted (a 5xx,
 *    a dropped connection — it may have been made) leaves the list unsettled, and so does a request cut off part way
 *    (it is marked unsettled before its first create). A list that is not settled by this account — none yet, one left
 *    unsettled, one a restore brought back — is first read against the calendar (the events carrying this profile's
 *    `rgCue` and this app's origin): what is there comes in, what is gone goes. So no event is ever made twice or left
 *    behind, and a retry finishes the job. At most CUE_CALLS_PER_REQUEST writes a request; the rest wait for the next.
 *  - DELETE removes exactly the events on the list (read against the calendar first when it isn't settled) and clears
 *    it; it needs neither the condition on nor a cue.
 *  - One change at a time per account (a lock, `CUE_LOCK`): a second request while one is under way is refused.
 *  - Nothing else creates a cue: a restore brings the list back and makes no event, and a whole-preferences save keeps
 *    what is stored (calendar-sync.ts `savePreferences`).
 *
 * Spend (pinned in the tests): a change at most 14 D1 statements and 10 fetches (the token, the calendar read, four
 * deletes, four creates); turning off at most 12 and 6; the same times again 5 statements and no fetch.
 */
import { and, eq, sql } from "drizzle-orm";
import { userConditions, userPreferences } from "@rg/database";
import { nowInstant, type ConditionCueEvent, type ConditionCueState, type UserPreferences } from "@rg/domain";
import { appOrigin, buildCueEvent, cueProfileFromEvent, cueSearch, cueStartDate, cueWallTimeOf, originFromEvent, wallClock } from "@rg/calendar";
import type { Env } from "../env.js";
import type { Db } from "./db.js";
import { loadAccountState, type AccountStateRow } from "./account-state.js";
import { loadPreferences } from "./calendar-sync.js";
import { conditionLabelOf, cueOf } from "./condition-words.js";
import { GoogleAuthError, googleCalendarClient } from "./google-calendar.js";
import { claimUserLock, releaseUserLock } from "./locks.js";

/** The lock one change to an account's cues holds (coach_locks kind). */
export const CUE_LOCK = "condition_cues";
/** A cue change's lock is anyone's after this long: a change is a few Google calls. */
const CUE_LOCK_STALE_MINUTES = 2;
/** Most Google writes one request makes: four times replaced by four. */
export const CUE_CALLS_PER_REQUEST = 8;

export interface CueView {
  profileId: string;
  /** The profile's cue words; null for a profile with none. */
  words: string | null;
  /** The times on the calendar now, as far as the list knows, each once. */
  times: string[];
  /** The athlete's zone, which new events are made in. */
  timezone: string;
}

export interface CueAnswer {
  status: 200 | 202 | 409 | 412 | 422 | 502;
  body: Record<string, unknown>;
}

const NOT_CONNECTED = "Google Calendar isn't connected. Connect it in Settings, then try again.";
const NO_CALENDAR = "No calendar is chosen for the app's events yet. Choose one in Settings, then try again.";
const BUSY = "Another change to these cues is still going. Try again in a moment.";
const READ_FAILED = "Google Calendar didn't answer, so nothing changed. Try again.";

const refusal = (status: CueAnswer["status"], error: string, message: string): CueAnswer => ({ status, body: { error, message } });

const timesOf = (events: readonly ConditionCueEvent[]): string[] => [...new Set(events.map((e) => e.time))].sort();

const viewOf = (profileId: string, prefs: UserPreferences, events: readonly ConditionCueEvent[]): CueView => ({
  profileId,
  words: cueOf(profileId)?.words ?? null,
  times: timesOf(events),
  timezone: prefs.timezone,
});

const done = (view: CueView): CueAnswer => ({ status: 200, body: { cues: view, done: true } });

/** Put the profile's cue on the calendar at `times` (24-hour "HH:MM", checked by the route), replacing any others. */
export async function setConditionCues(db: Db, env: Env, userId: string, profileId: string, times: readonly string[], now: Date = new Date()): Promise<CueAnswer> {
  const cue = cueOf(profileId);
  if (!cue) return refusal(422, "no_cue", `${conditionLabelOf(profileId)} has no daytime cue.`);
  if (!(await conditionOn(db, userId, profileId))) {
    return refusal(409, "condition_off", `${conditionLabelOf(profileId)} isn't switched on. Switch it on first.`);
  }
  const wanted = [...new Set(times)].sort();
  const { prefs, state, account } = await readCues(db, userId, profileId);
  if (settled(state, account) && holds(state, wanted, prefs)) return done(viewOf(profileId, prefs, state.events));
  return underLock(db, userId, () => change(db, env, { userId, profileId, cue, wanted, account, now, clearing: false }));
}

/** Take the profile's cue off the calendar: every event on its list, and clear the list. */
export async function clearConditionCues(db: Db, env: Env, userId: string, profileId: string, now: Date = new Date()): Promise<CueAnswer> {
  const { prefs, state, account } = await readCues(db, userId, profileId);
  if (settled(state, account) && state.events.length === 0) return done(viewOf(profileId, prefs, []));
  return underLock(db, userId, () => change(db, env, { userId, profileId, cue: null, wanted: [], account, now, clearing: true }));
}

async function conditionOn(db: Db, userId: string, profileId: string): Promise<boolean> {
  const [row] = await db
    .select({ active: userConditions.active })
    .from(userConditions)
    .where(and(eq(userConditions.userId, userId), eq(userConditions.profileId, profileId)))
    .limit(1);
  return row?.active === true;
}

async function readCues(db: Db, userId: string, profileId: string) {
  const prefs = await loadPreferences(db, userId);
  return { prefs, state: prefs.conditionCues?.[profileId] ?? null, account: await loadAccountState(db, userId) };
}

/** A list this account settled: not one left unsettled, and not one a restore brought back (settled before it finished). */
function settled(state: ConditionCueState | null, account: AccountStateRow | null): state is ConditionCueState {
  if (!state || state.settledAt === null) return false;
  const restored = account?.restoreFinishedAt;
  return !restored || state.settledAt > restored;
}

/** The list is exactly `wanted`, one event each, all on the athlete's calendar and in their zone now. */
function holds(state: ConditionCueState, wanted: readonly string[], prefs: UserPreferences): boolean {
  return (
    state.events.length === wanted.length &&
    state.events.every((e) => e.calendarId === prefs.calendarId && e.timezone === prefs.timezone) &&
    timesOf(state.events).join() === wanted.join()
  );
}

async function underLock(db: Db, userId: string, work: () => Promise<CueAnswer>): Promise<CueAnswer> {
  const token = await claimUserLock(db, userId, CUE_LOCK, CUE_LOCK_STALE_MINUTES);
  if (!token) return refusal(409, "cues_busy", BUSY);
  try {
    return await work();
  } finally {
    await releaseUserLock(db, userId, CUE_LOCK, token);
  }
}

/** One statement: this profile's list, and nothing else in the preferences. */
async function writeCues(db: Db, userId: string, profileId: string, state: ConditionCueState, at: string): Promise<void> {
  const json = JSON.stringify(state);
  const path = `$.conditionCues."${profileId}"`;
  await db.run(sql`
    INSERT INTO ${userPreferences} (user_id, prefs, updated_at)
    VALUES (${userId}, json_object('conditionCues', json_object(${profileId}, json(${json}))), ${at})
    ON CONFLICT (user_id) DO UPDATE SET prefs = json_set(prefs, ${path}, json(${json})), updated_at = ${at}
  `);
}

interface ListedCue {
  id: string;
  status?: string;
  start?: { dateTime?: string; timeZone?: string; date?: string };
  extendedProperties?: { private?: Record<string, string> };
}

/**
 * The list read against what the calendar holds of this profile's cues made by this deployment (its origin; another
 * stack writing into the same calendar keeps its own): an entry for `calendarId` that isn't there any more goes, and an
 * event the list lacks comes in at its own clock time and zone. Entries for another calendar stay as they are. Only a
 * live event carrying this profile's `rgCue` is one, whatever the search answered (a session's event carries this app's
 * origin too); a cancelled occurrence of a series (the athlete deleted one day's) is not; and an event with no timed
 * start is not one this app made any more (the athlete changed it), and stays theirs.
 */
function withCalendar(
  events: ConditionCueEvent[],
  found: unknown[],
  c: { calendarId: string; profileId: string; origin: string | undefined },
): ConditionCueEvent[] {
  const { calendarId } = c;
  const ours = (found as ListedCue[]).filter(
    (e) => e.status !== "cancelled" && cueProfileFromEvent(e.extendedProperties) === c.profileId && originFromEvent(e.extendedProperties) === c.origin,
  );
  const there = new Set(ours.map((e) => e.id));
  const kept = events.filter((e) => e.calendarId !== calendarId || there.has(e.eventId));
  const known = new Set(kept.map((e) => e.eventId));
  for (const e of ours) {
    const at = cueWallTimeOf(e);
    if (known.has(e.id) || !at) continue;
    kept.push({ time: at.time, eventId: e.id, calendarId, timezone: at.timezone });
  }
  return kept;
}

/** A failure that says the event wasn't made: a refusal from Google, or a token that couldn't be refreshed before the call. */
function certainlyNotMade(e: unknown): boolean {
  if (e instanceof GoogleAuthError) return e.status < 500;
  return e instanceof Error && e.message.startsWith("google_token_refresh_failed");
}

async function change(
  db: Db,
  env: Env,
  c: {
    userId: string;
    profileId: string;
    cue: { words: string; label: string } | null;
    wanted: string[];
    account: AccountStateRow | null;
    now: Date;
    clearing: boolean;
  },
): Promise<CueAnswer> {
  const at = nowInstant(c.now);
  // Read again under the lock: a change that just finished may have settled it.
  const prefs = await loadPreferences(db, c.userId);
  const state = prefs.conditionCues?.[c.profileId] ?? null;
  const client = await googleCalendarClient(db, env, c.userId);
  if (!client) return refusal(412, "google_not_connected", NOT_CONNECTED);
  const calendarId = prefs.calendarId;
  if (c.wanted.length > 0 && !calendarId) return refusal(412, "no_calendar", NO_CALENDAR);
  const timezone = prefs.timezone;

  let events = [...(state?.events ?? [])];
  if (!settled(state, c.account) && calendarId) {
    let found: unknown[];
    try {
      found = await client.findEvents(calendarId, cueSearch(c.profileId));
    } catch {
      return { status: 502, body: { error: "calendar_failed", done: false, message: READ_FAILED, cues: viewOf(c.profileId, prefs, events) } };
    }
    events = withCalendar(events, found, { calendarId, profileId: c.profileId, origin: appOrigin(env.APP_URL) });
  }

  // The events kept (one per wanted time, on the athlete's calendar and in their zone), the ones to remove, the times to make.
  const keep: ConditionCueEvent[] = [];
  const remove: ConditionCueEvent[] = [];
  for (const e of events) {
    const kept = e.calendarId === calendarId && e.timezone === timezone && c.wanted.includes(e.time) && !keep.some((k) => k.time === e.time);
    (kept ? keep : remove).push(e);
  }
  const add = c.wanted.filter((t) => !keep.some((k) => k.time === t));

  let left = [...events];
  let calls = CUE_CALLS_PER_REQUEST;
  let failed = false;
  let unsure: string | null = null;
  // Cut off after a create and before the list is written, the next request must look for what was made.
  if (add.length > 0) await writeCues(db, c.userId, c.profileId, { events: left, settledAt: null }, at);
  for (const e of remove) {
    if (calls === 0) break;
    calls -= 1;
    try {
      await client.deleteEvent(e.calendarId, e.eventId);
      left = left.filter((x) => x !== e);
    } catch {
      failed = true;
      break;
    }
  }
  // The old ones go first: nothing is made after a delete failed, and a request whose calls the deletes used up makes
  // nothing either (the budget below is spent).
  if (!failed) {
    const { date, time: clock } = wallClock(c.now, timezone);
    for (const t of add) {
      if (calls === 0) break;
      calls -= 1;
      try {
        const made = await client.insertEvent(
          calendarId!,
          buildCueEvent({ profileId: c.profileId, words: c.cue!.words, label: c.cue!.label, time: t, startDate: cueStartDate(date, clock, t), timezone, appUrl: env.APP_URL }),
        );
        left.push({ time: t, eventId: made.id, calendarId: calendarId!, timezone });
      } catch (e) {
        failed = true;
        if (!certainlyNotMade(e)) unsure = t;
        break;
      }
    }
  }
  await writeCues(db, c.userId, c.profileId, { events: left, settledAt: unsure ? null : at }, at);

  const view = viewOf(c.profileId, prefs, left);
  const finished =
    remove.every((e) => !left.includes(e)) && add.every((t) => left.some((x) => x.time === t && x.calendarId === calendarId && x.timezone === timezone));
  if (!failed && finished) return done(view);
  const progress = progressWords(left, c.wanted, c.clearing);
  if (failed) {
    const lead = c.clearing ? "Google Calendar didn't remove them all." : "Google Calendar didn't finish the change.";
    const doubt = unsure ? ` Google didn't answer for ${unsure}, so it may be there too: trying again checks.` : "";
    return { status: 502, body: { error: "calendar_failed", done: false, message: `${lead} ${progress}${doubt} Try again to finish.`, cues: view } };
  }
  return { status: 202, body: { done: false, message: `Part done. ${progress} Try again to finish.`, cues: view } };
}

/** What is on the calendar now and, for a change, what isn't yet. */
function progressWords(left: readonly ConditionCueEvent[], wanted: readonly string[], clearing: boolean): string {
  const on = timesOf(left);
  if (clearing) return `Still on your calendar: ${on.join(", ")}.`;
  const missing = wanted.filter((t) => !on.includes(t));
  return [on.length > 0 ? `On your calendar now: ${on.join(", ")}.` : "Nothing on your calendar now.", ...(missing.length > 0 ? [`Not on it yet: ${missing.join(", ")}.`] : [])].join(" ");
}
