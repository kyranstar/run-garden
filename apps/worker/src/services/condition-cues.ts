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
 * moves, re-times or deletes one (condition-cues.test.ts pins it on every kind of read). A change here forgets the
 * sync's token for the calendars it wrote to, so the sync's next run reads its window in full: a token read would
 * answer every occurrence of each series changed, as far ahead as Google expands an endless one.
 *
 * What the calendar holds of a profile's cues: its live series carrying this profile's `rgCue` and this app's origin
 * (another stack writing into the same calendar keeps its own). Never an occurrence — one the athlete changed or deleted
 * by hand, which Google lists as an event of its own (`recurringEventId`) — and never one with no timed start (the
 * athlete made it something else, and it is theirs).
 *
 *  - Every PUT reads the chosen calendar once, for what the athlete may have done by hand. The same times it holds, as
 *    the list says, write nothing. Otherwise — one deleted, moved, or an extra beside them, or other times — the change
 *    reads it again under the lock: the events no longer wanted go first (one moved by hand among them), then the
 *    missing ones are made; a time in both is kept. An event in another calendar or zone than the athlete's now is
 *    replaced. An empty list turns the cues off, as DELETE does.
 *  - A call that fails stops the change. The list is then what is there: an event Google refused to make is not on it,
 *    one it made is, one it deleted (or already had gone: 404, 410) is off. A create whose answer can't be trusted (a 5xx,
 *    a dropped connection — it may have been made) leaves the list unsettled, and so does a request cut off part way
 *    (it is marked unsettled before its first create). A list not settled by this account — none yet, one left
 *    unsettled, one a restore brought back — is read in every calendar it names, as well. A calendar Google no longer
 *    has took its events with it. So no event is ever made twice or left behind, and a retry finishes the job. At most
 *    CUE_CALLS_PER_REQUEST writes a request; the rest wait for the next.
 *  - DELETE removes exactly the events on a settled list, with no read, and clears it; a list not settled here is read
 *    first, and with no calendar to read it is refused rather than called done. It needs neither the condition on nor a
 *    cue.
 *  - One change at a time per account (a lock, `CUE_LOCK`): a second request while one is under way is refused.
 *  - Nothing else creates a cue: a restore brings the list back and makes no event, and a whole-preferences write keeps
 *    what is stored (calendar-sync.ts `wholePreferencesWrite`). Delete-all takes every cue off first (`takeEveryCueOff`).
 *
 * Spend (pinned in the tests): a change at most 15 D1 statements and 10 fetches (the token, the calendar read, four
 * deletes, four creates); the same times with every series moved by hand 15 and 11; turning off at most 13 and 6; the
 * same times again 6 statements and one fetch.
 */
import { and, eq, sql } from "drizzle-orm";
import { userConditions, userPreferences } from "@rg/database";
import { nowInstant, type ConditionCueEvent, type ConditionCueState, type UserPreferences } from "@rg/domain";
import { PROFILE_IDS } from "@rg/exercise-library";
import { appOrigin, buildCueEvent, cueProfileFromEvent, cueSearch, cueStartDate, cueWallTimeOf, originFromEvent, wallClock } from "@rg/calendar";
import type { Env } from "../env.js";
import type { Db } from "./db.js";
import { loadAccountState, type AccountStateRow } from "./account-state.js";
import { forgetSyncTokens, loadPreferences } from "./calendar-sync.js";
import { conditionLabelOf, cueOf } from "./condition-words.js";
import { GoogleAuthError, googleCalendarClient, type GoogleCalendarClient } from "./google-calendar.js";
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
const CANT_LOOK = "No calendar is chosen for the app's events, so the app can't look for cues on it. Choose one in Settings, then try again.";
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
const readFailed = (view: CueView): CueAnswer => ({ status: 502, body: { error: "calendar_failed", done: false, message: READ_FAILED, cues: view } });

/** Put the profile's cue on the calendar at `times` (24-hour "HH:MM", checked by the route), replacing any others. */
export async function setConditionCues(db: Db, env: Env, userId: string, profileId: string, times: readonly string[], now: Date = new Date()): Promise<CueAnswer> {
  // No times turns the cues off: as DELETE, whether the condition is on or has a cue.
  if (times.length === 0) return clearConditionCues(db, env, userId, profileId, now);
  const cue = cueOf(profileId);
  if (!cue) return refusal(422, "no_cue", `${conditionLabelOf(profileId)} has no daytime cue.`);
  if (!(await conditionOn(db, userId, profileId))) {
    return refusal(409, "condition_off", `${conditionLabelOf(profileId)} isn't switched on. Switch it on first.`);
  }
  const wanted = [...new Set(times)].sort();
  const { prefs, state, account } = await readCues(db, userId, profileId);
  let client: GoogleCalendarClient | null = null;
  if (settled(state, account) && holds(state, wanted, prefs)) {
    // The list holds these times: one read of the calendar, which the athlete may have changed by hand since.
    client = await googleCalendarClient(db, env, userId);
    if (!client) return refusal(412, "google_not_connected", NOT_CONNECTED);
    let found: unknown[];
    try {
      found = await client.findEvents(prefs.calendarId!, cueSearch(profileId));
    } catch {
      return readFailed(viewOf(profileId, prefs, state.events));
    }
    const seen = withCalendar(state.events, found, { calendarId: prefs.calendarId!, profileId, origin: appOrigin(env.APP_URL) });
    if (JSON.stringify(seen) === JSON.stringify(state.events)) return done(viewOf(profileId, prefs, state.events));
  }
  return underLock(db, userId, () => change(db, env, { userId, profileId, cue, wanted, account, now, clearing: false, client }));
}

/** Take the profile's cue off the calendar: every event on its list, and clear the list. */
export async function clearConditionCues(db: Db, env: Env, userId: string, profileId: string, now: Date = new Date()): Promise<CueAnswer> {
  const { prefs, state, account } = await readCues(db, userId, profileId);
  if (settled(state, account) && state.events.length === 0) return done(viewOf(profileId, prefs, []));
  return underLock(db, userId, () => change(db, env, { userId, profileId, cue: null, wanted: [], account, now, clearing: true, client: null }));
}

/**
 * Before delete-all (routes/misc.ts): every condition's cues off the calendar, best effort — each profile with a list,
 * and each the library gives a cue (a list a restore of an older file lost). Through the same service and lock; a cue
 * it can't take off is logged by its code and never stops the delete.
 */
export async function takeEveryCueOff(db: Db, env: Env, userId: string): Promise<void> {
  let listed: string[] = [];
  try {
    listed = Object.keys((await loadPreferences(db, userId)).conditionCues ?? {});
  } catch {
    // Unreadable preferences: the library's profiles below still get their turn.
  }
  const profiles = [...new Set([...listed, ...PROFILE_IDS.filter((id) => cueOf(id) !== null)])];
  for (const profileId of profiles) {
    let code: string | null;
    try {
      const answer = await clearConditionCues(db, env, userId, profileId);
      code = answer.status === 200 ? null : String(answer.body.error ?? "not_finished");
    } catch {
      code = "exception";
    }
    if (code) console.warn(JSON.stringify({ level: "warn", msg: "delete-all: a condition's cues not taken off", profileId, code }));
  }
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
  recurringEventId?: string;
  start?: { dateTime?: string; timeZone?: string; date?: string };
  extendedProperties?: { private?: Record<string, string> };
}

/**
 * The list read against one calendar's answer (the module comment says what of it is a cue): an entry for `calendarId`
 * the calendar still holds takes the clock time and zone it has there (the athlete may have moved it); one it doesn't
 * hold, or holds as something else, goes; a cue the list lacks comes in. Entries for another calendar stay as they are.
 * Unchanged, it is the same list, in the same order.
 */
function withCalendar(
  events: readonly ConditionCueEvent[],
  found: unknown[],
  c: { calendarId: string; profileId: string; origin: string | undefined },
): ConditionCueEvent[] {
  const ours = new Map(
    (found as ListedCue[])
      .filter(
        (e) =>
          !e.recurringEventId &&
          e.status !== "cancelled" &&
          cueProfileFromEvent(e.extendedProperties) === c.profileId &&
          originFromEvent(e.extendedProperties) === c.origin,
      )
      .map((e) => [e.id, cueWallTimeOf(e)] as const),
  );
  const out: ConditionCueEvent[] = [];
  for (const e of events) {
    if (e.calendarId !== c.calendarId) {
      out.push(e);
      continue;
    }
    const at = ours.get(e.eventId);
    if (at) out.push({ ...e, time: at.time, timezone: at.timezone });
  }
  const known = new Set(out.map((e) => e.eventId));
  for (const [id, at] of ours) {
    if (!known.has(id) && at) out.push({ time: at.time, eventId: id, calendarId: c.calendarId, timezone: at.timezone });
  }
  return out;
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
    /** The request's client, if it already made one. */
    client: GoogleCalendarClient | null;
  },
): Promise<CueAnswer> {
  const at = nowInstant(c.now);
  // Read again under the lock: a change that just finished may have settled it.
  const prefs = await loadPreferences(db, c.userId);
  const state = prefs.conditionCues?.[c.profileId] ?? null;
  const client = c.client ?? (await googleCalendarClient(db, env, c.userId));
  if (!client) return refusal(412, "google_not_connected", NOT_CONNECTED);
  const calendarId = prefs.calendarId;
  if (c.wanted.length > 0 && !calendarId) return refusal(412, "no_calendar", NO_CALENDAR);
  const timezone = prefs.timezone;

  // Where to look: a change reads the chosen calendar; a list not settled here, every calendar it names as well; turning
  // a settled list off reads nothing (it removes exactly its ids).
  let events = [...(state?.events ?? [])];
  const unsettled = !settled(state, c.account);
  const look = [...new Set([...(calendarId && (unsettled || !c.clearing) ? [calendarId] : []), ...(unsettled ? events.map((e) => e.calendarId) : [])])];
  if (unsettled && look.length === 0) return refusal(412, "no_calendar", CANT_LOOK);
  for (const cal of look) {
    let found: unknown[];
    try {
      found = await client.findEvents(cal, cueSearch(c.profileId));
    } catch (e) {
      // A calendar Google no longer has (the athlete deleted it) took its events with it.
      if (!(e instanceof GoogleAuthError && e.status === 404)) return readFailed(viewOf(c.profileId, prefs, events));
      found = [];
    }
    events = withCalendar(events, found, { calendarId: cal, profileId: c.profileId, origin: appOrigin(env.APP_URL) });
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
  const written = new Set<string>();
  // Cut off after a create and before the list is written, the next request must look for what was made.
  if (add.length > 0) await writeCues(db, c.userId, c.profileId, { events: left, settledAt: null }, at);
  for (const e of remove) {
    if (calls === 0) break;
    calls -= 1;
    written.add(e.calendarId);
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
      written.add(calendarId!);
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
  // What this wrote would come to the sync's next token read as every occurrence of each series, months ahead.
  await forgetSyncTokens(db, c.userId, [...written]);
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
