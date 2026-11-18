/**
 * `/api/qa` — THE LIFEOS QA ACCOUNT'S ROUTES (the phone QA harness, kit v0.16; services/qa-account.ts).
 *
 * The owner's laptop, the session cookie only — any other signed-in account is 404 (as if they weren't here), a device token
 * 403 `out_of_scope` (`requireUser`'s list, and again here), and every route is 404 where the QA account can't exist:
 *   GET  /status      {qa: {userId, accountTag, createdAt} | null, today, rows, devices, plan}: what Settings → Developer shows
 *   POST /user        the QA account made (201), or 409 `qa_exists`
 *   POST /seed        its fixtures for today and tomorrow, or 404 `no_qa_account` / 409 `already_seeded`
 *   POST /pairings    a pairing code for the QA account, with the run's plan and harness tokens (429 `too_many_codes`)
 *   GET  /state       what the QA account holds (ids, states, kinds, counts — no detail text)
 *   POST /purge       {confirm: "purge qa"}: one bounded step of the purge (≤ 45 statements a request) — `{done: false,
 *                     removed, remaining}` until the step that empties the last table, its sign-ins and its user row, and
 *                     checks every table zero: `{done: true, removed, remaining (all 0), total: 0}` (500 `purge_incomplete`
 *                     names the rest). Ask again while `done` is false
 *
 * The harness token's own door (`Authorization: Bearer rgq_…`, auth/qa-tokens.ts) — never a cookie, never a device token:
 *   GET  /run/state, POST /run/pairings, POST /run/purge {confirm}: as above, for the QA account the token names, while that
 *        account is the QA account (else 404 `no_qa_account`)
 *   GET  /run/verify  {userId, exists, rows, total}: every table counted for the token's account — still answering after the
 *        purge, so the harness can check zero itself; never for an account that isn't the QA address
 * Every refusal of a token is the same 401 `unauthenticated`.
 */
import { Hono, type Context, type MiddlewareHandler } from "hono";
import { eq } from "drizzle-orm";
import { nativeDevices, plannedWorkouts, users } from "@rg/database";
import { nowInstant, todayInZone } from "@rg/domain";
import type { AppContext } from "../auth/middleware.js";
import { requireUser } from "../auth/middleware.js";
import { isOwnerEmail } from "../auth/native-devices.js";
import { QA_EMAIL, qaPossible } from "../auth/qa-identity.js";
import { verifyHarnessToken } from "../auth/qa-tokens.js";
import { loadPreferences } from "../services/calendar-sync.js";
import {
  accountTag,
  createQaUser,
  mintQaPairing,
  purgeQaStep,
  QaAlreadySeededError,
  QaExistsError,
  QaGuardError,
  QaPurgeIncompleteError,
  qaRowCounts,
  qaState,
  qaTargetById,
  resolveQaTarget,
  seedQaFixtures,
  type QaTarget,
} from "../services/qa-account.js";

export const qaRoutes = new Hono<AppContext>();

const CONFIRM = "purge qa";

/** The owner's laptop: the cookie (`requireUser`), no device, the owner's address, and a deployment where QA can exist. */
const ownerOnly: MiddlewareHandler<AppContext> = async (c, next) => {
  if (c.get("device")) return c.json({ error: "out_of_scope" }, 403);
  if (!qaPossible(c.env) || !isOwnerEmail(c.get("userEmail"), c.env)) return c.json({ error: "not_found" }, 404);
  await next();
};
const owner = [requireUser, ownerOnly] as const;

/** The harness token's account id, set by its door. */
type RunContext = { Bindings: AppContext["Bindings"]; Variables: AppContext["Variables"] & { qaRunUserId: string } };

/** The harness token's door: a genuine, live `rgq_` token or the same 401 as none; 404 where QA can't exist. */
const harnessDoor: MiddlewareHandler<RunContext> = async (c, next) => {
  if (!qaPossible(c.env)) return c.json({ error: "not_found" }, 404);
  const header = c.req.header("authorization") ?? "";
  const token = header.startsWith("Bearer ") ? header.slice("Bearer ".length).trim() : "";
  const userId = token ? await verifyHarnessToken(c.env, token) : null;
  if (!userId) return c.json({ error: "unauthenticated" }, 401);
  c.set("qaRunUserId", userId);
  c.header("Cache-Control", "no-store");
  await next();
};

const noAccount = (c: Context) => c.json({ error: "no_qa_account" }, 404);

/** The QA account, from the owner's request; a guard refusal answers 404 (nothing written). */
async function ownersTarget(c: Context<AppContext>): Promise<QaTarget | null | Response> {
  try {
    return await resolveQaTarget(c.get("db"), c.env, c.get("userId"));
  } catch (e) {
    if (e instanceof QaGuardError) return c.json({ error: "not_found" }, 404);
    throw e;
  }
}

async function mintAnswer(c: Context, target: QaTarget): Promise<Response> {
  const minted = await mintQaPairing(c.get("db"), c.env, target, nowInstant());
  c.header("Cache-Control", "no-store");
  if ("refused" in minted) return c.json({ error: "too_many_codes", retryAfter: minted.retryAfterSeconds }, 429);
  return c.json(minted);
}

async function purgeAnswer(c: Context, target: QaTarget): Promise<Response> {
  const body = (await c.req.json().catch(() => null)) as { confirm?: unknown } | null;
  if (body?.confirm !== CONFIRM) return c.json({ error: "confirmation_required" }, 400);
  try {
    // One bounded step (≤ 45 statements: Workers Free counts each); the caller asks again until `done`.
    return c.json(await purgeQaStep(c.get("db"), c.env, target));
  } catch (e) {
    if (e instanceof QaPurgeIncompleteError) return c.json({ error: "purge_incomplete", remaining: e.remaining }, 500);
    if (e instanceof QaGuardError) return c.json({ error: "not_found" }, 404);
    throw e;
  }
}

qaRoutes.get("/status", ...owner, async (c) => {
  const db = c.get("db");
  const target = await ownersTarget(c);
  if (target instanceof Response) return target;
  const { timezone } = await loadPreferences(db, c.get("userId"));
  c.header("Cache-Control", "no-store");
  if (!target) return c.json({ qa: null, today: todayInZone(timezone), rows: 0, devices: [], plan: [] });
  const [row] = await db.select({ createdAt: users.createdAt }).from(users).where(eq(users.id, target.userId));
  const rows = await qaRowCounts(db, target.userId);
  const devices = await db
    .select({ state: nativeDevices.state, scope: nativeDevices.scope, label: nativeDevices.label, lastUsedAt: nativeDevices.lastUsedAt })
    .from(nativeDevices)
    .where(eq(nativeDevices.userId, target.userId));
  const plan = await db
    .select({ title: plannedWorkouts.title, date: plannedWorkouts.effectiveDate, time: plannedWorkouts.effectiveTime, state: plannedWorkouts.completionState })
    .from(plannedWorkouts)
    .where(eq(plannedWorkouts.userId, target.userId))
    .orderBy(plannedWorkouts.effectiveDate, plannedWorkouts.effectiveTime);
  return c.json({
    qa: { userId: target.userId, accountTag: await accountTag(target.userId), createdAt: row?.createdAt ?? null },
    today: todayInZone(timezone),
    rows: Object.values(rows).reduce((a, b) => a + b, 0),
    devices,
    plan,
  });
});

qaRoutes.post("/user", ...owner, async (c) => {
  try {
    const target = await createQaUser(c.get("db"), c.env, c.get("userId"));
    return c.json({ qa: { userId: target.userId, accountTag: await accountTag(target.userId) } }, 201);
  } catch (e) {
    if (e instanceof QaExistsError) return c.json({ error: "qa_exists" }, 409);
    if (e instanceof QaGuardError) return c.json({ error: "not_found" }, 404);
    throw e;
  }
});

qaRoutes.post("/seed", ...owner, async (c) => {
  const target = await ownersTarget(c);
  if (target instanceof Response) return target;
  if (!target) return noAccount(c);
  try {
    return c.json(await seedQaFixtures(c.get("db"), c.env, target));
  } catch (e) {
    if (e instanceof QaAlreadySeededError) return c.json({ error: "already_seeded" }, 409);
    throw e;
  }
});

qaRoutes.post("/pairings", ...owner, async (c) => {
  const target = await ownersTarget(c);
  if (target instanceof Response) return target;
  if (!target) return noAccount(c);
  return mintAnswer(c, target);
});

qaRoutes.get("/state", ...owner, async (c) => {
  const target = await ownersTarget(c);
  if (target instanceof Response) return target;
  if (!target) return noAccount(c);
  c.header("Cache-Control", "no-store");
  return c.json(await qaState(c.get("db"), target.userId));
});

qaRoutes.post("/purge", ...owner, async (c) => {
  const target = await ownersTarget(c);
  if (target instanceof Response) return target;
  if (!target) return noAccount(c);
  return purgeAnswer(c, target);
});

// ── The harness token's door ─────────────────────────────────────────────────────────────────────────────────

const run = new Hono<RunContext>();
run.use("*", harnessDoor);

/** The token's account, while it is the QA account. */
const runTarget = (c: Context<RunContext>) => qaTargetById(c.get("db"), c.env, c.get("qaRunUserId"));

run.get("/state", async (c) => {
  const target = await runTarget(c);
  if (!target) return noAccount(c);
  return c.json(await qaState(c.get("db"), target.userId));
});

run.post("/pairings", async (c) => {
  const target = await runTarget(c);
  if (!target) return noAccount(c);
  return mintAnswer(c, target);
});

run.post("/purge", async (c) => {
  const target = await runTarget(c);
  if (!target) return noAccount(c);
  return purgeAnswer(c, target);
});

run.get("/verify", async (c) => {
  const db = c.get("db");
  const userId = c.get("qaRunUserId");
  const [row] = await db.select({ email: users.email }).from(users).where(eq(users.id, userId)).limit(1);
  // Never a count of an account that isn't the QA address: only the QA account, or no account at all (purged).
  if (row && row.email !== QA_EMAIL) return noAccount(c);
  const rows = await qaRowCounts(db, userId, { all: true });
  return c.json({ userId, exists: row !== undefined, rows, total: Object.values(rows).reduce((a, b) => a + b, 0) });
});

qaRoutes.route("/run", run as unknown as Hono<AppContext>);
