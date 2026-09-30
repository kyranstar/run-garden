/**
 * THE UNMAPPED-MOVE SPIKE PROGRAM (Task 16) — one owner-gated test workout
 * that asks the real account a question no fixture can answer: what does COROS
 * KEEP when a strength step is not a catalog movement?
 *
 * COROS's own run/bike programs carry `originId: "0"` steps with free-text
 * names, and its catalog has generic steps (T1121 "Training"). Whether a
 * STRENGTH program keeps either — the name, the overview, the target — decides
 * how the app can push a movement the athlete's catalog lacks. The mock server
 * echoes whatever it is sent, so only a live write can tell.
 *
 * Four steps, each a question:
 *   (a) `originId: "0"`, free-text name, 30 s time target;
 *   (b) the generic Training step (T1121's catalog id) renamed, 30 s;
 *   (c) a real catalog exercise with a non-empty `overview` cue;
 *   (d) a per-side pair of that exercise (two steps, overview "each side").
 *
 * HOW (a) GETS PAST THE CATALOG GATE, and why that is safe.
 * `buildStrengthProgram` refuses any step whose originId is not in the catalog
 * it is handed, and sends the catalog's name for every step. That refusal is
 * NOT touched. This helper hands it a SPIKE catalog instead of the athlete's:
 * `"0"` → "Chin tuck hold", T1121's id → "Chin tuck hold (generic)", and the
 * chosen exercise → its real catalog name. Every wire shape therefore comes out
 * of the production builder unchanged — containers, sort numbers, weight
 * encoding, per-side expansion, overview — and the only thing the spike decides
 * is which names ride on which ids. It refuses to build under any name that is
 * not a spike stamp, so the trick cannot leak into a real push.
 */

import { coachSessionSchema, type CoachSession } from "@rg/domain";
import type { RawCorosProgram } from "@rg/providers";
import { buildStrengthProgram } from "./create-executor.js";

/** Every spike workout's program name starts with exactly this. */
export const SPIKE_STAMP_PREFIX = "RG SPIKE — SAFE TO DELETE";
const SPIKE_STAMP_RE = /^RG SPIKE — SAFE TO DELETE \d{4}-\d{2}-\d{2}$/;

/** The stamp for a spike run on `isoDate` (yyyy-mm-dd). */
export function spikeStamp(isoDate: string): string {
  const stamp = `${SPIKE_STAMP_PREFIX} ${isoDate}`;
  if (!SPIKE_STAMP_RE.test(stamp)) throw new Error(`not a yyyy-mm-dd date: ${isoDate}`);
  return stamp;
}

/** Exactly a spike stamp — the prefix plus a date, nothing before or after. */
export function isSpikeStamp(name: unknown): boolean {
  return typeof name === "string" && SPIKE_STAMP_RE.test(name);
}

/** The catalog T-code of COROS's generic "Training" step. */
export const GENERIC_TRAINING_CODE = "T1121";
/** The free-text step's id: what COROS's own run/bike programs carry. */
export const FREE_TEXT_ORIGIN_ID = "0";
export const SPIKE_FREE_TEXT_NAME = "Chin tuck hold";
export const SPIKE_GENERIC_NAME = "Chin tuck hold (generic)";
export const SPIKE_CUE = "cue: long neck";
export const SPIKE_HOLD_SECONDS = 30;
export const SPIKE_REPS = 8;

export interface SpikeProgramInputs {
  /** COROS calendar day, YYYYMMDD. */
  happenDay: string;
  /** Must be a spike stamp (`spikeStamp`). */
  name: string;
  /** The athlete's synced catalog, originId → catalog name (T-codes). */
  catalog: Map<string, string>;
  /** originId of the generic Training step — the catalog row named T1121. */
  genericTrainingOriginId: string;
  /** originId of a real catalog exercise, used for steps (c) and (d). */
  exerciseOriginId: string;
  /** Human label for (c)/(d), for error messages only. */
  exerciseLabel?: string;
}

/** The session and the spike catalog `buildStrengthProgram` is handed. */
export interface SpikeWorkout {
  session: CoachSession;
  catalog: Map<string, string>;
}

/**
 * The spike as a coach lift session plus the catalog that names its steps.
 * `createWorkout` takes exactly this pair, so the create runs through the
 * production executor untouched. Throws on anything but a well-formed spike.
 */
export function spikeWorkout(inputs: SpikeProgramInputs): SpikeWorkout {
  const { name, catalog, genericTrainingOriginId: genericId, exerciseOriginId: exerciseId } = inputs;
  if (!isSpikeStamp(name)) {
    throw new Error(`refusing to build a spike program under a non-spike name ("${name}")`);
  }
  if (catalog.get(genericId)?.trim() !== GENERIC_TRAINING_CODE) {
    throw new Error(
      `originId ${genericId} is not the catalog's ${GENERIC_TRAINING_CODE} (generic Training) entry`,
    );
  }
  const exerciseName = catalog.get(exerciseId);
  if (exerciseName === undefined) {
    throw new Error(`exercise originId ${exerciseId} is not in the COROS exercise catalog`);
  }
  if (exerciseId === genericId || exerciseId === FREE_TEXT_ORIGIN_ID) {
    throw new Error("the catalog exercise must be a real movement, not the generic or free-text step");
  }

  const label = inputs.exerciseLabel ?? "Catalog exercise";
  const session = coachSessionSchema.parse({
    category: "strength",
    title: name,
    durationMinutes: 10,
    lift: {
      exercises: [
        // (a) free text on id "0".
        {
          name: SPIKE_FREE_TEXT_NAME,
          originId: FREE_TEXT_ORIGIN_ID,
          sets: 1,
          holdSeconds: SPIKE_HOLD_SECONDS,
          restSeconds: 0,
        },
        // (b) the generic Training step, renamed.
        {
          name: SPIKE_GENERIC_NAME,
          originId: genericId,
          sets: 1,
          holdSeconds: SPIKE_HOLD_SECONDS,
          restSeconds: 0,
        },
        // (c) a real movement with a cue in `overview`.
        { name: label, originId: exerciseId, sets: 1, reps: SPIKE_REPS, restSeconds: 0, note: SPIKE_CUE },
        // (d) the same movement per side — two steps, overview "each side".
        { name: label, originId: exerciseId, sets: 1, reps: SPIKE_REPS, restSeconds: 0, perSide: true },
      ],
    },
  });
  return {
    session,
    catalog: new Map([
      [FREE_TEXT_ORIGIN_ID, SPIKE_FREE_TEXT_NAME],
      [genericId, SPIKE_GENERIC_NAME],
      [exerciseId, exerciseName],
    ]),
  };
}

/** The exact program `createWorkout` will write for these inputs. */
export function buildSpikeProgram(inputs: SpikeProgramInputs): RawCorosProgram {
  const { session, catalog } = spikeWorkout(inputs);
  return buildStrengthProgram({ happenDay: inputs.happenDay, name: inputs.name, session }, catalog);
}

/** The per-step fields the spike compares, sent vs stored. */
export interface SpikeStepFields {
  name: string | null;
  originId: string | null;
  overview: string | null;
  targetType: number | null;
  targetValue: number | null;
}

/**
 * A program's REAL steps (repeat-group containers dropped), in wire order
 * (`sortNo`, then array order), reduced to the fields the spike compares.
 */
export function spikeStepFields(program: RawCorosProgram | undefined): SpikeStepFields[] {
  const steps = (program?.exercises ?? [])
    .map((e, index) => ({ e, index }))
    .filter(({ e }) => e.isGroup !== true && Number(e.exerciseType) !== 0);
  steps.sort((x, y) => {
    const a = Number(x.e.sortNo);
    const b = Number(y.e.sortNo);
    if (Number.isFinite(a) && Number.isFinite(b) && a !== b) return a - b;
    return x.index - y.index;
  });
  const str = (v: unknown): string | null => (v === undefined || v === null ? null : String(v));
  const num = (v: unknown): number | null =>
    v === undefined || v === null || v === "" || !Number.isFinite(Number(v)) ? null : Number(v);
  return steps.map(({ e }) => ({
    name: str(e.name),
    originId: str(e.originId),
    overview: str(e.overview),
    targetType: num(e.targetType),
    targetValue: num(e.targetValue),
  }));
}
