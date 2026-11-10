import type { Context, Next } from "hono";
import { getCookie } from "hono/cookie";
import { and, eq, isNull } from "drizzle-orm";
import { nowInstant } from "@rg/domain";
import type { Env } from "../env.js";
import { makeDb, type Db } from "../services/db.js";
import { restoreInProgress } from "../services/account-state.js";
import { resolveSession, SESSION_COOKIE } from "./sessions.js";
import { deviceSigningMessage, sha256Hex, verifyEd25519 } from "./crypto.js";
import { nativeDevicesEnabled } from "../env.js";
import { DEVICE_SCOPE, inDeviceScope } from "./device-scope.js";
import { deviceTokenOf, findDevice, isDeviceBearer, isOwnerEmail, touchDevice } from "./native-devices.js";

/** A request a paired phone made with its device token (native device sign-in): which device, as `requireUser` found it. */
export interface DeviceContext {
  id: string;
  label: string;
  expiresAt: string;
}

export interface AppContext {
  Bindings: Env;
  Variables: {
    db: Db;
    userId: string;
    userEmail: string;
    /**
     * Test-only seam: when set, `/api/studio` routes pass this instead of the
     * global `fetch` into `generatePlan`/`editPlan`'s own optional trailing
     * `fetchImpl` parameter, so a route test can script an exact gateway
     * response (e.g. a major-edit reply with a mutated `brief`) without a
     * live network call. Never set by any production code path — omitted,
     * every real request falls back to the global `fetch`, identical to
     * before this existed.
     */
    llmFetch?: typeof fetch;
    /** Set only when a device token signed the request in (`requireUser`'s device branch); never for a cookie. */
    device?: DeviceContext;
  };
}

export async function withDb(c: Context<AppContext>, next: Next): Promise<void | Response> {
  c.set("db", makeDb(c.env.DB));
  await next();
}

/**
 * Requests that still go through while a restore is replacing the account:
 * the restore itself, deleting everything, signing in/out, and the app-open
 * COROS pull (which answers "restoring" and writes nothing). (And the import's
 * dry run: `openWhileRestoring`.) And stopping a paired phone — the laptop's
 * Revoke and Revoke all, and the phone's own sign-out (native device sign-in,
 * worker review L1): they write only `native_devices`, which no restore
 * touches, and a restore abandoned days ago must not keep a lost phone live.
 */
const OPEN_WHILE_RESTORING = [
  /^\/api\/settings\/restore\//,
  /^\/api\/settings\/delete-all$/,
  /^\/api\/auth\//,
  /^\/api\/(coros|sync)\/read-now$/,
  /^\/api\/native\/devices\/(revoke-all|[^/]+\/revoke)$/,
  /^\/api\/native\/sign-out$/,
];
const MUTATING = new Set(["POST", "PUT", "PATCH", "DELETE"]);

/** Open while restoring: the routes above, and the standalone import's DRY RUN — a read that writes nothing, with
 * the same `dryRun` reading the route uses (Audit 2c-A MINOR-3). The import itself stays refused. */
function openWhileRestoring(c: Context<AppContext>): boolean {
  if (OPEN_WHILE_RESTORING.some((re) => re.test(c.req.path))) return true;
  return c.req.path === "/api/import/standalone" && ["1", "true"].includes(c.req.query("dryRun") ?? "");
}

/** Browser-session authentication (cookie).
 *
 * Also the one place every route module passes through, so it is where a
 * restore in progress (ruling B2) freezes the account against every OTHER
 * write — a second tab or the phone moving a session, approving a proposal,
 * saving settings — with 423. GET requests still read. */
export async function requireUser(c: Context<AppContext>, next: Next): Promise<void | Response> {
  // A device token (native device sign-in, SLICE-CONTRACT revision 2 §10.3) takes its own branch, and only it: every
  // request without `Bearer rgd_…` runs the cookie path below exactly as before.
  if (isDeviceBearer(c.req.header("authorization"))) return requireDevice(c, next);
  const token = getCookie(c, SESSION_COOKIE);
  const session = await resolveSession(c.get("db"), token);
  if (!session) return c.json({ error: "unauthenticated" }, 401);
  c.set("userId", session.userId);
  c.set("userEmail", session.email);
  if (
    MUTATING.has(c.req.method) &&
    !openWhileRestoring(c) &&
    (await restoreInProgress(c.get("db"), session.userId))
  ) {
    return c.json({ error: "restore_in_progress" }, 423);
  }
  await next();
}

/**
 * THE DEVICE BRANCH of `requireUser` (SLICE-CONTRACT revision 2 §10.2, §10.3), for `Authorization: Bearer rgd_…`. In
 * order, each answer final:
 *
 *  1. a session cookie on the same request: 400 `two_credentials` (one request, one credential);
 *  2. the kill switch (`NATIVE_DEVICES`, a secret) not exactly "1": 401 `device_access_off`, before any read;
 *  3. not one well-formed token: 401 `unauthenticated`, before any read;
 *  4. the device, by its token's SHA-256, with its account (one read): none, 401 `unauthenticated`; revoked, 401
 *     `device_revoked`; expired, 401 `device_expired`; not yet confirmed on the laptop, 401 `device_pending`; another
 *     scope, 403 `out_of_scope`; an account that is not the owner's email, 401 `unauthenticated`;
 *  5. the route and its body on the scope's list (device-scope.ts), else 403 `out_of_scope` — before the restore rule;
 *  6. the restore rule (ruling B2), as the cookie path has it: a write while a restore runs is 423;
 *  7. last use written, at most hourly.
 *
 * 401 rather than 404 on purpose: the outbox keeps a 401 entry pending, shown as "Not signed in" (§4).
 */
async function requireDevice(c: Context<AppContext>, next: Next): Promise<void | Response> {
  if (getCookie(c, SESSION_COOKIE) !== undefined) return c.json({ error: "two_credentials" }, 400);
  if (!nativeDevicesEnabled(c.env)) return c.json({ error: "device_access_off" }, 401);
  const token = deviceTokenOf(c.req.header("authorization"));
  if (!token) return c.json({ error: "unauthenticated" }, 401);
  const db = c.get("db");
  const now = nowInstant();
  const device = await findDevice(db, token);
  if (!device) return c.json({ error: "unauthenticated" }, 401);
  if (device.state === "revoked") return c.json({ error: "device_revoked" }, 401);
  if (device.expiresAt <= now) return c.json({ error: "device_expired" }, 401);
  if (device.state !== "active") return c.json({ error: "device_pending" }, 401);
  if (device.scope !== DEVICE_SCOPE) return c.json({ error: "out_of_scope" }, 403);
  if (!isOwnerEmail(device.email, c.env)) return c.json({ error: "unauthenticated" }, 401);
  if (!(await inDeviceScope(c))) return c.json({ error: "out_of_scope" }, 403);
  if (MUTATING.has(c.req.method) && !openWhileRestoring(c) && (await restoreInProgress(db, device.userId))) {
    return c.json({ error: "restore_in_progress" }, 423);
  }
  await touchDevice(db, device, now);
  c.set("userId", device.userId);
  c.set("userEmail", device.email);
  c.set("device", { id: device.id, label: device.label, expiresAt: device.expiresAt });
  await next();
}

