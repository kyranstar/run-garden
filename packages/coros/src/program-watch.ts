/**
 * A PROGRAM SESSION'S WIRE PROGRAM, AND ITS PREVIEW READ BACK OFF IT (Phase 3
 * Task 3; spec 2026-09-30-phase-3-watch-design.md §3, §4.2).
 *
 * The steps arrive resolved (`ProgramWatchSession`): catalog steps carry the
 * athlete's catalog id and its T-code, unmapped moves go as free text on
 * `originId "0"` (spike outcome A). This builder only lays them out, in the
 * shape the unmapped-move spike proved live, through the same container and
 * child helpers the studio/coach strength builder uses:
 *
 *  - every step in its own repeat container with `sets: 1`;
 *  - a per-side pair — a "left" step directly followed by its "right" step of
 *    the same move — shares one container, two children;
 *  - reps → `targetType 3`, a hold → `targetType 2`, neither → open (`0`);
 *  - grams → `intensityValue`, null → the bodyweight encoding;
 *  - rest seconds → `restType 1`, none → `restType 3`.
 *
 * The preview is read straight off the program this builds, so it lists each
 * step exactly as the wire carries it — one builder, two renderings.
 *
 * A self-validating safety core, like `buildStrengthProgram`: the session is
 * re-parsed, and every catalog id is re-checked against the catalog it is
 * handed — present, and naming the same T-code the preview showed — before
 * any wire call.
 */
import {
  programWatchSessionSchema,
  type ProgramWatchSession,
  type ProgramWatchStep,
  type StudioWeight,
} from "@rg/domain";
import { programStepsInWireOrder, type RawCorosExercise, type RawCorosProgram } from "@rg/providers";
import {
  strengthChild,
  strengthContainer,
  strengthProgram,
  SUB_SORT,
  TOP_SORT,
  type CreateWorkoutSpec,
} from "./create-executor.js";
import { FREE_TEXT_ORIGIN_ID } from "./spike-program.js";

const targetOf = (s: ProgramWatchStep): { holdSeconds?: number; reps?: number } =>
  s.target.kind === "hold" ? { holdSeconds: s.target.seconds } : s.target.kind === "reps" ? { reps: s.target.reps } : {};

const weightOf = (grams: number | null): StudioWeight =>
  grams === null ? { type: "bodyweight" } : { type: "kg", value: grams / 1000 };

/** A left step directly followed by the right step of the same move: one container. */
function groupsOf(steps: readonly ProgramWatchStep[]): ProgramWatchStep[][] {
  const groups: ProgramWatchStep[][] = [];
  for (let i = 0; i < steps.length; i++) {
    const step = steps[i]!;
    const next = steps[i + 1];
    if (step.side === "left" && next?.side === "right" && next.originId === step.originId && next.name === step.name) {
      groups.push([step, next]);
      i += 1;
    } else {
      groups.push([step]);
    }
  }
  return groups;
}

export function buildProgramWatchProgram(
  spec: CreateWorkoutSpec & { session: ProgramWatchSession },
  catalog: Map<string, string>,
): RawCorosProgram {
  const parsed = programWatchSessionSchema.safeParse(spec.session);
  if (!parsed.success) {
    throw new Error(
      `cannot build "${spec.name}": invalid program session — ` +
        parsed.error.issues.map((i) => `${i.path.join(".") || "session"}: ${i.message}`).join("; "),
    );
  }
  const { steps } = parsed.data;
  for (const step of steps) {
    if (step.originId === FREE_TEXT_ORIGIN_ID) continue;
    const catalogName = catalog.get(step.originId);
    if (catalogName === undefined) {
      throw new Error(
        `exercise originId ${step.originId} (${step.name}) is not in the COROS exercise catalog` +
          " — refusing to build a program the server would reject",
      );
    }
    if (catalogName.trim() !== step.name) {
      throw new Error(
        `catalog id ${step.originId} is ${catalogName} in the COROS exercise catalog, not the previewed ${step.name}` +
          " — refusing to send what was not previewed",
      );
    }
  }

  const exercises: RawCorosExercise[] = [];
  let realSteps = 0;
  let nextId = 1;
  groupsOf(steps).forEach((group, index) => {
    const containerId = nextId++;
    const groupSort = TOP_SORT * (index + 1);
    exercises.push(strengthContainer(containerId, 1, groupSort));
    group.forEach((step, j) => {
      realSteps += 1;
      exercises.push(
        strengthChild(
          {
            originId: step.originId,
            name: step.name,
            ...targetOf(step),
            weight: weightOf(step.grams),
            restSeconds: step.restSeconds,
            overview: step.overview,
          },
          nextId++,
          containerId,
          groupSort + SUB_SORT * (j + 1),
        ),
      );
    });
  });
  // Every container repeats once, so the program's set count is its step count.
  return strengthProgram(spec.name, exercises, realSteps, realSteps);
}

export interface ProgramPreviewStep {
  /** As the watch shows it: the English name of a catalog step, the free text of a "0" step. */
  name: string;
  freeText: boolean;
  target: ProgramWatchStep["target"];
  grams: number | null;
  overview: string;
  restSeconds: number;
}

const num = (v: unknown): number => (v === undefined || v === null || v === "" ? Number.NaN : Number(v));

/**
 * Read straight off the wire program — the preview IS the wire. Reads what
 * COROS stores as well as what we send: numbers as strings or numbers, an
 * absent overview as an empty one, a bodyweight step with no intensity value.
 */
export function previewOfProgram(
  program: RawCorosProgram,
  englishName: (key: string) => string | undefined,
): ProgramPreviewStep[] {
  return programStepsInWireOrder(program).map((e) => {
    const freeText = String(e.originId ?? "") === FREE_TEXT_ORIGIN_ID;
    const raw = String(e.name ?? "");
    const tt = num(e.targetType);
    const tv = num(e.targetValue);
    const target: ProgramWatchStep["target"] =
      tt === 3 && tv >= 1 ? { kind: "reps", reps: tv } : tt === 2 && tv >= 1 ? { kind: "hold", seconds: tv } : { kind: "open" };
    const iv = num(e.intensityValue);
    const grams = num(e.intensityCustom) === 1 || !Number.isFinite(iv) ? null : iv;
    return {
      name: freeText ? raw : (englishName(raw) ?? raw),
      freeText,
      target,
      grams,
      overview: String(e.overview ?? ""),
      restSeconds: num(e.restType) === 1 ? num(e.restValue) || 0 : 0,
    };
  });
}
