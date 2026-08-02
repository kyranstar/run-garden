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
import { addDays, type CorosWriteResult } from "@rg/domain";
import type { NameResolver } from "@rg/providers";
import type { CorosClient } from "./coros-client.js";
import { buildSnapshot, loadNameResolver } from "./snapshot.js";
import { executeMoveJob, type MoveJobResult } from "./write-executor.js";

const DEFAULT_POLL_MS = 45_000;
const DEFAULT_SNAPSHOT_MS = 30 * 60_000;
const SNAPSHOT_PAST_DAYS = 14;
const SNAPSHOT_FUTURE_DAYS = 8 * 7;

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
  intervals?: { pollMs?: number; snapshotMs?: number };
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
  workout: {
    id?: string;
    sourcePlanId: string;
    sourceWorkoutId?: string;
    sourceIdInPlan?: string;
    sourceProgramId?: string;
    title?: string;
  };
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
  private readonly logger: (line: string) => void;

  private pollTimer: ReturnType<typeof setInterval> | null = null;
  private snapshotTimer: ReturnType<typeof setInterval> | null = null;
  /** Serializes snapshot pushes and job execution: one COROS write at a time. */
  private chain: Promise<void> = Promise.resolve();
  private localePromise: Promise<NameResolver | undefined> | null = null;

  constructor(opts: CloudSyncOptions) {
    this.apiUrl = opts.apiUrl.replace(/\/+$/, "");
    this.deviceId = opts.deviceId;
    this.privateKey = resolvePrivateKey(opts);
    this.client = opts.client;
    this.bridgeVersion = opts.bridgeVersion ?? "0.1.0";
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.pollMs = opts.intervals?.pollMs ?? DEFAULT_POLL_MS;
    this.snapshotMs = opts.intervals?.snapshotMs ?? DEFAULT_SNAPSHOT_MS;
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
    this.localePromise ??= loadNameResolver(this.client.fetchImpl);
    const resolver = await this.localePromise;
    const snapshot = await buildSnapshot(this.client, rangeStart, rangeEnd, resolver);
    await this.post("/api/devices/bridge/sync", {
      bridgeVersion: this.bridgeVersion,
      capabilities: this.client.getCapabilities(),
      plan: snapshot.plan,
      workouts: snapshot.workouts,
      rangeStart,
      rangeEnd,
      activities: snapshot.activities,
      lapsByProviderId: snapshot.lapsByProviderId,
      health: snapshot.health,
    });
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
      };
      if (!claim.job) return;
      const job = claim.job;
      this.logger(`[coros-bridge] claimed job ${job.id}`);

      let executed: MoveJobResult;
      if (!job.workout.sourceIdInPlan) {
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

  start(): void {
    this.enqueue("pushSnapshot", () => this.pushSnapshot());
    this.enqueue("pollJobs", () => this.pollJobs());
    this.pollTimer = setInterval(
      () => this.enqueue("pollJobs", () => this.pollJobs()),
      this.pollMs,
    );
    this.snapshotTimer = setInterval(
      () => this.enqueue("pushSnapshot", () => this.pushSnapshot()),
      this.snapshotMs,
    );
  }

  stop(): void {
    if (this.pollTimer) clearInterval(this.pollTimer);
    if (this.snapshotTimer) clearInterval(this.snapshotTimer);
    this.pollTimer = null;
    this.snapshotTimer = null;
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
    const res = await this.fetchImpl(`${this.apiUrl}${path}`, {
      method: "POST",
      headers,
      body: text,
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
