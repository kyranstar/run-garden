/**
 * WHAT A DEVICE TOKEN MAY REACH: scope `training-slice-v1` (SLICE-CONTRACT revision 2 §10.3), deny by default.
 *
 * Exact (method, anchored pattern) pairs, matched against `c.req.path` (the same decoded path the router matches) and
 * `c.req.method`, for every method: HEAD is its own method here and is on no pair, so a device's HEAD is refused like any
 * other off-list request. `requireUser`'s device branch checks this before the restore rule (423), and anything off the
 * list is 403 `out_of_scope`. A pair may also hold a body rule: the request's body is read (Hono keeps it, so the handler
 * reads the same bytes) and refused 403 `out_of_scope` when it asks for more than the slice allows.
 *
 * Later slices get new scopes, never a widened v1. `native-allowlist.test.ts` holds every route the app mounts against
 * this list, every method, so a new route fails that test until it is classified.
 */
import type { Context } from "hono";

export const DEVICE_SCOPE = "training-slice-v1";

/** True when the body, as raw text, is within the slice. */
type BodyRule = (raw: string) => boolean;

export interface DeviceRoute {
  method: "GET" | "POST" | "PUT";
  pattern: RegExp;
  /** Answers true when the body is in scope. */
  body?: BodyRule;
}

const parsed = (raw: string): { ok: true; value: unknown } | { ok: false } => {
  try {
    return { ok: true, value: JSON.parse(raw) };
  } catch {
    return { ok: false };
  }
};

const isPlainObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/** Build from the phone is the day's build as it stands: exactly `{}` — no checks, overrides or swaps. */
export const emptyObjectBody: BodyRule = (raw) => {
  const p = parsed(raw);
  return p.ok && isPlainObject(p.value) && Object.keys(p.value).length === 0;
};

/**
 * A save from the phone is the app's own session with nothing of a plan edit in it (§9.6, §10.5): `review.graduations`
 * (a graduation switches a block's lift) and `review.excluded` ("not for me", an `exercise_prefs` write) absent or
 * empty, and `source` absent or the app's own ("app"; a watch review or an import is not the phone's). The phone strips
 * those two fields before it queues, so a refusal here is a bug path. A body that is not a JSON object is left to the
 * route, which answers 422 `invalid_save` as it does for the web.
 */
export const deviceSaveBody: BodyRule = (raw) => {
  const p = parsed(raw);
  if (!p.ok || !isPlainObject(p.value)) return true;
  const body = p.value;
  if ("source" in body && body.source !== "app") return false;
  if (body.review === undefined) return true;
  if (!isPlainObject(body.review)) return false;
  const { graduations, excluded } = body.review;
  if (graduations !== undefined && !(Array.isArray(graduations) && graduations.length === 0)) return false;
  if (excluded !== undefined && !(isPlainObject(excluded) && Object.keys(excluded).length === 0)) return false;
  return true;
};

/** One path segment, as Hono's `:param` matches one. */
const SEG = "[^/]+";

/** The slice, exactly. Nothing else answers a device. */
export const DEVICE_ROUTES: readonly DeviceRoute[] = [
  { method: "GET", pattern: /^\/api\/native\/me$/ },
  { method: "GET", pattern: /^\/api\/native\/today$/ },
  { method: "POST", pattern: /^\/api\/native\/sign-out$/ },
  { method: "GET", pattern: new RegExp(`^/api/sessions/${SEG}$`) },
  { method: "GET", pattern: new RegExp(`^/api/sessions/${SEG}/review-basis$`) },
  { method: "POST", pattern: new RegExp(`^/api/sessions/${SEG}/build$`), body: emptyObjectBody },
  { method: "POST", pattern: new RegExp(`^/api/sessions/${SEG}/start$`) },
  { method: "PUT", pattern: new RegExp(`^/api/sessions/performed/${SEG}$`), body: deviceSaveBody },
];

/** The pair this request is, or undefined (off the list). */
export function deviceRouteOf(method: string, path: string): DeviceRoute | undefined {
  return DEVICE_ROUTES.find((r) => r.method === method && r.pattern.test(path));
}

/** Whether this request is in the device's scope: on the list, and its body within the pair's rule. */
export async function inDeviceScope(c: Context): Promise<boolean> {
  const route = deviceRouteOf(c.req.method, c.req.path);
  if (!route) return false;
  if (!route.body) return true;
  return route.body(await c.req.text());
}
