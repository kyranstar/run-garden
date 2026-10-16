/**
 * `/api/admin/parity/*` — the parity harness's endpoints (Phase 0 Task 12).
 *
 * They exist only on staging (`STAGING = "1"`) or where `PARITY_ENABLED =
 * "1"` is set; everywhere else every path here is a plain 404, signed in or
 * not. They answer with hashes, counts and dates only (services/parity.ts).
 * A resimulation rewrites the garden's derived tables, so production can
 * only hash what it has: `resim: true` is refused (409) unless this is
 * staging.
 *
 * `/api/admin/workout-docs/backfill` (Stage 1 Task 14) lives behind the same
 * switch and sign-in: one bounded step of the workout document backfill
 * (services/workout-doc-backfill.ts), counts and ids only.
 *
 * `/api/admin/coach-memory-migration` (Stage 3 Task 10) lives behind it too, for the owner's own account only: the
 * one-time move of profile-shaped memories into the profile, a dry run unless asked to apply.
 */
import { Hono, type Context, type ExecutionContext } from "hono";
import type { Env } from "../env.js";
import { stagingEnabled } from "../env.js";
import type { AppContext } from "../auth/middleware.js";
import { requireUser } from "../auth/middleware.js";
import { sha256Hex } from "../auth/crypto.js";
import { canonicalJson } from "../services/account-tables.js";
import { loadPreferences } from "../services/calendar-sync.js";
import { calendarHash, gardenHash, jobCounts, ParityRefused, tableHashes } from "../services/parity.js";
import { BACKFILL_KINDS, backfillWorkoutDocs, type BackfillKind } from "../services/workout-doc-backfill.js";
import { migrationApply, migrationDryRun } from "../services/coach-memory-migration.js";

/** Hands a request to the app itself, in-process (index.ts passes `app.fetch`). */
export type AppDispatch = (req: Request, env: Env, ctx?: ExecutionContext) => Response | Promise<Response>;

export const parityEnabled = (env: Env): boolean => stagingEnabled(env) || env.PARITY_ENABLED === "1";

const DATE = /^\d{4}-\d{2}-\d{2}$/;
const SINCE = /^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2}(:\d{2}(\.\d{1,3})?)?Z?)?$/;

/**
 * The read DTOs the DTO hash may call, with the query parameters each one
 * takes (`week` is accepted for `/api/plan/week` and passed on as the route's
 * own `start`). Nothing else is reachable through it.
 */
const DTO_ROUTES: ReadonlyArray<{ path: string; params: Readonly<Record<string, RegExp>>; rename?: Record<string, string> }> = [
  { path: "/api/plan/today", params: {} },
  { path: "/api/plan/week", params: { start: DATE, week: DATE }, rename: { week: "start" } },
  { path: "/api/plan/workouts", params: { start: DATE, end: DATE } },
  { path: "/api/garden", params: {} },
  { path: "/api/coach/plans", params: {} },
  { path: "/api/coach/state", params: {} },
  { path: "/api/insights", params: { discipline: /^(run|strength|yoga)$/ } },
];

/**
 * Write stamps a DTO carries that a garden replay rewrites without changing
 * anything the screen shows: the stored garden events' `createdAt`. They
 * are dropped before hashing (Audit 2 I1), by exact key path ("*" = every
 * item of an array), so the runbook's two recordings of one unchanged
 * garden agree. Only write stamps belong here, never content.
 */
export const VOLATILE_DTO_KEYS: Readonly<Record<string, ReadonlyArray<readonly string[]>>> = {
  "/api/garden": [["events", "*", "createdAt"]],
  "/api/plan/today": [["garden", "recentEvents", "*", "createdAt"]],
};

/** `body` without the keys at `paths` (mutates it; returns it). */
export function dropVolatile(body: unknown, paths: ReadonlyArray<readonly string[]>): unknown {
  const drop = (node: unknown, path: readonly string[]): void => {
    if (node === null || typeof node !== "object" || path.length === 0) return;
    const [head, ...rest] = path as [string, ...string[]];
    if (head === "*") {
      if (Array.isArray(node)) for (const item of node) drop(item, rest);
      return;
    }
    if (Array.isArray(node)) return;
    const obj = node as Record<string, unknown>;
    if (rest.length === 0) delete obj[head];
    else drop(obj[head], rest);
  };
  for (const path of paths) drop(body, path);
  return body;
}

/** The sha-256 the DTO hash reports for a response body from `pathname`. */
export async function dtoDigest(pathname: string, body: unknown): Promise<string> {
  return sha256Hex(canonicalJson(dropVolatile(body, VOLATILE_DTO_KEYS[pathname] ?? [])));
}

/** At most this many DTOs per call (each is a full handler run). */
const MAX_DTO_PATHS = 16;

const BASE = "http://parity.invalid";

/** The normalised same-origin path for an allowlisted DTO, or null. */
export function allowedDtoPath(raw: string): string | null {
  if (!raw.startsWith("/") || raw.startsWith("//") || raw.includes("#")) return null;
  let url: URL;
  try {
    url = new URL(raw, BASE);
  } catch {
    return null;
  }
  if (url.origin !== BASE) return null;
  const route = DTO_ROUTES.find((r) => r.path === url.pathname);
  if (!route) return null;
  const out = new URLSearchParams();
  for (const [key, value] of url.searchParams) {
    const pattern = route.params[key];
    if (!pattern || !pattern.test(value)) return null;
    const name = route.rename?.[key] ?? key;
    if (out.has(name)) return null;
    out.set(name, value);
  }
  const query = out.toString();
  return query ? `${url.pathname}?${query}` : url.pathname;
}

function executionCtxOf(c: Context<AppContext>): ExecutionContext | undefined {
  try {
    return c.executionCtx;
  } catch {
    return undefined; // Hono's getter throws outside a Workers runtime
  }
}

export function adminRoutes(dispatch: AppDispatch): Hono<AppContext> {
  const routes = new Hono<AppContext>();

  // Disabled: indistinguishable from a route that does not exist — before
  // authentication, so not even a 401 says it is here.
  routes.use("*", async (c, next) => {
    if (!parityEnabled(c.env)) return c.notFound();
    await next();
  });
  routes.use("*", requireUser);

  routes.get("/parity/tables", async (c) => {
    return c.json({ tables: await tableHashes(c.get("db"), c.get("userId")) });
  });

  routes.post("/parity/garden", async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as { resim?: unknown; from?: unknown };
    const resim = body?.resim === true;
    if (resim && !stagingEnabled(c.env)) return c.json({ error: "resim_staging_only" }, 409);
    let from: string | undefined;
    if (body?.from !== undefined) {
      if (typeof body.from !== "string" || !DATE.test(body.from)) return c.json({ error: "bad_from" }, 400);
      from = body.from;
    }
    const db = c.get("db");
    const userId = c.get("userId");
    try {
      const prefs = await loadPreferences(db, userId);
      return c.json(await gardenHash(db, userId, prefs, { resim, from }));
    } catch (e) {
      if (e instanceof ParityRefused) return c.json({ error: e.code }, 409);
      throw e;
    }
  });

  routes.get("/parity/calendar", async (c) => {
    return c.json(await calendarHash(c.get("db"), c.get("userId")));
  });

  routes.get("/parity/jobs", async (c) => {
    const since = c.req.query("since");
    if (!since || !SINCE.test(since)) return c.json({ error: "bad_since" }, 400);
    return c.json({ since, counts: await jobCounts(c.get("db"), c.get("userId"), since) });
  });

  /**
   * `?paths=<encoded path>` (repeatable, or comma-separated): each allowlisted
   * DTO is fetched from the app itself, in-process, as the caller — their own
   * session cookie and nothing else — and answered as its status and the
   * sha-256 of its canonical JSON body, write stamps dropped
   * (`VOLATILE_DTO_KEYS`).
   */
  routes.get("/parity/dto", async (c) => {
    const requested = (c.req.queries("paths") ?? [])
      .flatMap((p) => p.split(","))
      .map((p) => p.trim())
      .filter((p) => p.length > 0);
    if (requested.length === 0) return c.json({ error: "no_paths" }, 400);
    if (requested.length > MAX_DTO_PATHS) return c.json({ error: "too_many_paths", max: MAX_DTO_PATHS }, 400);
    const paths: string[] = [];
    for (const [index, raw] of requested.entries()) {
      const path = allowedDtoPath(raw);
      if (!path) return c.json({ error: "path_not_allowed", index }, 400);
      paths.push(path);
    }
    const cookie = c.req.header("cookie") ?? "";
    const ctx = executionCtxOf(c);
    const out: Record<string, { status: number; sha256: string }> = {};
    for (const path of paths) {
      const res = await dispatch(new Request(new URL(path, c.req.url), { headers: { cookie } }), c.env, ctx);
      const text = await res.text();
      let body: unknown = text;
      try {
        body = JSON.parse(text);
      } catch {
        /* hashed as text */
      }
      out[path] = { status: res.status, sha256: await dtoDigest(new URL(path, BASE).pathname, body) };
    }
    return c.json(out);
  });

  /**
   * One step of the workout document backfill, for the signed-in account:
   * `?kind=planned|builds` (required), `dryRun=1` (the default — only
   * `dryRun=0` writes), `limit` (rows, 15 by default, at most 20), `after`
   * (the previous answer's `nextAfter`). Answers `{ dryRun, kind, scanned,
   * converted, skipped, skippedBy, failed: [{ id, code }], nextAfter }`.
   */
  routes.post("/workout-docs/backfill", async (c) => {
    const kind = c.req.query("kind");
    if (!BACKFILL_KINDS.includes(kind as BackfillKind)) return c.json({ error: "bad_kind" }, 400);
    const dryRun = c.req.query("dryRun");
    if (dryRun !== undefined && dryRun !== "0" && dryRun !== "1") return c.json({ error: "bad_dry_run" }, 400);
    const after = c.req.query("after");
    if (after !== undefined && (after.length === 0 || after.length > 200)) return c.json({ error: "bad_after" }, 400);
    const rawLimit = c.req.query("limit");
    const limit = rawLimit === undefined ? undefined : Number(rawLimit);
    if (limit !== undefined && !Number.isInteger(limit)) return c.json({ error: "bad_limit" }, 400);
    try {
      return c.json(
        await backfillWorkoutDocs(c.get("db"), c.get("userId"), {
          kind: kind as BackfillKind,
          dryRun: dryRun !== "0",
          ...(after !== undefined ? { after } : {}),
          ...(limit !== undefined ? { limit } : {}),
        }),
      );
    } catch (e) {
      // The kind only: an error's text can quote the data it failed on.
      const name = e instanceof Error && /^\w{1,40}$/.test(e.name) ? e.name : "unknown";
      console.error(`workout doc backfill failed: ${name}`);
      return c.json({ error: "backfill_failed", name }, 500);
    }
  });

  /**
   * The one-time copy of profile-shaped memories into the profile — each kept in memory too, for the thread coach
   * (Stage 3 Task 10; fix wave 3B, A-I1; services/coach-memory-migration.ts),
   * for the owner's own account only (`ALLOWED_GOOGLE_EMAIL`, compared as sign-in compares it; any other account is a
   * 404). `{}` answers the dry run — reads only. `{ apply: true, fingerprint }` applies exactly the plan that dry run
   * reported, and refuses (409, with the fresh report) a plan that changed since. The report is the answer only:
   * nothing here logs it (the handler below logs an error's kind).
   */
  routes.post("/coach-memory-migration", async (c) => {
    const owner = (c.env.ALLOWED_GOOGLE_EMAIL ?? "").toLowerCase();
    if (!owner || (c.get("userEmail") ?? "").toLowerCase() !== owner) return c.notFound();
    const body = (await c.req.json().catch(() => ({}))) as { apply?: unknown; fingerprint?: unknown } | null;
    if (body?.apply !== undefined && typeof body.apply !== "boolean") return c.json({ error: "bad_apply" }, 400);
    const db = c.get("db");
    const userId = c.get("userId");
    if (body?.apply !== true) return c.json(await migrationDryRun(db, userId));
    if (typeof body.fingerprint !== "string" || !/^[0-9a-f]{32}$/.test(body.fingerprint)) {
      return c.json({ error: "needs_fingerprint", why: "Run the dry run first, and send its fingerprint with apply." }, 400);
    }
    const out = await migrationApply(db, userId, body.fingerprint);
    if (out.kind === "changed") return c.json({ error: "changed_since_dry_run", report: out.report }, 409);
    return c.json(out.report);
  });

  // The kind only, as the copier does (Audit 2 M6): Hono's default handler
  // logs the whole error, and an error's text can quote the data it failed
  // on (V8's JSON errors quote their input).
  routes.onError((e, c) => {
    console.error(`parity failed: ${e.name}`);
    return c.json({ error: "parity_failed", kind: e.name }, 500);
  });

  return routes;
}
