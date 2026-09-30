import { addDays, todayInZone, type UserPreferences } from "@rg/domain";
import {
  buildSpikeProgram,
  createWorkout,
  deleteWorkout,
  errText,
  GENERIC_TRAINING_CODE,
  isSpikeStamp,
  planView,
  readFullSpan,
  spikeStamp,
  spikeStepFields,
  spikeWorkout,
  stampedPlacements,
  stampOf,
  type CorosClient,
  type Located,
  type SpikeStepFields,
  type StampPredicate,
} from "@rg/coros";
import {
  COROS_EXERCISE_NAMES,
  localDateToCorosDay,
  type RawCorosProgram,
  type RawCorosSchedule,
} from "@rg/providers";
import type { Env } from "../env.js";
import type { Db } from "./db.js";
import { corosClient } from "./coros-connection.js";
import { claimUserLock, releaseUserLock } from "./locks.js";
import { buildExerciseIndex, exerciseNameMap, resolveExerciseOriginId } from "./exercise-catalog.js";

/**
 * THE UNMAPPED-MOVE WRITE SPIKE (Task 16), owner-gated: one strength workout
 * written to the athlete's real COROS account, read back, and deleted, to learn
 * what COROS keeps of a step that is not a catalog movement. The program and
 * its four questions are `@rg/coros`'s `buildSpikeProgram`; this is the run.
 *
 * Everything COROS-facing goes through the production executors — the same
 * client/session handling and write lock as the cloud write consumer,
 * `createWorkout` (plan-scoped id derivation, stamp uniqueness, calculate,
 * read-after-write by stamp) and `deleteWorkout` (re-proven, triple-addressed,
 * verified). Nothing here writes to COROS directly.
 *
 * The response carries our own test strings only — step names, overviews,
 * targets and catalog ids — and never another workout's name or any other
 * account data.
 */

/** The exact body the route demands before anything is written. */
export const SPIKE_CONFIRM = "write a test workout";
/** How far out the test workout is placed — clear of anything this week. */
const SPIKE_DAYS_OUT = 14;
/**
 * Movements tried, in order, for steps (c)/(d): matched on English names
 * through the same resolver the coach uses. A per-side movement fits (d).
 */
const EXERCISE_CANDIDATES = ["Bird Dog", "Dead Bug", "Squats", "Push-ups"];
/** The generic steps (Warm Up / Training / Cool Down / Rest) — never (c). */
const GENERIC_CODES = new Set(["T1120", "T1121", "T1122", "T1123"]);

const STEP_LABELS: Array<{ step: string; about: string }> = [
  { step: "a", about: "free text on originId 0" },
  { step: "b", about: "generic Training step (T1121), renamed" },
  { step: "c", about: "catalog exercise with an overview cue" },
  { step: "d1", about: "per-side pair, first" },
  { step: "d2", about: "per-side pair, second" },
];

export interface SpikeStepReport {
  step: string;
  about: string;
  sent: SpikeStepFields;
  storedName: string | null;
  storedOriginId: string | null;
  storedOverview: string | null;
  storedTarget: { targetType: number | null; targetValue: number | null } | null;
  /** Fields whose stored value differs from the sent one; ["not stored"] when absent. */
  changed: string[];
}

export interface SpikeReport {
  stored: SpikeStepReport[];
  /** True when a fresh read after the delete step finds no workout carrying the stamp. */
  deleted: boolean;
  notes: string[];
}

export type SpikeOutcome =
  | { status: "not_connected" }
  | { status: "busy" }
  | { status: "catalog_incomplete"; message: string }
  | { status: "done"; body: SpikeReport };

/** A real movement for (c)/(d), by English name, else the first nameable one. */
function pickExercise(
  catalog: Map<string, string>,
  genericId: string,
): { id: string; label: string } | null {
  const usable = (id: string): boolean => {
    const code = catalog.get(id)?.trim() ?? "";
    return id !== genericId && id !== "0" && !GENERIC_CODES.has(code);
  };
  const index = buildExerciseIndex(catalog);
  for (const label of EXERCISE_CANDIDATES) {
    const id = resolveExerciseOriginId(label, index);
    if (id && usable(id)) return { id, label };
  }
  for (const id of [...catalog.keys()].sort()) {
    const english = COROS_EXERCISE_NAMES[catalog.get(id)?.trim() ?? ""];
    if (english && usable(id)) return { id, label: english };
  }
  return null;
}

function compare(label: (typeof STEP_LABELS)[number], sent: SpikeStepFields, got?: SpikeStepFields): SpikeStepReport {
  if (!got) {
    return {
      ...label,
      sent,
      storedName: null,
      storedOriginId: null,
      storedOverview: null,
      storedTarget: null,
      changed: ["not stored"],
    };
  }
  const fields = ["name", "originId", "overview", "targetType", "targetValue"] as const;
  return {
    ...label,
    sent,
    storedName: got.name,
    storedOriginId: got.originId,
    storedOverview: got.overview,
    storedTarget: { targetType: got.targetType, targetValue: got.targetValue },
    changed: fields.filter((f) => sent[f] !== got[f]),
  };
}

/** The delete target for a placement observed on a fresh read. */
function targetOf(found: Located, planId: string) {
  return {
    happenDay: String(localDateToCorosDay(found.date)),
    name: stampOf(found),
    idInPlan: String(found.entity.idInPlan),
    programId: String(found.entity.planProgramId ?? found.entity.idInPlan),
    planId: String(found.entity.planId ?? planId),
  };
}

/**
 * Delete every placement `isTarget` accepts in a plan-wide read (a fresh one
 * unless `span` was read just now), each through `deleteWorkout` — which
 * re-proves the stamp and verifies plan-wide itself. `found` is how many
 * distinct (stamp, day) placements the read held.
 */
async function removeStamped(
  client: CorosClient,
  today: string,
  planId: string,
  isTarget: StampPredicate,
  notes: string[],
  what: string,
  span?: RawCorosSchedule,
): Promise<{ found: number; allGone: boolean }> {
  const view = planView(span ?? (await readFullSpan(client, today)), planId);
  const seen = new Set<string>();
  let allGone = true;
  for (const placement of stampedPlacements(view, isTarget)) {
    const key = `${stampOf(placement)}|${placement.date}`;
    if (seen.has(key)) continue; // one delete removes every copy of a stamp on a day
    seen.add(key);
    const res = await deleteWorkout(client, targetOf(placement, planId), { today });
    const gone = res.ok || res.refused === "not_found";
    if (!gone) allGone = false;
    notes.push(
      `${what}: spike workout on ${placement.date} ` +
        (res.ok
          ? "deleted"
          : gone
            ? "already gone"
            : `NOT deleted (${res.refused ?? "error"}${res.error ? `: ${res.error}` : ""})`),
    );
  }
  return { found: seen.size, allGone };
}

export async function runUnmappedMoveSpike(
  db: Db,
  env: Env,
  userId: string,
  prefs: UserPreferences,
  opts: { fetchImpl?: typeof fetch } = {},
): Promise<SpikeOutcome> {
  // The catalog decides the program; a refusal here costs no COROS call.
  const catalog = await exerciseNameMap(db);
  const genericId = [...catalog.entries()]
    .filter(([, name]) => name.trim() === GENERIC_TRAINING_CODE)
    .map(([id]) => id)
    .sort()[0];
  if (!genericId) {
    return {
      status: "catalog_incomplete",
      message:
        `The synced COROS exercise catalog has no ${GENERIC_TRAINING_CODE} (generic Training) entry,` +
        " so step (b) cannot be built. Sync the catalog with a COROS read, then retry.",
    };
  }
  const exercise = pickExercise(catalog, genericId);
  if (!exercise) {
    return {
      status: "catalog_incomplete",
      message:
        "The synced COROS exercise catalog has no nameable movement for steps (c) and (d)." +
        " Sync the catalog with a COROS read, then retry.",
    };
  }

  const client = await corosClient(db, env, userId, opts.fetchImpl ?? fetch);
  if (!client) return { status: "not_connected" };
  // The cloud write consumer's lock: id derivation is read-then-write, so no
  // other COROS write for this athlete may interleave with the spike's.
  const lock = await claimUserLock(db, userId, "coros_write", 10);
  if (!lock) return { status: "busy" };

  const notes: string[] = [];
  const today = todayInZone(prefs.timezone);
  const date = addDays(today, SPIKE_DAYS_OUT);
  const happenDay = String(localDateToCorosDay(date));
  const stamp = spikeStamp(today);
  const isThisStamp: StampPredicate = (name) => name === stamp;
  const inputs = {
    happenDay,
    name: stamp,
    catalog,
    genericTrainingOriginId: genericId,
    exerciseOriginId: exercise.id,
    exerciseLabel: exercise.label,
  };
  const sent = spikeStepFields(buildSpikeProgram(inputs));
  let stored: SpikeStepReport[] = sent.map((s, i) => compare(STEP_LABELS[i]!, s));
  let deleted = false;

  try {
    notes.push(
      `catalog: ${GENERIC_TRAINING_CODE} → ${genericId}; "${exercise.label}"` +
        ` (${catalog.get(exercise.id)}) → ${exercise.id}`,
    );
    notes.push(`workout: "${stamp}" on ${date}`);

    // 1. A spike that died before its delete leaves a workout behind. Only an
    //    exact spike stamp (prefix + date) is ever touched.
    const span = await readFullSpan(client, today);
    const planId = String(span.id ?? "");
    if (planId === "") {
      notes.push("no active plan in the schedule read — nothing written");
      return { status: "done", body: { stored, deleted, notes } };
    }
    const cleanup = await removeStamped(client, today, planId, isSpikeStamp, notes, "cleanup", span);
    if (!cleanup.allGone) {
      notes.push("stopped before writing: an earlier spike workout could not be removed");
      return { status: "done", body: { stored, deleted, notes } };
    }

    // 2–3. Create through the production executor, then read it back fresh.
    let created: Awaited<ReturnType<typeof createWorkout>> | undefined;
    try {
      const { session, catalog: spikeCatalog } = spikeWorkout(inputs);
      created = await createWorkout(client, { happenDay, name: stamp, session }, { catalog: spikeCatalog, today });
      notes.push(
        `create: ${created.ok ? "ok" : "failed"}` +
          `${created.code ? ` (result ${created.code})` : ""}` +
          `${created.reason ? ` ${created.reason}` : ""}` +
          `${created.error ? `: ${created.error}` : ""}`,
      );
      if (created.serverIdInPlan != null) {
        const landedOn = created.serverHappenDay ?? date;
        const raw = await client.getRawSchedule(addDays(landedOn, -3), addDays(landedOn, 3));
        const found = stampedPlacements(planView(raw, created.serverPlanId ?? planId), isThisStamp).find(
          (f) => f.date === landedOn,
        );
        const program: RawCorosProgram | undefined = found?.program;
        const got = spikeStepFields(program);
        stored = sent.map((s, i) => compare(STEP_LABELS[i]!, s, got[i]));
        notes.push(
          found
            ? `read-back: ${got.length} step(s) stored for ${sent.length} sent`
            : `read-back: nothing carrying the stamp on ${landedOn}`,
        );
      }
    } catch (e) {
      notes.push(`error before the delete step: ${errText(e)}`);
    }

    // 4. Delete through the verified path, by the create's recorded address.
    if (created?.serverIdInPlan != null && created.serverProgramId != null) {
      const del = await deleteWorkout(
        client,
        {
          happenDay: String(localDateToCorosDay(created.serverHappenDay ?? date)),
          name: stamp,
          idInPlan: created.serverIdInPlan,
          programId: created.serverProgramId,
          planId: created.serverPlanId ?? planId,
        },
        { today },
      );
      notes.push(
        del.ok
          ? `delete: ok${del.code ? ` (result ${del.code})` : ""}`
          : `delete: ${del.refused ?? "failed"}${del.error ? `: ${del.error}` : ""}`,
      );
    } else {
      notes.push("delete: the create left no address — checking by stamp");
    }

    // 5. A fresh plan-wide read: anything still carrying the stamp (a stray,
    //    or a delete that did not take) is removed by its own observed address.
    const after = await removeStamped(client, today, planId, isThisStamp, notes, "after delete");
    deleted = after.allGone;
    notes.push(
      after.found === 0
        ? "fresh read: no workout carries the spike stamp"
        : after.allGone
          ? "fresh read: stray spike workout(s) removed and verified"
          : "fresh read: a spike workout is STILL on the calendar — remove it by hand in COROS",
    );
  } catch (e) {
    notes.push(`error: ${errText(e)}`);
  } finally {
    await releaseUserLock(db, userId, "coros_write", lock).catch(() => undefined);
  }
  return { status: "done", body: { stored, deleted, notes } };
}
