/**
 * THE COACH ON A DEVICE, AFTER `requireUser` (R1; the LifeOS migration's DESIGN-3 §3.5 "the QA gate", §3.6; risk 9).
 *
 * The coach's routes check their switch BEFORE `requireUser` (a plain 404 while the designer is off, signed in or not), and
 * the LifeOS QA account's phone gets its switches off (`qaEnv`: the designer, the model's key) only INSIDE `requireUser`'s
 * device branch — so the switch the routes saw was the owner's. This runs after it, for a device's request only: the coach
 * is off for it (404 `coach_off`) when the designer is off as the device's own env reads it, or the account is the QA one
 * (whatever the env: staging keeps the designer on). A cookie request is never touched here: the laptop's coach is as it was.
 * `coachModelGate` holds a phone's new run to a model it can reach (no key, no run that would only fail).
 */
import type { MiddlewareHandler } from "hono";
import type { AppContext } from "../auth/middleware.js";
import { isQaEmail } from "../auth/qa-identity.js";
import { coachDesignerEnabled } from "../env.js";
import { wakeGateway } from "../services/gateway-route.js";

export const COACH_OFF = { error: "coach_off", why: "The coach isn't on for this account." } as const;

export const deviceCoachGate: MiddlewareHandler<AppContext> = async (c, next) => {
  if (c.get("device") && (!coachDesignerEnabled(c.env) || isQaEmail(c.get("userEmail"), c.env))) return c.json(COACH_OFF, 404);
  await next();
};

/** A phone's new run: only with a model to call (the key, or the fixture stack's canned or recorded one). */
export const coachModelGate: MiddlewareHandler<AppContext> = async (c, next) => {
  if (c.get("device") && wakeGateway(c.env).kind === "no_key") return c.json(COACH_OFF, 404);
  await next();
};
