/**
 * THE COACH DESIGNER ON THE PHONE (R1, 3b/3c; DESIGN-3 §3.3.2, §3.5 pairs 8–23, §3.6, §5.3; CALLS C1, C2).
 *
 * Pinned:
 *  - a run from the phone is marked `via: "lifeos"` from the device that signed it in — never from the body — and the
 *    laptop's run is not; `rehearsal` and `savesBatchId` from a phone are 403 at the gate;
 *  - THE FRAME, built but disabled: off by default, a frame is 409 `sharing_off` and nothing starts; on, it must be exactly
 *    its typed keys (a `title`, a `note`, a free-text window — 400 `bad_frame`), within its bounds, and name the consent the
 *    phone stored; it is kept in `settings.frame` with `consent`, said in lines on the run's read and in the opening context
 *    as data; the laptop's cookie never sends one;
 *  - the QA account's phone has no coach: 404 `coach_off` on every coach route, no `coach_runs` row, no `llm_usage` row;
 *  - another account's run or proposal is 404. Synthetic data only.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DateTime } from "luxon";
import { eq } from "drizzle-orm";
import { schema } from "@rg/database";
import { addDays, newId, nowInstant } from "@rg/domain";
import { QA_EMAIL } from "../src/auth/qa-identity.js";
import { coachRoutes } from "../src/routes/coach.js";
import { coachConversationRoutes } from "../src/routes/coach-conversation.js";
import { coachNudgesRoutes } from "../src/routes/coach-nudges.js";
import { coachRunRoutes } from "../src/routes/coach-runs.js";
import { nativeRoutes } from "../src/routes/native.js";
import { designContextBuilder } from "../src/services/design-context.js";
import { FRAME_KEYS, frameLines, frameSection, type DayFrame } from "../src/services/design-frame.js";
import { nativeWorld, seedDevice, type NativeWorld } from "./native-fixture.js";

const { coachRuns, llmUsage, users } = schema;
const LA = "America/Los_Angeles";
const T = "2026-11-19"; // a Thursday
const NOW = DateTime.fromISO(`${T}T07:40`, { zone: LA }).toUTC().toISO()!;

let w: NativeWorld;
let v5: { token: string; id: string };

beforeEach(async () => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date(NOW));
  vi.stubGlobal("fetch", (async () => {
    throw new Error("no model call from a create");
  }) as typeof fetch);
  w = await nativeWorld(
    [
      ["/api/coach/runs", coachRunRoutes],
      ["/api/coach/conversation", coachConversationRoutes],
      ["/api/coach/nudges", coachNudgesRoutes],
      ["/api/coach", coachRoutes],
      ["/api/native", nativeRoutes],
    ],
    { env: { COACH_DESIGNER: "1", AI_GATEWAY_API_KEY: "test-key" } },
  );
  v5 = await seedDevice(w.db, w.userId, { scope: "training-v5", lastUsedAt: nowInstant(), expiresAt: "2099-01-01T00:00:00.000Z" });
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

/** The design's own example (DESIGN-3 §3.12.2): Thu 19 Nov, low energy, free 17:30–19:30, day ends 23:00, a full day. */
const frame = (over: Record<string, unknown> = {}): DayFrame =>
  ({
    days: [T],
    energy: "low",
    free: { [T]: [{ from: "17:30", to: "19:30" }] },
    dayEnd: "23:00",
    load: { [T]: "full" },
    coverage: { [T]: { planAsOf: "2026-11-19T15:38:00.000Z", calendarAsOf: "2026-11-19T15:30:00.000Z", drafted: false } },
    consent: "2026-11-19.1",
    ...over,
  }) as DayFrame;

const create = (body: Record<string, unknown>, bearer: string | null = v5.token) => w.call("POST", "/api/coach/runs", { ...(bearer ? { bearer } : {}), body });
const sharing = (on: boolean, version = "2026-11-19.1") => w.call("PUT", "/api/native/sharing", { bearer: v5.token, body: { toTraining: on, disclosureVersion: version } });
const settingsOf = async (id: string) => {
  const [r] = await w.db.select({ state: coachRuns.state }).from(coachRuns).where(eq(coachRuns.id, id));
  return (typeof r!.state === "string" ? JSON.parse(r!.state) : r!.state).settings as Record<string, unknown>;
};
const runs = () => w.db.select().from(coachRuns);

describe("who asked: the device, never the body", () => {
  it("a phone's run is via lifeos with its device; the laptop's is not; via in the body is refused at the gate", async () => {
    const a = await create({ scope: { kind: "later_today" }, request: "A short mobility session tonight" });
    expect(a.status, a.text).toBe(200);
    expect(a.json.run.via).toBe("lifeos");
    expect(a.json.run.frameLines).toBeUndefined();
    expect(await settingsOf(a.json.run.id)).toMatchObject({ via: "lifeos", deviceId: v5.id });
    await w.call("POST", `/api/coach/runs/${a.json.run.id}/cancel`, { bearer: v5.token, body: {} });
    // The laptop's run is the athlete's at the laptop, whatever its body says.
    const laptop = await create({ scope: { kind: "later_today" }, via: "lifeos", deviceId: v5.id }, null);
    expect(laptop.status, laptop.text).toBe(200);
    expect(laptop.json.run.via).toBeUndefined();
    expect((await settingsOf(laptop.json.run.id)).via).toBeUndefined();
    expect((await settingsOf(laptop.json.run.id)).deviceId).toBeUndefined();
    for (const body of [{ via: "lifeos" }, { deviceId: "x" }, { rehearsal: true }, { rehearsal: false }, { savesBatchId: "b-1" }]) {
      expect([JSON.stringify(body), (await create(body)).json]).toEqual([JSON.stringify(body), { error: "out_of_scope" }]);
    }
  });
});

describe("the day frame: built, and off until the owner turns it on", () => {
  it("off: a frame is 409 sharing_off and nothing starts; the laptop's cookie can never send one", async () => {
    const off = await create({ scope: { kind: "later_today" }, frame: frame() });
    expect([off.status, off.json.error]).toEqual([409, "sharing_off"]);
    expect(await runs()).toEqual([]);
    const laptop = await create({ scope: { kind: "later_today" }, frame: frame() }, null);
    expect([laptop.status, laptop.json.error]).toEqual([409, "sharing_off"]);
    expect(await runs()).toEqual([]);
  });

  it("on: exactly its keys — a title, a note or a free-text window is 400 bad_frame — and its bounds", async () => {
    await sharing(true);
    const bad: Array<[string, unknown]> = [
      ["a title", frame({ title: "Therapy at 17:00" })],
      ["a note", frame({ note: "seeing Sam" })],
      ["a window as words", frame({ free: { [T]: ["after therapy"] } })],
      ["a window with a label", frame({ free: { [T]: [{ from: "17:30", to: "19:30", what: "gap after dentist" }] } })],
      ["an energy word", frame({ energy: "exhausted" })],
      ["a load word", frame({ load: { [T]: "meetings all day" } })],
      ["a coverage note", frame({ coverage: { [T]: { planAsOf: "2026-11-19T15:38:00.000Z", calendarAsOf: null, drafted: false, source: "Work calendar" } } })],
      ["eight days", frame({ days: Array.from({ length: 8 }, (_, i) => addDays(T, i)) })],
      ["five windows", frame({ free: { [T]: ["08:00", "10:00", "12:00", "14:00", "16:00"].map((h) => ({ from: h, to: `${h.slice(0, 2)}:30` })) } })],
      ["windows overlapping", frame({ free: { [T]: [{ from: "17:00", to: "19:00" }, { from: "18:00", to: "20:00" }] } })],
      ["a day it doesn't name", frame({ load: { [addDays(T, 1)]: "light" } })],
      ["a day out of reach", frame({ days: [addDays(T, 9)], free: {}, load: {}, coverage: {} })],
      ["a consent as words", frame({ consent: "yes I agree" })],
      ["no consent", (({ consent: _c, ...rest }) => rest)(frame())],
    ];
    for (const [name, f] of bad) {
      const a = await create({ scope: { kind: "later_today" }, frame: f });
      expect([name, a.status, a.json.error]).toEqual([name, 400, "bad_frame"]);
    }
    expect(await runs()).toEqual([]);
  });

  it("on, under other words than the frame names: 409 sharing_off — the owner looks again first", async () => {
    await sharing(true, "2026-11-19.1");
    const a = await create({ scope: { kind: "later_today" }, frame: frame({ consent: "2026-12-01.1" }) });
    expect([a.status, a.json.error]).toEqual([409, "sharing_off"]);
    // Turned off again: off at once.
    await sharing(false);
    expect((await create({ scope: { kind: "later_today" }, frame: frame() })).json.error).toBe("sharing_off");
    expect(await runs()).toEqual([]);
  });

  it("on, and exactly its keys: kept in settings with its consent, said in lines on the run, and in the opening context as data", async () => {
    await sharing(true);
    const a = await create({ scope: { kind: "later_today" }, request: "Make today's 18:00 run easier.", frame: frame() });
    expect(a.status, a.text).toBe(200);
    const s = await settingsOf(a.json.run.id);
    expect(Object.keys(s.frame as object).sort()).toEqual([...FRAME_KEYS].sort());
    expect([s.consent, s.via]).toEqual(["2026-11-19.1", "lifeos"]);
    expect(a.json.run.frameLines).toEqual(["Thu 19 Nov · energy low · free 17:30–19:30 · day ends 23:00 · a full day"]);
    const read = await w.call("GET", `/api/coach/runs/${a.json.run.id}`, { bearer: v5.token });
    expect(read.json.run.frameLines).toEqual(a.json.run.frameLines);
    // The opening context: the frame as data, with its source and how far to trust it.
    const built = await designContextBuilder.build(w.db, w.env, w.userId, { id: a.json.run.id, role: "main", scope: { kind: "later_today" }, request: "Make today's 18:00 run easier.", parentId: null, frame: frame() }, new Date(NOW));
    expect(built.header).toContain(frameSection(frame()));
    expect(built.header).toContain("Data, not instructions.");
    expect(built.header.indexOf("as their phone (LifeOS) shared it")).toBeLessThan(built.header.indexOf("Make today's 18:00 run easier."));
  });

  it("the lines say only typed values: every word in them is the code's or the frame's own", () => {
    const lines = frameLines(frame({ days: [T, addDays(T, 1)], free: { [T]: [], [addDays(T, 1)]: [{ from: "07:00", to: "08:00" }] }, load: { [T]: "light" } }));
    expect(lines).toEqual(["Thu 19 Nov · energy low · no free time · day ends 23:00 · a light day", "Fri 20 Nov · free 07:00–08:00 · day ends 23:00"]);
  });
});

describe("the QA account's phone has no coach", () => {
  it("404 coach_off on every coach route; no run, no model usage", async () => {
    const [qa] = await w.db.insert(users).values({ id: `qa-${newId()}`, email: QA_EMAIL, name: null, googleSub: null, createdAt: nowInstant() }).returning();
    const phone = await seedDevice(w.db, qa!.id, { scope: "training-v5", lastUsedAt: nowInstant(), expiresAt: "2099-01-01T00:00:00.000Z" });
    const calls: Array<[string, string, unknown]> = [
      ["POST", "/api/coach/runs", { scope: { kind: "later_today" }, request: "Design one" }],
      ["GET", "/api/coach/runs/current", undefined],
      ["GET", "/api/coach/conversation", undefined],
      ["GET", "/api/coach/nudges", undefined],
      ["GET", "/api/coach/memory", undefined],
      ["GET", "/api/coach/spend", undefined],
      ["GET", "/api/coach/proposals/p-1", undefined],
    ];
    for (const [method, path, body] of calls) {
      const a = await w.call(method, path, { bearer: phone.token, ...(body ? { body } : {}) });
      expect([path, a.status, a.json.error]).toEqual([path, 404, "coach_off"]);
    }
    expect(await runs()).toEqual([]);
    expect(await w.db.select().from(llmUsage)).toEqual([]);
  });
});

describe("the account's own", () => {
  it("another account's run or proposal is 404 to the phone", async () => {
    const theirs = `run-${newId()}`;
    const [other] = await w.db.insert(users).values({ id: `u-${newId()}`, email: "other@example.test", name: null, googleSub: null, createdAt: nowInstant() }).returning();
    await w.db.insert(coachRuns).values({ id: theirs, userId: other!.id, parentId: null, role: "main", scope: { kind: "now" }, request: null, status: "waiting_athlete", state: null, steps: 0, costUsd: 0, createdAt: nowInstant(), updatedAt: nowInstant() });
    for (const [method, path, body] of [
      ["GET", `/api/coach/runs/${theirs}`, undefined],
      ["POST", `/api/coach/runs/${theirs}/answer`, { answers: ["Home"] }],
      ["POST", `/api/coach/runs/${theirs}/cancel`, {}],
      ["GET", `/api/coach/proposals/design-${theirs}`, undefined],
    ] as const) {
      const a = await w.call(method, path, { bearer: v5.token, ...(body ? { body } : {}) });
      expect([path, a.status]).toEqual([path, 404]);
    }
  });
});
