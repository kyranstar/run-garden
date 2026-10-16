/**
 * THE ONE-TIME COPY OF PROFILE-SHAPED MEMORIES INTO THE PROFILE (Stage 3 Task 10; spec §9; principles §6.7: "anything
 * that has a home in the profile moves to the profile; memory keeps what does not fit a field"). Owner data: the admin
 * route (routes/admin.ts) answers a dry run unless asked to apply, and an apply must carry the dry run's fingerprint.
 *
 * COPY, NOT MOVE (fix wave 3B, A-I1; the lead's ruling). The live thread coach reads only memory — its guardrails' dated
 * events (coach-wake.ts `datedEventsFromMemory`) and its dossier — so an item superseded here would vanish from both:
 * a trip it schedules around, a goal it plans for. Until the thread coach reads the profile, every item the profile
 * gains is KEPT LIVE in memory too, and the dry run says so; the apply supersedes nothing.
 *
 * WHAT IS PROFILE-SHAPED. Deterministic and conservative: an item is copied only on plain signs, and everything else
 * stays in memory as it is. Live items only (`liveMemoryWhere`: never a rehearsal's, a superseded or an expired one).
 *  - An EVENT or race: a date (YYYY-MM-DD, as the thread coach is told to write one) and an event word (race,
 *    marathon, ski, trip, holiday, travel, wedding…). It becomes a profile event of that kind; a race is priority B
 *    with a taper, anything else C without. A past one, or one the profile has no room for, stays in memory. The race
 *    already in Settings is already there.
 *  - A GOAL: goal words ("goal", "wants to", "working on", "training for"…) naming exactly one of the profile's goals.
 *    Naming two is left in memory, said so.
 *  - A FOCUS AREA: focus words ("focus on", "work on", "strengthen", "weak", "tight"…) and body regions the library
 *    names — never with pain words (pain, sore, injury, flare…): a health signal stays in memory. A condition's own
 *    area belongs to its profile, never a focus area.
 *  - A PLACE ("trains at", "home gym", "garage"…): reported only. Places live in Settings → Places, which this never
 *    changes; the item stays in memory.
 * WHAT IS LEFT IN MEMORY. Everything: each item stays live as it is (above). An event's name is at most 80 characters,
 * so a longer item's event carries its words cut.
 *
 * THE OLD STUDIO'S PLAN BRIEF (`studio_plans.brief`, its newest plan): its goal goes to the profile's goals (strength
 * and muscle size are strength; general fitness is athleticism), its session length and days to the profile's
 * preferences (only when unset); its equipment (free text, not a place) becomes a memory fact and its constraints a
 * memory rule — stated, from "the old Studio's brief" — once each (`studio-brief:<plan>:<field>`, so one the athlete
 * deleted is never brought back); its weeks, sessions a week and start date were the old plan's own. The old Studio's
 * tables are never changed here.
 *
 * APPLY does exactly the plan the dry run reported: the profile written whole from what it held (entries no reader
 * takes any more kept as they are) plus the plan's entries, and the brief's items added — one atomic batch within the
 * request's 45 statements; no memory item is changed. Run again, the plan is empty and nothing is written. The report
 * is the answer only: nothing here logs.
 */
import { and, asc, desc, eq, sql } from "drizzle-orm";
import { athleteProfiles, coachMemory, studioPlans } from "@rg/database";
import {
  focusAreaSchema,
  GOAL_IDS,
  isLocalDate,
  nowInstant,
  planBriefSchema,
  profileEventSchema,
  profileGoalSchema,
  todayInZone,
  type FocusArea,
  type ProfileEvent,
  type ProfileGoal,
} from "@rg/domain";
import { sha256Hex } from "../auth/crypto.js";
import { canonicalJson } from "./account-tables.js";
import { loadPreferences } from "./calendar-sync.js";
import { runAtomically, type AtomicStatement, type Db } from "./db.js";
import { liveMemoryWhere } from "./memory-core.js";

type GoalId = (typeof GOAL_IDS)[number];
type EventKind = ProfileEvent["kind"];

/** The profile's own caps (`profileUpdateSchema`). */
const PROFILE_MAX = { goals: 10, focusAreas: 20, events: 40 } as const;
/** An event's name, at most (`profileEventSchema`). */
const EVENT_LABEL_MAX = 80;
const WORDS_MAX = 300;
const FOCUS_LABEL_MAX = 60;
const FOCUS_ID_MAX = 40;
/** The id prefix of the items the old Studio's brief becomes. */
const BRIEF_PREFIX = "studio-brief:";
/** What every copied item's note says: the live thread coach reads only memory (A-I1). */
export const KEPT_IN_MEMORY_TOO = "Kept in memory too, until the thread coach reads the profile.";

// ── The report ──────────────────────────────────────────────────────────────

export type Shape = "event" | "goal" | "focus_area" | "place";
export interface MemoryMove {
  id: string;
  kind: string;
  body: string;
  shape: Shape;
  /** The profile's entry this item would be: null when none (a place; an item left as it is). */
  profile: { field: "events"; entry: ProfileEvent } | { field: "goals"; entry: ProfileGoal } | { field: "focusAreas"; entry: FocusArea } | null;
  /** add: the profile gains it; already: the profile (or Settings) holds it; none: nothing changes in the profile. */
  change: "add" | "already" | "none";
  /** Always kept: live in memory as it is, whatever the profile gains (copy, not move — A-I1). */
  memory: "kept";
  note: string;
}

export interface BriefToProfile {
  field: "goal" | "sessionMinutes" | "preferredDays";
  profile: "goals" | "preferences.sessionMinutes" | "preferences.trainingDays";
  value: unknown;
  change: "add" | "already";
}
export interface BriefToMemory {
  field: "equipment" | "constraints" | "notes";
  id: string;
  kind: "fact" | "rule";
  body: string;
  change: "add" | "already";
}
export interface StudioBriefSection {
  planId: string;
  readable: boolean;
  toProfile: BriefToProfile[];
  toMemory: BriefToMemory[];
  notCarried: Array<{ field: string; why: string }>;
}

export interface MigrationReport {
  dryRun: boolean;
  /** The athlete's today: what "past" means for an event. */
  today: string;
  /** The plan's fingerprint: an apply carries it back, and a plan that changed since is refused. */
  fingerprint: string;
  memory: { read: number; items: MemoryMove[] };
  studioBrief: StudioBriefSection | null;
  /** One plain line for each change, for the owner. */
  lines: string[];
  /** What the apply wrote: the profile, and how many of the brief's items it added (it supersedes none). */
  applied?: { profile: boolean; added: number };
}

// ── Reading the signs ───────────────────────────────────────────────────────

const DATE = /\b(\d{4}-\d{2}-\d{2})\b/g;
const EVENT_WORDS: ReadonlyArray<readonly [EventKind, RegExp]> = [
  ["race", /\b(race|races|racing|marathon|half[- ]marathon|\d+ ?k race|10 ?k|5 ?k|ultra|triathlon|parkrun|relay)\b/i],
  ["ski", /\bski(s|ing|er|ers)?\b/i],
  ["trip", /\b(trip|holiday|vacation|getaway|camping)\b/i],
  ["travel", /\b(travel|travels|travelling|traveling|flight|flying|abroad)\b/i],
  ["other", /\b(event|wedding|conference|festival|competition)\b/i],
];
const KIND_WORDS: Record<EventKind, string> = { race: "a race", ski: "a ski week", trip: "a trip", travel: "travel", other: "an event" };

const GOAL_SIGN = /\b(goals?|wants? to|would like to|aim(s|ing)? (to|for)|working (on|towards?)|training for|hopes? to)\b/i;
const GOAL_WORDS: ReadonlyArray<readonly [GoalId, RegExp]> = [
  ["ski", /\bski(s|ing|er)?\b/i],
  ["posture", /\bposture\b/i],
  ["alignment", /\balignment\b/i],
  ["athleticism", /\b(athletic|athleticism|agility|agile)\b/i],
  ["aerobic-base", /\b(aerobic|endurance)\b/i],
  ["speed", /\b(speed|faster|quicker|personal best)\b/i],
  ["strength", /\b(strength|stronger)\b/i],
  ["mobility", /\b(mobility|flexible|flexibility|range of motion)\b/i],
  ["recovery", /\b(recovery|recover)\b/i],
];

const FOCUS_SIGN = /\b(focus(ing)? on|focus areas?|work(ing)? on|strengthen(ing)?|weak|weakness|weaker|tight|tightness|imbalance)\b/i;
const PAIN = /\b(pain|painful|injury|injured|injuries|hurt|hurts|hurting|sore|soreness|flare|flares|flaring|strain|strained|sprain|sprained|tear|torn|surgery)\b/i;
/** The library's regions by the words for them; a condition's own area (the jaw) is its profile's, never a focus. */
const REGION_WORDS: ReadonlyArray<readonly [string, string, RegExp]> = [
  ["neck", "neck", /\bneck\b/i],
  ["upper-back", "upper back", /\bupper back\b/i],
  ["thoracic", "mid back", /\b(thoracic|mid back)\b/i],
  ["shoulders", "shoulders", /\bshoulders?\b/i],
  ["chest", "chest", /\bchest\b/i],
  ["lats", "lats", /\blats\b/i],
  ["arms", "arms", /\barms?\b/i],
  ["core", "core", /\bcore\b/i],
  ["low-back", "low back", /\blow(er)? back\b/i],
  ["hips", "hips", /\bhips?\b/i],
  ["glutes", "glutes", /\bglutes?\b/i],
  ["hamstrings", "hamstrings", /\bhamstrings?\b/i],
  ["quads", "quads", /\bquads?\b/i],
  ["calves", "calves", /\b(calf|calves)\b/i],
  ["ankles", "ankles", /\bankles?\b/i],
  ["feet", "feet", /\b(foot|feet)\b/i],
];
const PLACE_SIGN = /\b(trains? at|works? out at|home gym|garage gym|at the gym|at home|gym membership)\b/i;

const cut = (text: string, max: number): string => (text.length <= max ? text : `${text.slice(0, max - 1).trimEnd()}…`);
const quoted = (body: string): string => `"${cut(body.replace(/\s+/g, " ").trim(), 120)}"`;
const goalWords = (id: string): string => id.replace(/-/g, " ");
const span = (e: { start: string; end?: string }): string => (e.end ? `${e.start} to ${e.end}` : e.start);

// ── The stored profile, as it is ────────────────────────────────────────────

interface StoredProfile {
  exists: boolean;
  /** Each list as stored (entries no schema takes any more kept as they are); null when it doesn't read at all. */
  goals: unknown[] | null;
  focusAreas: unknown[] | null;
  events: unknown[] | null;
  preferences: Record<string, unknown> | null;
}

function parsed(text: string | null | undefined): unknown {
  if (text === null || text === undefined) return undefined;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}
const listOf = (text: string | null | undefined): unknown[] | null => {
  const v = parsed(text);
  return v === undefined ? [] : Array.isArray(v) ? v : null;
};
const objectOf = (text: string | null | undefined): Record<string, unknown> | null => {
  const v = parsed(text);
  return v === undefined ? {} : v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
};
const readable = <T>(list: unknown[] | null, schema: { safeParse: (v: unknown) => { success: boolean; data?: T } }): T[] =>
  (list ?? []).flatMap((e) => {
    const p = schema.safeParse(e);
    return p.success ? [p.data as T] : [];
  });

// ── The plan ────────────────────────────────────────────────────────────────

interface MemoryRow {
  id: string;
  kind: string;
  body: string;
  active: boolean;
}

interface Plan {
  today: string;
  read: number;
  items: MemoryMove[];
  brief: StudioBriefSection | null;
  profile: StoredProfile;
  /** The profile's parts as they would be written: null when nothing in it changes. */
  write: { goals?: unknown[]; focusAreas?: unknown[]; events?: unknown[]; preferences?: Record<string, unknown> } | null;
  /** The brief's new memory items. */
  newMemory: Array<BriefToMemory & { planId: string }>;
}

async function plan(db: Db, userId: string): Promise<Plan> {
  const prefs = await loadPreferences(db, userId);
  const today = todayInZone(prefs.timezone);
  const m = coachMemory;
  const rows = (await db
    .select({ id: m.id, kind: m.kind, body: m.body, active: m.active, supersededBy: m.supersededBy })
    .from(m)
    .where(and(eq(m.userId, userId), sql`(${liveMemoryWhere(userId, today)} or substr(${m.id}, 1, ${BRIEF_PREFIX.length}) = ${BRIEF_PREFIX})`))
    .orderBy(asc(m.learnedAt), asc(m.id))) as Array<MemoryRow & { supersededBy: string | null }>;
  const [stored] = await db
    .select({
      goals: sql<string | null>`${athleteProfiles.goals}`,
      focusAreas: sql<string | null>`${athleteProfiles.focusAreas}`,
      events: sql<string | null>`${athleteProfiles.events}`,
      preferences: sql<string | null>`${athleteProfiles.preferences}`,
    })
    .from(athleteProfiles)
    .where(eq(athleteProfiles.userId, userId))
    .limit(1);
  const [studio] = await db
    .select({ id: studioPlans.id, brief: sql<string | null>`${studioPlans.brief}` })
    .from(studioPlans)
    .where(eq(studioPlans.userId, userId))
    .orderBy(desc(studioPlans.updatedAt), desc(studioPlans.id))
    .limit(1);

  const profile: StoredProfile = {
    exists: !!stored,
    goals: listOf(stored?.goals),
    focusAreas: listOf(stored?.focusAreas),
    events: listOf(stored?.events),
    preferences: objectOf(stored?.preferences),
  };
  const goals = readable<ProfileGoal>(profile.goals, profileGoalSchema);
  const focusAreas = readable<FocusArea>(profile.focusAreas, focusAreaSchema);
  const events = readable<ProfileEvent>(profile.events, profileEventSchema);
  const added = { goals: [] as ProfileGoal[], focusAreas: [] as FocusArea[], events: [] as ProfileEvent[] };
  const room = (field: keyof typeof added): boolean =>
    profile[field] !== null && (profile[field]!.length + added[field].length) < PROFILE_MAX[field];

  const live = rows.filter((r) => r.supersededBy === null && r.active && !r.id.startsWith(BRIEF_PREFIX));
  const items: MemoryMove[] = [];
  for (const r of live) {
    const move = await classify(r, { today, raceDate: prefs.raceDate, goals: [...goals, ...added.goals], focusAreas: [...focusAreas, ...added.focusAreas], events: [...events, ...added.events], room });
    if (!move) continue;
    if (move.change === "add" && move.profile) {
      if (move.profile.field === "events") added.events.push(move.profile.entry);
      if (move.profile.field === "goals") added.goals.push(move.profile.entry);
      if (move.profile.field === "focusAreas") added.focusAreas.push(move.profile.entry);
    }
    items.push(move);
  }

  // The old Studio's brief.
  let brief: StudioBriefSection | null = null;
  const newMemory: Plan["newMemory"] = [];
  const prefsAdd: Record<string, unknown> = {};
  if (studio) {
    const b = planBriefSchema.safeParse(parsed(studio.brief));
    brief = { planId: studio.id, readable: b.success, toProfile: [], toMemory: [], notCarried: [] };
    if (b.success) {
      const goal: GoalId = b.data.goal === "general" ? "athleticism" : "strength";
      const goalWordsOf = { strength: "Get stronger", hypertrophy: "Build muscle", general: "General fitness" }[b.data.goal];
      const has = [...goals, ...added.goals].some((g) => g.id === goal);
      if (!has && room("goals")) added.goals.push({ id: goal, words: `${goalWordsOf} (the old Studio's plan goal)` });
      brief.toProfile.push({ field: "goal", profile: "goals", value: { id: goal }, change: has ? "already" : "add" });
      const prefsStored = profile.preferences ?? {};
      const minutes = { default: b.data.sessionMinutes };
      const minutesSet = prefsStored.sessionMinutes !== undefined || profile.preferences === null;
      if (!minutesSet) prefsAdd.sessionMinutes = minutes;
      brief.toProfile.push({ field: "sessionMinutes", profile: "preferences.sessionMinutes", value: minutes, change: minutesSet ? "already" : "add" });
      const days = [...new Set(b.data.preferredDays.map((d) => d - 1))].sort((x, y) => x - y);
      const daysSet = prefsStored.trainingDays !== undefined || profile.preferences === null;
      if (!daysSet) prefsAdd.trainingDays = days;
      brief.toProfile.push({ field: "preferredDays", profile: "preferences.trainingDays", value: days, change: daysSet ? "already" : "add" });
      const have = new Set(rows.filter((r) => r.id.startsWith(BRIEF_PREFIX)).map((r) => r.id));
      const texts: Array<[BriefToMemory["field"], BriefToMemory["kind"], string]> = [
        ["equipment", "fact", b.data.equipment.trim() ? `Equipment: ${b.data.equipment.trim()}` : ""],
        ["constraints", "rule", b.data.constraints.trim()],
        ["notes", "fact", b.data.notes.trim()],
      ];
      for (const [field, kind, body] of texts) {
        if (!body) {
          brief.notCarried.push({ field, why: "empty" });
          continue;
        }
        const id = `${BRIEF_PREFIX}${studio.id}:${field}`;
        const entry: BriefToMemory = { field, id, kind, body, change: have.has(id) ? "already" : "add" };
        brief.toMemory.push(entry);
        if (entry.change === "add") newMemory.push({ ...entry, planId: studio.id });
      }
      brief.notCarried.unshift(
        { field: "durationWeeks", why: "the old plan's own length" },
        { field: "sessionsPerWeek", why: "the old plan's own: training days carry the rhythm" },
        { field: "startDate", why: "the old plan's own start" },
      );
    }
  }

  // Only a part that reads is written (a part that doesn't gains nothing — `room` — and is left exactly as stored).
  const changed = added.goals.length + added.focusAreas.length + added.events.length + Object.keys(prefsAdd).length > 0;
  const write = changed
    ? {
        ...(profile.goals !== null ? { goals: [...profile.goals, ...added.goals] } : {}),
        ...(profile.focusAreas !== null ? { focusAreas: [...profile.focusAreas, ...added.focusAreas] } : {}),
        ...(profile.events !== null ? { events: [...profile.events, ...added.events] } : {}),
        ...(profile.preferences !== null ? { preferences: { ...profile.preferences, ...prefsAdd } } : {}),
      }
    : null;
  return { today, read: live.length, items, brief, profile, write, newMemory };
}

interface Seen {
  today: string;
  raceDate: string | null;
  goals: ProfileGoal[];
  focusAreas: FocusArea[];
  events: ProfileEvent[];
  room: (field: "goals" | "focusAreas" | "events") => boolean;
}

async function classify(r: MemoryRow, seen: Seen): Promise<MemoryMove | null> {
  const body = r.body.trim();
  const base = { id: r.id, kind: r.kind, body: r.body };
  if (r.kind === "observation") return null;

  // An event: a date, and a word for one.
  const dates = [...body.matchAll(DATE)].map((d) => d[1]!).filter((d) => isLocalDate(d)).sort();
  const eventKind = EVENT_WORDS.find(([, re]) => re.test(body))?.[0];
  if (dates.length > 0 && eventKind) {
    const start = dates[0]!;
    const last = dates.at(-1)!;
    const id = `mem-${(await sha256Hex(r.id)).slice(0, 16)}`;
    const fits = body.length <= EVENT_LABEL_MAX;
    const entry: ProfileEvent = profileEventSchema.parse({
      id,
      label: cut(body, EVENT_LABEL_MAX),
      kind: eventKind,
      start,
      ...(last > start ? { end: last } : {}),
      priority: eventKind === "race" ? "B" : "C",
      taper: eventKind === "race",
    });
    const what = `${KIND_WORDS[eventKind]}, ${span(entry)}`;
    if ((entry.end ?? entry.start) < seen.today) {
      return { ...base, shape: "event", profile: null, change: "none", memory: "kept", note: `${quoted(body)} → a past event: left in memory.` };
    }
    const settingsRace = eventKind === "race" && seen.raceDate === start;
    const there = seen.events.find((e) => e.id === id || (e.kind === eventKind && e.start === start));
    const kept = fits ? KEPT_IN_MEMORY_TOO : `${KEPT_IN_MEMORY_TOO} The event's name is its first ${EVENT_LABEL_MAX} characters.`;
    if (settingsRace) {
      return { ...base, shape: "event", profile: null, change: "already", memory: "kept", note: `${quoted(body)} → already your race in Settings. ${KEPT_IN_MEMORY_TOO}` };
    }
    if (there) {
      return { ...base, shape: "event", profile: { field: "events", entry: there }, change: "already", memory: "kept", note: `${quoted(body)} → already in the profile's events (${KIND_WORDS[there.kind]}, ${span(there)}). ${KEPT_IN_MEMORY_TOO}` };
    }
    if (!seen.room("events")) {
      return { ...base, shape: "event", profile: null, change: "none", memory: "kept", note: `${quoted(body)} → ${what}, but the profile holds at most ${PROFILE_MAX.events} events: left in memory.` };
    }
    return { ...base, shape: "event", profile: { field: "events", entry }, change: "add", memory: "kept", note: `${quoted(body)} → the profile's events: ${what}. ${kept}` };
  }

  if (r.kind !== "fact" && r.kind !== "rule") return null;

  // A goal: goal words naming exactly one of the profile's goals.
  if (GOAL_SIGN.test(body)) {
    const named = GOAL_WORDS.filter(([, re]) => re.test(body)).map(([id]) => id);
    if (named.length > 1) {
      return { ...base, shape: "goal", profile: null, change: "none", memory: "kept", note: `${quoted(body)} → names more than one goal (${named.map(goalWords).join(", ")}): left in memory.` };
    }
    if (named.length === 1) {
      const id = named[0]!;
      const there = seen.goals.find((g) => g.id === id);
      if (there) {
        return { ...base, shape: "goal", profile: { field: "goals", entry: there }, change: "already", memory: "kept", note: `${quoted(body)} → the profile already has the goal ${goalWords(id)}: left in memory.` };
      }
      if (!seen.room("goals")) {
        return { ...base, shape: "goal", profile: null, change: "none", memory: "kept", note: `${quoted(body)} → the goal ${goalWords(id)}, but the profile holds at most ${PROFILE_MAX.goals} goals: left in memory.` };
      }
      const entry: ProfileGoal = profileGoalSchema.parse({ id, words: cut(body, WORDS_MAX) });
      return { ...base, shape: "goal", profile: { field: "goals", entry }, change: "add", memory: "kept", note: `${quoted(body)} → the profile's goals: ${goalWords(id)}. ${KEPT_IN_MEMORY_TOO}` };
    }
  }

  // A focus area: focus words and regions, never a health signal.
  if (FOCUS_SIGN.test(body) && !PAIN.test(body)) {
    const regions = REGION_WORDS.filter(([, , re]) => re.test(body));
    if (regions.length > 0) {
      const refs = regions.map(([id]) => id);
      const label = cut(regions.map(([, words]) => words).join(" and ").replace(/^./, (c) => c.toUpperCase()), FOCUS_LABEL_MAX);
      const there = seen.focusAreas.find((f) => refs.every((ref) => f.refs.includes(ref)));
      if (there) {
        return { ...base, shape: "focus_area", profile: { field: "focusAreas", entry: there }, change: "already", memory: "kept", note: `${quoted(body)} → already a focus area in the profile (${there.label}): left in memory.` };
      }
      if (!seen.room("focusAreas")) {
        return { ...base, shape: "focus_area", profile: null, change: "none", memory: "kept", note: `${quoted(body)} → a focus area, but the profile holds at most ${PROFILE_MAX.focusAreas}: left in memory.` };
      }
      const entry: FocusArea = focusAreaSchema.parse({ id: refs.join("-").slice(0, FOCUS_ID_MAX).replace(/-+$/, ""), label, refs, note: cut(body, WORDS_MAX) });
      return { ...base, shape: "focus_area", profile: { field: "focusAreas", entry }, change: "add", memory: "kept", note: `${quoted(body)} → a focus area in the profile: ${label}. ${KEPT_IN_MEMORY_TOO}` };
    }
  }

  // A place: reported, never moved.
  if (PLACE_SIGN.test(body)) {
    return { ...base, shape: "place", profile: null, change: "none", memory: "kept", note: `${quoted(body)} → a place: set it in Settings → Places. Left in memory.` };
  }
  return null;
}

function briefLines(b: StudioBriefSection | null): string[] {
  if (!b) return [];
  if (!b.readable) return ["The old Studio's plan brief doesn't read: nothing is taken from it."];
  const out: string[] = [];
  for (const f of b.toProfile) {
    const what =
      f.field === "goal"
        ? `its goal → the profile's goals: ${goalWords((f.value as { id: string }).id)}`
        : f.field === "sessionMinutes"
          ? `its session length (${(f.value as { default: number }).default} min) → the profile's usual session length`
          : `its training days → the profile's training days`;
    out.push(`The old Studio's plan: ${what}${f.change === "already" ? " — already set; left as it is." : "."}`);
  }
  for (const f of b.toMemory) {
    out.push(`The old Studio's plan: its ${f.field} → a memory ${f.kind}, ${quoted(f.body)}${f.change === "already" ? " — already there; left as it is." : "."}`);
  }
  return out;
}

async function reportOf(p: Plan, dryRun: boolean): Promise<MigrationReport> {
  const fingerprint = (await sha256Hex(canonicalJson({ items: p.items, studioBrief: p.brief }))).slice(0, 32);
  return {
    dryRun,
    today: p.today,
    fingerprint,
    memory: { read: p.read, items: p.items },
    studioBrief: p.brief,
    lines: [...p.items.map((i) => i.note), ...briefLines(p.brief)],
  };
}

/** The dry run: reads only. */
export async function migrationDryRun(db: Db, userId: string): Promise<MigrationReport> {
  return reportOf(await plan(db, userId), true);
}

export type ApplyOutcome = { kind: "applied"; report: MigrationReport } | { kind: "changed"; report: MigrationReport };

/**
 * Apply the plan the dry run with `fingerprint` reported — refused, writing nothing, when the plan is another now. Two
 * writes at most, as one batch: the profile, and the brief's new items (at most three). No memory item is changed.
 */
export async function migrationApply(db: Db, userId: string, fingerprint: string): Promise<ApplyOutcome> {
  const p = await plan(db, userId);
  const report = await reportOf(p, false);
  const nothing = !p.write && p.newMemory.length === 0;
  if (!nothing && report.fingerprint !== fingerprint) return { kind: "changed", report: { ...report, dryRun: true } };
  const now = nowInstant();
  const m = coachMemory;
  const statements: AtomicStatement[] = [];
  if (p.write) {
    statements.push(
      db
        .insert(athleteProfiles)
        .values({ id: userId, userId, ...p.write, updatedAt: now })
        .onConflictDoUpdate({ target: athleteProfiles.userId, set: { ...p.write, updatedAt: now } }),
    );
  }
  if (p.newMemory.length > 0) {
    statements.push(
      db
        .insert(m)
        .values(
          p.newMemory.map((n) => ({
            id: n.id,
            userId,
            kind: n.kind,
            body: n.body,
            provenance: { source: "studio_brief", planId: n.planId, at: now } as unknown as typeof m.$inferInsert.provenance,
            learnedAt: now,
            active: true,
            pinned: false,
            confidence: "stated",
            updatedAt: now,
          })),
        )
        .onConflictDoNothing(),
    );
  }
  await runAtomically(db, statements);
  return { kind: "applied", report: { ...report, applied: { profile: p.write !== null, added: p.newMemory.length } } };
}
