import { z } from "zod";
import { isLocalDate } from "./time.js";
import { studioSessionSchema } from "./studio.js";

export const COROS_WRITE_JOB_STATUSES = [
  "queued", // waiting for a capable executor
  "claimed", // a device has claimed it
  "in_progress", // write being attempted
  "verifying", // write sent; read-after-write in progress
  "verified", // read-after-write confirmed the desired state
  "failed", // permanently failed after retries; workout falls back to calendar_only
  "needs_attention", // upstream conflict or ambiguous result; user decision required
  "superseded", // a newer job for the same workout replaced this one
  "cancelled",
] as const;
export type CorosWriteJobStatus = (typeof COROS_WRITE_JOB_STATUSES)[number];

/**
 * Every mutation the bridge can be asked to perform (plan-studio-design §5).
 * `move_scheduled_workout` is the original calendar-move protocol; the two
 * studio kinds carry a Plan Studio session onto (or off) the account's own
 * container plan via the create-executor.
 */
export const COROS_WRITE_JOB_KINDS = [
  "move_scheduled_workout",
  "create_scheduled_workout",
  "delete_scheduled_workout",
] as const;
export type CorosWriteJobKind = (typeof COROS_WRITE_JOB_KINDS)[number];

/** The two kinds whose lifecycle is owned by the studio push state machine. */
export const STUDIO_JOB_KINDS = [
  "create_scheduled_workout",
  "delete_scheduled_workout",
] as const;
export type StudioJobKind = (typeof STUDIO_JOB_KINDS)[number];

export function isStudioJobKind(kind: string): kind is StudioJobKind {
  return (STUDIO_JOB_KINDS as readonly string[]).includes(kind);
}

const localDate = z.string().refine(isLocalDate, {
  message: "must be a YYYY-MM-DD calendar date",
});

/**
 * What the bridge is handed to create ONE studio session on COROS.
 *
 * Deliberately carries NO plan id. The create-executor resolves the account's
 * active container plan from its own fresh read and refuses if that identity
 * shifts mid-create; handing it a caller-asserted plan would put a stale id
 * ahead of the server's own answer, which is the one thing that guard exists
 * to prevent.
 *
 * `catalog` is only the entries THIS session needs (originId → display name),
 * resolved by the worker from `coros_exercises` before the job is enqueued —
 * so an exercise the account's catalog does not know fails at enqueue time
 * rather than on the wire.
 */
export const createScheduledWorkoutJobSchema = z
  .object({
    /** The `studio_plan_pushes` row this job reports back onto. */
    pushId: z.string().min(1),
    /** LocalDate. The bridge converts to COROS's YYYYMMDD wire form. */
    happenDay: localDate,
    /** Workout name AND ownership stamp; unique across the container plan. */
    name: z.string().min(1),
    session: studioSessionSchema,
    catalog: z.array(z.object({ id: z.string().min(1), name: z.string().min(1) }).strict()),
  })
  .strict();
export type CreateScheduledWorkoutJob = z.infer<typeof createScheduledWorkoutJobSchema>;

/**
 * What the bridge is handed to remove one studio session. Every field is a
 * CLAIM recorded at push time; the executor re-reads and re-proves all of it
 * (plan scope, delete triple, program-name stamp) before sending anything.
 */
export const deleteScheduledWorkoutJobSchema = z
  .object({
    pushId: z.string().min(1),
    happenDay: localDate,
    /** The exact program-name stamp recorded when the workout was created. */
    name: z.string().min(1),
    idInPlan: z.string().min(1),
    /** The recorded `planProgramId` — third element of the delete triple. */
    programId: z.string().min(1),
    /** The COROS container plan the workout lives in. */
    corosPlanId: z.string().min(1),
  })
  .strict();
export type DeleteScheduledWorkoutJob = z.infer<typeof deleteScheduledWorkoutJobSchema>;

/** Why a studio create did not end in a verified workout (create-executor). */
export const CREATE_FAILURE_REASONS = [
  "no_target_plan",
  "out_of_span",
  "slot_occupied",
  "rejected",
  "not_visible",
  "wrong_date",
  "error",
  "already_present",
] as const;
export type CreateFailureReasonCode = (typeof CREATE_FAILURE_REASONS)[number];

/** Why a studio delete was not sent (create-executor). */
export const DELETE_REFUSALS = ["not_found", "stamp_mismatch", "ambiguous"] as const;
export type DeleteRefusalCode = (typeof DELETE_REFUSALS)[number];

/**
 * The bridge's report on one studio job.
 *
 * STRUCTURED CODES ONLY — there is deliberately no free-text `error` field.
 * The executor's error strings can name workouts the user authored and this
 * envelope crosses the device→cloud boundary and lands in the worker's state
 * machine, so nothing that could be a title (or an executor log line) is
 * transmitted. Diagnostics stay on the bridge's own local logger.
 */
export const studioJobResultSchema = z
  .object({
    pushId: z.string().min(1),
    kind: z.enum(STUDIO_JOB_KINDS),
    ok: z.boolean(),
    /** COROS envelope result code of the write ("0000" = accepted). */
    code: z.string().optional(),
    reason: z.enum(CREATE_FAILURE_REASONS).optional(),
    refused: z.enum(DELETE_REFUSALS).optional(),
    serverIdInPlan: z.string().optional(),
    serverProgramId: z.string().optional(),
    serverEntityId: z.string().optional(),
    serverPlanId: z.string().optional(),
  })
  .strict();
export type StudioJobResult = z.infer<typeof studioJobResultSchema>;

export const corosWriteJobSchema = z.object({
  /** Unique operation id; also the idempotency key. */
  id: z.string(),
  workoutId: z.string(),
  kind: z.enum(COROS_WRITE_JOB_KINDS),
  /** Version/fingerprint the workout is expected to still have upstream. */
  expectedSourceVersion: z.string().optional(),
  expectedContentFingerprint: z.string(),
  originalDate: z.string(),
  destinationDate: z.string(),
  requestedAt: z.string(),
  status: z.enum(COROS_WRITE_JOB_STATUSES),
  claimedByDeviceId: z.string().optional(),
  claimedAt: z.string().optional(),
  attemptCount: z.number().int().default(0),
  maxAttempts: z.number().int().default(5),
  pathUsed: z.enum(["official_api", "direct_update", "remove_and_add"]).optional(),
  /** True when remove_and_add was used (identity may have changed). */
  degraded: z.boolean().default(false),
  verifiedAt: z.string().optional(),
  lastErrorCategory: z.string().optional(),
  completedAt: z.string().optional(),
});
export type CorosWriteJob = z.infer<typeof corosWriteJobSchema>;

/** Result a device reports after executing (or failing) a claimed job. */
export const corosWriteResultSchema = z.object({
  jobId: z.string(),
  deviceId: z.string(),
  outcome: z.enum([
    "verified", // write done AND read-after-write confirmed
    "already_in_desired_state", // idempotent no-op
    "upstream_changed", // expected version mismatch; did not write
    "write_failed", // write attempt failed cleanly (nothing changed)
    "ambiguous", // network failure mid-write; schedule re-read required
    "verification_failed", // write appeared to succeed but re-read disagrees
    "rolled_back", // remove-and-add fallback failed and was rolled back
    "unsupported", // bridge lacks the capability
  ]),
  pathUsed: z.enum(["official_api", "direct_update", "remove_and_add"]).optional(),
  /** Date range re-read after the write, with what COROS now reports. */
  observedDate: z.string().optional(),
  observedFingerprint: z.string().optional(),
  observedVersion: z.string().optional(),
  errorCategory: z.string().optional(),
  finishedAt: z.string(),
  /** Ed25519 signature over the canonical result payload, by the device key. */
  signature: z.string(),
  /**
   * Present only for the studio kinds. `outcome` above stays populated (it is
   * what the attempt log records), but the studio state machine reads THIS
   * block — the move-outcome vocabulary cannot express a create's
   * `wrong_date` or a delete's `stamp_mismatch`.
   */
  studio: studioJobResultSchema.optional(),
});
export type CorosWriteResult = z.infer<typeof corosWriteResultSchema>;

export function isTerminalJobStatus(s: CorosWriteJobStatus): boolean {
  return (
    s === "verified" ||
    s === "failed" ||
    s === "superseded" ||
    s === "cancelled" ||
    s === "needs_attention"
  );
}
