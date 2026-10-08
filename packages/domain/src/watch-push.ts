import { z } from "zod";

/**
 * A PROGRAM SESSION ON THE WATCH (Phase 3, spec 2026-09-30-phase-3-watch-design.md §3–§4).
 *
 * The locked build of a program or on-demand slot, resolved into the steps the
 * watch will hold: catalog steps carry the athlete's catalog id and its T-code,
 * moves the catalog does not hold go as free text on `originId "0"` (spike
 * outcome A). The resolved steps ride in the push job's payload, so what was
 * previewed is exactly what is sent.
 */

/** A free-text step's name is cut at a word boundary to this many characters (ruling 3-R6). */
export const WATCH_NAME_MAX = 30;
/** A step overview (the side and the first cue) is at most this long (ruling 3-R6). */
export const WATCH_OVERVIEW_MAX = 80;
/** The longest stamp proven to round-trip live (the spike's), ruling 3-R5. */
export const WATCH_STAMP_MAX = 36;
/** At most this many real steps reach the watch ("Too long for the watch"). */
export const WATCH_MAX_STEPS = 200;

export const programWatchStepSchema = z
  .object({
    /** The athlete's catalog id, or "0" for a move the catalog does not hold (spike outcome A). */
    originId: z.string().min(1).max(40),
    /** The catalog T-code for a catalog step; the move's own name for a "0" step. */
    name: z.string().min(1).max(WATCH_NAME_MAX),
    target: z.discriminatedUnion("kind", [
      z.object({ kind: z.literal("reps"), reps: z.number().int().min(1).max(500) }).strict(),
      z.object({ kind: z.literal("hold"), seconds: z.number().int().min(1).max(3600) }).strict(),
      z.object({ kind: z.literal("open") }).strict(),
    ]),
    /** kg × 1000 as the wire carries it; null = bodyweight. */
    grams: z.number().int().min(0).max(500_000).nullable(),
    restSeconds: z.number().int().min(0).max(900),
    overview: z.string().max(WATCH_OVERVIEW_MAX),
    /** A per-side pair: a "left" step directly followed by its "right" step shares one container. */
    side: z.enum(["left", "right"]).nullable(),
  })
  .strict();
export type ProgramWatchStep = z.infer<typeof programWatchStepSchema>;

export const programWatchSessionSchema = z
  .object({
    kind: z.literal("program_watch"),
    /** The athlete-facing title — what the stamp reader un-stamps to. */
    title: z.string().min(1).max(200),
    steps: z.array(programWatchStepSchema).min(1).max(WATCH_MAX_STEPS),
  })
  .strict();
export type ProgramWatchSession = z.infer<typeof programWatchSessionSchema>;

/** The discriminator only: `programWatchSessionSchema` is what validates one. */
export function isProgramWatchSession(s: unknown): s is ProgramWatchSession {
  return typeof s === "object" && s !== null && (s as { kind?: unknown }).kind === "program_watch";
}
