/**
 * THE STAGING COPIER AND NATIVE SIGN-IN (worker review M1; SLICE-CONTRACT revision 2 §10.6). A paired phone's row and the
 * account's pairing code are sign-in credentials: like `sessions` and `oauth_states` they are never copied to staging,
 * the scrub deletes any staging holds, and the scrub's audit counts them. Otherwise a production device token would
 * read staging's copy of the owner's data, where a production revoke never reaches and no cron purges.
 *
 * The copier's exclusions are the registry's sign-in marks (`excluded(…, { signIn: true })`), so a later sign-in table
 * can't slip through; the other excluded tables (catalogs, versions, restore bookkeeping) are still copied, and the copy
 * set is pinned table by table to the one before native sign-in. Synthetic data only.
 */
import { describe, expect, it } from "vitest";
import { schema } from "@rg/database";
import { nowInstant } from "@rg/domain";
import { randomToken, sha256Hex } from "../src/auth/crypto.js";
import { findDevice } from "../src/auth/native-devices.js";
import { createSession } from "../src/auth/sessions.js";
import {
  COPY_EXCLUDED,
  COPY_TABLES,
  copyFinished,
  copyStep,
  guardBindings,
  initialCopyState,
  isCopyTable,
  scrubSecrets,
  secretsRemaining,
} from "../src/copier/copy.js";
import { ACCOUNT_TABLES } from "../src/services/account-tables.js";
import type { Db } from "../src/services/db.js";
import { makeTestDb, makeTestUser, untilDone } from "./helpers.js";

const { nativeDevices, nativePairings, nativePairLimits } = schema;

/** What the copier copied at 81827cd1, before native sign-in, in its order: every registry table but the sign-ins. */
const COPIED_BEFORE = [
  "users", "user_preferences", "provider_connections", "training_plans", "planned_workouts",
  "coros_schedule_snapshots", "coros_write_jobs", "sync_intents", "sync_notes", "activities", "daily_health",
  "athlete_zones", "sleep_records", "garden_state", "garden_plants", "garden_events", "garden_unlocks",
  "garden_wildlife", "garden_scene_layouts", "garden_snapshots", "garden_visitors", "garden_day_inputs",
  "garden_seen", "computed_metrics", "motivation_evidence", "weekly_reviews", "dismissed_insights",
  "llm_usage", "sync_runs", "sync_errors", "provider_cursor_state", "audit_events", "backfill_state",
  "studio_plans", "coach_memory", "coach_questions", "coach_messages", "coach_proposals", "coach_triggers",
  "coach_plans", "coach_reads", "coach_locks", "programs", "session_builds", "performed_sessions",
  "condition_checks", "user_conditions", "locations", "exercise_prefs", "exercise_provenance",
  "workout_doc_revisions", "athlete_profiles", "objectives", "key_results", "athlete_answers",
  "workout_templates", "coach_runs", "coach_run_events", "saved_posts", "save_checks", "save_batches",
  "personal_moves", "saved_post_moves", "saved_links", "import_events", "import_blobs", "import_corrections",
  "training_plan_versions", "planned_workout_stages", "schedule_overrides", "workout_completion_matches",
  "calendar_event_links", "calendar_event_suppressions", "coros_write_attempts", "activity_laps",
  "activity_source_links", "activity_stream_summaries", "studio_plan_pushes", "coach_plan_weeks",
  "program_versions", "program_blocks", "performed_sets", "garden_species", "coros_exercises",
  "schema_versions", "prompt_versions", "account_state",
];

const SIGN_INS = ["sessions", "oauth_states", "native_devices", "native_pairings", "native_pair_limits"];

async function seedDevice(db: Db, userId: string): Promise<string> {
  const token = `rgd_${randomToken(32)}`;
  await db.insert(nativeDevices).values({
    id: await sha256Hex(token),
    userId,
    scope: "training-slice-v1",
    label: "Synthetic phone",
    state: "active",
    checkNumber: "0420",
    createdAt: nowInstant(),
    confirmedAt: nowInstant(),
    expiresAt: new Date(Date.now() + 30 * 86_400_000).toISOString(),
  });
  return token;
}
/** A rate-control counter row, as pairing leaves one (review F5: the scrub and the copier see one). */
const seedLimit = (db: Db, key: string) =>
  db.insert(nativePairLimits).values({ key, windowStart: nowInstant(), count: 2, expiresAt: new Date(Date.now() + 600_000).toISOString() });
const seedPairing = (db: Db, userId: string) =>
  db.insert(nativePairings).values({ userId, codeHmac: "a".repeat(64), createdAt: nowInstant(), expiresAt: new Date(Date.now() + 300_000).toISOString() });

async function copyAll(src: Db, dst: Db): Promise<void> {
  let state = initialCopyState();
  await untilDone(async () => {
    state = await copyStep(src, dst, state, { maxRows: 500 });
    return copyFinished(state);
  }, { max: 400, what: "the copy" });
}

describe("what the copier copies", () => {
  it("is exactly what it copied before native sign-in, table by table and in order", () => {
    expect(COPY_TABLES.map((t) => t.name)).toEqual(COPIED_BEFORE);
  });

  it("leaves out the registry's sign-in tables, and only them: the other excluded tables are still copied", () => {
    expect([...COPY_EXCLUDED].sort()).toEqual([...SIGN_INS].sort());
    const signIns = ACCOUNT_TABLES.filter((t) => t.scope.kind === "excluded" && t.scope.signIn).map((t) => t.name);
    expect(signIns.sort()).toEqual([...SIGN_INS].sort());
    for (const name of SIGN_INS) expect(isCopyTable(name), name).toBe(false);
    for (const t of ACCOUNT_TABLES.filter((x) => x.scope.kind === "excluded" && !SIGN_INS.includes(x.name))) expect(isCopyTable(t.name), t.name).toBe(true);
  });
});

describe("a production phone never reaches staging", () => {
  it("its device row and the account's pairing code are not copied, and its token resolves nothing on staging", async () => {
    const src = makeTestDb();
    const dst = makeTestDb();
    const { userId } = await makeTestUser(src);
    const token = await seedDevice(src, userId);
    await seedPairing(src, userId);
    await seedLimit(src, "redeem:global");
    await seedLimit(src, `mint:${userId}`);
    expect(await guardBindings(src, dst, { prepare: true })).toBeNull();
    await copyAll(src, dst);
    await scrubSecrets(dst);
    expect(await dst.select().from(nativeDevices)).toEqual([]);
    expect(await dst.select().from(nativePairings)).toEqual([]);
    expect(await dst.select().from(nativePairLimits)).toEqual([]);
    expect(await findDevice(dst, token)).toBeNull();
    // Production keeps its own.
    expect(await findDevice(src, token)).toMatchObject({ userId, state: "active" });
    expect(await src.select().from(nativePairings)).toHaveLength(1);
    expect(await src.select().from(nativePairLimits)).toHaveLength(2);
  });

  it("the scrub deletes any device or code staging holds of its own, and its audit counts them until it does", async () => {
    const src = makeTestDb();
    const dst = makeTestDb();
    await makeTestUser(src);
    expect(await guardBindings(src, dst, { prepare: true })).toBeNull();
    await copyAll(src, dst);
    const [user] = await dst.select().from(schema.users);
    const token = await seedDevice(dst, user!.id);
    await seedPairing(dst, user!.id);
    await seedLimit(dst, "redeem:global");
    await createSession(dst, user!.id, "test");
    expect(await secretsRemaining(dst)).toEqual({ secrets: 0, sessions: 1, oauthStates: 0, nativeDevices: 1, nativePairings: 1, nativePairLimits: 1 });
    await scrubSecrets(dst);
    expect(await secretsRemaining(dst)).toEqual({ secrets: 0, sessions: 0, oauthStates: 0, nativeDevices: 0, nativePairings: 0, nativePairLimits: 0 });
    expect(await findDevice(dst, token)).toBeNull();
  });
});
