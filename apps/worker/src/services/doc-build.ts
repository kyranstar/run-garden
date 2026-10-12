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
 *    block, no new move and no progression targets of the engine's; its mode is its effort's. Its alternatives are
 *    left to the player's swap (Stage 2 Task 8): none are offered here.
 */
import type { WorkoutDoc, WorkoutItem } from "@rg/domain";
import { sessionLead } from "@rg/domain";
import { EXERCISES, PROFILES, isProfileId, type ExerciseRecord } from "@rg/exercise-library";
import { Swapping, type Step } from "@rg/session-engine";
import {
  deriveDoc,
  makeLibraryIndex,
  modeOfEffort,
  playerStepsFromDoc,
  validateWorkoutDoc,
  type DocIssue,
  type DocIssueCode,
  type ValidateCtx,
} from "@rg/workout";
import type { BuildItem, BuildPayload, CheckAnswer, ExerciseSlice, SessionView } from "./session-build.js";

/** Bump when a document build's shape or rules change: a stored build of an older version is then built again. */
export const DOC_BUILD_VERSION = "doc-build-1";

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

/** What a document build says of its document (`BuildPayload.fromDoc`). */
export interface DocBuildInfo {
  /** The document revision the build was made from (`planned_workouts.workout_doc_rev`). */
  rev: number | null;
  swaps: DocSwap[];
  /** The errors left once the swaps are made: while any stands, the build is never locked. */
  blocked: DocIssue[];
}

export interface GatedDoc {
  doc: WorkoutDoc;
  swaps: DocSwap[];
  blocked: DocIssue[];
}

type Exercise = Extract<WorkoutItem, { kind: "exercise" }>;

/** An issue at one of an item's alternates — an option for a swap, never what is played. */
const atAlternate = (i: DocIssue): boolean => i.path.includes(".alternates[");

/**
 * The errors that stop a document being played as it stands: every error but those at alternates (a gated alternate
 * is only an option the day takes away, see `gateDoc`).
 */
export function playedErrors(issues: readonly DocIssue[]): DocIssue[] {
  return issues.filter((i) => i.severity === "error" && !atAlternate(i));
}

/** The document as the day allows it (see the header). */
export function gateDoc(doc: WorkoutDoc, ctx: ValidateCtx): GatedDoc {
  const judged = validateWorkoutDoc(doc, ctx);
  const errors = judged.filter((i) => i.severity === "error");
  if (errors.length === 0) return { doc, swaps: [], blocked: [] };
  const find = makeLibraryIndex(ctx.library);
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
    /** An alternate that can stand in: a move the library has, not the item's own, raising nothing `bar` counts. */
    const standsIn = (bar: (i: DocIssue) => boolean) => (alt: { libraryId: string }, ai: number): boolean => {
      const rec = find(alt.libraryId);
      return rec !== undefined && rec.id !== own && !judged.some((x) => bar(x) && x.path.startsWith(`${path}.alternates[${ai}].`));
    };
    // One that costs nothing (no warning either: the mode, the format, set aside, the gear) first; else the first that
    // the day allows.
    const options = item.alternates ?? [];
    const clean = options.findIndex(standsIn(() => true));
    const k = clean >= 0 ? clean : options.findIndex(standsIn((x) => x.severity === "error"));
    if (k < 0) continue;
    const alt = item.alternates![k]!;
    const to = find(alt.libraryId)!.id;
    const rest = item.alternates!.filter((_, ai) => ai !== k);
    // The alternate takes the item's place and dose; what was said of the original move alone goes with it.
    const { progression: _progression, test: _test, alternates: _alternates, ...kept } = item;
    const swapped: Exercise = {
      ...kept,
      libraryId: to,
      ...(alt.why ? { why: alt.why } : {}),
      ...(rest.length > 0 ? { alternates: rest } : {}),
    };
    parts[p]!.items[i] = swapped;
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
  const resolved = issues
    .filter((i) => i.severity === "error" && !stillBlocked(i))
    .map((i): DocIssue => {
      const swap = gated.swaps.find((s) => i.path === `${s.path}.libraryId`);
      if (!swap) return { ...i, severity: "warning" };
      return { ...i, severity: "warning", message: `${i.message} ${find(swap.to)?.name ?? swap.to} stands in today.`, fix: swap.to };
    });
  return { errors: gated.blocked, warnings: [...warnings, ...resolved] };
}

/** What the validator reads of a day when only its errors matter: the active profiles and each one's reading. */
export function dayValidateCtx(o: {
  profiles: readonly string[];
  checks: Readonly<Record<string, CheckAnswer>>;
  date: string;
  today: string;
  excluded?: readonly string[];
  equipment?: readonly string[];
}): ValidateCtx {
  return {
    library: EXERCISES,
    activeProfiles: o.profiles.filter(isProfileId).map((id) => PROFILES[id]),
    day: {
      date: o.date,
      today: o.today,
      readings: Object.fromEntries(Object.entries(o.checks).map(([p, a]) => [p, { pre: a.pre, post: null, feelingOff: a.feelingOff }])),
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
  library: readonly ExerciseRecord[];
}

/** What `materializeDocBuild` makes: the build without what only storing it decides, and its view. */
export interface MaterializedBuild {
  build: Omit<BuildPayload, "buildId" | "version" | "engineVersion" | "inputsHash" | "builtAt" | "blockRef" | "fromDoc">;
  view: SessionView;
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
    });
  }
  const mode = modeOfEffort(doc.intent.effort);
  const minutes = deriveDoc(doc, input.library).estimatedMinutes;
  const targets: BuildPayload["targets"] = {};
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
  };
}
