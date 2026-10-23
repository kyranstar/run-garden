/**
 * A DOCUMENT WORKOUT'S SESSION, MADE FROM ITS DOCUMENT (programme spec §3.11; Stage 2 spec §10). Pure: the worker's
 * session path (`session-build.ts`) reads the day, calls these, and stores what they answer.
 *
 *  - `gateDoc` — the document as the day allows it. Every issue `validateWorkoutDoc` raises with the day's reading is
 *    read once: an exercise item the day keeps out (`GATE_CODES`: the profile's never, its pattern or record rule, a
 *    gate still waiting on the day's check) takes its FIRST ALTERNATE that raised no error of its own — the validator
 *    holds an alternate to the item's own rules, so that is the one that passes here — and the swap is recorded with
 *    the reason the item was kept out. The swapped document is validated again: an alternate the day keeps out is
 *    taken off its item (only an option, never played: it blocks nothing, and the player's swap must not offer it);
 *    any other error left (an item with no passing alternate, or any other fatal issue) is `blocked`, and a blocked
 *    build is never locked — Start and Send refuse with those issues. The row's own document is never changed: the
 *    swap is the day's, and the build's `workout_doc` snapshot is what was played.
 *  - `materializeDocBuild` — the build the player plays: the steps are `playerStepsFromDoc` of the gated document (one
 *    builder per output, principles §3.2), one item per slot in play order, the library records of every move the
 *    steps name, the planned time the steps add up to (the engine's own `costOf`). A document workout has no theme, no
 *    block, no new move and no progression targets of the engine's; its mode is its effort's. The engine's swap list
 *    (`alternatives`) stays empty: the sheet's ⇄ rebuilds with the day's swaps, which a document's build does not run.
 *    What the player reads of each item beside its steps (Stage 2 Task 8) is `slots` (stored as `fromDoc.slots`): its
 *    cue, a hold to max, its planned alternates and the library's usual offers (`docSlots`) — each with the slot's steps
 *    as the document plays with it in the item's place (`inPlace`, the day's own swap) and its record among the build's
 *    moves, for ⇄ offline.
 *  - `slotsForDay` — a locked build's alternates and offers judged again with the day's reading (Start of a build sent
 *    to the watch): one the day now keeps out is taken off.
 */
import type { WorkoutDoc, WorkoutItem } from "@rg/domain";
import { sessionLead } from "@rg/domain";
import { PROFILES, isPlyometric, isProfileId, label, onFrontier, type ExerciseRecord } from "@rg/exercise-library";
import { Swapping, type SlotChoice, type Step, type Target } from "@rg/session-engine";
import {
  DocTooLargeError,
  deriveDoc,
  docSlotKeys,
  makeLibraryIndex,
  modeOfEffort,
  playerStepsFromDoc,
  validateWorkoutDoc,
  type DocIssue,
  type DocIssueCode,
  type DocSlotKey,
  type ValidateCtx,
} from "@rg/workout";
import type { BuildItem, BuildPayload, CheckAnswer, ExerciseSlice, SessionView } from "./session-build.js";

/** Bump when a document build's shape or rules change: a stored build of an older version is then built again. */
export const DOC_BUILD_VERSION = "doc-build-7";

/** The issue codes that keep a move out on the day — what an alternate can stand in for. */
const GATE_CODES: ReadonlySet<DocIssueCode> = new Set(["condition_never", "condition_pattern", "condition_gate", "condition_gate_pending"]);

/** An item's own library id: `parts[p].items[i].libraryId`. */
const ITEM_ID = /^parts\[(\d+)\]\.items\[(\d+)\]\.libraryId$/;

/** One move the day kept out, and the alternate that stands in for it. */
export interface DocSwap {
  /** The item: "parts[0].items[2]". */
  path: string;
  from: string;
  to: string;
  /** Why the day kept `from` out, in the validator's words. */
  reason: string;
}

/** What the player reads of one slot's item beside its steps (`DocBuildInfo.slots`). */
export interface DocSlot {
  /** The item's cue: shown under the move's name. */
  cue?: string;
  /** "To max" (`dose.max`): the slot's holds count up past their window until Done, and log the seconds held. */
  max?: true;
  /**
   * The item's planned alternates, each with the slot's steps with it in place: ⇄ offers them first — those the day
   * judges clean in the document's order, then those that cost something, the cost in their reasons.
   */
  alternates?: SlotChoice[];
  /** The library's usual offers for the slot (`libraryOffers`), after the planned alternates. */
  offers?: SlotChoice[];
}

/** What a document build says of its document (`BuildPayload.fromDoc`). */
export interface DocBuildInfo {
  /** The document revision the build was made from (`planned_workouts.workout_doc_rev`). */
  rev: number | null;
  swaps: DocSwap[];
  /** The errors left once the swaps are made: while any stands, the build is never locked. */
  blocked: DocIssue[];
  /** Per slot key, what its item says that the steps do not (only slots that say something). Absent before doc-build-2. */
  slots?: Record<string, DocSlot>;
}

export interface GatedDoc {
  doc: WorkoutDoc;
  swaps: DocSwap[];
  blocked: DocIssue[];
}

type Exercise = Extract<WorkoutItem, { kind: "exercise" }>;

/**
 * The item with another move (the library's `to`) in its place, as the day's swap makes it: the move takes the item's
 * place and dose, its why (if it has one) replaces the item's, and what was said of the original move alone — its
 * progression, its test, its cue, its alternates — goes with it; `rest`, the other alternates, stay.
 */
function inPlace(item: Exercise, to: string, why: string | undefined, rest: NonNullable<Exercise["alternates"]> = []): Exercise {
  const { progression: _progression, test: _test, cue: _cue, alternates: _alternates, ...kept } = item;
  return { ...kept, libraryId: to, ...(why ? { why } : {}), ...(rest.length > 0 ? { alternates: rest } : {}) };
}

/**
 * A jump the session would hold new — one not done cleanly (`day.done`, the jumps the build was given): the engine's
 * one-new-or-retried-jump rule, read from the tally a document build has (a rung done cleanly once and flagged since is
 * not one here, where the engine would retry it). False without a tally: no jump can be among such a build's options.
 */
export function freshJump(rec: ExerciseRecord, ctx: ValidateCtx): boolean {
  const done = ctx.day?.done;
  return done !== undefined && isPlyometric(rec) && !done.has(rec.id);
}

/** An issue at one of an item's alternates — an option for a swap, never what is played. */
const atAlternate = (i: DocIssue): boolean => i.path.includes(".alternates[");

/**
 * Rules of what may be SAVED, never of what is played (designed runs, §8 §3): a document saved before the rule — the
 * coach's strength workout with a run part, from before `run_mixed` — plays as it always did; a new save is refused.
 */
const SAVE_ONLY = new Set<string>(["run_mixed"]);

/**
 * The errors that stop a document being played as it stands: every error but those at alternates (a gated alternate
 * is only an option the day takes away, see `gateDoc`) and the rules of saving alone (`SAVE_ONLY`).
 */
export function playedErrors(issues: readonly DocIssue[]): DocIssue[] {
  return issues.filter((i) => i.severity === "error" && !atAlternate(i) && !SAVE_ONLY.has(i.code));
}

/** The document as the day allows it (see the header). */
export function gateDoc(doc: WorkoutDoc, ctx: ValidateCtx): GatedDoc {
  const judged = validateWorkoutDoc(doc, ctx);
  const errors = judged.filter((i) => i.severity === "error");
  if (errors.length === 0) return { doc, swaps: [], blocked: [] };
  const find = makeLibraryIndex(ctx.library);
  const done = ctx.day?.done;
  const swaps: DocSwap[] = [];
  const parts = doc.parts.map((p) => ({ ...p, items: [...p.items] }));
  for (const e of playedErrors(errors)) {
    const at = GATE_CODES.has(e.code) ? ITEM_ID.exec(e.path) : null;
    if (!at) continue;
    const [p, i] = [Number(at[1]), Number(at[2])];
    const path = `parts[${p}].items[${i}]`;
    if (swaps.some((s) => s.path === path)) continue;
    const item = doc.parts[p]?.items[i];
    if (item?.kind !== "exercise") continue;
    const own = find(item.libraryId)?.id ?? item.libraryId;
    /**
     * An alternate that can stand in: a move the library has, not the item's own, on the athlete's jump frontier (when
     * the build knows it), raising nothing `bar` counts.
     */
    const standsIn = (bar: (i: DocIssue) => boolean) => (alt: { libraryId: string }, ai: number): boolean => {
      const rec = find(alt.libraryId);
      if (rec === undefined || rec.id === own || (done && !onFrontier(rec, (id) => done.has(find(id)?.id ?? id)))) return false;
      return !judged.some((x) => bar(x) && x.path.startsWith(`${path}.alternates[${ai}].`));
    };
    // One that costs nothing (no warning either: the mode, the format, set aside, the gear) first; else the first that
    // the day allows.
    const options = item.alternates ?? [];
    const clean = options.findIndex(standsIn(() => true));
    const k = clean >= 0 ? clean : options.findIndex(standsIn((x) => x.severity === "error"));
    if (k < 0) continue;
    const to = find(item.alternates![k]!.libraryId)!.id;
    parts[p]!.items[i] = inPlace(item, to, item.alternates![k]!.why, item.alternates!.filter((_, ai) => ai !== k));
    swaps.push({ path, from: own, to, reason: e.message });
  }
  // The day's document, judged again: an alternate the day keeps out is taken off its item (the player's swap must
  // not offer it), and what is left that would be played and is still an error blocks.
  const swappedDoc: WorkoutDoc = swaps.length > 0 ? { ...doc, parts } : doc;
  const issues = swaps.length > 0 ? validateWorkoutDoc(swappedDoc, ctx) : errors;
  const closed = issues.filter((i) => i.severity === "error" && atAlternate(i)).map((i) => i.path);
  return { doc: closed.length > 0 ? withoutAlternates(swappedDoc, closed) : swappedDoc, swaps, blocked: playedErrors(issues) };
}

/**
 * A document judged as a SAVE judges it (made or revised, Stage 2 ruling): for the day itself — or a day gone, still
 * to be done — through `gateDoc`, as its build will play it: only what no alternate can answer refuses it (`errors`);
 * a move the day keeps out that an alternate stands in for comes back as a warning naming the alternate (its `fix`),
 * and so does an alternate the day closes (it is only not offered today). A day ahead, or no day (a template), keeps
 * the validator's own rules: a gate the day's check could close needs an alternate that suits a recovery day.
 */
export function judgeDoc(doc: WorkoutDoc, ctx: ValidateCtx): { errors: DocIssue[]; warnings: DocIssue[] } {
  const issues = validateWorkoutDoc(doc, ctx);
  const warnings = issues.filter((i) => i.severity === "warning");
  if (ctx.day === null || ctx.day.date > ctx.day.today || !issues.some((i) => i.severity === "error")) {
    return { errors: issues.filter((i) => i.severity === "error"), warnings };
  }
  const gated = gateDoc(doc, ctx);
  const find = makeLibraryIndex(ctx.library);
  const stillBlocked = (i: DocIssue): boolean => gated.blocked.some((b) => b.path === i.path && b.code === i.code);
  const saveOnly = issues.filter((i) => i.severity === "error" && SAVE_ONLY.has(i.code));
  const resolved = issues
    .filter((i) => i.severity === "error" && !stillBlocked(i) && !SAVE_ONLY.has(i.code))
    .map((i): DocIssue => {
      const swap = gated.swaps.find((s) => i.path === `${s.path}.libraryId`);
      if (!swap) return { ...i, severity: "warning" };
      return { ...i, severity: "warning", message: `${i.message} ${find(swap.to)?.name ?? swap.to} stands in today.`, fix: swap.to };
    });
  return { errors: [...gated.blocked, ...saveOnly], warnings: [...warnings, ...resolved] };
}

/** What the validator reads of a day when only its errors matter: the active profiles and each one's reading. */
export function dayValidateCtx(o: {
  /** What the document's moves resolve in: the account library's `all` (`loadAccountLibrary`). */
  library: readonly ExerciseRecord[];
  profiles: readonly string[];
  checks: Readonly<Record<string, CheckAnswer>>;
  date: string;
  today: string;
  excluded?: readonly string[];
  equipment?: readonly string[];
  /** The jumps done cleanly: given, a jump past the athlete's frontier is noted (`progression_jump`). */
  done?: ReadonlySet<string>;
}): ValidateCtx {
  return {
    library: o.library,
    activeProfiles: o.profiles.filter(isProfileId).map((id) => PROFILES[id]),
    day: {
      date: o.date,
      today: o.today,
      readings: Object.fromEntries(Object.entries(o.checks).map(([p, a]) => [p, { pre: a.pre, post: null, feelingOff: a.feelingOff }])),
      ...(o.done ? { done: o.done } : {}),
    },
    ...(o.excluded ? { excluded: o.excluded } : {}),
    ...(o.equipment ? { equipment: o.equipment } : {}),
  };
}

/**
 * A LOCKED build's snapshot judged for the day — Start of a build on the watch, and every Send of one: its errors in
 * what is played (`playedErrors`). Nothing can be swapped in a locked build, so a move an alternate could have stood
 * in for still counts.
 */
export function snapshotErrors(snapshot: WorkoutDoc, ctx: ValidateCtx): DocIssue[] {
  return playedErrors(validateWorkoutDoc(snapshot, ctx));
}

/** The document with the alternates at `paths` ("parts[p].items[i].alternates[k].libraryId") taken off their items. */
function withoutAlternates(doc: WorkoutDoc, paths: readonly string[]): WorkoutDoc {
  const gone = new Set(paths.map((p) => p.replace(/\.libraryId$/, "")));
  return {
    ...doc,
    parts: doc.parts.map((part, p) => ({
      ...part,
      items: part.items.map((item, i) => {
        if (item.kind !== "exercise" || !item.alternates) return item;
        const kept = item.alternates.filter((_, k) => !gone.has(`parts[${p}].items[${i}].alternates[${k}]`));
        if (kept.length === item.alternates.length) return item;
        const { alternates: _alternates, ...rest } = item;
        return kept.length > 0 ? { ...rest, alternates: kept } : rest;
      }),
    })),
  };
}

/** A library record as the player needs it, offline (never the provider mappings). */
function sliceOf(rec: ExerciseRecord): ExerciseSlice {
  const { providers: _providers, ...rest } = rec;
  return rest;
}

export interface DocBuildInput {
  /** The day the session is built for. */
  date: string;
  /** The place, as the view carries it (its gear and implement weights, for the player offline). */
  location: SessionView["location"];
  checks: Record<string, CheckAnswer>;
  /** What the document's moves resolve in: the account library's `all`. */
  library: readonly ExerciseRecord[];
  /**
   * What a slot's ⇄ may offer beside the document's own alternates (`libraryOffers`): the account library's `offered`
   * (an archived personal move resolves, and is never offered). `library` when not given.
   */
  offered?: readonly ExerciseRecord[];
  /** The day's judgement (`dayValidateCtx`, with the athlete's set-aside moves and the place's gear): the options' gate. */
  judge: ValidateCtx;
}

/** What `materializeDocBuild` makes: the build without what only storing it decides, its view, and its slots. */
export interface MaterializedBuild {
  build: Omit<BuildPayload, "buildId" | "version" | "engineVersion" | "inputsHash" | "builtAt" | "blockRef" | "fromDoc">;
  view: SessionView;
  /** What each slot's item says beside its steps (`DocBuildInfo.slots`). */
  slots: Record<string, DocSlot>;
}

/** How many of the library's usual offers a slot holds. */
const OFFERS = 3;
/** How many of the library's moves are judged for a slot's offers, best first. */
const OFFER_CANDIDATES = 9;

/** A move a slot can take instead of its own: its record, what ⇄ says of it, and the why it brings to the item. */
interface SlotOption {
  to: ExerciseRecord;
  reasons: string[];
  why: string | undefined;
}

const optionKey = (slotKey: string, id: string): string => `${slotKey}|${id}`;

/** The item without its alternates (an item a probe does not ask about). */
const bare = (item: WorkoutItem): WorkoutItem => {
  if (item.kind !== "exercise" || !item.alternates) return item;
  const { alternates: _alternates, ...rest } = item;
  return rest;
};

/**
 * Each asked item's moves judged by the validator IN THE ITEM'S PLACE — the move as the item (`inPlace`: the item's
 * dose), every alternate in the document stripped — so every rule that judges a move played holds: the day's flare
 * rule and a gate waiting on the day's check among them, which the validator does not apply to an alternate. One move
 * an item a probe, the items' next moves together; the issues at the item's move, by slot key and move id. An item is
 * asked no further once `enough` says so. A probe the validator cannot read at all (its bounds, its size: moves put in
 * together can take a document past its bound) is asked again one move at a time; one it cannot read alone is judged
 * with that issue.
 */
function judgeInPlace(
  doc: WorkoutDoc,
  asked: ReadonlyArray<{ at: DocSlotKey; ids: readonly string[] }>,
  ctx: ValidateCtx,
  enough: (slotKey: string, judged: ReadonlyMap<string, DocIssue[]>) => boolean = () => false,
): Map<string, DocIssue[]> {
  const out = new Map<string, DocIssue[]>();
  const next = new Map(asked.map((a) => [a.at.key, 0]));
  for (;;) {
    const probing = asked.flatMap((a) => {
      const k = next.get(a.at.key)!;
      return k < a.ids.length && !enough(a.at.key, out) ? [{ at: a.at, id: a.ids[k]! }] : [];
    });
    if (probing.length === 0) return out;
    for (const a of probing) next.set(a.at.key, next.get(a.at.key)! + 1);
    const probe = (moves: typeof probing): void => {
      const parts = doc.parts.map((p) => ({ ...p, items: p.items.map(bare) }));
      for (const a of moves) parts[a.at.part]!.items[a.at.item] = inPlace(doc.parts[a.at.part]!.items[a.at.item] as Exercise, a.id, undefined);
      const issues = validateWorkoutDoc({ ...doc, parts }, ctx);
      const unread = issues.filter((i) => i.code === "bounds" || i.code === "too_large");
      if (unread.length > 0 && moves.length > 1) {
        for (const a of moves) probe([a]);
        return;
      }
      for (const a of moves) {
        const path = `parts[${a.at.part}].items[${a.at.item}].libraryId`;
        out.set(optionKey(a.at.key, a.id), unread.length > 0 ? unread : issues.filter((i) => i.path === path));
      }
    };
    probe(probing);
  }
}

/**
 * The library's usual offers for an exercise item (`rec`, its move), best first and nine at most: its easier versions
 * (two steps down), then its family's other versions, then moves of its patterns — each dosed the same way (reps, time
 * or breaths: the item's dose stays), never a jump in a move's place that is not one, never a move `away` names: a
 * version of a move the document holds elsewhere (`keys`: family and regions, so the document's own moves too), or one
 * the item already plans as an alternate (`ids`).
 *
 * A gentle move (`gentleMove`: mobility, release, breathing, condition care) is offered only what eases the same: a move
 * of a region and a purpose it has — a shared pattern alone is no reason (CUJ R9) — then, after its patterns' moves,
 * such moves of any pattern. Each says why honestly: "The same movement" only when it shares the pattern AND the region;
 * otherwise what it eases (a gentle move's: "Also eases the neck") or works ("Also works the hips"), in plain words.
 */
export function libraryOffers(
  rec: ExerciseRecord,
  library: readonly ExerciseRecord[],
  find: (id: string) => ExerciseRecord | undefined,
  away: { ids: ReadonlySet<string>; keys: ReadonlySet<string> },
): Array<{ to: ExerciseRecord; reason: string }> {
  const kind = (r: ExerciseRecord): string => (r.dose.type === "carry" ? "time" : r.dose.type);
  const seen = new Set<string>([rec.id]);
  const out: Array<{ to: ExerciseRecord; reason: string }> = [];
  const soft = gentleMove(rec);
  const areas = (r: ExerciseRecord): string[] => r.regions.filter((g) => rec.regions.includes(g));
  /** A gentle move's offer eases what it eases: a region and a purpose it has. */
  const eases = (r: ExerciseRecord): boolean => areas(r).length > 0 && r.purposes.some((p) => rec.purposes.includes(p));
  const take = (r: ExerciseRecord | undefined, reason: string | ((r: ExerciseRecord) => string)): void => {
    if (!r || seen.has(r.id) || out.length >= OFFER_CANDIDATES) return;
    seen.add(r.id);
    if (away.ids.has(r.id) || away.keys.has(Swapping.moveKeyOf(r)) || kind(r) !== kind(rec)) return;
    if (isPlyometric(r) && !isPlyometric(rec)) return;
    if (soft && !eases(r)) return;
    out.push({ to: r, reason: typeof reason === "string" ? reason : reason(r) });
  };
  /** What a move offered for its region says: what it eases (a gentle move's) or works, in plain words. */
  const plainly = (r: ExerciseRecord): string => {
    const area = areas(r)[0];
    if (area) return `Also ${soft ? "eases" : "works"} the ${areaWords(area)}`;
    return `Works the ${areaWords(r.regions[0] ?? "full-body")}`;
  };
  let frontier = [...rec.easier];
  for (let depth = 0; depth < 2 && frontier.length > 0; depth++) {
    const next: string[] = [];
    for (const id of frontier) {
      const r = find(id);
      if (!r) continue;
      next.push(...r.easier);
      take(r, "An easier version");
    }
    frontier = next;
  }
  for (const r of library) if (r.family === rec.family) take(r, "Another version");
  for (const r of library) {
    if (r.patterns.some((p) => rec.patterns.includes(p))) take(r, (x) => (areas(x).length > 0 ? "The same movement" : plainly(x)));
  }
  if (soft) for (const r of library) if (eases(r)) take(r, plainly);
  return out;
}

/** Patterns and purposes of the gentle work: mobility, release, breathing, stretching and condition care. */
const GENTLE_PATTERNS: ReadonlySet<string> = new Set(["mobility", "breathe", "release"]);
const GENTLE_PURPOSES: ReadonlySet<string> = new Set(["mobility", "stretch", "condition-care"]);

/** A move of the gentle work: its offers must ease what it eases (`libraryOffers`). */
export const gentleMove = (r: ExerciseRecord): boolean =>
  r.patterns.some((p) => GENTLE_PATTERNS.has(p)) || r.purposes.some((p) => GENTLE_PURPOSES.has(p));

/** A region as the Studio's suggestions say it (`areaWord`): "neck", "upper spine", "low back". */
const areaWords = (region: string): string =>
  region === "thoracic" ? "upper spine" : region === "full-body" ? "whole body" : label(region).toLowerCase();

/**
 * What each slot's item says beside its steps: its cue, a hold to max, and the moves ⇄ offers — its planned
 * alternates, then the library's usual offers (`libraryOffers`), each judged by the validator in the item's place
 * (`judgeInPlace`) with the build's own judgement (`judge`): an alternate the day keeps out (an error) is never offered;
 * one that costs something (a warning: the flare rule, a move set aside, gear the place lacks) comes after the clean
 * ones, the cost in its reasons; an offer is only ever a clean one, three at most — the library's moves are judged in
 * order until three are. A move the library lacks, or the item's own move, is none.
 *
 * A move's steps are the slot's steps in the document with it in the item's place (`inPlace`): every item's k-th move
 * goes in at once — a slot's steps are its own item's (its dose, its move, its part's format and rounds) — so the moves
 * cost at most six more builds of the steps. A set that would take the document past its size bound is tried one by
 * one; one that alone does is not offered.
 */
function docSlots(
  doc: WorkoutDoc,
  library: readonly ExerciseRecord[],
  offerable: readonly ExerciseRecord[],
  judge: ValidateCtx,
): { slots: Record<string, DocSlot>; records: ExerciseRecord[] } {
  const find = makeLibraryIndex(library);
  const keys = docSlotKeys(doc);
  const itemAt = (s: DocSlotKey) => doc.parts[s.part]!.items[s.item]!;
  const slots: Record<string, DocSlot> = {};
  for (const s of keys) {
    const item = itemAt(s);
    if (item.kind === "rest") continue;
    const max = item.kind !== "run" && item.dose.max === true;
    if (item.cue || max) slots[s.key] = { ...(item.cue ? { cue: item.cue } : {}), ...(max ? { max: true as const } : {}) };
  }

  const exercises = keys.flatMap((at) => {
    const item = itemAt(at);
    return item.kind === "exercise" ? [{ at, item, rec: find(item.libraryId) }] : [];
  });
  const held = exercises.flatMap((x) => (x.rec ? [x.rec] : []));
  const asked = exercises.map(({ at, item, rec }) => {
    const own = rec?.id ?? item.libraryId;
    const planned: Array<{ to: ExerciseRecord; why: string | undefined }> = [];
    for (const alt of item.alternates ?? []) {
      const to = find(alt.libraryId);
      if (to && to.id !== own && !planned.some((p) => p.to.id === to.id)) planned.push({ to, why: alt.why });
    }
    const away = { ids: new Set(planned.map((p) => p.to.id)), keys: new Set(held.filter((r) => r.id !== own).map((r) => Swapping.moveKeyOf(r))) };
    return { at, item, planned, offered: rec ? libraryOffers(rec, offerable, find, away) : [] };
  });
  const byKey = new Map(asked.map((a) => [a.at.key, a]));
  /** An item is judged enough once three of the library's moves are clean (all it plans comes first, so is judged). */
  const enough = (slotKey: string, judged: ReadonlyMap<string, DocIssue[]>): boolean => {
    const a = byKey.get(slotKey)!;
    return a.offered.filter((o) => judged.get(optionKey(slotKey, o.to.id))?.length === 0).length >= OFFERS;
  };
  const judged = judgeInPlace(doc, asked.map((a) => ({ at: a.at, ids: [...a.planned, ...a.offered].map((o) => o.to.id) })), judge, enough);
  const issuesOf = (slotKey: string, id: string): DocIssue[] | undefined => judged.get(optionKey(slotKey, id));

  const lists = asked.map(({ at, item, planned, offered }) => {
    const clean: SlotOption[] = [];
    const costly: SlotOption[] = [];
    for (const p of planned) {
      const issues = issuesOf(at.key, p.to.id) ?? [];
      // A jump past the athlete's frontier is never offered, planned or not: the frontier is a safety rule, not a cost.
      if (issues.some((i) => i.severity === "error" || i.code === "progression_jump")) continue;
      const costs = issues.map((i) => i.message);
      (costs.length > 0 ? costly : clean).push({ to: p.to, why: p.why, reasons: [...(p.why ? [p.why] : []), ...costs] });
    }
    const offers = offered
      .filter((o) => issuesOf(at.key, o.to.id)?.length === 0)
      .slice(0, OFFERS)
      .map((o): SlotOption => ({ to: o.to, why: undefined, reasons: [o.reason] }));
    const all = [
      ...[...clean, ...costly].map((option) => ({ option, list: "alternates" as const })),
      ...offers.map((option) => ({ option, list: "offers" as const })),
    ];
    return { at, item, all };
  });

  /** A move put in an item's place. */
  interface Put {
    at: DocSlotKey;
    item: Exercise;
    option: SlotOption;
    list: "alternates" | "offers";
  }
  /** The slots' steps with each move in its item's place; null when that takes the document past its bound. */
  const playedWith = (puts: readonly Put[]): Step[] | null => {
    const parts = doc.parts.map((p) => ({ ...p, items: [...p.items] }));
    for (const x of puts) parts[x.at.part]!.items[x.at.item] = inPlace(x.item, x.option.to.id, x.option.why);
    try {
      return playerStepsFromDoc({ ...doc, parts }, library);
    } catch (e) {
      if (e instanceof DocTooLargeError) return null;
      throw e;
    }
  };
  const records: ExerciseRecord[] = [];
  const most = Math.max(0, ...lists.map((l) => l.all.length));
  for (let k = 0; k < most; k++) {
    const puts = lists.flatMap((l): Put[] => (l.all[k] ? [{ at: l.at, item: l.item, ...l.all[k]! }] : []));
    const together = playedWith(puts);
    for (const x of puts) {
      const played = together ?? playedWith([x]);
      if (!played) continue;
      const choice: SlotChoice = {
        id: x.option.to.id,
        name: x.option.to.name,
        reasons: x.option.reasons,
        steps: played.filter((st) => st.kind !== "rest" && st.slotKey === x.at.key),
        moveKey: Swapping.moveKeyOf(x.option.to),
        pairing: Swapping.pairingOf(x.option.to),
        // A jump not yet done cleanly is the session's new one: ⇄ takes no second while one is held (`Swapping`).
        ...(freshJump(x.option.to, judge) ? { fresh: true as const } : {}),
      };
      const slot = (slots[x.at.key] ??= {});
      slot[x.list] = [...(slot[x.list] ?? []), choice];
      records.push(x.option.to);
    }
  }
  return { slots, records };
}

/**
 * A locked document build's alternates and offers judged again, in the item's place, with the day's reading — Start of
 * a build sent to the watch, which nothing rebuilds — by the build's own rules (`docSlots`): a planned alternate the day
 * now keeps out (an error, or a jump past the frontier) is taken off, and one that now costs something (the day's flare
 * rule) stays with the cost in its reasons, after the clean ones; an offer is only ever a clean one, so one that costs
 * anything today is taken off. A slot left saying nothing goes. Only options change: never what is played.
 */
export function slotsForDay(slots: Readonly<Record<string, DocSlot>>, snapshot: WorkoutDoc, ctx: ValidateCtx): Record<string, DocSlot> {
  const where = new Map(docSlotKeys(snapshot).map((s) => [s.key, s]));
  const asked = Object.entries(slots).flatMap(([key, slot]) => {
    const at = where.get(key);
    const ids = [...(slot.alternates ?? []), ...(slot.offers ?? [])].map((c) => c.id);
    return at && snapshot.parts[at.part]!.items[at.item]!.kind === "exercise" && ids.length > 0 ? [{ at, ids }] : [];
  });
  const judged = judgeInPlace(snapshot, asked, ctx);
  const issuesOf = (key: string, c: SlotChoice): DocIssue[] => judged.get(optionKey(key, c.id)) ?? [];
  const out: Record<string, DocSlot> = {};
  for (const [key, slot] of Object.entries(slots)) {
    const { alternates, offers, ...said } = slot;
    const judgedAlts = (alternates ?? []).flatMap((c) => {
      const issues = issuesOf(key, c);
      if (issues.some((i) => i.severity === "error" || i.code === "progression_jump")) return [];
      const costs = issues.map((i) => i.message).filter((m) => m !== "" && !c.reasons.includes(m));
      return [{ choice: costs.length > 0 ? { ...c, reasons: [...c.reasons, ...costs] } : c, costly: issues.length > 0 }];
    });
    const a = [...judgedAlts.filter((x) => !x.costly), ...judgedAlts.filter((x) => x.costly)].map((x) => x.choice);
    const o = (offers ?? []).filter((c) => issuesOf(key, c).length === 0);
    const kept: DocSlot = { ...said, ...(a.length > 0 ? { alternates: a } : {}), ...(o.length > 0 ? { offers: o } : {}) };
    if (Object.keys(kept).length > 0) out[key] = kept;
  }
  return out;
}

/**
 * Each move's target from its item's dose (CUJ R4), in an engine build's shape — by move id, the first item that plays
 * it — so the sheet's dose line, Today's lead and the how-to read a document build as the builder says it: reps (a
 * number; or a range, `type: "reps"` with `lo`–`hi` and no `reps`), its load as typed, a hold's seconds, the item's
 * progression note. Nothing of history: no last session, no graduation, and the action "hold" (the dose as written).
 */
function docTargets(doc: WorkoutDoc, steps: readonly Step[], find: (id: string) => ExerciseRecord | undefined): BuildPayload["targets"] {
  const out: BuildPayload["targets"] = {};
  for (const at of docSlotKeys(doc)) {
    const item = doc.parts[at.part]!.items[at.item]!;
    if (item.kind !== "exercise") continue;
    const rec = find(item.libraryId);
    if (!rec || out[rec.id]) continue;
    const said: Partial<Target> | null = steps.find((s) => s.slotKey === at.key && s.kind !== "rest" && s.target)?.target ?? null;
    const timed = rec.dose.type === "time" || rec.dose.type === "carry";
    out[rec.id] = {
      lo: said?.lo ?? rec.dose.range[0],
      hi: said?.hi ?? rec.dose.range[1],
      type: said?.type ?? rec.dose.type,
      w: said?.w ?? null,
      reps: said?.reps ?? null,
      secs: said?.secs ?? (timed ? (item.dose.holdSec ?? null) : null),
      graduate: null,
      last: null,
      lastDate: null,
      action: "hold",
      note: said?.note ?? "",
    };
  }
  return out;
}

/** The build the player plays, made from a (gated) document (see the header). */
export function materializeDocBuild(doc: WorkoutDoc, input: DocBuildInput): MaterializedBuild {
  const find = makeLibraryIndex(input.library);
  const steps: Step[] = playerStepsFromDoc(doc, input.library);
  const exercises: Record<string, ExerciseSlice> = {};
  const items: BuildItem[] = [];
  const seen = new Set<string>();
  for (const s of steps) {
    if (s.kind === "rest" || !s.exerciseId) continue;
    const rec = find(s.exerciseId);
    if (rec && !exercises[rec.id]) exercises[rec.id] = sliceOf(rec);
    if (seen.has(s.slotKey)) continue;
    seen.add(s.slotKey);
    items.push({
      slotKey: s.slotKey,
      block: s.block,
      exerciseId: s.exerciseId,
      format: s.format.id,
      sets: s.setCount ?? 1,
      group: s.format.group,
      coreFamily: null,
      isNew: false,
      why: [...s.why],
      ...(rec && freshJump(rec, input.judge) ? { fresh: true as const } : {}),
    });
  }
  const { slots, records } = docSlots(doc, input.library, input.offered ?? input.library, input.judge);
  for (const rec of records) if (!exercises[rec.id]) exercises[rec.id] = sliceOf(rec);
  const mode = modeOfEffort(doc.intent.effort);
  const minutes = deriveDoc(doc, input.library).estimatedMinutes;
  const targets: BuildPayload["targets"] = docTargets(doc, steps, find);
  return {
    build: {
      date: input.date,
      mode,
      modeReasons: [],
      theme: null,
      themeReasons: [],
      minutes,
      locationId: input.location.id,
      weekOfBlock: null,
      plannedSeconds: Swapping.costOf(steps),
      steps,
      items,
      exercises,
      alternatives: {},
      targets,
      newMove: null,
      params: { checks: input.checks, overrides: {}, swaps: {} },
    },
    view: {
      mode,
      proposedMode: mode,
      modeReasons: [],
      theme: null,
      proposedTheme: null,
      themeReasons: [],
      minutes,
      location: input.location,
      block: null,
      newMove: null,
      lead: sessionLead({ items, steps, targets, exercises }),
    },
    slots,
  };
}
