/**
 * THE ATHLETE'S PROFILE (principles §5.1; programme spec §3.6 and its Amendment A).
 *
 * One `athlete_profiles` row per account (`id` = `user_id`): goals, focus areas (each with the library's region or
 * muscle ids it means), events and the few preferences no other table owns. The athlete writes it; the coach reads it
 * on every design. Read beside it, never written through it: units, timezone and the race (the user's preferences),
 * places and their gear (services/places.ts) and the condition profiles switched on (services/user-conditions.ts).
 *
 * A stored list is read entry by entry: an entry that no longer passes its schema is left out, never a 500 (the row
 * may come from a restored file or an older writer). Every write is refused while a restore is replacing the account
 * (ruling B2).
 */
import { and, eq, sql } from "drizzle-orm";
import { ZodError, type z } from "zod";
import { athleteProfiles, locations } from "@rg/database";
import {
  focusAreaSchema,
  newId,
  profileEventSchema,
  profileGoalSchema,
  profilePreferencesSchema,
  profileUpdateSchema,
  type ProfileDto,
  type ProfilePreferences,
  type UserPreferences,
} from "@rg/domain";
import { MUSCLES, REGIONS } from "@rg/exercise-library";
import { restoreInProgress } from "./account-state.js";
import { loadPreferences } from "./calendar-sync.js";
import { runAtomically, type Db } from "./db.js";
import { listPlaces, markDefault } from "./places.js";
import { RestoreInProgressError } from "./programs.js";
import { listConditions } from "./user-conditions.js";

/** What a focus area may refer to: the library's regions and muscles. */
const FOCUS_REFS: ReadonlySet<string> = new Set<string>([...REGIONS, ...MUSCLES]);

function parsedJson(text: string | null | undefined): unknown {
  if (text === null || text === undefined) return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

/** The entries of a stored list that still pass their schema. */
function validEntries<S extends z.ZodTypeAny>(raw: unknown, schema: S): Array<z.output<S>> {
  if (!Array.isArray(raw)) return [];
  return raw.flatMap((entry) => {
    const parsed = schema.safeParse(entry);
    return parsed.success ? [parsed.data as z.output<S>] : [];
  });
}

/** The stored preferences, field by field: a field that no longer passes is left out. */
function validPreferences(raw: unknown): ProfilePreferences {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return {};
  const shape = profilePreferencesSchema.shape;
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(shape) as Array<keyof typeof shape>) {
    const value = (raw as Record<string, unknown>)[key];
    if (value === undefined) continue;
    const parsed = shape[key].safeParse(value);
    if (parsed.success && parsed.data !== undefined) out[key] = parsed.data;
  }
  return out as ProfilePreferences;
}

/** The account's row, its JSON columns as text (a damaged column must read as empty, not throw in the driver). */
async function storedProfile(db: Db, userId: string) {
  const [row] = await db
    .select({
      goals: sql<string | null>`${athleteProfiles.goals}`,
      focusAreas: sql<string | null>`${athleteProfiles.focusAreas}`,
      events: sql<string | null>`${athleteProfiles.events}`,
      preferences: sql<string | null>`${athleteProfiles.preferences}`,
      updatedAt: athleteProfiles.updatedAt,
    })
    .from(athleteProfiles)
    .where(eq(athleteProfiles.userId, userId))
    .limit(1);
  return row ?? null;
}

export async function loadProfile(db: Db, userId: string): Promise<ProfileDto> {
  return (await loadProfileWithPreferences(db, userId)).profile;
}

/**
 * The profile and the user's whole preferences from the same four statements: for a reader that also needs what the
 * profile DTO leaves out (the scheduling times — the coach designer's "later today"), without reading them twice.
 */
export async function loadProfileWithPreferences(db: Db, userId: string): Promise<{ profile: ProfileDto; prefs: UserPreferences }> {
  const [row, prefs, places, conditions] = await Promise.all([
    storedProfile(db, userId),
    loadPreferences(db, userId),
    listPlaces(db, userId),
    listConditions(db, userId),
  ]);
  const preferences = validPreferences(parsedJson(row?.preferences));
  // A default place deleted since is no default: the places service never told the profile.
  if (preferences.defaultPlaceId !== undefined && !places.some((p) => p.id === preferences.defaultPlaceId)) delete preferences.defaultPlaceId;
  const profile: ProfileDto = {
    goals: validEntries(parsedJson(row?.goals), profileGoalSchema),
    focusAreas: validEntries(parsedJson(row?.focusAreas), focusAreaSchema),
    events: validEntries(parsedJson(row?.events), profileEventSchema),
    preferences,
    units: { distance: prefs.units, weight: prefs.weightUnit, temperature: prefs.temperatureUnit },
    timezone: prefs.timezone,
    race: prefs.raceDate ? { date: prefs.raceDate, distanceKm: prefs.raceDistanceKm } : null,
    places: places.map((p) => ({ id: p.id, name: p.name, equipment: p.equipment, implements: p.implements, isDefault: p.isDefault })),
    conditions: conditions.map((c) => ({ profileId: c.profileId, label: c.label, active: c.active, since: c.since })),
    updatedAt: row?.updatedAt ?? null,
  };
  return { profile, prefs };
}

/**
 * Write what is sent (`profileUpdateSchema`: goals, focus areas, events, preferences — each replaced whole), keep the
 * rest, and answer the whole profile. A ZodError names every problem: the schema's, a focus-area ref the library does
 * not hold, a default place that is not one of the account's. A new event gets an id.
 */
export async function updateProfile(db: Db, userId: string, input: unknown, now: string): Promise<ProfileDto> {
  const p = profileUpdateSchema.parse(input);
  if (await restoreInProgress(db, userId)) throw new RestoreInProgressError();

  const issues: z.ZodIssue[] = [];
  p.focusAreas?.forEach((area, i) =>
    area.refs.forEach((ref, j) => {
      if (!FOCUS_REFS.has(ref)) {
        issues.push({ code: "custom", path: ["focusAreas", i, "refs", j], message: "not a region or muscle the library knows" });
      }
    }),
  );
  const placeId = p.preferences?.defaultPlaceId;
  if (placeId !== undefined) {
    const [place] = await db
      .select({ id: locations.id })
      .from(locations)
      .where(and(eq(locations.id, placeId), eq(locations.userId, userId)))
      .limit(1);
    if (!place) issues.push({ code: "custom", path: ["preferences", "defaultPlaceId"], message: "not one of your places" });
  }
  if (issues.length > 0) throw new ZodError(issues);

  const events = p.events?.map((e) => ({ ...e, id: e.id ?? newId() }));
  const changed = {
    ...(p.goals !== undefined ? { goals: p.goals } : {}),
    ...(p.focusAreas !== undefined ? { focusAreas: p.focusAreas } : {}),
    ...(events !== undefined ? { events } : {}),
    ...(p.preferences !== undefined ? { preferences: p.preferences } : {}),
    updatedAt: now,
  };
  const upsert = db
    .insert(athleteProfiles)
    .values({
      id: userId,
      userId,
      goals: p.goals ?? [],
      focusAreas: p.focusAreas ?? [],
      events: events ?? [],
      preferences: p.preferences ?? {},
      updatedAt: now,
    })
    // One profile per account: the unique user_id holds it, whatever id an older or restored row carries.
    .onConflictDoUpdate({ target: athleteProfiles.userId, set: changed });
  // A default place chosen here is the place marked default too: one setting (places.ts).
  if (placeId !== undefined) await runAtomically(db, [upsert, ...markDefault(db, userId, placeId, now)]);
  else await upsert;
  return loadProfile(db, userId);
}
