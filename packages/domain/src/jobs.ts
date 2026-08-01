import { z } from "zod";

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

export const corosWriteJobSchema = z.object({
  /** Unique operation id; also the idempotency key. */
  id: z.string(),
  workoutId: z.string(),
  kind: z.literal("move_scheduled_workout"),
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
