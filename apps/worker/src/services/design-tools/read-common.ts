/**
 * WHAT THE COACH DESIGNER'S READ TOOLS SHARE (Stage 3 spec §4; principles §6.2–§6.3, §8).
 *
 * Every read tool answers the same way, so the model learns one contract:
 *  - `ToolOk` built by `answer`: `{ provenance: { source, asOf }, missing, nextCursor?, data, summary }`, in that key
 *    order. The loop cuts a result over TOOL_RESULT_MAX_BYTES by bytes from the end, so what says where the data came
 *    from, what could not be read and where the next page starts comes first and survives a cut. `asOf` is the instant
 *    of the read; each item carries its own date, and staleness is said in `missing` ("HRV last read 9 d ago").
 *  - A list is a page that fits (`pagedAnswer`): at most `limit` rows, and fewer when more would pass
 *    RESULT_BUDGET_BYTES, so the loop's cut never takes rows (or the cursor) away; `nextCursor` names the first row left
 *    out. A list a run can change while it pages (sessions, answers, the plan, memory, proposals, workouts) pages by
 *    key, so a row written meanwhile never shifts the next page; the others page by position and say so.
 *  - `missing` names what could not be read, in plain words. Unknown is never written as 0: a value nobody recorded
 *    is null or absent, and `missing` says so.
 *  - Text that came from outside the app's own code — the athlete's notes, answers and typed names, imported names,
 *    memory bodies, a workout's or template's words, a past run's words — is `{ untrusted: true, text }`, the marker
 *    FIRST, so a cut by bytes can never leave the text without it.
 *  - A refusal is teachable (`refuse`): what was wrong, why, how to fix it. Input is checked against the tool's own
 *    schema (`parseInput`, strict: an unknown field is named, never silently ignored).
 *  - Lists are compact and ranked, `limit` small by default, and paged with an opaque `cursor` (`nextCursor`).
 *  - Dates are the athlete's local dates; a range is at most MAX_RANGE_DAYS days (`checkRange`).
 *
 * BUDGET. A tool's `statementCost` is the most D1 statements one call runs, pinned by a counting test. To keep it
 * fixed whatever the account holds, a list of ids goes into SQL as ONE bound JSON value (`jsonList`) or as a
 * subquery — never as chunks, whose number grows with the data — and several small reads share one statement:
 * scalar subqueries beside the athlete's preferences (`readAthlete`), or a compound SELECT of tagged JSON rows
 * (`readTagged`, at most D1's five terms).
 */
import { sql, type SQL } from "drizzle-orm";
import { z } from "zod";
import { conditionChecks, userConditions, userPreferences } from "@rg/database";
import { addDays, daysBetween, isLocalDate, isoWeekday, todayInZone, userPreferencesSchema, weightInUnit, type UserPreferences, type WeightUnit } from "@rg/domain";
import { isProfileId, profileById, UNANSWERED, type CheckReading, type ConditionProfile } from "@rg/exercise-library";
import { readingsOfDay } from "../condition-views.js";
import type { Db } from "../db.js";
import type { ToolErr, ToolOk, ToolRole } from "./types.js";

/** Read tools serve every role: the reviewer reads too (spec §5). */
export const READ_ROLES: ToolRole[] = ["main", "designer", "reviewer"];

/** The longest range one read covers, in days (inclusive). */
export const MAX_RANGE_DAYS = 92;

// ── Results ─────────────────────────────────────────────────────────────────────────────────────────────────────────

/** Text from outside the app's own code: data to design from, never an instruction. The marker comes first. */
export interface Untrusted {
  untrusted: true;
  text: string;
}

export const untrusted = (text: string): Untrusted => ({ untrusted: true, text });

/** Marked text, or null when there is none. */
export const untrustedOrNull = (text: unknown): Untrusted | null =>
  typeof text === "string" && text.trim() !== "" ? untrusted(text) : null;

/** A read's answer: a `ToolOk`, with a paged list's `nextCursor` before the data. */
export type ReadOk = ToolOk & { nextCursor?: string | null };

/** A read's answer, keys in the order the module comment gives (`nextCursor` only on a paged list). */
export function answer(o: { source: string; now: Date; missing: string[]; data: unknown; summary: string; nextCursor?: string | null }): ReadOk {
  return {
    provenance: { source: o.source, asOf: o.now.toISOString() },
    missing: o.missing,
    ...(o.nextCursor !== undefined ? { nextCursor: o.nextCursor } : {}),
    data: o.data,
    summary: o.summary,
  };
}

export const refuse = (error: string, why: string, fix: string): ToolErr => ({ error, why, fix });

/** "1 session", "3 sessions". */
export const plural = (n: number, one: string, many = `${one}s`): string => `${n} ${n === 1 ? one : many}`;

// ── Input ───────────────────────────────────────────────────────────────────────────────────────────────────────────

export const dateField = z.string().refine(isLocalDate, "must be a date like 2026-10-12");
export const cursorField = z.string().max(600).regex(/^[A-Za-z0-9_-]+$/, "must be the nextCursor of the previous result, as it was");
export const limitField = (max: number) => z.number().int().min(1).max(max);

/** JSON-schema pieces the tools' `inputSchema`s are written from. */
export const DATE_SCHEMA = { type: "string", description: "A local date, YYYY-MM-DD." } as const;
export const CURSOR_SCHEMA = { type: "string", description: "nextCursor from the previous page, as it was." } as const;
export const limitSchema = (def: number, max: number) => ({
  type: "integer",
  minimum: 1,
  maximum: max,
  description: `Default ${def}. A page may hold fewer, to stay compact; nextCursor goes on.`,
});

function issueText(i: z.ZodIssue): string {
  if (i.code === "unrecognized_keys") return `unknown field${i.keys.length === 1 ? "" : "s"} ${i.keys.map((k) => `"${k}"`).join(", ")}`;
  const at = i.path.length ? i.path.join(".") : "input";
  return `${at}: ${i.message}`;
}

/** The input as the tool's schema reads it, or a teachable refusal naming every problem (at most three). */
export function parseInput<S extends z.ZodTypeAny>(schema: S, input: unknown, fields: string): z.output<S> | ToolErr {
  const parsed = schema.safeParse(input ?? {});
  if (parsed.success) return parsed.data as z.output<S>;
  return refuse("invalid_input", parsed.error.issues.slice(0, 3).map(issueText).join("; "), `Call it again with ${fields}.`);
}

export const isErr = (x: unknown): x is ToolErr => typeof (x as ToolErr | null)?.error === "string" && typeof (x as ToolErr).fix === "string";

/**
 * A refusal for a range that is upside down or longer than MAX_RANGE_DAYS; null for a good one. `names` are the
 * fields as the tool calls them (read_answers' range is `since` to today).
 */
export function checkRange(from: string, to: string, names: { from: string; to: string } = { from: "from", to: "to" }): ToolErr | null {
  if (from > to) return refuse("bad_range", `${names.from} (${from}) is after ${names.to} (${to}).`, `Give a ${names.from} on or before ${names.to}.`);
  const days = daysBetween(from, to) + 1;
  if (days > MAX_RANGE_DAYS) {
    return refuse(
      "range_too_long",
      `${names.from} ${from} to ${names.to} ${to} is ${days} days; one read covers at most ${MAX_RANGE_DAYS}.`,
      `Ask for ${MAX_RANGE_DAYS} days or fewer; read the earlier part in a second call only if it would change the design.`,
    );
  }
  return null;
}

// ── Paging ──────────────────────────────────────────────────────────────────────────────────────────────────────────

/** The most one answer may carry for the model (its envelope included): well under the loop's 8,000-byte cut. */
export const RESULT_BUDGET_BYTES = 6_500;

const bytesOf = (value: unknown): number => new TextEncoder().encode(JSON.stringify(value)).length;

/** A cursor: opaque to the model, a JSON array of key parts (or one offset) underneath. */
export function encodeCursor(parts: ReadonlyArray<string | number>): string {
  let binary = "";
  for (const b of new TextEncoder().encode(JSON.stringify(parts))) binary += String.fromCharCode(b);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function decodeCursor(cursor: string): unknown[] | null {
  try {
    const b64 = cursor.replace(/-/g, "+").replace(/_/g, "/");
    const binary = atob(b64 + "=".repeat((4 - (b64.length % 4)) % 4));
    const parts: unknown = JSON.parse(new TextDecoder().decode(Uint8Array.from(binary, (c) => c.charCodeAt(0))));
    return Array.isArray(parts) ? parts : null;
  } catch {
    return null;
  }
}

const badCursor = (): ToolErr =>
  refuse("bad_cursor", "That cursor is not one this list gave.", "Pass nextCursor exactly as the last page gave it, or leave it out to start from the top.");

/** A position cursor's offset (0 with none), or a refusal. */
export function offsetCursor(cursor: string | undefined): number | ToolErr {
  if (cursor === undefined) return 0;
  const parts = decodeCursor(cursor);
  const n = parts?.length === 1 ? parts[0] : null;
  return typeof n === "number" && Number.isInteger(n) && n >= 0 && n <= 100_000 ? n : badCursor();
}

/** A key cursor's parts (null with none), or a refusal: `arity` strings, the key of the row the page starts at. */
export function keyCursor(cursor: string | undefined, arity: number): string[] | null | ToolErr {
  if (cursor === undefined) return null;
  const parts = decodeCursor(cursor);
  return parts && parts.length === arity && parts.every((p) => typeof p === "string") ? (parts as string[]) : badCursor();
}

/**
 * A page that fits. `rows` are the candidates in order — the page asked for plus, when there is more, the row after
 * it. Keeps as many of the first `limit` as fit RESULT_BUDGET_BYTES with the rest of the answer (always at least one:
 * a single row too big is the loop's to cut, its marker and the cursor first), and `nextCursor` names the first row
 * left out (`cursorOf`; null when none is).
 */
export function pagedAnswer<R>(o: {
  source: string;
  now: Date;
  missing: string[];
  rows: readonly R[];
  limit: number;
  render: (row: R) => unknown;
  cursorOf: (row: R, index: number) => string;
  /** The answer's data around the page's items. */
  data: (items: unknown[]) => Record<string, unknown>;
  summary: (shown: number) => string;
}): ReadOk {
  const candidates = o.rows.slice(0, o.limit);
  const rendered = candidates.map(o.render);
  const cursors = o.rows.slice(0, o.limit + 1).map((r, i) => o.cursorOf(r, i));
  const longest = cursors.reduce((n, c) => Math.max(n, c.length), 0);
  let total = bytesOf(answer({ source: o.source, now: o.now, missing: o.missing, nextCursor: "x".repeat(longest), data: o.data([]), summary: "" }));
  let kept = 0;
  for (const item of rendered) {
    const add = bytesOf(item) + (kept > 0 ? 1 : 0);
    if (kept > 0 && total + add > RESULT_BUDGET_BYTES) break;
    total += add;
    kept += 1;
  }
  const nextCursor = kept < o.rows.length ? (cursors[kept] ?? null) : null;
  return answer({ source: o.source, now: o.now, missing: o.missing, nextCursor, data: o.data(rendered.slice(0, kept)), summary: o.summary(kept) });
}

// ── SQL ─────────────────────────────────────────────────────────────────────────────────────────────────────────────

/** A list of values as one bound JSON value, for `IN (…)`: one bind whatever its length (D1 allows 100 a statement). */
export const jsonList = (values: readonly string[]): SQL => sql`(select value from json_each(${JSON.stringify(values)}))`;

/** A JSON array the database holds as text, parsed; [] when it does not read. */
export function parsedArray(text: unknown): unknown[] {
  if (Array.isArray(text)) return text;
  if (typeof text !== "string") return [];
  try {
    const v: unknown = JSON.parse(text);
    return Array.isArray(v) ? v : [];
  } catch {
    return [];
  }
}

/** A JSON value the database holds as text, parsed; null when it does not read. */
export function parsedJson(text: unknown): unknown {
  if (typeof text !== "string") return text ?? null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

/** D1's limit on the terms of one compound SELECT. */
export const MAX_TAGGED_TERMS = 5;

/**
 * Several reads in ONE statement: each term selects `t` (a tag) and `j` (one row as JSON text). Answers each tag's
 * rows, parsed, in no particular order (callers sort). At most MAX_TAGGED_TERMS terms.
 */
export async function readTagged(db: Db, terms: SQL[]): Promise<Map<string, Array<Record<string, unknown>>>> {
  if (terms.length === 0 || terms.length > MAX_TAGGED_TERMS) throw new Error(`readTagged: ${terms.length} terms`);
  const rows = (await db.all(sql.join(terms, sql` union all `))) as Array<{ t: string; j: string }>;
  const out = new Map<string, Array<Record<string, unknown>>>();
  for (const r of rows) {
    const row = parsedJson(r.j);
    if (!row || typeof row !== "object") continue;
    out.set(r.t, [...(out.get(r.t) ?? []), row as Record<string, unknown>]);
  }
  return out;
}

// ── The athlete ─────────────────────────────────────────────────────────────────────────────────────────────────────

export interface Athlete {
  prefs: UserPreferences;
  /** A timezone the runtime knows (the stored one, else UTC). */
  tz: string;
  today: string;
  /** The switched-on condition profiles the library knows, by id. */
  profiles: ConditionProfile[];
  /** Today's reading per switched-on profile: the latest answered daily or pre check (the day's one rule). */
  readings: Record<string, CheckReading & { at: string | null }>;
  /** What the athlete's own settings could not tell: every tool puts these in its `missing`. */
  missing: string[];
}

const RESERVED_COLUMNS = new Set(["prefs", "active", "checks"]);

function zoneOrUtc(tz: string): string {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
    return tz;
  } catch {
    return "UTC";
  }
}

/**
 * The athlete's preferences, switched-on profiles and today's readings — and any `extras` (scalar subqueries, by
 * column name) — in ONE statement. Today's checks are read for the UTC day either side of `now`, which holds every
 * timezone's today, and kept for the athlete's own today once the timezone is known.
 */
export async function readAthlete(
  db: Db,
  userId: string,
  now: Date,
  extras: Record<string, SQL> = {},
): Promise<{ athlete: Athlete; extra: Record<string, unknown> }> {
  const taken = Object.keys(extras).filter((name) => RESERVED_COLUMNS.has(name));
  if (taken.length) throw new Error(`readAthlete: ${taken.join(", ")} is the athlete's own column`);
  const utcDay = now.toISOString().slice(0, 10);
  const columns: SQL[] = [
    sql`(select ${userPreferences.prefs} from ${userPreferences} where ${userPreferences.userId} = ${userId}) as prefs`,
    sql`(select json_group_array(${userConditions.profileId}) from ${userConditions}
          where ${userConditions.userId} = ${userId} and ${userConditions.active} = 1) as active`,
    sql`(select json_group_array(json_object('id', ${conditionChecks.id}, 'profileId', ${conditionChecks.profileId},
          'value', ${conditionChecks.value}, 'feelingOff', ${conditionChecks.feelingOff}, 'localDate', ${conditionChecks.localDate},
          'at', ${conditionChecks.at}))
          from ${conditionChecks} where ${conditionChecks.userId} = ${userId} and ${conditionChecks.kind} in ('daily', 'pre')
          and ${conditionChecks.localDate} between ${addDays(utcDay, -1)} and ${addDays(utcDay, 1)}) as checks`,
    ...Object.entries(extras).map(([name, expr]) => sql`${expr} as ${sql.identifier(name)}`),
  ];
  const [row] = (await db.all(sql`select ${sql.join(columns, sql`, `)}`)) as Array<Record<string, unknown>>;
  const stored = parsedJson(row?.prefs);
  const parsed = userPreferencesSchema.safeParse(stored ?? {});
  const prefs = parsed.success ? parsed.data : userPreferencesSchema.parse({});
  const missing: string[] = [];
  // Settings that do not read say nothing about where the athlete is: UTC, said plainly, never a default zone's guess.
  const tz = parsed.success ? zoneOrUtc(prefs.timezone) : "UTC";
  if (!parsed.success) missing.push("the athlete's settings do not read: timezone unknown — using UTC; units are the defaults");
  else if (tz !== prefs.timezone) missing.push("timezone unknown — using UTC");
  const today = todayInZone(tz, now);
  const active = [...new Set(parsedArray(row?.active).filter((id): id is string => typeof id === "string" && isProfileId(id)))].sort();
  const checks = parsedArray(row?.checks).flatMap((c) => {
    const x = c as { id?: unknown; profileId?: unknown; value?: unknown; feelingOff?: unknown; localDate?: unknown; at?: unknown };
    return typeof x.id === "string" && typeof x.profileId === "string" && x.localDate === today && typeof x.at === "string"
      ? [{ id: x.id, profileId: x.profileId, value: typeof x.value === "number" ? x.value : null, feelingOff: x.feelingOff === 1 || x.feelingOff === true, at: x.at }]
      : [];
  });
  const readings: Athlete["readings"] = {};
  const day = readingsOfDay(checks, active);
  for (const id of active) {
    const latest = day.get(id);
    readings[id] = latest ? { pre: latest.value, post: null, feelingOff: latest.feelingOff, at: latest.at } : { ...UNANSWERED, at: null };
  }
  const extra: Record<string, unknown> = {};
  for (const name of Object.keys(extras)) extra[name] = row?.[name] ?? null;
  return {
    athlete: { prefs, tz, today, profiles: active.map(profileById), readings, missing },
    extra,
  };
}

// ── Words and figures ───────────────────────────────────────────────────────────────────────────────────────────────

const WEEKDAYS = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"];
export const weekdayOf = (date: string): string => WEEKDAYS[isoWeekday(date) - 1]!;

/** "07:40" in the athlete's timezone; null for no instant. */
export function localTimeOf(tz: string, iso: unknown): string | null {
  if (typeof iso !== "string") return null;
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return null;
  return new Intl.DateTimeFormat("en-GB", { timeZone: tz, hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(new Date(t));
}

/** An instant's local date in the athlete's timezone; null for no instant. */
export function localDateOf(tz: string, iso: unknown): string | null {
  if (typeof iso !== "string") return null;
  if (/^\d{4}-\d{2}-\d{2}$/.test(iso)) return iso;
  const t = Date.parse(iso);
  return Number.isFinite(t) ? todayInZone(tz, new Date(t)) : null;
}

/** An activity's local date: the device's own local start, else its start instant in the athlete's timezone. */
export function activityDateOf(tz: string, startLocal: unknown, start: unknown): string | null {
  if (typeof startLocal === "string" && /^\d{4}-\d{2}-\d{2}/.test(startLocal)) return startLocal.slice(0, 10);
  return localDateOf(tz, start);
}

/** How old a dated reading is: "today", "1 d old", "9 d old". */
export const ageWords = (date: string, today: string): string => {
  const d = daysBetween(date, today);
  return d <= 0 ? "today" : `${d} d old`;
};

/** Whole minutes of `seconds`; null for none (unknown is not zero). */
export const minutesOf = (seconds: unknown): number | null =>
  typeof seconds === "number" && seconds > 0 ? Math.max(1, Math.round(seconds / 60)) : null;

/** "1 h 05 min" / "42 min". */
export function durationWords(seconds: number): string {
  const m = Math.round(seconds / 60);
  return m >= 60 ? `${Math.floor(m / 60)} h ${String(m % 60).padStart(2, "0")} min` : `${m} min`;
}

const METERS_PER_MILE = 1609.344;

/** "8.1 km" / "5.0 mi". */
export function distanceWords(meters: number, units: "km" | "mi"): string {
  return units === "mi" ? `${(meters / METERS_PER_MILE).toFixed(1)} mi` : `${(meters / 1000).toFixed(1)} km`;
}

/** "5:42 /km" / "9:10 /mi". */
export function paceWords(secPerKm: number, units: "km" | "mi"): string {
  const s = Math.round(units === "mi" ? secPerKm * (METERS_PER_MILE / 1000) : secPerKm);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")} /${units}`;
}

const trim = (n: number): string => String(Math.round(n * 10) / 10);

/** A logged weight in the athlete's unit: as typed when it is in that unit, else converted (to the half unit). */
export function weightWords(value: number, unit: unknown, athleteUnit: WeightUnit): string | null {
  if (!(value > 0) || (unit !== "lb" && unit !== "kg")) return null;
  return `${trim(weightInUnit({ v: value, u: unit }, athleteUnit))} ${athleteUnit}`;
}
