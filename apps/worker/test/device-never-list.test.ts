/**
 * THE NEVER-LIST: NO HEALTH READING, CONDITION OR MEMORY CORE REACHES THE PHONE (R1 review A/MAJOR-1; the v4 grant's "Never
 * heart rate, pace, routes or health readings"; the lead's v0.20 "structured results over raw transcripts").
 *
 * Planted where the coach reads them: heart-rate variability, resting heart rate, a recovery score, sleep and its stress, a
 * threshold pace; TMJ switched on with today's check; a pinned memory-core line and one beyond the core. A phone's run then
 * goes through the real loop (a scripted model) and reads every one of them — read_readiness, read_day, read_profile,
 * recall_memory — asks a question in words that name them, proposes a workout and finishes with a line that names them.
 *
 * Every v5 answer the phone can get is read — the run, its steps' events, the current run, an answer, the conversation, the
 * proposal and its approve, the nudges, the spend, memory, the library, the templates, a take-back and its receipt — and
 * none holds a planted value, a reading's key, the condition's name or the memory lines; memory's own read is the one
 * exception for its lines (the grant: "see, edit, add to and delete what your coach remembers"), and it carries no account
 * id. The laptop's read of the same run still holds them: its answers are unchanged. Synthetic data only.
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { DateTime } from "luxon";
import { eq } from "drizzle-orm";
import { schema } from "@rg/database";
import { addDays, newId, nowInstant, startOfIsoWeek } from "@rg/domain";
import { coachRoutes } from "../src/routes/coach.js";
import { coachConversationRoutes } from "../src/routes/coach-conversation.js";
import { coachNudgesRoutes } from "../src/routes/coach-nudges.js";
import { coachRunRoutes } from "../src/routes/coach-runs.js";
import { nativeRoutes } from "../src/routes/native.js";
import { nativeLibraryRoutes } from "../src/routes/native-library.js";
import { nativeTakeBackRoutes } from "../src/routes/native-take-back.js";
import { runStep, type RunDeps } from "../src/services/coach-runs.js";
import { designContextBuilder } from "../src/services/design-context.js";
import { REVIEW_DIMENSIONS } from "../src/services/design-prompt.js";
import { allTools } from "../src/services/design-tools/index.js";
import type { ContentBlock, MessagesOk, MessagesResult } from "../src/services/llm-messages.js";
import { calmDoc } from "./doc-workout-fixture.js";
import { nativeWorld, seedDevice, type Answer, type NativeWorld } from "./native-fixture.js";

const { coachMemory, conditionChecks, dailyHealth, sleepRecords, userConditions, workoutTemplates } = schema;
const LA = "America/Los_Angeles";
const T = "2026-11-19";
const NOW = DateTime.fromISO(`${T}T07:40`, { zone: LA }).toUTC().toISO()!;

/** What must never reach the phone: the planted values, the readings' own keys, the condition, the memory lines — and what
 * the opening, a chip and the weekly review word (review A MAJOR-1r): a drift, a pace, a zone, cadence, power, load, climb. */
const PLANTED = ["91.37", "37.73", "13.31", "23457", "61.9", "77.71", "271.3", "Sasquatch", "Bigfoot", "6% late", "5:40 /km", "zone 4", "187 spm", "251 W", "load 417", "903 m", "fueling"];
/** Effort words a coach's line may use (never in the library's own catalog, whose moves may be named for power). */
const EFFORT_WORDS = [/\bhr\b/i, /zones?\s*\d/i, /cadence/i, /\bpower\b/i, /training load/i, /elevation/i, /\d+:\d{2}\s*\/\s*km/i, /\/km/i];
const NEVER_WORDS = [/\btmj\b/i, /\bjaw\b/i, /\bhrv\b/i, /resting\s*h(eart|r)/i, /\bsleep/i, /\bstress/i, /readiness verdict/i];
const NEVER_KEYS = ["hrv", "restingHr", "restingHeartRate", "sleep", "stress", "stressAvg", "recoveryScore", "readings", "profiles", "conditions", "conditionMax", "thresholdPaceSecPerKm", "userId", "input", "data"];

function keysOf(v: unknown, out = new Set<string>()): Set<string> {
  if (Array.isArray(v)) for (const x of v) keysOf(x, out);
  else if (v && typeof v === "object") for (const [k, x] of Object.entries(v)) (out.add(k), keysOf(x, out));
  return out;
}
/**
 * What of the never-list an answer holds (empty when none). `memoryLines`: memory's own read, whose bodies the grant shows.
 * `catalog`: the library's public catalog, where a move for the jaw is a move every account sees — not the owner's condition.
 */
function leaks(a: Answer, o: { memoryLines?: boolean; catalog?: boolean } = {}): string[] {
  const text = a.text;
  const found = [
    ...PLANTED.filter((p) => text.includes(p) && !(o.memoryLines && (p === "Sasquatch" || p === "Bigfoot"))),
    ...NEVER_WORDS.filter((r) => !(o.catalog && r.source === "\\bjaw\\b") && r.test(text)).map(String),
    ...(o.catalog ? [] : EFFORT_WORDS.filter((r) => r.test(text)).map(String)),
    ...[...keysOf(a.json)].filter((k) => NEVER_KEYS.includes(k)).map((k) => `key:${k}`),
  ];
  return found;
}

let w: NativeWorld;
let v5: { token: string; id: string };

beforeAll(() => undefined);
beforeEach(async () => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date(NOW));
  vi.stubGlobal("fetch", (async () => new Response("{}", { status: 404 })) as typeof fetch);
  w = await nativeWorld(
    [
      ["/api/coach/runs", coachRunRoutes],
      ["/api/coach/conversation", coachConversationRoutes],
      ["/api/coach/nudges", coachNudgesRoutes],
      ["/api/coach", coachRoutes],
      ["/api/native", nativeRoutes],
      ["/api/native", nativeLibraryRoutes],
      ["/api/native", nativeTakeBackRoutes],
    ],
    { env: { COACH_DESIGNER: "1", AI_GATEWAY_API_KEY: "test-key" } },
  );
  v5 = await seedDevice(w.db, w.userId, { scope: "training-v5", lastUsedAt: nowInstant(), expiresAt: "2099-01-01T00:00:00.000Z" });
  // The readings, every morning of the last two weeks.
  for (let n = 0; n < 14; n++) {
    const date = addDays(T, -n);
    await w.db.insert(dailyHealth).values({ id: `${w.userId}:${date}`, userId: w.userId, date, restingHeartRate: 37.73, hrv: 91.37, recoveryScore: 13.31, thresholdPaceSecPerKm: 271.3, contentFingerprint: "fp", updatedAt: NOW });
    await w.db.insert(sleepRecords).values({ id: `${w.userId}:${date}`, userId: w.userId, date, durationSeconds: 23457, qualityScore: 61.9, stressAvg: 77.71, contentFingerprint: "fp", updatedAt: NOW } as typeof sleepRecords.$inferInsert);
  }
  await w.db.insert(userConditions).values({ id: `${w.userId}:tmj`, userId: w.userId, profileId: "tmj", active: true, since: "2026-09-01", settings: {} });
  await w.db.insert(conditionChecks).values({ id: newId(), userId: w.userId, profileId: "tmj", kind: "daily", value: 3, feelingOff: false, localDate: T, at: NOW });
  const memory = (body: string, pinned: boolean) => ({ id: newId(), userId: w.userId, kind: "fact", body, confidence: "stated", pinned, active: true, learnedAt: NOW, updatedAt: NOW, provenance: { source: "athlete" } }) as typeof coachMemory.$inferInsert;
  await w.db.insert(coachMemory).values([memory("Sasquatch keeps the morning slot free", true), memory("Bigfoot likes hills more than flats", false)]);
  await w.db.insert(workoutTemplates).values({ id: "t-1", userId: w.userId, name: "Hip reset", doc: JSON.stringify(calmDoc()), pinned: false, uses: 0, lastUsedAt: null, createdAt: NOW, updatedAt: NOW });
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

let seq = 0;
const use = (name: string, input: unknown): ContentBlock => ({ type: "tool_use", id: `toolu_nl${++seq}`, name, input });
const turn = (uses: ContentBlock[], text: string): MessagesOk => ({
  ok: true,
  model: "anthropic/claude-opus-5.5",
  content: [{ type: "thinking", thinking: "", signature: `sig-${++seq}-${"x".repeat(30)}` }, { type: "text", text }, ...uses],
  stopReason: uses.length > 0 ? "tool_use" : "end_turn",
  usage: { inputTokens: 100, cacheReadTokens: 60, cacheWriteTokens: 50, outputTokens: 40 },
  costMicros: 1_000,
});
const DIMS = REVIEW_DIMENSIONS.map((d) => d.id);
const verdict = { scores: Object.fromEntries(DIMS.map((d) => [d, 4])), notes: Object.fromEntries(DIMS.map((d) => [d, `${d}: as it should be.`])), mustFix: [], improvements: [] };

function scripted(turns: MessagesResult[]): RunDeps {
  return {
    callModel: async () => {
      const next = turns.shift();
      if (!next) throw new Error("the scripted model ran out of turns");
      return next;
    },
    buildContext: designContextBuilder,
    tools: allTools(),
    review: true,
    clock: () => 0,
  };
}

const device = (method: string, path: string, body?: unknown) => w.call(method, path, { bearer: v5.token, ...(body === undefined ? {} : { body }) });

async function stepUntil(runId: string, deps: RunDeps, done: (status: string) => boolean): Promise<Answer[]> {
  const events: Answer[] = [];
  for (let i = 0; i < 20; i++) {
    const out = await runStep(w.db, { ...w.env, COACH_DESIGNER: "1" }, runId, w.userId, new Date(Date.now() + i * 1000), deps);
    if (out.kind !== "ok") throw new Error(`step answered ${out.kind}`);
    if (done(out.result.status)) break;
  }
  return events;
}

describe("the opening, its chips and the weekly review (review A MAJOR-1r)", () => {
  const lastWeekStart = addDays(startOfIsoWeek(T), -7);
  async function seedOpening() {
    await w.db.insert(schema.weeklyReviews).values({
      id: newId(), userId: w.userId, weekStart: lastWeekStart, facts: {},
      narrative: "Last week your HR sat in zone 4 too long, cadence 187 spm, power 251 W, training load 417 and 903 m of elevation. Steady work.",
      createdAt: NOW,
    });
    await w.db.insert(schema.activities).values({
      id: "act-1", userId: w.userId, startTime: `${T}T14:00:00Z`, startTimeLocal: `${T}T06:00:00`, sport: "run", durationSeconds: 5440, distanceMeters: 16_000, avgPaceSecPerKm: 340,
      telemetry: { hrZones: [{ lo: 100, hi: 120, seconds: 600 }, { lo: 120, hi: 140, seconds: 4840 }] }, completionMatchId: null, sourceMergeConfidence: 1, createdAt: NOW, updatedAt: NOW,
    } as typeof schema.activities.$inferInsert);
    await w.db.insert(schema.coachReads).values({ id: newId(), userId: w.userId, activityId: "act-1", status: "done", attempt: 1, nextAttemptAt: NOW, glance: "HR drifted 6% late — fueling, not fitness.", body: "Body.", flags: [], createdAt: NOW });
  }

  it("the phone reads kinds, ids, days and the app's labels — never the line, a chip's words or the review; the laptop still does", async () => {
    await seedOpening();
    // Monday's review first.
    const laptopReview = await w.call("GET", "/api/coach/nudges");
    expect(laptopReview.text).toContain("zone 4");
    const review = await device("GET", "/api/coach/nudges");
    expect(review.status, review.text).toBe(200);
    expect(leaks(review)).toEqual([]);
    expect(review.json.opening).toMatchObject({ id: `review:${lastWeekStart}`, source: "review", weekStart: lastWeekStart, chips: [{ id: `review:${lastWeekStart}`, kind: "review", label: "Plan this week" }] });
    // Then the session the coach read.
    const seen = `?seen=review:${lastWeekStart}`;
    const laptopSession = await w.call("GET", `/api/coach/nudges${seen}`);
    expect(laptopSession.text).toContain("HR drifted 6% late");
    expect(laptopSession.text).toContain("16 km");
    const session = await device("GET", `/api/coach/nudges${seen}`);
    expect(leaks(session)).toEqual([]);
    expect(session.text).not.toContain("16 km");
    expect(session.json.opening).toMatchObject({ id: "session:act-1", source: "read", chips: [{ id: "session:act-1", kind: "session", subject: "act-1", label: "Plan around my last session" }] });
    // Exactly the allowlisted keys, at every level.
    expect(Object.keys(session.json).sort()).toEqual(["nudges", "opening"]);
    expect(Object.keys(session.json.opening).sort()).toEqual(["chips", "id", "line", "source"]);
    expect(Object.keys(session.json.opening.chips[0]).sort()).toEqual(["id", "kind", "label", "subject"]);
  });

  it("Rework from the phone sends the chip's id: the server looks up its words, and the phone reads the chip's label", async () => {
    await seedOpening();
    const made = await device("POST", "/api/coach/runs", { scope: { kind: "now" }, chip: "session:act-1" });
    expect(made.status, made.text).toBe(200);
    expect(leaks(made)).toEqual([]);
    expect([made.json.run.request, made.json.run.chip]).toEqual(["Plan around my last session", "session:act-1"]);
    const [row] = await w.db.select({ request: schema.coachRuns.request }).from(schema.coachRuns).where(eq(schema.coachRuns.id, made.json.run.id));
    expect(row!.request).toContain("16 km");
    expect(leaks(await device("GET", "/api/coach/conversation"))).toEqual([]);
    expect(leaks(await device("GET", `/api/coach/runs/${made.json.run.id}`))).toEqual([]);
  });

  it("a chip no longer offered is 409 chip_gone, nothing started; a chip's words beside it are refused at the gate", async () => {
    const gone = await device("POST", "/api/coach/runs", { scope: { kind: "now" }, chip: "session:act-none" });
    expect([gone.status, gone.json.error]).toEqual([409, "chip_gone"]);
    const both = await device("POST", "/api/coach/runs", { scope: { kind: "now" }, chip: "session:act-1", request: "16 km at 5:40 /km" });
    expect([both.status, both.json.error]).toEqual([403, "out_of_scope"]);
    expect(await w.db.select().from(schema.coachRuns)).toEqual([]);
  });
});

describe("the never-list", () => {
  it("no v5 answer holds a reading, the condition or the memory core — and the laptop's read still does", async () => {
    const created = await device("POST", "/api/coach/runs", { scope: { kind: "now" }, request: "Something calm today." });
    expect(created.status, created.text).toBe(200);
    expect(leaks(created)).toEqual([]);
    const runId = created.json.run.id as string;
    const deps = scripted([
      turn([use("read_readiness", {}), use("read_day", {}), use("read_profile", {}), use("recall_memory", {})], "Your HRV is 91.37 ms and resting heart rate 37.73 bpm; Bigfoot likes hills."),
      turn([use("ask_athlete", { questions: [{ text: "Your HRV is 91.37 and your jaw (TMJ) checked in at 3. How do you feel?", chips: ["Fine", "Sore jaw"], why: "Sleep was 23457 seconds and stress 77.71." }] })], "One question first."),
    ]);
    await stepUntil(runId, deps, (s) => s === "waiting_athlete");
    // Waiting on the phone: the run and its question, as the phone reads them.
    const waiting = await device("GET", `/api/coach/runs/${runId}`);
    expect(waiting.status).toBe(200);
    expect(leaks(waiting)).toEqual([]);
    const question = (waiting.json.events as Array<{ kind: string; payload: { questions?: Array<{ chips: string[] }> } }>).find((e) => e.kind === "question")!;
    expect(question.payload.questions![0]!.chips).toEqual(["Fine"]);
    expect(leaks(await device("GET", "/api/coach/runs/current"))).toEqual([]);
    expect(leaks(await device("GET", "/api/coach/conversation"))).toEqual([]);
    const answered = await device("POST", `/api/coach/runs/${runId}/answer`, { answers: ["Fine"] });
    expect(answered.status, answered.text).toBe(200);
    expect(leaks(answered)).toEqual([]);
    const rest = scripted([
      turn([use("propose_workout", { doc: calmDoc({ title: "Calm hips" }), target: { kind: "new", date: T } })], "Easy on the jaw today, given the 37.73 resting rate."),
      turn([use("submit_review", verdict)], "Reviewed."),
      turn([use("finish", { summary: "A calm hips session for today. Your stress was 77.71 and your TMJ is quiet. Keep it in zone 4 at 187 spm, 251 W." })], "Done."),
    ]);
    await stepUntil(runId, rest, (s) => s === "finished");

    const reads: Array<[string, Answer, { memoryLines?: boolean; catalog?: boolean }?]> = [];
    const read = async (label: string, a: Promise<Answer>, o?: { memoryLines?: boolean; catalog?: boolean }) => {
      const answer = await a;
      reads.push([label, answer, o]);
      return answer;
    };
    const run = await read("run", device("GET", `/api/coach/runs/${runId}`));
    expect(run.json.run.status).toBe("finished");
    await read("run after", device("GET", `/api/coach/runs/${runId}?afterSeq=2`));
    await read("current", device("GET", "/api/coach/runs/current"));
    await read("step", device("POST", `/api/coach/runs/${runId}/step`, {}));
    await read("conversation", device("GET", "/api/coach/conversation"));
    const proposalId = run.json.run.proposalId as string;
    const proposal = await read("proposal", device("GET", `/api/coach/proposals/${proposalId}`));
    expect(proposal.json.complete).toBe(true);
    // Typed fields and titles only: never the cards' manifest, even stripped (the walker is the second line).
    expect(Object.keys(proposal.json).sort()).toEqual(["complete", "id", "opsSummary", "receipts", "resolvedAt", "status", "takeBackable", "titles", "version"]);
    // Each workout's line from its minutes and category, never its title (the coach's words).
    expect(Object.values(proposal.json.titles)).toEqual([expect.stringMatching(/^\d+ min strength$/)]);
    const opId = proposal.json.opsSummary[0].opId as string;
    await read("draft", device("GET", `/api/coach/proposals/${proposalId}/ops/${opId}/draft`));
    const approved = await read("approve", device("POST", `/api/coach/proposals/${proposalId}/approve`, { opIds: [opId], version: proposal.json.version }));
    expect(approved.status, approved.text).toBe(200);
    await read("nudges", device("GET", "/api/coach/nudges"));
    await read("spend", device("GET", "/api/coach/spend"));
    const memory = await read("memory", device("GET", "/api/coach/memory"), { memoryLines: true });
    expect(memory.json.memory.length).toBeGreaterThan(0);
    expect(Object.keys(memory.json.memory[0]).sort()).toEqual(["body", "confidence", "expiresAt", "id", "kind", "learnedAt", "pinned", "source"]);
    await read("library", device("GET", "/api/native/library"), { catalog: true });
    await read("templates", device("GET", "/api/native/templates"));
    await read("template", device("GET", "/api/native/templates/t-1"));
    const receiptId = approved.json.receipts?.[0]?.receiptId as string;
    expect(receiptId).toBeTruthy();
    await read("receipt", device("GET", `/api/native/receipts/${receiptId}`));
    await read("take-back", device("POST", "/api/native/take-back", { receiptIds: [receiptId], requestId: "req-nl" }));
    await read("sharing", device("GET", "/api/native/sharing"));

    for (const [label, a, o] of reads) {
      expect(a.status, `${label}: ${a.text.slice(0, 300)}`).toBeLessThan(500);
      expect([label, leaks(a, o)]).toEqual([label, []]);
    }
    // The laptop's read of the same run is the laptop's: what the coach read is there.
    const laptop = await w.call("GET", `/api/coach/runs/${runId}`);
    expect(laptop.text).toContain("91.37");
    expect(laptop.text).toMatch(/tmj/i);
  });
});
