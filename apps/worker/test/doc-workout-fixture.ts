/**
 * Shared by the document-workout suites (Stage 2 Task 3): a synthetic document, the account's switches, and a client
 * that calls the real routes with a signed-in cookie. Synthetic data only.
 */
import { schema } from "@rg/database";
import { workoutDocSchema, type WorkoutDoc } from "@rg/domain";
import type { Hono } from "hono";
import type { AppContext } from "../src/auth/middleware.js";
import { createSession, SESSION_COOKIE } from "../src/auth/sessions.js";
import type { Env } from "../src/env.js";
import { conditionRoutes, sessionRoutes } from "../src/routes/sessions.js";
import { templateRoutes } from "../src/routes/templates.js";
import { workoutRoutes } from "../src/routes/workouts.js";
import type { Db } from "../src/services/db.js";
import { mountRoutes } from "./helpers.js";

/**
 * Landings, then the legs: a jump (a plyometric move the TMJ profile gates by the day's check) with a gentler
 * alternate, then a split squat. Maintain effort.
 */
export function landingsDoc(over: { alternates?: boolean; title?: string; reps?: number } = {}): WorkoutDoc {
  return workoutDocSchema.parse({
    version: 1,
    title: over.title ?? "Legs and landings",
    intent: { summary: "Land softly, then work the legs.", goals: ["athleticism"], focus: [], effort: "maintain" },
    parts: [
      {
        purpose: "power",
        format: "straight",
        items: [
          {
            kind: "exercise",
            libraryId: "snapDown",
            dose: { sets: 2, reps: 5, restSec: 45 },
            ...(over.alternates === false ? {} : { alternates: [{ libraryId: "tempoSquat", why: "The same legs, no landing." }] }),
          },
        ],
      },
      {
        purpose: "main",
        format: "straight",
        items: [{ kind: "exercise", libraryId: "bwSplitSquat", dose: { sets: 2, reps: over.reps ?? 8, perSide: true, restSec: 45 } }],
      },
    ],
    source: { kind: "studio" },
  });
}

/** A calm mobility document: nothing in it is gated by any reading. */
export function calmDoc(over: { title?: string } = {}): WorkoutDoc {
  return workoutDocSchema.parse({
    version: 1,
    title: over.title ?? "Hips and back",
    intent: { summary: "Wake the glutes and brace the trunk.", goals: ["posture"], focus: [], effort: "maintain" },
    parts: [
      {
        purpose: "main",
        format: "straight",
        items: [
          { kind: "exercise", libraryId: "bridge", dose: { sets: 2, reps: 12, restSec: 30 } },
          { kind: "exercise", libraryId: "deadBug", dose: { sets: 2, reps: 8, restSec: 30 } },
        ],
      },
    ],
    source: { kind: "studio" },
  });
}

export async function activateTmj(db: Db, userId: string): Promise<void> {
  await db
    .insert(schema.userConditions)
    .values({ id: `${userId}:tmj`, userId, profileId: "tmj", active: true, since: "2026-09-01", settings: {} });
}

export function makeEnv(): Env {
  return {
    DB: {} as unknown as Env["DB"],
    ASSETS: {} as unknown as Env["ASSETS"],
    APP_URL: "https://app.test",
    FIXTURE_MODE: "0",
    AI_DEFAULT_ENABLED: "1",
    SESSION_SECRET: "test-session-secret",
    TOKEN_ENCRYPTION_KEY: "test-token-encryption-key",
    ALLOWED_GOOGLE_EMAIL: "runner@example.com",
    GOOGLE_CLIENT_ID: "test-client-id",
    GOOGLE_CLIENT_SECRET: "test-client-secret",
  } as Env;
}

export interface Reply {
  status: number;
  body: any;
}

/** Calls `/api/workouts`, `/api/templates`, `/api/sessions` and `/api/conditions` as the signed-in user. */
export async function clientFor(db: Db, userId: string): Promise<(method: string, path: string, body?: unknown) => Promise<Reply>> {
  const cookie = `${SESSION_COOKIE}=${await createSession(db, userId, "test")}`;
  const apps: Array<[string, Hono<AppContext>]> = [
    ["/api/workouts", mountRoutes(db, "/api/workouts", workoutRoutes)],
    ["/api/templates", mountRoutes(db, "/api/templates", templateRoutes)],
    ["/api/sessions", mountRoutes(db, "/api/sessions", sessionRoutes)],
    ["/api/conditions", mountRoutes(db, "/api/conditions", conditionRoutes)],
  ];
  return async (method, path, body) => {
    const app = apps.find(([prefix]) => path.startsWith(prefix))![1];
    const res = await app.request(
      path,
      {
        method,
        headers: { Cookie: cookie, "Content-Type": "application/json" },
        body: body === undefined ? undefined : JSON.stringify(body),
      },
      makeEnv(),
    );
    const text = await res.text();
    return { status: res.status, body: text ? JSON.parse(text) : null };
  };
}
