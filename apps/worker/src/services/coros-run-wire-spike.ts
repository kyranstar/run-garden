import { and, desc, eq, isNotNull } from "drizzle-orm";
import { dailyHealth } from "@rg/database";
import { addDays, todayInZone, type RunWatchSession, type RunWire, type UserPreferences } from "@rg/domain";
import {
  buildProgramFor,
  createWorkout,
  deleteWorkout,
  errText,
  isSpikeStamp,
  planView,
  readFullSpan,
  spikeStamp,
  stampedPlacements,
  type StampPredicate,
} from "@rg/coros";
import { localDateToCorosDay, type RawCorosExercise, type RawCorosProgram } from "@rg/providers";
import type { Env } from "../env.js";
import type { Db } from "./db.js";
import { corosClient } from "./coros-connection.js";
import { distinctStamped, removeStamped } from "./coros-unmapped-spike.js";
import { claimUserLock, releaseUserLock } from "./locks.js";

/**
 * THE RUN-WIRE LIVE CHECK (§8 phase 2), owner-gated, as the unmapped-move spike is: ONE stamped run program written
 * to the athlete's real COROS account 14 days out, read back, deleted, and the deletion confirmed by a fresh read — to
 * learn what COROS keeps of each wire before designed runs go on it.
 *
 * - `v1`: phase 1's flat interval topology — a 10-minute warm-up, 3 × (3 minutes at threshold, a bare 90 s recovery),
 *   one 20 s strides step, a 10-minute cool-down; every step a time.
 * - `v2`: phase 2's — a 10-minute warm-up, a repeat group of 3 × (800 m at interval pace, a bare 90 s recovery), and a
 *   2 km cool-down by distance.
 *
 * The variant picks the builder, whatever `RUN_WIRE_V2` says. Everything COROS-facing goes through the production
 * executors — the cloud write consumer's client and lock, `createWorkout` (plan-scoped ids, stamp uniqueness, calculate,
 * read-after-write by stamp, a designed run's own read-back) and `deleteWorkout` (re-proven, triple-addressed,
 * verified) — under the spike's stamp, so the spike's own cleanup body removes a leftover. One program per call: about
 * the unmapped spike's subrequests, inside Workers Free's 50. With no threshold known a stand-in (5:00 /km) puts the
 * bands on the wire to read, and the report says so. The response carries this app's own strings only.
 */

/** The exact run body: `{ confirm, variant }`. The cleanup body is the unmapped spike's (`SPIKE_CLEANUP_CONFIRM`). */
export const RUN_WIRE_SPIKE_CONFIRM = "write a test run";
/** How far out the test run is placed — clear of anything this week. */
const SPIKE_DAYS_OUT = 14;
/** The threshold the bands are made from when the athlete has none on file: 5:00 /km. */
const STAND_IN_THRESHOLD = 300;
/** The fields read back per step (`group` is the 1-based step number of its container: COROS issues its own ids). */
const STEP_FIELDS = [
  "exerciseType",
  "name",
  "originId",
  "targetType",
  "targetValue",
  "targetDisplayUnit",
  "intensityType",
  "intensityValue",
  "intensityValueExtend",
  "intensityMultiplier",
  "intensityDisplayUnit",
  "isGroup",
  "sets",
  "group",
  // What COROS is likeliest to change of a group (review-2 F1): a container's rest (its shape A's 0/30) and the sort.
  "restType",
  "restValue",
  "sortNo",
] as const;
const TOTAL_FIELDS = ["duration", "estimatedTime", "distance", "estimatedDistance", "exerciseNum", "totalSets"] as const;

type StepFields = Record<(typeof STEP_FIELDS)[number], unknown>;

export interface RunWireStepReport {
  step: number;
  sent: StepFields;
  /** Null when COROS stored no step at this position. */
  stored: StepFields | null;
  /** Fields whose stored value differs from the sent one (numbers compared by value); ["not stored"] when absent. */
  changed: string[];
}

export interface RunWireReport {
  variant: RunWire;
  thresholdSecPerKm: number;
  steps: RunWireStepReport[];
  /** The program's totals as built (before COROS's calculate) and as stored. */
  totals: { sent: Record<string, unknown>; stored: Record<string, unknown> | null };
  /** The create's own read-back by value (`storedContentDelta`): what it would record as differing, or null. */
  contentDelta: string | null;
  /** True when a fresh read after the delete finds no workout carrying the stamp. */
  deleted: boolean;
  notes: string[];
}

export type RunWireOutcome =
  | { status: "not_connected" }
  | { status: "busy" }
  | { status: "leftovers"; count: number }
  | { status: "done"; body: RunWireReport };

/** The test run of each variant (see the module comment). */
export function runWireSpikeSession(variant: RunWire): RunWatchSession {
  const warmup = { rounds: 1, steps: [{ role: "warmup" as const, effort: "easy" as const, target: { kind: "time" as const, seconds: 600 } }] };
  if (variant === "v1") {
    return {
      kind: "run_watch",
      title: "Run wire check",
      segments: [
        warmup,
        {
          rounds: 3,
          steps: [
            { role: "work", effort: "threshold", target: { kind: "time", seconds: 180 } },
            { role: "recovery", effort: "recovery", target: { kind: "time", seconds: 90 } },
          ],
        },
        { rounds: 1, steps: [{ role: "work", effort: "strides", target: { kind: "time", seconds: 20 } }] },
        { rounds: 1, steps: [{ role: "cooldown", effort: "easy", target: { kind: "time", seconds: 600 } }] },
      ],
    };
  }
  return {
    kind: "run_watch",
    title: "Run wire check",
    segments: [
      warmup,
      {
        rounds: 3,
        steps: [
          { role: "work", effort: "interval", target: { kind: "distance", meters: 800 } },
          { role: "recovery", effort: "recovery", target: { kind: "time", seconds: 90 } },
        ],
      },
      { rounds: 1, steps: [{ role: "cooldown", effort: "easy", target: { kind: "distance", meters: 2000 } }] },
    ],
  };
}

/** A program's steps in the report's terms: each field asked for, its container by step number. */
function stepFieldsOf(program: RawCorosProgram | undefined): StepFields[] {
  const steps = (program?.exercises ?? []) as Array<RawCorosExercise & Record<string, unknown>>;
  const containerAt = new Map(steps.map((e, i) => [String(e.id), i + 1] as const).filter(([, i]) => steps[i - 1]!.isGroup === true));
  return steps.map((e) => {
    const out = {} as StepFields;
    for (const f of STEP_FIELDS) out[f] = f === "group" ? (containerAt.get(String(e.groupId)) ?? null) : (e[f] ?? null);
    return out;
  });
}

/** Equal by value: COROS re-encodes on save ("871.00" for 871). */
function same(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  const na = typeof a === "string" && a.trim() !== "" ? Number(a) : a;
  const nb = typeof b === "string" && b.trim() !== "" ? Number(b) : b;
  return typeof na === "number" && typeof nb === "number" && na === nb;
}

function totalsOf(program: RawCorosProgram): Record<string, unknown> {
  const p = program as unknown as Record<string, unknown>;
  return Object.fromEntries(TOTAL_FIELDS.map((f) => [f, p[f] ?? null]));
}

async function thresholdOf(db: Db, userId: string): Promise<number | null> {
  const [r] = await db
    .select({ v: dailyHealth.thresholdPaceSecPerKm })
    .from(dailyHealth)
    .where(and(eq(dailyHealth.userId, userId), isNotNull(dailyHealth.thresholdPaceSecPerKm)))
    .orderBy(desc(dailyHealth.date))
    .limit(1);
  return r?.v ?? null;
}

export async function runRunWireSpike(
  db: Db,
  env: Env,
  userId: string,
  prefs: UserPreferences,
  variant: RunWire,
  opts: { fetchImpl?: typeof fetch } = {},
): Promise<RunWireOutcome> {
  const client = await corosClient(db, env, userId, opts.fetchImpl ?? fetch);
  if (!client) return { status: "not_connected" };
  // The cloud write consumer's lock: id derivation is read-then-write, so no other COROS write may interleave.
  const lock = await claimUserLock(db, userId, "coros_write", 10);
  if (!lock) return { status: "busy" };

  const notes: string[] = [];
  const today = todayInZone(prefs.timezone);
  const date = addDays(today, SPIKE_DAYS_OUT);
  const happenDay = String(localDateToCorosDay(date));
  const stamp = spikeStamp(today);
  const isThisStamp: StampPredicate = (name) => name === stamp;
  const known = await thresholdOf(db, userId);
  const threshold = known ?? STAND_IN_THRESHOLD;
  const spec = { happenDay, name: stamp, session: runWireSpikeSession(variant), thresholdPaceSecPerKm: threshold, runWire: variant };
  const built = buildProgramFor(spec, new Map());
  const sent = stepFieldsOf(built);
  let steps: RunWireStepReport[] = sent.map((s, i) => ({ step: i + 1, sent: s, stored: null, changed: ["not stored"] }));
  let storedTotals: Record<string, unknown> | null = null;
  let contentDelta: string | null = null;
  let deleted = false;

  try {
    notes.push(`variant ${variant}: "${stamp}" on ${date}`);
    notes.push(known !== null ? `threshold: the athlete's, ${known} s/km` : `no threshold known: a stand-in ${STAND_IN_THRESHOLD} s/km (5:00 /km) makes the bands`);

    // 1. A spike that died before its delete leaves a workout behind: stop before writing (the cleanup body removes it).
    const span = await readFullSpan(client, today);
    const planId = String(span.id ?? "");
    if (planId === "") {
      notes.push("no active plan in the schedule read — nothing written");
      return { status: "done", body: { variant, thresholdSecPerKm: threshold, steps, totals: { sent: totalsOf(built), stored: null }, contentDelta, deleted, notes } };
    }
    const leftovers = distinctStamped(span, planId, isSpikeStamp).length;
    if (leftovers > 0) return { status: "leftovers", count: leftovers };

    // 2–3. Create through the production executor, then read it back fresh.
    let created: Awaited<ReturnType<typeof createWorkout>> | undefined;
    try {
      created = await createWorkout(client, spec, { catalog: new Map(), today });
      contentDelta = created.contentDelta ?? null;
      notes.push(
        `create: ${created.ok ? "ok" : "failed"}` +
          `${created.code ? ` (result ${created.code})` : ""}` +
          `${created.reason ? ` ${created.reason}` : ""}` +
          `${created.error ? `: ${created.error}` : ""}`,
      );
      if (created.serverIdInPlan != null) {
        const landedOn = created.serverHappenDay ?? date;
        const raw = await client.getRawSchedule(addDays(landedOn, -3), addDays(landedOn, 3));
        const found = stampedPlacements(planView(raw, created.serverPlanId ?? planId), isThisStamp).find((f) => f.date === landedOn);
        if (found?.program) {
          const got = stepFieldsOf(found.program);
          steps = sent.map((s, i) => {
            const g = got[i];
            return g ? { step: i + 1, sent: s, stored: g, changed: STEP_FIELDS.filter((f) => !same(s[f], g[f])) } : { step: i + 1, sent: s, stored: null, changed: ["not stored"] };
          });
          storedTotals = totalsOf(found.program);
          notes.push(`read-back: ${got.length} step(s) stored for ${sent.length} sent`);
        } else {
          notes.push(`read-back: nothing carrying the stamp on ${landedOn}`);
        }
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
      notes.push(del.ok ? `delete: ok${del.code ? ` (result ${del.code})` : ""}` : `delete: ${del.refused ?? "failed"}${del.error ? `: ${del.error}` : ""}`);
    } else {
      notes.push("delete: the create left no address — checking by stamp");
    }

    // 5. A fresh plan-wide read: anything still carrying the stamp is removed by its own observed address.
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
  return { status: "done", body: { variant, thresholdSecPerKm: threshold, steps, totals: { sent: totalsOf(built), stored: storedTotals }, contentDelta, deleted, notes } };
}
