/**
 * THE ONE-TIME COPY OF PROFILE-SHAPED MEMORIES INTO THE PROFILE (Stage 3 Task 10; spec §9; principles §6.7: "anything
 * that has a home in the profile moves to the profile; memory keeps what does not fit a field"). Owner data: a dry run
 * first. COPY, NOT MOVE (fix wave 3B, A-I1): the live thread coach reads only memory — its guardrails' dated events and
 * its dossier — so every item stays live in memory until the thread coach reads the profile; the apply supersedes
 * nothing.
 *
 *   POST /api/admin/coach-memory-migration { apply?, fingerprint? }
 *
 *  - Behind the admin switch and sign-in, as every admin route, and the owner's account only (ALLOWED_GOOGLE_EMAIL).
 *  - The default is a dry run: it writes nothing (only reads run) and answers the report — each profile-shaped item
 *    (an event or race, a goal, a focus area, a place) and where it would go, each kept in memory too; and the old
 *    Studio's plan brief: which fields go to the profile and which become memory items (stated, "the old Studio's
 *    brief"); and a fingerprint of the plan.
 *  - `apply: true` with that fingerprint does exactly what the dry run said, in one batch within 45 statements and D1's
 *    100 bound variables a statement; a plan that changed since is refused (409) with the fresh report. Run again, it
 *    finds nothing to do and writes nothing.
 *  - The report is the response only: never written to the logs.
 *
 * Synthetic data only: a made-up athlete's made-up memories, dated relative to today (fix wave 3B, A-M6).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { schema } from "@rg/database";
import { addDays, DEFAULT_USER_PREFERENCES, newId } from "@rg/domain";
import type { Env } from "../src/env.js";
import type { Db } from "../src/services/db.js";
import { adminRoutes } from "../src/routes/admin.js";
import { createSession, SESSION_COOKIE } from "../src/auth/sessions.js";
import { loadPreferences, savePreferences } from "../src/services/calendar-sync.js";
import { buildDossier } from "../src/services/coach-context.js";
import { guardrailCtx } from "../src/services/coach-wake.js";
import { liveMemoryWhere } from "../src/services/memory-core.js";
import { isWrite, makeTestDb, mountRoutes } from "./helpers.js";

const OWNER = "owner@example.com";
const env = {
  DB: {} as unknown as Env["DB"],
  ASSETS: {} as unknown as Env["ASSETS"],
  APP_URL: "https://app.test",
  FIXTURE_MODE: "0",
  AI_DEFAULT_ENABLED: "1",
  SESSION_SECRET: "s",
  TOKEN_ENCRYPTION_KEY: "k",
  ALLOWED_GOOGLE_EMAIL: OWNER,
  GOOGLE_CLIENT_ID: "c",
  GOOGLE_CLIENT_SECRET: "c",
  PARITY_ENABLED: "1",
} as Env;

let db: Db;
let userId: string;
let cookie: string;
const ran: string[] = [];

/** "Today" for the athlete, far from the fixture's dates. */
const TODAY = new Date().toISOString().slice(0, 10);
/** A day `n` days after today: the fixture's events lie ahead whatever day the suite runs (A-M6 — fixed dates would
 * have turned past one day, and these tests red with them). */
const ahead = (n: number): string => addDays(TODAY, n);
const SKI = { start: ahead(120), end: ahead(127) };
const RACE = ahead(180);
const WEDDING = ahead(240);
/** What every copied item's note says (A-I1). */
const KEPT_TOO = "Kept in memory too, until the thread coach reads the profile.";
const AT = "2026-09-01T09:00:00.000Z";

async function user(email: string, timezone = "Europe/Paris"): Promise<{ id: string; cookie: string }> {
  const id = newId();
  await db.insert(schema.users).values({ id, email, googleSub: `sub-${id}`, createdAt: AT });
  await savePreferences(db, id, { ...DEFAULT_USER_PREFERENCES, timezone });
  return { id, cookie: `${SESSION_COOKIE}=${await createSession(db, id)}` };
}

type Mem = typeof schema.coachMemory.$inferInsert;
const mem = (id: string, kind: string, body: string, o: Partial<Mem> = {}): Mem => ({
  id,
  userId,
  kind,
  body,
  provenance: { source: "message", at: AT },
  learnedAt: AT,
  active: true,
  ...o,
});

async function seed() {
  const rows: Mem[] = [
    mem("m-ski", "note", `Ski trip ${SKI.start} to ${SKI.end}`, { expiresAt: addDays(SKI.end, 1) }),
    mem("m-race", "note", `Half marathon on ${RACE}, wants a gentle week before`, { expiresAt: addDays(RACE, 1) }),
    mem("m-long-event", "note", `Wedding abroad on ${WEDDING} ${"with a long story about the plans, the travel and the days around it ".repeat(2)}`, {
      expiresAt: addDays(WEDDING, 1),
    }),
    mem("m-past", "fact", "Ran a marathon on 2001-05-01"),
    mem("m-expired", "note", "Trip 2001-01-01", { expiresAt: "2001-01-02" }),
    mem("m-goal", "fact", "Wants to improve posture"),
    mem("m-goal-two", "fact", "Goal: get stronger for skiing"),
    mem("m-goal-have", "rule", "Working on mobility every morning"),
    mem("m-focus", "rule", "Focus on hips and glutes"),
    mem("m-sore", "fact", "Hamstrings get tight and sore after long runs"),
    mem("m-place", "fact", "Trains at a home gym with kettlebells"),
    mem("m-plain", "rule", "Long runs on Sunday"),
    mem("m-rehearsal", "note", `Race ${ahead(200)}`, { expiresAt: ahead(201), provenance: { source: "athlete_words", at: AT, rehearsal: true } }),
    mem("m-old", "note", `Ski trip ${ahead(100)}`, { expiresAt: ahead(101), supersededBy: "m-ski" }),
  ];
  for (let i = 0; i < rows.length; i += 4) await db.insert(schema.coachMemory).values(rows.slice(i, i + 4));
  await db.insert(schema.athleteProfiles).values({
    id: userId,
    userId,
    goals: [{ id: "mobility", words: "Move better" }],
    focusAreas: [],
    // An entry no reader takes any more: kept exactly as it is.
    events: [{ label: "an old entry with no id" }],
    preferences: {},
    updatedAt: AT,
  });
  await db.insert(schema.studioPlans).values([
    {
      id: "plan-old",
      userId,
      brief: { goal: "general", durationWeeks: 4, sessionsPerWeek: 1, preferredDays: [1], sessionMinutes: 30, equipment: "", constraints: "", notes: "", startDate: "2026-01-05" },
      plan: {},
      createdAt: "2026-01-01T09:00:00.000Z",
      updatedAt: "2026-01-01T09:00:00.000Z",
    },
    {
      id: "plan-new",
      userId,
      brief: {
        goal: "strength",
        durationWeeks: 8,
        sessionsPerWeek: 2,
        preferredDays: [2, 4],
        sessionMinutes: 45,
        equipment: "dumbbells and a bench",
        constraints: "No overhead pressing",
        notes: "",
        startDate: "2026-09-07",
      },
      plan: {},
      createdAt: "2026-09-01T09:00:00.000Z",
      updatedAt: "2026-09-02T09:00:00.000Z",
    },
  ]);
}

beforeEach(async () => {
  ran.length = 0;
  db = makeTestDb({ boundVariableCap: 100, onStatement: (s) => ran.push(s) });
  ({ id: userId, cookie } = await user(OWNER));
  // Another athlete's memory is never read.
  const other = await user("someone-else@example.com");
  await db.insert(schema.coachMemory).values(mem("o-ski", "note", `Ski trip ${SKI.start}`, { userId: other.id, expiresAt: addDays(SKI.start, 1) }));
});

afterEach(() => vi.restoreAllMocks());

async function migrate(body: unknown, o: { cookie?: string; env?: Env } = {}) {
  const app = mountRoutes(db, "/api/admin", adminRoutes(() => new Response(null, { status: 500 })));
  ran.length = 0;
  const res = await app.request(
    "/api/admin/coach-memory-migration",
    { method: "POST", headers: { Cookie: o.cookie ?? cookie, "content-type": "application/json" }, body: JSON.stringify(body) },
    o.env ?? env,
  );
  return { status: res.status, body: (await res.json().catch(() => null)) as Record<string, any>, statements: [...ran] };
}

/** What the account holds that the copy could touch. */
async function snapshot() {
  const memory = await db.select().from(schema.coachMemory);
  const profile = await db.select().from(schema.athleteProfiles);
  return JSON.stringify({ memory: memory.sort((a, b) => a.id.localeCompare(b.id)), profile });
}

const itemOf = (report: Record<string, any>, id: string): Record<string, any> => (report.memory.items as Array<Record<string, any>>).find((i) => i.id === id)!;

describe("who may run it", () => {
  it("the owner only: behind the admin switch, signed in, and the owner's own account", async () => {
    await seed();
    const before = await snapshot();
    expect((await migrate({}, { env: { ...env, PARITY_ENABLED: undefined } as Env })).status).toBe(404);
    expect((await migrate({}, { cookie: "" })).status).toBe(401);
    const stranger = await user("someone@example.com");
    expect((await migrate({}, { cookie: stranger.cookie })).status).toBe(404);
    expect((await migrate({ apply: true, fingerprint: "x" }, { cookie: stranger.cookie })).status).toBe(404);
    expect((await migrate({})).status).toBe(200);
    // The owner's address is compared without case, as sign-in compares it.
    expect((await migrate({}, { env: { ...env, ALLOWED_GOOGLE_EMAIL: OWNER.toUpperCase() } as Env })).status).toBe(200);
    expect(await snapshot()).toBe(before);
  });
});

describe("the dry run", () => {
  it("writes nothing: only reads run", async () => {
    await seed();
    const before = await snapshot();
    const dry = await migrate({});
    expect(dry.status).toBe(200);
    expect(dry.body.dryRun).toBe(true);
    expect(dry.statements.filter(isWrite)).toEqual([]);
    expect(await snapshot()).toBe(before);
    // The session and the restore marker, then the preferences, the memory, the profile and the old Studio's plan.
    expect(dry.statements).toHaveLength(6);
    // `apply: false` is a dry run too.
    const asked = await migrate({ apply: false });
    expect(asked.status).toBe(200);
    expect(asked.body.dryRun).toBe(true);
    expect(asked.statements.filter(isWrite)).toEqual([]);
    expect(await snapshot()).toBe(before);
  });

  it("says, for each profile-shaped item, where it would go — and that it stays in memory too", async () => {
    await seed();
    const { body: r } = await migrate({});
    expect(r.today).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(typeof r.fingerprint).toBe("string");
    // Live items only: never a rehearsal's, an expired note or a superseded item; never another athlete's.
    expect(r.memory.read).toBe(11);
    const ids = (r.memory.items as Array<{ id: string }>).map((i) => i.id).sort();
    expect(ids).toEqual(["m-focus", "m-goal", "m-goal-have", "m-goal-two", "m-long-event", "m-past", "m-place", "m-race", "m-ski"]);

    expect(itemOf(r, "m-ski")).toMatchObject({
      shape: "event",
      change: "add",
      memory: "kept",
      profile: { field: "events", entry: { kind: "ski", start: SKI.start, end: SKI.end, label: `Ski trip ${SKI.start} to ${SKI.end}`, priority: "C", taper: false } },
    });
    expect(itemOf(r, "m-race")).toMatchObject({
      shape: "event",
      change: "add",
      memory: "kept",
      profile: { field: "events", entry: { kind: "race", start: RACE, priority: "B", taper: true } },
    });
    expect(itemOf(r, "m-race").profile.entry.end).toBeUndefined();
    // Longer than an event's name holds: the event is added with its name cut, and the item stays in memory as it is.
    expect(itemOf(r, "m-long-event")).toMatchObject({ shape: "event", change: "add", memory: "kept" });
    expect(itemOf(r, "m-long-event").profile.entry.label.length).toBeLessThanOrEqual(80);
    expect(itemOf(r, "m-past")).toMatchObject({ shape: "event", change: "none", memory: "kept" });

    expect(itemOf(r, "m-goal")).toMatchObject({ shape: "goal", change: "add", memory: "kept", profile: { field: "goals", entry: { id: "posture", words: "Wants to improve posture" } } });
    expect(itemOf(r, "m-goal-two")).toMatchObject({ shape: "goal", change: "none", memory: "kept", profile: null });
    expect(itemOf(r, "m-goal-two").note).toMatch(/more than one goal/);
    expect(itemOf(r, "m-goal-have")).toMatchObject({ shape: "goal", change: "already", memory: "kept" });

    expect(itemOf(r, "m-focus")).toMatchObject({
      shape: "focus_area",
      change: "add",
      memory: "kept",
      profile: { field: "focusAreas", entry: { id: "hips-glutes", label: "Hips and glutes", refs: ["hips", "glutes"], note: "Focus on hips and glutes" } },
    });
    expect(itemOf(r, "m-place")).toMatchObject({ shape: "place", change: "none", memory: "kept", profile: null });
    expect(itemOf(r, "m-place").note).toMatch(/Settings → Places/);
    // Sore is no focus: a health signal stays in memory, unreported.
    expect(itemOf(r, "m-sore")).toBeUndefined();

    // Copy, not move (A-I1): every item stays live in memory, and nothing points it anywhere else.
    for (const item of r.memory.items as Array<Record<string, any>>) {
      expect(item.memory, item.id).toBe("kept");
      expect(item.to, item.id).toBeUndefined();
    }
    for (const id of ["m-ski", "m-race", "m-long-event", "m-goal", "m-focus"]) expect(itemOf(r, id).note, id).toContain(KEPT_TOO);

    // One plain line for each, for the owner to read.
    expect(r.lines.length).toBeGreaterThanOrEqual(r.memory.items.length);
    expect(r.lines.join("\n")).toContain(`"Ski trip ${SKI.start} to ${SKI.end}" → the profile's events: a ski week, ${SKI.start} to ${SKI.end}. ${KEPT_TOO}`);
    expect(r.lines.join("\n")).not.toMatch(/kept as history|superseded/i);
  });

  it("the old Studio's brief (its newest plan): the fields that go to the profile, the ones that become memory, the ones left behind", async () => {
    await seed();
    const { body: r } = await migrate({});
    expect(r.studioBrief).toMatchObject({
      planId: "plan-new",
      readable: true,
      toProfile: [
        { field: "goal", profile: "goals", value: { id: "strength" }, change: "add" },
        { field: "sessionMinutes", profile: "preferences.sessionMinutes", value: { default: 45 }, change: "add" },
        { field: "preferredDays", profile: "preferences.trainingDays", value: [1, 3], change: "add" },
      ],
      toMemory: [
        { field: "equipment", id: "studio-brief:plan-new:equipment", kind: "fact", body: "Equipment: dumbbells and a bench", change: "add" },
        { field: "constraints", id: "studio-brief:plan-new:constraints", kind: "rule", body: "No overhead pressing", change: "add" },
      ],
    });
    expect((r.studioBrief.notCarried as Array<{ field: string }>).map((n) => n.field)).toEqual(["durationWeeks", "sessionsPerWeek", "startDate", "notes"]);
  });

  it("no old Studio plan: no section; a brief that doesn't read: said so, nothing taken from it", async () => {
    expect((await migrate({})).body.studioBrief).toBeNull();
    await db.insert(schema.studioPlans).values({ id: "plan-bad", userId, brief: { goal: "flying" }, plan: {}, createdAt: AT, updatedAt: AT });
    expect((await migrate({})).body.studioBrief).toMatchObject({ planId: "plan-bad", readable: false, toProfile: [], toMemory: [] });
  });
});

describe("the apply", () => {
  it("needs the dry run's fingerprint, and refuses a plan that changed since — with the fresh report, writing nothing", async () => {
    await seed();
    const dry = (await migrate({})).body;
    expect((await migrate({ apply: true })).status).toBe(400);
    expect((await migrate({ apply: "yes" })).status).toBe(400);
    await db.insert(schema.coachMemory).values(mem("m-new", "note", `Trip to the coast ${ahead(260)}`, { expiresAt: ahead(261) }));
    const before = await snapshot();
    const stale = await migrate({ apply: true, fingerprint: dry.fingerprint });
    expect(stale.status).toBe(409);
    expect(stale.body.error).toBe("changed_since_dry_run");
    expect(itemOf(stale.body.report, "m-new")).toMatchObject({ shape: "event", change: "add" });
    expect(stale.statements.filter(isWrite)).toEqual([]);
    expect(await snapshot()).toBe(before);
  });

  it("does exactly what the dry run said: the profile gains the entries, and every memory item stays as it was", async () => {
    await seed();
    const dry = (await migrate({})).body;
    const applied = await migrate({ apply: true, fingerprint: dry.fingerprint });
    expect(applied.status).toBe(200);
    const { dryRun: _d, applied: done, ...report } = applied.body;
    const { dryRun: _d2, ...planned } = dry;
    expect(report).toEqual(planned);
    expect(done).toEqual({ profile: true, added: 2 });
    expect(applied.statements.length).toBeLessThanOrEqual(45);
    // The profile written and the brief's items added — and no memory item changed (A-I1: the apply supersedes nothing).
    expect(applied.statements.filter((s) => /^update "coach_memory"/i.test(s))).toEqual([]);

    // The profile: what was there, kept as it was, and what the plan added.
    const [p] = await db.select().from(schema.athleteProfiles).where(eq(schema.athleteProfiles.userId, userId));
    const added = (field: string) => (dry.memory.items as Array<Record<string, any>>).filter((i) => i.change === "add" && i.profile?.field === field).map((i) => i.profile.entry);
    expect(p!.events).toEqual([{ label: "an old entry with no id" }, ...added("events")]);
    expect(p!.goals).toEqual([{ id: "mobility", words: "Move better" }, ...added("goals"), { id: "strength", words: "Get stronger (the old Studio's plan goal)" }]);
    expect(p!.focusAreas).toEqual(added("focusAreas"));
    expect(p!.preferences).toEqual({ sessionMinutes: { default: 45 }, trainingDays: [1, 3] });

    // Memory: every item as it was — still live, superseded by nothing — beside the brief's new items.
    for (const item of dry.memory.items as Array<Record<string, any>>) {
      const [row] = await db.select().from(schema.coachMemory).where(eq(schema.coachMemory.id, item.id));
      expect(row!.active, item.id).toBe(true);
      expect(row!.supersededBy, item.id).toBeNull();
    }
    const live = await db.select().from(schema.coachMemory).where(liveMemoryWhere(userId, TODAY));
    expect(live.map((m) => m.id).sort()).toEqual(
      [
        "m-focus",
        "m-goal",
        "m-goal-have",
        "m-goal-two",
        "m-long-event",
        "m-past",
        "m-place",
        "m-plain",
        "m-race",
        "m-ski",
        "m-sore",
        "studio-brief:plan-new:constraints",
        "studio-brief:plan-new:equipment",
      ].sort(),
    );
    const [equipment] = await db.select().from(schema.coachMemory).where(eq(schema.coachMemory.id, "studio-brief:plan-new:equipment"));
    expect(equipment).toMatchObject({ kind: "fact", body: "Equipment: dumbbells and a bench", confidence: "stated", pinned: false });
    expect(equipment!.provenance).toMatchObject({ source: "studio_brief", planId: "plan-new" });
    // The old Studio's tables are left as they are.
    expect(await db.select().from(schema.studioPlans)).toHaveLength(2);
  });

  it("run twice, changes nothing: the second finds nothing to do and writes nothing", async () => {
    await seed();
    const first = (await migrate({})).body;
    await migrate({ apply: true, fingerprint: first.fingerprint });
    const after = await snapshot();
    const second = (await migrate({})).body;
    expect((second.memory.items as Array<{ change: string; memory: string }>).filter((i) => i.change === "add" || i.memory !== "kept")).toEqual([]);
    expect(second.studioBrief.toProfile.every((f: { change: string }) => f.change === "already")).toBe(true);
    expect(second.studioBrief.toMemory.every((f: { change: string }) => f.change === "already")).toBe(true);
    const again = await migrate({ apply: true, fingerprint: second.fingerprint });
    expect(again.status).toBe(200);
    expect(again.body.applied).toEqual({ profile: false, added: 0 });
    expect(again.statements.filter(isWrite)).toEqual([]);
    expect(await snapshot()).toBe(after);
  });

  it("an item the athlete deleted from the old Studio's brief is never brought back", async () => {
    await seed();
    await migrate({ apply: true, fingerprint: (await migrate({})).body.fingerprint });
    await db.update(schema.coachMemory).set({ active: false }).where(eq(schema.coachMemory.id, "studio-brief:plan-new:constraints"));
    const r = (await migrate({})).body;
    expect(r.studioBrief.toMemory.find((f: { field: string }) => f.field === "constraints").change).toBe("already");
    await migrate({ apply: true, fingerprint: r.fingerprint });
    const [row] = await db.select().from(schema.coachMemory).where(eq(schema.coachMemory.id, "studio-brief:plan-new:constraints"));
    expect(row!.active).toBe(false);
  });

  it("many items: chunked within D1's 100 variables a statement, the whole request within 45 — and every item stays live", async () => {
    const rows: Mem[] = Array.from({ length: 160 }, (_, i) => mem(`trip-${String(i).padStart(3, "0")}`, "note", `Trip ${i} on ${ahead(30 + i)}`, { expiresAt: ahead(400) }));
    for (let i = 0; i < rows.length; i += 4) await db.insert(schema.coachMemory).values(rows.slice(i, i + 4));
    const dry = (await migrate({})).body;
    const adds = (dry.memory.items as Array<{ change: string }>).filter((i) => i.change === "add").length;
    // The profile holds 40 events: the rest are reported and left in memory.
    expect(adds).toBe(40);
    expect((dry.memory.items as Array<{ change: string; note?: string }>).filter((i) => i.change === "none" && /holds at most 40/.test(i.note ?? ""))).not.toHaveLength(0);
    const applied = await migrate({ apply: true, fingerprint: dry.fingerprint });
    expect(applied.status).toBe(200);
    expect(applied.statements.length).toBeLessThanOrEqual(45);
    // Every trip stays live in memory: the thread coach's dated events lose none of them.
    expect(await db.select().from(schema.coachMemory).where(liveMemoryWhere(userId, TODAY))).toHaveLength(160);
  });
});

describe("what the live thread coach reads (A-I1: copy, not move)", () => {
  /** The thread coach's reads: its guardrails' dated events and anchor-day rules, and its dossier. */
  async function threadCoachReads() {
    const prefs = await loadPreferences(db, userId);
    const today = (await migrate({})).body.today as string;
    const ctx = await guardrailCtx(db, userId, prefs, today);
    const dossier = await buildDossier(db, userId, prefs, today);
    return { datedEvents: ctx.datedEvents, rules: ctx.rules, dossier: dossier.text };
  }

  it("its dated events and its dossier are unchanged by the apply: every trip, goal and focus area stays in them", async () => {
    await seed();
    // The old Studio's plans aside: the items the apply adds from them are new memory, which the dossier would list.
    await db.delete(schema.studioPlans).where(eq(schema.studioPlans.userId, userId));
    const before = await threadCoachReads();
    expect(before.datedEvents.map((e) => e.id)).toEqual(expect.arrayContaining(["m-ski", "m-race", "m-long-event"]));
    expect(before.dossier).toContain("Wants to improve posture");
    expect(before.dossier).toContain("Focus on hips and glutes");
    const applied = await migrate({ apply: true, fingerprint: (await migrate({})).body.fingerprint });
    expect(applied.body.applied).toEqual({ profile: true, added: 0 });
    expect(await threadCoachReads()).toEqual(before);
  });

  it("with the old Studio's brief too: nothing it read is lost, and its dated events and rules are the same", async () => {
    await seed();
    const before = await threadCoachReads();
    await migrate({ apply: true, fingerprint: (await migrate({})).body.fingerprint });
    const after = await threadCoachReads();
    expect(after.datedEvents).toEqual(before.datedEvents);
    expect(after.rules).toEqual(before.rules);
    for (const line of before.dossier.split("\n")) expect(after.dossier).toContain(line);
  });
});

describe("the report stays in the response", () => {
  it("nothing of it reaches the logs, dry run or apply", async () => {
    await seed();
    const spies = (["log", "info", "warn", "error", "debug"] as const).map((k) => vi.spyOn(console, k).mockImplementation(() => undefined));
    const dry = (await migrate({})).body;
    await migrate({ apply: true, fingerprint: dry.fingerprint });
    for (const s of spies) expect(s).not.toHaveBeenCalled();
  });
});
