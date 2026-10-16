/**
 * THE STUDIO'S DECISIONS, PURE (Stage 2 spec §3–§5). Everything the Studio's screens decide that needs no React, so
 * each rule is a test and the screens only draw:
 *
 *   readStudio / studioSearch  the URL is the state: the query, the filters, "all moves". Back leaves the results.
 *   fitToday                   a move against every switched-on condition profile for TODAY's reading: fits (safe even
 *                              on a flare day) · care (allowed today, within the profile's limits) · not today — with
 *                              the reason in plain words, the profile's own where it has them. Computed on the device
 *                              from the bundled library and its profiles, so it works offline.
 *   studioResults              the shared `searchLibrary` over the bundled library (no network): the filters, then the
 *                              Studio's two defaults — the place's gear and "fits today" while a profile is on — and the
 *                              athlete's lean (pins and ratings up, "not for me" down) for ties.
 *   activeChips / loosenings   every filter in force as a removable chip, the defaults included; for an empty result,
 *                              the removals that would show the most.
 *   browse / themes / tags     what the home offers, each only where it opens something.
 *   doseLine / historyLine     line 4 of a row: the dose Add puts in, the athlete's history with the move.
 */
import {
  CONTRACTIONS,
  EQUIPMENT,
  EQUIPMENT_IDS,
  FIT_RANK,
  fitToday as libraryFitToday,
  hasEquipment,
  isProfileId,
  label,
  LOCATION_PRESETS,
  NO_EQUIPMENT_PLACE_ID,
  noEquipmentPlace,
  MUSCLES,
  PROFILES,
  PURPOSES,
  REGIONS,
  searchLibrary,
  TAGS,
  THEMES,
  type CheckReading,
  type ConditionProfile,
  type Contraction,
  type EquipmentId,
  type ExerciseRecord,
  type FitState as LibraryFitState,
  type LibraryFilters,
  type MuscleId,
  type Purpose,
  type Region,
  type Tag,
  type Theme,
} from "@rg/exercise-library";
import type { LibraryListDto, PlacesResponse, TodayResponse } from "@rg/api-client";
import type { ProfileDto } from "@rg/domain";
import { QUICK_START_MINUTES, doseFor, placementFor, quickStartKinds, type QuickStartKind } from "@rg/workout";
import { doseSummary } from "@rg/domain";
import { formatShortDate } from "../../components.js";

// ── State: the URL ─────────────────────────────────────────────────────────

export type Mine = "pinned" | "set-aside";

/** One value per facet. Absent means "no filter", except the two defaults (`gear`, `fit`), which absent means ON. */
export interface StudioFilters {
  /** A part of a workout: the move's purpose. */
  part?: Purpose;
  /** How the muscles work: the move's contraction. */
  how?: Contraction;
  /** A body area (region); `muscle` narrows it. */
  area?: Region;
  muscle?: MuscleId;
  /** `any`, or a move that uses this gear. Absent (and no `place`): the moves the default place's gear can do. */
  gear?: "any" | EquipmentId;
  /** The moves another place's gear can do: one of the athlete's places, or "none" — bodyweight only (CUJ re-walk §2.3). */
  place?: string;
  tag?: Tag;
  theme?: string;
  /** The hardest difficulty shown (1–4). */
  max?: number;
  /** The athlete turned "fits today" off. Absent: on while a profile is on. */
  fit?: false;
  mine?: Mine;
}

export interface StudioState {
  q: string;
  filters: StudioFilters;
  /** "All moves" was asked for: the list shows with nothing else set. */
  all: boolean;
  /** The list replaces the home. */
  listing: boolean;
}

const MINE: readonly Mine[] = ["pinned", "set-aside"];
const THEME_IDS = new Set(THEMES.map((t) => t.id));
const oneOf = <T extends string>(xs: readonly T[], v: string | null): T | undefined =>
  v !== null && (xs as readonly string[]).includes(v) ? (v as T) : undefined;

/** The Studio's state from its URL; a value outside its vocabulary is ignored. */
export function readStudio(params: URLSearchParams): StudioState {
  const f: StudioFilters = {};
  const part = oneOf(PURPOSES, params.get("part"));
  const how = oneOf(CONTRACTIONS, params.get("how"));
  const area = oneOf(REGIONS, params.get("area"));
  const muscle = oneOf(MUSCLES, params.get("muscle"));
  const gearParam = params.get("gear");
  const gear = gearParam === "any" ? "any" : oneOf(EQUIPMENT_IDS, gearParam);
  const tag = oneOf(TAGS, params.get("tag"));
  const theme = params.get("theme");
  const max = Number(params.get("max"));
  const mine = oneOf(MINE, params.get("mine"));
  if (part) f.part = part;
  if (how) f.how = how;
  if (area) f.area = area;
  if (muscle) f.muscle = muscle;
  if (gear) f.gear = gear;
  const place = params.get("place");
  if (place && place.length <= 80 && !gear) f.place = place;
  if (tag) f.tag = tag;
  if (theme && THEME_IDS.has(theme)) f.theme = theme;
  if (Number.isInteger(max) && max >= 1 && max <= 4) f.max = max;
  if (params.get("fit") === "0") f.fit = false;
  if (mine) f.mine = mine;
  const q = params.get("q") ?? "";
  const all = params.get("all") === "1";
  return { q, filters: f, all, listing: q.trim() !== "" || all || Object.keys(f).length > 0 };
}

/** The URL search for a state, keys in one order ("" for the home). */
export function studioSearch(q: string, f: StudioFilters, all = false): string {
  const p = new URLSearchParams();
  if (q !== "") p.set("q", q);
  if (all) p.set("all", "1");
  if (f.part) p.set("part", f.part);
  if (f.how) p.set("how", f.how);
  if (f.area) p.set("area", f.area);
  if (f.muscle) p.set("muscle", f.muscle);
  if (f.gear) p.set("gear", f.gear);
  if (f.place) p.set("place", f.place);
  if (f.tag) p.set("tag", f.tag);
  if (f.theme) p.set("theme", f.theme);
  if (f.max) p.set("max", String(f.max));
  if (f.fit === false) p.set("fit", "0");
  if (f.mine) p.set("mine", f.mine);
  const s = p.toString();
  return s ? `?${s}` : "";
}

// ── What the Studio knows about the athlete ────────────────────────────────

/** The athlete's say on, and history with, one move (`GET /api/library`). */
export interface MovePrefs {
  rating: 1 | -1 | null;
  pinned: boolean;
  excluded: boolean;
  lastDoneOn: string | null;
  timesDone30d: number;
  /**
   * Done cleanly (the server's `isDoneCleanly`): what the builder's validator reads as the jump frontier. Null when the
   * read does not say — an older cached payload, from before the field — so nothing is claimed either way.
   */
  doneCleanly: boolean | null;
}

export interface StudioCtx {
  /** The switched-on condition profiles. */
  profiles: readonly ConditionProfile[];
  /** Today's reading per profile id; a missing one reads as unanswered. */
  readings: Readonly<Record<string, CheckReading>>;
  /** Per move id; empty offline (the list still works). */
  prefs: ReadonlyMap<string, MovePrefs>;
  /** The default place and its gear (its id, unless it is the library's Home: no place saved); null until known (then no gear filter applies). */
  place: { id?: string; name: string; equipment: readonly string[] } | null;
  /** The athlete's places, the default first; empty until known, or with none saved (CUJ R8). */
  places: ReadonlyArray<{ id: string; name: string; equipment: readonly string[] }>;
  /** The profile's focus areas, as the region and muscle ids they name, each once; empty until known (CUJ R7). */
  focusRefs: readonly string[];
  /** The athlete's today (their timezone), for "last done". */
  today: string | null;
  /** The account's timezone (the profile's): its days, where no Today read says which one it is (CUJ J34). */
  timeZone: string | null;
}

export const emptyStudioCtx: StudioCtx = { profiles: [], readings: {}, prefs: new Map(), place: null, places: [], focusRefs: [], today: null, timeZone: null };

/**
 * The default place, in the server's order (apps/worker/src/services/default-place.ts): the profile's chosen default
 * while it is still one of the athlete's places, else the place marked default, else the first made — `GET /api/places`
 * lists the marked default first, then by creation. Null with no place at all (the caller's Home preset then).
 */
export function defaultPlaceOf<P extends { id: string; isDefault: boolean }>(places: readonly P[], chosenId: string | undefined): P | null {
  return (chosenId ? places.find((p) => p.id === chosenId) : undefined) ?? places.find((p) => p.isDefault) ?? places[0] ?? null;
}

/**
 * The context from the four reads the Studio makes, each optional: offline, or before they answer, the list still
 * renders from the bundled library and simply knows less. The switched-on profiles come from the library read and
 * from today's (which the service worker keeps offline); the place is the default place in the server's order
 * (`defaultPlaceOf`), else the library's Home; the focus areas come from the profile.
 */
export function studioCtxFrom(library?: LibraryListDto, today?: TodayResponse, places?: PlacesResponse, profile?: ProfileDto): StudioCtx {
  const ids = [...new Set([...(library?.profiles ?? []).map((p) => p.profileId), ...(today?.conditions ?? []).map((c) => c.profileId)])];
  const readings: Record<string, CheckReading> = {};
  for (const c of today?.conditions ?? []) {
    readings[c.profileId] = { pre: c.today?.value ?? null, post: null, feelingOff: c.today?.feelingOff ?? false };
  }
  const prefs = new Map<string, MovePrefs>(
    (library?.items ?? []).map((r) => [
      r.id,
      // An older payload (a cached read from before `doneCleanly`) does not say: unknown, not "never done cleanly".
      { rating: r.rating, pinned: r.pinned, excluded: r.excluded, lastDoneOn: r.lastDoneOn, timesDone30d: r.timesDone30d, doneCleanly: typeof r.doneCleanly === "boolean" ? r.doneCleanly : null },
    ]),
  );
  let place: StudioCtx["place"] = null;
  const list = places?.places ?? [];
  const chosen = defaultPlaceOf(list, profile?.preferences.defaultPlaceId);
  if (places) {
    const preset = LOCATION_PRESETS.find((p) => p.id === "home") ?? LOCATION_PRESETS[0]!;
    place = chosen ? { id: chosen.id, name: chosen.name, equipment: chosen.equipment } : { name: preset.name, equipment: preset.equipment };
  }
  return {
    profiles: ids.filter(isProfileId).map((id) => PROFILES[id]),
    readings,
    prefs,
    place,
    places: (chosen ? [chosen, ...list.filter((p) => p !== chosen)] : list).map((p) => ({ id: p.id, name: p.name, equipment: p.equipment })),
    focusRefs: [...new Set((profile?.focusAreas ?? []).flatMap((f) => f.refs))],
    today: today?.today ?? null,
    timeZone: profile?.timezone ?? null,
  };
}

// ── Today's condition fit ──────────────────────────────────────────────────

export type FitState = LibraryFitState;
export interface Fit {
  state: FitState;
  /** The status word, always shown beside the colour. */
  word: string;
  /** Why, one tap down. */
  reason: string;
}

export const FIT_WORD: Readonly<Record<FitState, string>> = { fits: "Fits today", care: "With care", not: "Not today" };

/** The library's one fit-today rule (the coach's search reads it too), with the status word the list shows. */
export function fitToday(
  rec: ExerciseRecord,
  profiles: readonly ConditionProfile[],
  readings: Readonly<Record<string, CheckReading>>,
): Fit | null {
  const f = libraryFitToday(rec, profiles, readings);
  return f ? { state: f.state, word: FIT_WORD[f.state], reason: f.reason } : null;
}

const fitCache = new WeakMap<StudioCtx, Map<string, Fit | null>>();
/** `fitToday` for a context, computed once per move per context. */
export function fitOf(rec: ExerciseRecord, ctx: StudioCtx): Fit | null {
  let m = fitCache.get(ctx);
  if (!m) fitCache.set(ctx, (m = new Map()));
  if (!m.has(rec.id)) m.set(rec.id, fitToday(rec, ctx.profiles, ctx.readings));
  return m.get(rec.id)!;
}

// ── Results ────────────────────────────────────────────────────────────────

/** "Fits today" is in force: a profile is on and the athlete has not turned it off. */
export const fitFilterOn = (f: StudioFilters, ctx: StudioCtx): boolean => f.fit !== false && ctx.profiles.length > 0;
const fitOn = fitFilterOn;
const placeGearOn = (f: StudioFilters, ctx: StudioCtx): boolean => f.gear === undefined && f.place === undefined && ctx.place !== null;

/** A place by its id: one of the athlete's, or the library's "No equipment" (bodyweight plus a bare room's props). */
export function placeById(ctx: StudioCtx, id: string): { id?: string; name: string; equipment: readonly string[] } | null {
  if (id === NO_EQUIPMENT_PLACE_ID) return noEquipmentPlace();
  return ctx.places.find((p) => p.id === id) ?? null;
}

/** The athlete's lean for ties: a pin and a thumbs-up lift a move, a thumbs-down lowers it, "not for me" sinks it. */
function lean(ctx: StudioCtx): (id: string) => number {
  return (id) => {
    const p = ctx.prefs.get(id);
    return p ? (p.pinned ? 2 : 0) + (p.rating ?? 0) - (p.excluded ? 4 : 0) : 0;
  };
}

/** The moves the Studio lists for a query and filters, best first. */
export function studioResults(records: readonly ExerciseRecord[], q: string, f: StudioFilters, ctx: StudioCtx): ExerciseRecord[] {
  const lib: LibraryFilters = {
    purpose: f.part,
    contraction: f.how,
    region: f.area,
    muscle: f.muscle,
    equipment: f.gear && f.gear !== "any" ? f.gear : undefined,
    tag: f.tag,
    theme: f.theme,
    maxDifficulty: f.max,
  };
  const byFit = fitOn(f, ctx);
  const byPlace = placeGearOn(f, ctx);
  // Another place chosen: its gear (one not known here yet, the default's).
  const chosen = f.place !== undefined ? (placeById(ctx, f.place) ?? ctx.place) : null;
  return searchLibrary(records, q, lib, {
    accepts: (rec) =>
      (!byPlace || hasEquipment(rec, ctx.place!.equipment)) &&
      (!chosen || hasEquipment(rec, chosen.equipment)) &&
      (!byFit || fitOf(rec, ctx)?.state !== "not") &&
      (f.mine !== "pinned" || ctx.prefs.get(rec.id)?.pinned === true) &&
      (f.mine !== "set-aside" || ctx.prefs.get(rec.id)?.excluded === true),
    fit: (rec) => FIT_RANK[fitOf(rec, ctx)?.state ?? "fits"],
    boost: lean(ctx),
  });
}

// ── Chips ──────────────────────────────────────────────────────────────────

export interface Chip {
  /** Stable for React keys. */
  key: string;
  label: string;
  /** The filters with this one removed. */
  without: StudioFilters;
  /** One of the Studio's own defaults (the place's gear, today's fit) rather than one the athlete set. */
  isDefault: boolean;
}

const omit = (f: StudioFilters, ...keys: Array<keyof StudioFilters>): StudioFilters => {
  const out = { ...f };
  for (const k of keys) delete out[k];
  return out;
};

export const themeName = (id: string): string => THEMES.find((t) => t.id === id)?.name ?? id;
export const difficultyLabel = (max: number): string => (max === 1 ? "Difficulty 1" : `Difficulty 1–${max}`);
const MINE_LABEL: Readonly<Record<Mine, string>> = { pinned: "Pinned", "set-aside": "Not for me" };

/** Every filter in force, in facet order, then the defaults: each a chip that removes it. */
export function activeChips(f: StudioFilters, ctx: StudioCtx): Chip[] {
  const out: Chip[] = [];
  const add = (key: string, text: string, without: StudioFilters, isDefault = false) => out.push({ key, label: text, without, isDefault });
  if (f.part) add("part", label(f.part), omit(f, "part"));
  if (f.how) add("how", label(f.how), omit(f, "how"));
  // A muscle belongs to its area: the area's chip takes both.
  if (f.area) add("area", label(f.area), omit(f, "area", "muscle"));
  if (f.muscle) add("muscle", label(f.muscle), omit(f, "muscle"));
  if (f.gear && f.gear !== "any") add("gear", EQUIPMENT[f.gear], { ...f, gear: "any" });
  if (f.place !== undefined) add("at", placeWord(f.place, ctx), omit(f, "place"));
  if (f.tag) add("tag", label(f.tag), omit(f, "tag"));
  if (f.theme) add("theme", themeName(f.theme), omit(f, "theme"));
  if (f.max) add("max", difficultyLabel(f.max), omit(f, "max"));
  if (f.mine) add("mine", MINE_LABEL[f.mine], omit(f, "mine"));
  if (placeGearOn(f, ctx)) add("place", `At ${ctx.place!.name}`, { ...f, gear: "any" }, true);
  if (fitOn(f, ctx)) add("fit", FIT_WORD.fits, { ...f, fit: false }, true);
  return out;
}

/** A chosen place as its chip and the filters say it: "Bodyweight only", else "At Gym". */
export function placeWord(id: string, ctx: StudioCtx): string {
  if (id === NO_EQUIPMENT_PLACE_ID) return "Bodyweight only";
  return `At ${placeById(ctx, id)?.name ?? ctx.place?.name ?? "your place"}`;
}

/** How many filters the athlete set (the defaults are not counted): the Filters button's badge. */
export const setFilterCount = (f: StudioFilters, ctx: StudioCtx): number => activeChips(f, ctx).filter((c) => !c.isDefault).length;

/** Whether Clear has anything to do: a filter or "all moves" in the URL (the query is the field's, not Clear's). */
export const clearable = (f: StudioFilters, all: boolean): boolean => studioSearch("", f, all) !== "";

/** For an empty result: the chips whose removal would show something, the most first (two at most). */
export function loosenings(
  records: readonly ExerciseRecord[],
  q: string,
  f: StudioFilters,
  ctx: StudioCtx,
): Array<{ chip: Chip; count: number }> {
  return activeChips(f, ctx)
    .map((chip) => ({ chip, count: studioResults(records, q, chip.without, ctx).length }))
    .filter((x) => x.count > 0)
    .sort((a, b) => b.count - a.count)
    .slice(0, 2);
}

// ── The home ───────────────────────────────────────────────────────────────

/** Parts in a workout's own order: what comes first in a session comes first here. */
const BROWSE_ORDER: readonly Purpose[] = [
  "warmup",
  "activation",
  "strength",
  "power",
  "balance",
  "mobility",
  "stretch",
  "recovery",
  "condition-care",
  "cooldown",
  "conditioning",
];

const caring = (ctx: StudioCtx): ConditionProfile[] => ctx.profiles.filter((p) => p.care !== null);

/** The parts that have moves; condition care only while a profile with care content is on. */
export function browseParts(records: readonly ExerciseRecord[], ctx: StudioCtx): Purpose[] {
  return BROWSE_ORDER.filter(
    (p) => records.some((r) => r.purposes.includes(p)) && (p !== "condition-care" || caring(ctx).length > 0),
  );
}

/** The themes to offer: a profile's own theme only while that profile is on. */
export function visibleThemes(ctx: StudioCtx): Theme[] {
  return THEMES.filter((t) => !t.profile || ctx.profiles.some((p) => p.id === t.profile));
}

const PURPOSE_IDS = new Set<string>(PURPOSES);

/**
 * The tags to browse by: those that have moves, the most used first (the vocabulary's order breaks ties). A tag that
 * is also a part's name (`balance`) is left out — the part already offers it, and two "Balance" chips opening two
 * different lists is one too many.
 */
export function browseTags(records: readonly ExerciseRecord[]): Tag[] {
  const used = (t: Tag) => records.filter((r) => r.tags.includes(t)).length;
  return TAGS.filter((t) => !PURPOSE_IDS.has(t) && used(t) > 0).sort((a, b) => used(b) - used(a) || TAGS.indexOf(a) - TAGS.indexOf(b));
}

/** How many tags the home shows before "More tags". */
export const HOME_TAGS = 8;

/**
 * What a theme card says under its name: how many moves a tap shows — or, when that is none because of one of the
 * Studio's own defaults, which one ("None fit today", "None at Home"), so the card never just reads "0 moves".
 */
export function themeCountWord(records: readonly ExerciseRecord[], themeId: string, ctx: StudioCtx): string {
  const f: StudioFilters = { theme: themeId };
  const n = studioResults(records, "", f, ctx).length;
  if (n > 0) return `${n} ${n === 1 ? "move" : "moves"}`;
  // Only the Studio's own defaults can be the reason: the theme itself is the point of the card.
  const why = activeChips(f, ctx).find((c) => c.isDefault && studioResults(records, "", c.without, ctx).length > 0);
  if (why?.key === "fit") return "None fit today";
  if (why?.key === "place") return `None ${why.label.charAt(0).toLowerCase()}${why.label.slice(1)}`;
  return "No moves";
}

export interface QuickStart {
  kind: QuickStartKind;
  title: string;
  minutes: number;
}

const QUICK_START_TITLE: Readonly<Record<Exclude<QuickStartKind, "condition_care">, string>> = {
  desk_reset: "Desk reset",
  hip_opener: "Hip opener",
};

/** The quick starts on offer: condition care (named by the profile's care block) only while one is on. */
export function quickStarts(ctx: StudioCtx): QuickStart[] {
  const carers = caring(ctx);
  return quickStartKinds({ activeProfiles: ctx.profiles }).map((kind) => ({
    kind,
    title:
      kind === "condition_care"
        ? carers.length === 1
          ? carers[0]!.care!.block.label
          : label("condition-care")
        : QUICK_START_TITLE[kind],
    minutes: QUICK_START_MINUTES[kind],
  }));
}

// ── A row's line 4 ─────────────────────────────────────────────────────────

/**
 * The dose Add would put in, for the part it would put the move in (`doseFor` in `placementFor`'s part), in the
 * builder's words: "2 × 8–12", "10 reps", "2 × 45 s", "90 s", "7 breaths", "… each side".
 */
export function doseLine(rec: ExerciseRecord): string {
  return doseSummary(doseFor(rec, placementFor(rec)));
}

const DAY_MS = 86_400_000;

/** The athlete's history with a move, as short phrases: when, how often lately, and their own marks on it. */
export function historyLine(p: MovePrefs | null | undefined, today: string): string[] {
  if (!p) return [];
  const out: string[] = [];
  if (p.lastDoneOn) {
    const days = Math.round((Date.parse(today) - Date.parse(p.lastDoneOn)) / DAY_MS);
    out.push(
      days <= 0
        ? "Done today"
        : days === 1
          ? "Done yesterday"
          : days < 60
            ? `Last done ${days} days ago`
            : `Last done ${formatShortDate(p.lastDoneOn)}`,
    );
  }
  if (p.timesDone30d >= 2) out.push(`${p.timesDone30d}× in 30 days`);
  if (p.pinned) out.push("Pinned");
  if (p.excluded) out.push("Not for me");
  return out;
}
