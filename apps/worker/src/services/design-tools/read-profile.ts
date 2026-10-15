/**
 * read_profile — the whole profile (Stage 3 spec §4; principles §5.1): goals in the athlete's words, focus areas with
 * the library refs they mean, upcoming events, the race, places with their gear and implements, units, timezone, the
 * condition profiles switched on, and the session preferences. The profile service's own read (`loadProfileWithPreferences`,
 * four statements). Every word the athlete typed is marked.
 */
import { z } from "zod";
import { daysBetween, todayInZone } from "@rg/domain";
import { loadProfileWithPreferences } from "../profile.js";
import type { DesignTool } from "./types.js";
import { answer, isErr, parseInput, plural, READ_ROLES, untrusted, untrustedOrNull } from "./read-common.js";

const input = z.object({}).strict();
/** `trainingDays` count from Monday (0). */
const WEEKDAY_BY_INDEX = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"];

export const readProfile: DesignTool = {
  name: "read_profile",
  description: "The whole profile: goals, focus areas with their library refs, upcoming events, places with equipment and implements, units, conditions, session preferences.",
  inputSchema: { type: "object", properties: {}, additionalProperties: false },
  statementCost: 4,
  roles: READ_ROLES,
  async run(ctx, raw) {
    const p = parseInput(input, raw, "no fields");
    if (isErr(p)) return p;
    const { profile } = await loadProfileWithPreferences(ctx.db, ctx.userId);
    let today: string;
    let zoneUnknown = false;
    try {
      today = todayInZone(profile.timezone, ctx.now);
    } catch {
      today = todayInZone("UTC", ctx.now);
      zoneUnknown = true;
    }
    const events = profile.events
      .filter((e) => (e.end ?? e.start) >= today)
      .sort((a, b) => a.start.localeCompare(b.start))
      .map((e) => ({
        id: e.id,
        label: untrusted(e.label),
        kind: e.kind,
        start: e.start,
        ...(e.end ? { end: e.end } : {}),
        priority: e.priority,
        taper: e.taper,
        daysAway: Math.max(0, daysBetween(today, e.start)),
      }));
    const prefs = profile.preferences;
    const data = {
      goals: profile.goals.map((g) => ({ id: g.id, words: untrusted(g.words) })),
      focusAreas: profile.focusAreas.map((f) => ({ id: f.id, label: untrusted(f.label), refs: f.refs, ...(f.note ? { note: untrusted(f.note) } : {}) })),
      events,
      race: profile.race ? { date: profile.race.date, distanceKm: profile.race.distanceKm } : null,
      places: profile.places.map((pl) => ({
        id: pl.id,
        name: untrusted(pl.name),
        isDefault: pl.id === prefs.defaultPlaceId || (prefs.defaultPlaceId === undefined && pl.isDefault),
        equipment: pl.equipment,
        implements: Object.fromEntries(Object.entries(pl.implements).flatMap(([id, typed]) => (untrustedOrNull(typed) ? [[id, untrusted(String(typed))]] : []))),
      })),
      units: profile.units,
      timezone: profile.timezone,
      conditions: profile.conditions.filter((c) => c.active).map((c) => ({ profileId: c.profileId, label: c.label, since: c.since })),
      preferences: {
        sessionMinutes: prefs.sessionMinutes ?? null,
        trainingDays: prefs.trainingDays ? prefs.trainingDays.map((d) => WEEKDAY_BY_INDEX[d] ?? String(d)) : null,
        defaultPlaceId: prefs.defaultPlaceId ?? null,
      },
    };
    const missing: string[] = zoneUnknown ? ["timezone unknown — using UTC"] : [];
    if (data.goals.length === 0) missing.push("no goals recorded");
    if (data.focusAreas.length === 0) missing.push("no focus areas recorded");
    if (data.places.length === 0) missing.push("no places set up");
    if (!prefs.sessionMinutes) missing.push("usual session length not set");
    if (!prefs.trainingDays?.length) missing.push("training days not set");
    return answer({
      source: "the athlete's profile, places, conditions and settings",
      now: ctx.now,
      missing,
      data,
      summary: `Read the profile — ${plural(data.goals.length, "goal")}, ${plural(data.focusAreas.length, "focus area")}, ${plural(events.length, "upcoming event")}`,
    });
  },
};
