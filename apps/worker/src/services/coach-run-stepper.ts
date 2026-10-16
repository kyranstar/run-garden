/**
 * THE COACH'S RUN STEPPER: a coach designer's steps in a Durable Object's alarm (the lead's ruling on the robustness
 * pass, Phase 3 (d)). Cloudflare may cancel a request's work when its client disconnects (`waitUntil` adds 30 s), and a
 * step killed mid-model-call left its run `stepping` for 15 minutes and billed its worst case. A phone that locks mid-step
 * is ordinary. So with the switch on (`COACH_STEP_ALARM = "1"` and the `COACH_RUN_STEPPER` binding), no client request
 * carries a step:
 *
 *  - `POST /api/coach/runs/:id/step` validates the run and ARMS its object — one per main run, `idFromName(runId)`,
 *    SQLite-backed (the only kind on Workers Free) — and answers at once. The object's ALARM runs the existing `runStep`,
 *    unchanged: the same claim, caps, ceilings, the 45-statement budget (it spends none on a route's sign-in) and tools.
 *    Only the alarm steps.
 *  - THE WATCHING RULE stays (the model is called only for a client that is watching). Every client request — the step,
 *    a read, an answer — stamps a lease (`touchedAt`). A finished step chains the next due one only while a client is
 *    watching: within STEPPER_LEASE_MS, and having asked or read since that step began. So a tab closed mid-step finishes
 *    that step and at most one more, then the run rests until a client is back; a read finds the step due and arms it.
 *    An alarm that fires with nobody watching steps nothing.
 *  - RECOVERY. The object records the claim its step takes (`step.claimAt`) before it takes it. An invocation that dies
 *    (a crash, an eviction) leaves that record. The platform's RETRY of that alarm (`alarmInfo.isRetry`: it follows an
 *    invocation that has ended) takes the claim back AT ONCE (`StepOptions.ownClaim`). Anything else that finds the record
 *    with no invocation of its own at work — a client's word on a fresh instance, an alarm that is no retry — can't know
 *    the step is dead: a deploy lets an invocation that doesn't touch the object's storage run on in the old instance
 *    (the go-live review, I2). It takes the claim back only at stepTakebackAt (the claim, the model's deadline,
 *    a minute), arming the object for then; foreign claims keep COACH_RUN_STEP_STALE_MINUTES. The takeover is counted
 *    (A14): a step that dies MAX_TAKEOVERS times in a row fails plainly. A takeover with nobody watching calls no model.
 *    A dead step counts against the run's ceiling at a realistic estimate (coach-runs.ts `deadStepEstimateMicros`), the
 *    week's ledger at its worst case.
 *  - A run that is over is forgotten: the object's storage and alarm deleted — by the step that finds it over, or at once
 *    by a cancel (`forget`).
 *
 * Workers Free: an alarm's wall time is 15 minutes (the model's own deadline is 10); its CPU is a Worker invocation's,
 * which the step already meets (design-cpu-bench.test.ts measures it through the alarm too); 100,000 object requests and
 * 13,000 GB-s a day. Each client read is one request to the object and one row written.
 */
import { stagingEnabled, type Env } from "../env.js";
import { defaultRunDeps, LIVE_STATUSES, MAX_TAKEOVERS, runStep, type RunDeps, type StepOutcome } from "./coach-runs.js";
import { COACH_RUN_STEP_STALE_MINUTES } from "./cron-limits.js";
import { makeDb, type Db } from "./db.js";
import { designModelTimeoutMs } from "./llm-messages.js";
import { installStagingGuard } from "./staging.js";

/** How long a client's request keeps the run stepping: its lease. A client at work reads every 2 s. */
export const STEPPER_LEASE_MS = 120_000;
/** A step another request holds (busy), or a run that is live with nothing due: tried again this much later. */
export const STEPPER_BUSY_RETRY_MS = 5_000;
/** An account being restored: tried again this much later. */
export const STEPPER_RESTORE_RETRY_MS = 30_000;
/**
 * Invocations in a row that died with a step on record, at which the object stops trying: one more than MAX_TAKEOVERS,
 * so a step that dies after its claim is failed plainly by A14 first (on the invocation after its third death). This is
 * for one that dies before any claim, which the run never counts. The claim then goes to the stale window's takeover,
 * which a client's read arms (the go-live review, M3).
 */
export const STEPPER_MAX_DEATHS = MAX_TAKEOVERS + 1;
/** Past the model's own deadline, this long, no invocation on any instance can still be in its step's model call. */
export const STEPPER_TAKEBACK_GRACE_MS = 60_000;

/** When a recorded step may be taken back by anything but the platform's retry: its claim, the model's deadline here
 * (`designModelTimeoutMs`: 10 minutes but in fixture mode), a minute. */
export const stepTakebackAt = (env: Env, claimAt: string): number =>
  Date.parse(claimAt) + designModelTimeoutMs(env) + STEPPER_TAKEBACK_GRACE_MS;

/** The switch: "1", with the binding there. Anything else is the direct path (the step in the client's request). */
export const stepAlarmOn = (env: Env | undefined): boolean => !!env && env.COACH_STEP_ALARM === "1" && !!env.COACH_RUN_STEPPER;

/** A client's word to its run's object: it asks for a step (`arm`); it is here, reading or answering (`touch`); the run
 * ended by its hand (`forget`: a cancel). */
export type StepperOp = "arm" | "touch" | "forget";

export interface StepperAnswer {
  /** An alarm is set, or one is at work: the run will be stepped. */
  armed: boolean;
  /** An alarm of the object's is at work on a step now. */
  working: boolean;
  /** When the run's next step is due, as the object knows it (ms); null: none until a client asks. */
  nextAt: number | null;
  /** The word named another athlete than the run's: nothing was done. */
  refused?: boolean;
}

/** What the object keeps of its run (one key; one row written per word). */
interface StepperRecord {
  runId: string;
  userId: string;
  /** The last client request (ms): the lease runs from it. */
  touchedAt: number;
  /** When the run's next step is due (ms); null: nothing to step until a client asks (it waits on the athlete). */
  nextAt: number | null;
  /** The step at work — the claim it takes — written before it starts and cleared once it ends: one on record that no
   * invocation is at work on died. */
  step: { claimAt: string; startedAt: number } | null;
  /** Invocations in a row that died with a step on record. */
  deaths: number;
}

const KEY = "run";

/** Tell `runId`'s object: one request to it. Throws when it can't be reached or answers an error. */
export async function tellStepper(env: Env, runId: string, userId: string, op: StepperOp): Promise<StepperAnswer> {
  const ns = env.COACH_RUN_STEPPER!;
  const res = await ns.get(ns.idFromName(runId)).fetch(`https://coach-run-stepper/${op}`, {
    method: "POST",
    body: JSON.stringify({ runId, userId }),
  });
  if (!res.ok) throw new Error(`coach run stepper: ${op} answered ${res.status}`);
  return (await res.json()) as StepperAnswer;
}

/** Tests' seams: a scripted model, the test database, a clock. Unset in the Worker: the real ones. */
export interface StepperOptions {
  deps?: () => RunDeps;
  db?: Db;
  clock?: () => number;
}

const isLive = (status: string): boolean => (LIVE_STATUSES as readonly string[]).includes(status);

export class CoachRunStepper implements DurableObject {
  /**
   * An alarm of THIS instance is at work on a step. A step on record that none is at work on died with an earlier
   * instance. Set before the record is written, so a word landing between them never takes a live step for dead.
   */
  private working = false;
  private readonly storage: DurableObjectStorage;

  constructor(
    state: DurableObjectState,
    private readonly env: Env,
    private readonly opts: StepperOptions = {},
  ) {
    this.storage = state.storage;
  }

  private now(): number {
    return (this.opts.clock ?? Date.now)();
  }

  private async load(): Promise<StepperRecord | null> {
    return (await this.storage.get<StepperRecord>(KEY)) ?? null;
  }

  private async save(record: StepperRecord): Promise<void> {
    await this.storage.put(KEY, record);
  }

  /** The run is over: nothing of it is kept, and nothing is armed. */
  private async forget(): Promise<void> {
    await this.storage.deleteAlarm();
    await this.storage.deleteAll();
  }

  async fetch(request: Request): Promise<Response> {
    const op = new URL(request.url).pathname.slice(1);
    if (op !== "arm" && op !== "touch" && op !== "forget") return Response.json({ error: "not_found" }, { status: 404 });
    const body = (await request.json().catch(() => null)) as { runId?: unknown; userId?: unknown } | null;
    if (!body || typeof body.runId !== "string" || typeof body.userId !== "string") return Response.json({ error: "bad_request" }, { status: 400 });
    return Response.json(await this.tell(op, body.runId, body.userId));
  }

  /** A client's word: the lease stamped; a step asked for is due now (never before a due time already known); a step
   * that is due — or one that died with nothing left to retry it — is armed unless an alarm is set or at work. */
  private async tell(op: StepperOp, runId: string, userId: string): Promise<StepperAnswer> {
    const now = this.now();
    let record = await this.load();
    if (record && (record.runId !== runId || record.userId !== userId)) return { armed: false, working: this.working, nextAt: null, refused: true };
    if (op === "forget") {
      // The run is over (a cancel): nothing of it is kept. A step at work finds it over and stops on its own.
      if (record) await this.forget();
      return { armed: false, working: this.working, nextAt: null };
    }
    if (!record) {
      // A read of a run nobody asked to step: nothing to keep.
      if (op === "touch") return { armed: false, working: false, nextAt: null };
      record = { runId, userId, touchedAt: now, nextAt: null, step: null, deaths: 0 };
    }
    record.touchedAt = now;
    if (op === "arm" && record.nextAt === null) record.nextAt = now;
    await this.save(record);
    if (this.working || (await this.storage.getAlarm()) !== null) return { armed: true, working: this.working, nextAt: record.nextAt };
    // Due: a step asked for, or chained. A step on record that no invocation of this instance is at work on began on an
    // earlier one — dead, or still running there after a deploy: armed for when it may be taken back, never sooner (I2).
    const due = record.step !== null ? stepTakebackAt(this.env, record.step.claimAt) : record.nextAt;
    if (due === null) return { armed: false, working: false, nextAt: null };
    await this.storage.setAlarm(Math.max(now, due));
    return { armed: true, working: false, nextAt: record.nextAt };
  }

  async alarm(alarmInfo?: AlarmInvocationInfo): Promise<void> {
    // An alarm is no request through the Worker's fetch: staging's outbound guard is installed here too.
    if (stagingEnabled(this.env)) installStagingGuard();
    const record = await this.load();
    if (!record) return;
    const now = this.now();
    // This instance runs one alarm at a time: a step on record is one an earlier invocation began. Only the platform's
    // retry knows that invocation has ended; anything else waits until no invocation can still be in its model call (I2).
    const dead = record.step;
    const retry = alarmInfo?.isRetry === true || (alarmInfo?.retryCount ?? 0) > 0;
    if (dead && !retry && now < stepTakebackAt(this.env, dead.claimAt)) {
      await this.storage.setAlarm(stepTakebackAt(this.env, dead.claimAt));
      return;
    }
    const deaths = dead ? record.deaths + 1 : 0;
    if (dead && deaths >= STEPPER_MAX_DEATHS) {
      // Stop trying it as our own: the claim goes to the stale window's takeover — a read arms it for then (M3).
      console.error(JSON.stringify({ level: "error", msg: "coach-run-stepper: the step kept dying; stopped", run: record.runId, deaths }));
      await this.save({ ...record, step: null, deaths: 0, nextAt: Date.parse(dead.claimAt) + COACH_RUN_STEP_STALE_MINUTES * 60_000 });
      return;
    }
    if (dead) console.warn(JSON.stringify({ level: "warn", msg: "coach-run-stepper: taking back its own dead step", run: record.runId, retry, deaths }));
    const watched = now - record.touchedAt < STEPPER_LEASE_MS;
    // Nobody watching and nothing to take back: the run rests until a client asks.
    if (!watched && !dead) return;
    const at = new Date(now);
    let outcome: StepOutcome;
    this.working = true;
    try {
      await this.save({ ...record, step: { claimAt: at.toISOString(), startedAt: now }, deaths });
      // Nobody watching: the dead claim is taken back, and no model is called for nobody (the sweep's own step).
      outcome = await runStep(this.opts.db ?? makeDb(this.env.DB), this.env, record.runId, record.userId, at, (this.opts.deps ?? defaultRunDeps)(), {
        ...(watched ? {} : { model: false }),
        ...(dead ? { ownClaim: dead.claimAt } : {}),
      });
    } finally {
      // A step that threw keeps its record: the platform's retry takes its claim back.
      this.working = false;
    }
    await this.settle(outcome, now);
  }

  /** After a step: the run forgotten once over; else when its next step is due, armed while a client watches. */
  private async settle(outcome: StepOutcome, startedAt: number): Promise<void> {
    const now = this.now();
    // Read again: a client's word may have landed while the step ran.
    const record = await this.load();
    if (!record) return;
    record.step = null;
    record.deaths = 0;
    switch (outcome.kind) {
      case "not_found":
        return this.forget();
      case "ok": {
        const result = outcome.result;
        if (!isLive(result.status)) return this.forget();
        const at = result.nextDue ? Date.parse(result.nextDue.at) : Number.NaN;
        record.nextAt = result.status === "waiting_athlete" ? null : Number.isFinite(at) ? at : now + STEPPER_BUSY_RETRY_MS;
        break;
      }
      case "busy":
        record.nextAt = now + STEPPER_BUSY_RETRY_MS;
        break;
      case "restoring":
        record.nextAt = now + STEPPER_RESTORE_RETRY_MS;
        break;
    }
    await this.save(record);
    // The next step only for a client watching: within the lease, and seen since this step began (a step that ran
    // nothing — busy, restoring — is tried again while the lease holds).
    const fresh = now - record.touchedAt < STEPPER_LEASE_MS;
    const seen = outcome.kind !== "ok" || record.touchedAt >= startedAt;
    if (record.nextAt !== null && fresh && seen) await this.storage.setAlarm(Math.max(now, record.nextAt));
  }
}
