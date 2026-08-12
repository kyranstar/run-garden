/**
 * Bridge ↔ cloud loop, used directly by the desktop app's Node sidecar.
 * Every request is Ed25519-signed over `${METHOD}\n${pathname}\n${timestamp}\n${sha256hex(body)}`
 * (see apps/worker/src/auth/crypto.ts deviceSigningMessage) with headers
 * x-device-id / x-device-timestamp / x-device-signature.
 */

import {
  createHash,
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
  sign as ed25519Sign,
  type KeyObject,
} from "node:crypto";
import {
  addDays,
  createScheduledWorkoutJobSchema,
  deleteScheduledWorkoutJobSchema,
  type CorosWriteResult,
} from "@rg/domain";
import type { NameResolver } from "@rg/providers";
import type { CorosClient } from "@rg/coros";
import { buildSnapshot, loadNameResolver } from "./snapshot.js";
import { buildActivityBackfill } from "./backfill.js";
import {
  executeMoveJob,
  executeStudioJob,
  type MoveJobResult,
  type StudioJob,
} from "@rg/coros";

const DEFAULT_POLL_MS = 45_000;
const FAST_POLL_MS = 10_000;
const DEFAULT_SNAPSHOT_MS = 30 * 60_000;
/**
 * Every cloud request aborts after this long. Without it, one hung request
 * wedges the shared work chain forever: the poll loop's re-arm lives in that
 * chain, so job claiming silently dies while the shell app's own reads keep
 * the device looking online — observed live for four days straight.
 */
const REQUEST_TIMEOUT_MS = 30_000;
const POLL_WATCHDOG_CHECK_MS = 60_000;
const SNAPSHOT_PAST_DAYS = 14;
const SNAPSHOT_FUTURE_DAYS = 8 * 7;
// Daily health (resting HR, HRV, recovery/fatigue) is one cheap query no
// matter the window, and the insights dashboard's load/recovery trends read
// much further back than the 14-day activity/plan window — so wellness gets
// its own, deeper backfill on every snapshot push.
const HEALTH_PAST_DAYS = 60;

/**
 * When may the watchdog re-arm the poll loop? Only when the loop is truly
 * dead: no timer pending and no poll waiting on the chain. Re-arming while a
 * poll is queued behind a busy chain multiplies load without recovering
 * anything — the request timeout, not the watchdog, is what unwedges chains.
 */
export function shouldWatchdogRearm(s: { pollTimerArmed: boolean; pollEnqueued: boolean }): boolean {
  return !s.pollTimerArmed && !s.pollEnqueued;
}

/** ASN.1 PKCS#8 wrapper for a raw Ed25519 32-byte seed. */
const PKCS8_ED25519_PREFIX = Buffer.from("302e020100300506032b657004220420", "hex");

/**
 * New device identity. `publicKeyRaw` is the b64url of the raw 32-byte public
 * key (JWK `x`), which the worker imports directly via WebCrypto
 * `importKey("raw", …, {name:"Ed25519"})`.
 */
export function generateDeviceKeypair(): { publicKeyRaw: string; privateKeyPem: string } {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const jwk = publicKey.export({ format: "jwk" }) as { x?: string };
  if (!jwk.x) throw new Error("failed to export Ed25519 public key");
  return {
    publicKeyRaw: jwk.x,
    privateKeyPem: privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
  };
}

export interface CloudSyncOptions {
  apiUrl: string;
  deviceId: string;
  privateKeyPem?: string;
  /** Alternative to the PEM: the raw 32-byte Ed25519 seed. */
  privateKeySeed?: Uint8Array;
  client: CorosClient;
  bridgeVersion?: string;
  fetchImpl?: typeof fetch;
  intervals?: { pollMs?: number; snapshotMs?: number; requestTimeoutMs?: number };
  logger?: (line: string) => void;
}

interface ClaimedJob {
  id: string;
  kind?: string;
  originalDate: string;
  destinationDate: string;
  expectedContentFingerprint?: string;
  expectedSourceVersion?: string;
  attemptCount?: number;
  /** Absent for the studio kinds, which act on a session, not a workout row. */
  workout?: {
    id?: string;
    sourcePlanId: string;
    sourceWorkoutId?: string;
    sourceIdInPlan?: string;
    sourceProgramId?: string;
    title?: string;
  } | null;
  /** Present for the backfill kind: the history chunk this job covers. */
  payload?: { chunkStart?: string; chunkEnd?: string };
  /** Present for the studio kinds (plan-studio-design §5). */
  studio?: unknown;
}

/**
 * A claimed job as a validated studio job, or undefined if it is not one (or
 * did not validate). The payload is re-parsed here even though the worker
 * built it: this process is the last stop before the user's real calendar.
 */
function toStudioJob(job: ClaimedJob): StudioJob | undefined {
  if (job.kind === "create_scheduled_workout") {
    const parsed = createScheduledWorkoutJobSchema.safeParse(job.studio);
    return parsed.success ? { id: job.id, kind: job.kind, studio: parsed.data } : undefined;
  }
  if (job.kind === "delete_scheduled_workout") {
    const parsed = deleteScheduledWorkoutJobSchema.safeParse(job.studio);
    return parsed.success ? { id: job.id, kind: job.kind, studio: parsed.data } : undefined;
  }
  return undefined;
}

export class CloudSync {
  private readonly apiUrl: string;
  private readonly deviceId: string;
  private readonly privateKey: KeyObject;
  private readonly client: CorosClient;
  private readonly bridgeVersion: string;
  private readonly fetchImpl: typeof fetch;
  private readonly pollMs: number;
  private readonly snapshotMs: number;
  private readonly requestTimeoutMs: number;
  private readonly logger: (line: string) => void;

  private pollTimer: ReturnType<typeof setTimeout> | null = null;
  private snapshotTimer: ReturnType<typeof setInterval> | null = null;
  private pollWatchdogTimer: ReturnType<typeof setInterval> | null = null;
  /** True from the moment a poll is enqueued until it settles — the watchdog
   * must never re-arm on top of a poll that is merely waiting on the chain. */
  private pollEnqueued = false;
  /** When a poll last settled (ok or not) — for the watchdog's log line only. */
  private lastPollSettledAt = Date.now();
  private stopped = true;
  /** Queued jobs remaining per the most recent claim response — drives adaptive polling. */
  private pendingCount = 0;
  /** Serializes snapshot pushes and job execution: one COROS write at a time. */
  private chain: Promise<void> = Promise.resolve();
  private localePromise: Promise<NameResolver | undefined> | null = null;
  /**
   * Whether the worker's stored exercise catalog is believed stale. Starts
   * `true`: at process start the bridge has no knowledge of the worker's
   * state, so the first-ever sync includes the catalog (documented choice —
   * see plan-studio-design §4). Updated from each sync response's
   * `catalogStale` field.
   */
  private catalogStale = true;

  constructor(opts: CloudSyncOptions) {
    this.apiUrl = opts.apiUrl.replace(/\/+$/, "");
    this.deviceId = opts.deviceId;
    this.privateKey = resolvePrivateKey(opts);
    this.client = opts.client;
    this.bridgeVersion = opts.bridgeVersion ?? "0.1.0";
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.pollMs = opts.intervals?.pollMs ?? DEFAULT_POLL_MS;
    this.snapshotMs = opts.intervals?.snapshotMs ?? DEFAULT_SNAPSHOT_MS;
    this.requestTimeoutMs = opts.intervals?.requestTimeoutMs ?? REQUEST_TIMEOUT_MS;
    this.logger = opts.logger ?? ((line) => console.error(line));
  }

  /** Signed headers for one request; the message covers method+path+time+body. */
  signRequest(method: string, path: string, body: string): Record<string, string> {
    const timestamp = new Date().toISOString();
    const pathname = new URL(path, `${this.apiUrl}/`).pathname;
    const bodySha256 = createHash("sha256").update(body, "utf8").digest("hex");
    const message = `${method.toUpperCase()}\n${pathname}\n${timestamp}\n${bodySha256}`;
    const signature = ed25519Sign(null, Buffer.from(message, "utf8"), this.privateKey);
    return {
      "x-device-id": this.deviceId,
      "x-device-timestamp": timestamp,
      "x-device-signature": signature.toString("base64url"),
    };
  }

  async pushSnapshot(): Promise<void> {
    const today = new Date().toISOString().slice(0, 10);
    const rangeStart = addDays(today, -SNAPSHOT_PAST_DAYS);
    const rangeEnd = addDays(today, SNAPSHOT_FUTURE_DAYS);
    const healthRangeStart = addDays(today, -HEALTH_PAST_DAYS);
    this.localePromise ??= loadNameResolver(this.client.fetchImpl);
    const resolver = await this.localePromise;
    const snapshot = await buildSnapshot(this.client, rangeStart, rangeEnd, resolver, {
      includeExerciseCatalog: this.catalogStale,
      healthRangeStart,
    });
    const response = (await this.post("/api/devices/bridge/sync", {
      bridgeVersion: this.bridgeVersion,
      capabilities: this.client.getCapabilities(),
      plan: snapshot.plan,
      workouts: snapshot.workouts,
      rangeStart,
      rangeEnd,
      activities: snapshot.activities,
      lapsByProviderId: snapshot.lapsByProviderId,
      health: snapshot.health,
      skippedSportTypes: snapshot.skippedSportTypes,
      exerciseCatalog: snapshot.exerciseCatalog,
    })) as { catalogStale?: boolean };
    // Conservative default: if the response is old/unparseable, keep trying.
    this.catalogStale = response.catalogStale ?? true;
    this.logger("[coros-bridge] cloud sync pushed snapshot");
  }

  /**
   * Read the current renderable garden over the signed device channel, for the
   * desktop app's ambient window. Read-only — no COROS access, so it can run
   * outside the write-serializing chain.
   */
  async readGarden(): Promise<unknown> {
    return this.post("/api/devices/bridge/garden", {});
  }

  /** Claim → execute → report, draining the queue one job at a time. */
  async pollJobs(): Promise<void> {
    for (let i = 0; i < 10; i++) {
      const claim = (await this.post("/api/devices/bridge/jobs/claim", {})) as {
        job: ClaimedJob | null;
        paused?: boolean;
        pendingCount?: number;
      };
      this.pendingCount = claim.pendingCount ?? 0;
      if (!claim.job) return;
      const job = claim.job;
      this.logger(`[coros-bridge] claimed job ${job.id}`);

      if (job.kind === "read_now") {
        await this.pushSnapshot();
        await this.post(`/api/devices/bridge/jobs/${job.id}/result`, {
          jobId: job.id,
          deviceId: this.deviceId,
          outcome: "verified",
          finishedAt: new Date().toISOString(),
          signature: "sig-in-headers",
        });
        this.logger(`[coros-bridge] job ${job.id} → read_now snapshot pushed`);
        continue;
      }

      if (job.kind === "backfill") {
        // Activities-only, never pushSnapshot: an old range through the
        // snapshot path trips import-plan rules 8/9 and archives the live plan.
        const chunkStart = job.payload?.chunkStart ?? job.originalDate;
        const chunkEnd = job.payload?.chunkEnd ?? job.destinationDate;
        this.localePromise ??= loadNameResolver(this.client.fetchImpl);
        const resolver = await this.localePromise;
        let outcome: "verified" | "write_failed" = "verified";
        try {
          const chunk = await buildActivityBackfill(this.client, chunkStart, chunkEnd, resolver);
          await this.post("/api/devices/bridge/backfill-chunk", {
            chunkStart,
            chunkEnd,
            activities: chunk.activities,
            lapsByProviderId: chunk.lapsByProviderId,
            skippedSportTypes: chunk.skippedSportTypes,
          });
          this.logger(
            `[coros-bridge] job ${job.id} → backfill ${chunkStart}..${chunkEnd}, ${chunk.activities.length} activities`,
          );
        } catch (e) {
          outcome = "write_failed";
          this.logger(
            `[coros-bridge] job ${job.id} → backfill failed: ${e instanceof Error ? e.name : "unknown"}`,
          );
        }
        await this.post(`/api/devices/bridge/jobs/${job.id}/result`, {
          jobId: job.id,
          deviceId: this.deviceId,
          outcome,
          finishedAt: new Date().toISOString(),
          signature: "sig-in-headers",
        });
        continue;
      }

      let executed: MoveJobResult;
      const studioJob = toStudioJob(job);
      if (studioJob) {
        executed = await executeStudioJob(this.client, studioJob, { log: this.logger });
      } else if (job.kind === "create_scheduled_workout" || job.kind === "delete_scheduled_workout") {
        // Studio kind whose payload did not validate. A write instruction that
        // reached this process malformed is never half-executed against the
        // user's real calendar.
        executed = {
          jobId: job.id,
          outcome: "unsupported",
          errorCategory: "malformed_studio_payload",
        };
      } else if (!job.workout?.sourceIdInPlan) {
        executed = {
          jobId: job.id,
          outcome: "unsupported",
          errorCategory: "missing_source_id_in_plan",
        };
      } else {
        executed = await executeMoveJob(this.client, {
          id: job.id,
          originalDate: job.originalDate,
          destinationDate: job.destinationDate,
          expectedContentFingerprint: job.expectedContentFingerprint,
          workout: {
            sourceIdInPlan: job.workout.sourceIdInPlan,
            sourcePlanId: job.workout.sourcePlanId,
            sourceProgramId: job.workout.sourceProgramId,
            sourceWorkoutId: job.workout.sourceWorkoutId,
          },
        });
      }

      const result: CorosWriteResult = {
        ...executed,
        jobId: job.id,
        deviceId: this.deviceId,
        finishedAt: new Date().toISOString(),
        // The Ed25519 request signature in the headers covers this body; the
        // worker trusts the transport signature. Field kept non-empty.
        signature: "sig-in-headers",
      };
      await this.post(`/api/devices/bridge/jobs/${job.id}/result`, result);
      this.logger(`[coros-bridge] job ${job.id} → ${executed.outcome}`);
    }
  }

  /**
   * Adaptive poll scheduling: while a `read_now` (or anything else) leaves
   * jobs queued, poll every `FAST_POLL_MS`; otherwise fall back to the normal
   * `pollMs` cadence. A `setTimeout` loop (rather than `setInterval`) so the
   * delay can change between runs based on the last claim's `pendingCount`.
   */
  private schedulePoll(): void {
    if (this.stopped) return;
    // Idempotent: exactly one pending timer, ever. A watchdog re-arm racing a
    // healthy loop must replace the pending timer, never duplicate it.
    if (this.pollTimer) clearTimeout(this.pollTimer);
    const delay = this.pendingCount > 0 ? FAST_POLL_MS : this.pollMs;
    this.pollTimer = setTimeout(() => {
      this.pollTimer = null;
      this.pollEnqueued = true;
      this.enqueue("pollJobs", async () => {
        try {
          await this.pollJobs();
        } finally {
          this.pollEnqueued = false;
          this.lastPollSettledAt = Date.now();
          this.schedulePoll();
        }
      });
    }, delay);
  }

  /**
   * The poll loop's re-arm rides the shared chain; if that re-arm is ever
   * skipped (a bug between timers), claiming dies silently while snapshots
   * (their own interval) keep the device looking online. The watchdog fixes
   * exactly that: no pending timer AND no poll queued on the chain = the loop
   * is dead — re-arm it. A poll stuck waiting on a busy chain is NOT re-armed
   * (the request timeout is what unsticks chains; piling on more polls only
   * amplified the load — review finding, 2026-08-10).
   */
  private watchdogCheck(): void {
    if (this.stopped) return;
    // Staleness is logged UNCONDITIONALLY: a poll wedged behind a hung chain
    // is exactly the state the watchdog cannot re-arm out of, and it must
    // never be silent again (it was, for four days).
    const quietMs = Date.now() - this.lastPollSettledAt;
    if (quietMs > Math.max(5 * 60_000, this.pollMs * 3)) {
      this.logger(
        `[coros-bridge] no poll settled for ${Math.round(quietMs / 1000)}s` +
          ` (timer=${this.pollTimer !== null} enqueued=${this.pollEnqueued})`,
      );
    }
    if (!shouldWatchdogRearm({ pollTimerArmed: this.pollTimer !== null, pollEnqueued: this.pollEnqueued })) {
      return;
    }
    this.logger(`[coros-bridge] poll loop dead (no timer, no queued poll) — re-arming`);
    this.schedulePoll();
  }

  start(): void {
    this.stopped = false;
    this.lastPollSettledAt = Date.now();
    this.enqueue("pushSnapshot", () => this.pushSnapshot());
    this.enqueue("pollJobs", () => this.pollJobs());
    this.schedulePoll();
    this.pollWatchdogTimer = setInterval(() => this.watchdogCheck(), POLL_WATCHDOG_CHECK_MS);
    this.snapshotTimer = setInterval(
      () => this.enqueue("pushSnapshot", () => this.pushSnapshot()),
      this.snapshotMs,
    );
  }

  stop(): void {
    this.stopped = true;
    if (this.pollTimer) clearTimeout(this.pollTimer);
    if (this.snapshotTimer) clearInterval(this.snapshotTimer);
    if (this.pollWatchdogTimer) clearInterval(this.pollWatchdogTimer);
    this.pollTimer = null;
    this.snapshotTimer = null;
    this.pollWatchdogTimer = null;
    this.pollEnqueued = false;
  }

  /** Wait for all queued work to settle (used by tests and shutdown). */
  async flush(): Promise<void> {
    await this.chain;
  }

  private enqueue(label: string, fn: () => Promise<void>): void {
    this.chain = this.chain.then(fn).catch((e: unknown) => {
      // Sanitized: category/name only, never payloads.
      this.logger(
        `[coros-bridge] ${label} failed: ${e instanceof Error ? e.name : "unknown"}`,
      );
    });
  }

  private async post(path: string, body: unknown): Promise<unknown> {
    const text = JSON.stringify(body);
    const headers = {
      ...this.signRequest("POST", path, text),
      "content-type": "application/json",
    };
    // Body-heavy uploads (a 90-day history chunk, a full snapshot) get a
    // generous budget on slow uplinks; everything else stays tight. A request
    // that never settles would wedge the whole work chain — abort it and let
    // the chain's catch move on.
    const heavy = path === "/api/devices/bridge/sync" || path === "/api/devices/bridge/backfill-chunk";
    const timeoutMs = heavy ? this.requestTimeoutMs * 4 : this.requestTimeoutMs;
    const res = await this.fetchImpl(`${this.apiUrl}${path}`, {
      method: "POST",
      headers,
      body: text,
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) throw new Error(`cloud request ${path} failed with status ${res.status}`);
    return res.json();
  }
}

function resolvePrivateKey(opts: CloudSyncOptions): KeyObject {
  if (opts.privateKeyPem) return createPrivateKey(opts.privateKeyPem);
  if (opts.privateKeySeed) {
    if (opts.privateKeySeed.length !== 32) {
      throw new Error("privateKeySeed must be exactly 32 bytes");
    }
    return createPrivateKey({
      key: Buffer.concat([PKCS8_ED25519_PREFIX, Buffer.from(opts.privateKeySeed)]),
      format: "der",
      type: "pkcs8",
    });
  }
  throw new Error("CloudSync requires privateKeyPem or privateKeySeed");
}

/** Raw 32-byte public key (b64url) for a private key — matches generateDeviceKeypair. */
export function publicKeyRawFromPrivate(privateKeyPem: string): string {
  const jwk = createPublicKey(createPrivateKey(privateKeyPem)).export({ format: "jwk" }) as {
    x?: string;
  };
  if (!jwk.x) throw new Error("failed to derive Ed25519 public key");
  return jwk.x;
}
