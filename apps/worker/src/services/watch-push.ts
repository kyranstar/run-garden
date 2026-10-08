/**
 * SEND TODAY'S SESSION TO THE WATCH (Phase 3; spec 2026-09-30-phase-3-watch-design.md §3–§4).
 *
 * The pure part: a locked build's steps as the watch will hold them
 * (`watchStepsFromBuild`), and the stamp the push carries (`programStamp`).
 *
 *  - Every work step of the build is one watch step. A timed window is a hold;
 *    a set is its reps, else its seconds, else open. Per-side windows stay two
 *    steps, each overview naming its side.
 *  - A move whose T-code (`corosKeyOf`, ruling 3-R1) the athlete's catalog holds
 *    goes as that catalog step; every other move goes as free text on
 *    `originId "0"` (spike outcome A), its name cut at a word to 30 characters
 *    (ruling 3-R6) so the preview stays exact if COROS has a limit.
 *  - Weights in grams (kg × 1000, the wire's only unit); none is bodyweight.
 *  - A rest adds onto the step before it (at most 900 s); a leading rest has no
 *    step to hang on and is dropped.
 */
import {
  toKg,
  WATCH_MAX_STEPS,
  WATCH_NAME_MAX,
  WATCH_OVERVIEW_MAX,
  WATCH_STAMP_MAX,
  type ProgramWatchStep,
} from "@rg/domain";
import { FREE_TEXT_ORIGIN_ID } from "@rg/coros";
import type { Step } from "@rg/session-engine";
import { STAMP_SEPARATOR, stampName } from "./coros-stamp.js";
import type { BuildPayload } from "./session-build.js";

/** The longest rest a step's rest fields carry. */
const MAX_REST_SECONDS = 900;

export interface WatchPlanDeps {
  /** T-code → the athlete's catalog id; keys the catalog holds twice are absent. */
  catalogIdByKey: ReadonlyMap<string, string>;
  /** Library id → T-code (`corosKeyOf`). */
  keyOf: (exerciseId: string) => string | null;
}

export type WatchRefusal = "empty" | "too_long";

export interface WatchPlan {
  steps: ProgramWatchStep[];
  /** How many steps go as free text. */
  freeText: number;
  refusal: WatchRefusal | null;
}

/**
 * `text` cut at a word boundary to at most `max` characters, with no dangling
 * separator; a single word longer than `max` is cut hard (ruling 3-R6).
 */
export function cutAtWord(text: string, max: number): string {
  const t = text.trim();
  if (t.length <= max) return t;
  const head = t.slice(0, max + 1);
  const space = head.lastIndexOf(" ");
  const cut = (space > 0 ? head.slice(0, space) : t.slice(0, max)).replace(/[\s·,;:—–-]+$/u, "");
  return cut || t.slice(0, max);
}

function targetOf(s: Step): ProgramWatchStep["target"] {
  if (s.kind === "timed") {
    const seconds = Math.round(s.seconds);
    return seconds >= 1 ? { kind: "hold", seconds: Math.min(3600, seconds) } : { kind: "open" };
  }
  const reps = Math.round(s.target?.reps ?? 0);
  if (reps >= 1) return { kind: "reps", reps: Math.min(500, reps) };
  const secs = Math.round(s.target?.secs ?? 0);
  if (secs >= 1) return { kind: "hold", seconds: Math.min(3600, secs) };
  return { kind: "open" };
}

function overviewOf(side: Step["side"], cue: string | undefined): string {
  const sideText = side === "Left" ? "left side" : side === "Right" ? "right side" : null;
  return cutAtWord([sideText, cue?.trim()].filter((p): p is string => Boolean(p)).join(" · "), WATCH_OVERVIEW_MAX);
}

/** The build's steps as the watch will hold them. Pure: the same build gives the same steps. */
export function watchStepsFromBuild(build: BuildPayload, deps: WatchPlanDeps): WatchPlan {
  const steps: ProgramWatchStep[] = [];
  for (const s of build.steps) {
    if (s.kind === "rest") {
      const prev = steps.at(-1);
      if (prev) prev.restSeconds = Math.min(MAX_REST_SECONDS, prev.restSeconds + Math.max(0, Math.round(s.seconds)));
      continue;
    }
    if (!s.exerciseId) continue;
    const record = build.exercises[s.exerciseId];
    if (!record) continue;
    const key = deps.keyOf(s.exerciseId);
    const originId = key ? deps.catalogIdByKey.get(key) : undefined;
    steps.push({
      originId: originId ?? FREE_TEXT_ORIGIN_ID,
      name: originId ? key! : cutAtWord(record.name, WATCH_NAME_MAX),
      target: targetOf(s),
      grams: s.target?.w ? Math.round(toKg(s.target.w) * 1000) : null,
      restSeconds: 0,
      overview: overviewOf(s.side, record.text.focus[0]),
      side: s.side === "Left" ? "left" : s.side === "Right" ? "right" : null,
    });
  }
  const refusal: WatchRefusal | null =
    steps.length === 0 ? "empty" : steps.length > WATCH_MAX_STEPS ? "too_long" : null;
  return { steps, freeText: steps.filter((s) => s.originId === FREE_TEXT_ORIGIN_ID).length, refusal };
}

/**
 * `<program name> — <date>`, at most WATCH_STAMP_MAX characters (ruling 3-R5):
 * the name cut to fit, then " (2)", " (3)" while `taken` holds the stamp — two
 * sessions of one day, or a coach session of the same title, each get their own.
 */
export function programStamp(programName: string, date: string, taken: ReadonlySet<string>): string {
  for (let n = 1; ; n++) {
    const suffix = n === 1 ? "" : ` (${n})`;
    const room = WATCH_STAMP_MAX - STAMP_SEPARATOR.length - date.length - suffix.length;
    const stamp = `${stampName(cutAtWord(programName, room), date)}${suffix}`;
    if (!taken.has(stamp)) return stamp;
  }
}
