/**
 * TWO HARD CHECKS OF A COACH'S DRAFT (2026-11-05, the owner's "hard checks + guard"; principles §6.4: anything code can
 * check, code checks). Measured in production: the independent reviewer passed, at 4.3 or more with no must-fix, every
 * draft the athlete then pushed back on — one that loaded the back the request called sore, and one titled for a hinge
 * whose only hinge was one light set of three among single-leg work.
 *
 *  - `sore_area_loaded`: a soreness answer recorded today (the request's, an asked question's or the body check's) and a
 *    draft whose working moves load that area — never a warm-up, activation, care or cool-down part, nor a mobility,
 *    breathing or release move — names the moves and the area as the athlete said it (a bare "back" is the back).
 *  - `title_not_content`: a title (or, failing it, an intent summary) that names a movement pattern the working sets
 *    mostly aren't.
 *
 * The pure checks first, then the tools that raise them (validate_workout, propose_workout), with the made-up athlete
 * of design-read-fixture.ts on its fixed clock. Synthetic data only.
 */
import { beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { schema } from "@rg/database";
import { newId, workoutDocSchema, type WorkoutDoc } from "@rg/domain";
import { EXERCISES } from "@rg/exercise-library";
import { makeLibraryIndex } from "@rg/workout";
import type { Env } from "../src/env.js";
import type { Db } from "../src/services/db.js";
import { soreAreaNotes, titleNotes, TITLE_SHARE_MIN, type SoreArea } from "../src/services/design-tools/draft-checks.js";
import { soreAreasOf } from "../src/services/design-tools/record-answer.js";
import { ACT_TOOLS } from "../src/services/design-tools/index.js";
import { designProposalId, type DocWorkoutOp } from "../src/services/design-tools/propose.js";
import { isToolErr, type ToolContext, type ToolErr, type ToolOk } from "../src/services/design-tools/types.js";
import { reviewPacket } from "../src/services/design-review.js";
import { at, NOW, seedRichAthlete, TODAY } from "./design-read-fixture.js";
import { makeTestDb } from "./helpers.js";

const find = makeLibraryIndex(EXERCISES);
const name = (id: string): string => find(id)!.name;

const ex = (libraryId: string, sets = 3, reps = 8) => ({ kind: "exercise", libraryId, dose: { sets, reps, restSec: 60 } });
function doc(o: { title?: string; summary?: string; parts: Array<{ purpose: string; format?: string; items: unknown[] }> }): WorkoutDoc {
  return workoutDocSchema.parse({
    version: 1,
    title: o.title ?? "Today's session",
    intent: { summary: o.summary ?? "A steady session for today.", goals: ["strength"], focus: [], effort: "maintain" },
    parts: o.parts.map((p) => ({ format: "straight", ...p })),
    source: { kind: "coach" },
  });
}

/** "glutes, legs, and back are really sore" as record_answer keeps a bare back: both backs, said as "back". */
const BACK: SoreArea = { words: "back", regions: ["upper-back", "low-back"], muscles: [] };
const GLUTES: SoreArea = { words: "glutes", regions: ["glutes"], muscles: [] };

describe("sore_area_loaded — a working move that loads an area the athlete called sore today", () => {
  const backDay = doc({
    title: "Upper body",
    parts: [
      { purpose: "warmup", items: [ex("bandFacePull", 1, 15), ex("catCow", 1, 6)] },
      { purpose: "main", items: [ex("cableRow"), ex("latPulldown"), ex("cableFacePull"), ex("catCow", 1, 6)] },
      { purpose: "accessory", items: [ex("deadBug")] },
      { purpose: "cooldown", items: [ex("cableRow", 1, 10)] },
    ],
  });

  it("names every loading move of the working parts once, in order, and the area in the athlete's words", () => {
    const notes = soreAreaNotes(backDay, [BACK], find);
    expect(notes).toHaveLength(1);
    const n = notes[0]!;
    expect(n).toMatchObject({ code: "sore_area_loaded", severity: "warning", path: "parts[1].items[0].libraryId" });
    expect(n.message).toBe(`You said your back is sore today; ${name("cableRow")}, ${name("latPulldown")} and ${name("cableFacePull")} load it.`);
    // The warm-up's face pull, the cat-cow (mobility) and the cool-down's row never count; the dead bug spares the back.
    expect(n.message).not.toContain(name("bandFacePull"));
    expect(n.message).not.toContain(name("catCow"));
    expect(n.message).not.toContain(name("deadBug"));
    expect(n.fix).toEqual(expect.any(String));
  });

  it("a move under load counts its secondary muscles too (a weight loads what holds it); a bodyweight one only its own areas", () => {
    const low: SoreArea = { words: "low back", regions: ["low-back"], muscles: [] };
    // RDL: hamstrings and glutes, the erectors secondary under a barbell or dumbbells — the low back carries it.
    expect(soreAreaNotes(doc({ parts: [{ purpose: "main", items: [ex("rdl")] }] }), [low], find)).toHaveLength(1);
    // A bodyweight single-leg RDL reach: its erectors are secondary, and there is no weight.
    expect(soreAreaNotes(doc({ parts: [{ purpose: "main", items: [ex("slRdlReach")] }] }), [low], find)).toEqual([]);
  });

  it("an activation part is not working: a glute bridge there is fine, in the main part it loads sore glutes", () => {
    const activation = doc({ parts: [{ purpose: "activation", items: [ex("bridge", 2, 12)] }, { purpose: "main", items: [ex("pushup")] }] });
    expect(soreAreaNotes(activation, [GLUTES], find)).toEqual([]);
    const main = doc({ parts: [{ purpose: "main", items: [ex("bridge", 2, 12)] }] });
    const [n] = soreAreaNotes(main, [GLUTES], find);
    expect(n!.message).toBe(`You said your glutes are sore today; ${name("bridge")} loads them.`);
  });

  it("one note per area; none when nothing is sore", () => {
    const both = doc({ parts: [{ purpose: "main", items: [ex("cableRow"), ex("gobletSquat")] }] });
    const notes = soreAreaNotes(both, [BACK, GLUTES], find);
    expect(notes.map((n) => n.message)).toEqual([
      `You said your back is sore today; ${name("cableRow")} and ${name("gobletSquat")} load it.`,
      `You said your glutes are sore today; ${name("gobletSquat")} loads them.`,
    ]);
    expect(soreAreaNotes(both, [], find)).toEqual([]);
  });
});

describe("soreAreasOf — the soreness the check reads: recorded today, the draft within its freshness", () => {
  const row = (o: { kind?: string; id: string; text?: string | null; date?: string }) => ({ kind: o.kind ?? "region", id: o.id, text: o.text ?? null, date: o.date ?? TODAY });
  const raw = (rows: unknown[]) => JSON.stringify(rows);
  const focus = new Map<string, string[]>([["ski-legs", ["quads", "glute-med"]]]);

  it("a bare back is the back — upper and low, said once; another area by its library name; a focus area by its own areas", () => {
    const areas = soreAreasOf(
      raw([
        row({ id: "upper-back", text: "glutes, legs, and back are really sore" }),
        row({ id: "low-back", text: "glutes, legs, and back are really sore" }),
        row({ id: "glutes", text: "glutes, legs, and back are really sore" }),
        row({ kind: "focus_area", id: "ski-legs", text: "ski legs are cooked" }),
      ]),
      { today: TODAY, date: TODAY, focusAreas: focus },
    );
    expect(areas).toEqual([
      { words: "back", regions: ["upper-back", "low-back"], muscles: [] },
      { words: "glutes", regions: ["glutes"], muscles: [] },
      { words: "quads and glute med", regions: ["quads"], muscles: ["glute-med"] },
    ]);
  });

  it("a back named with its part keeps it; a muscle is a muscle; a condition is the regions its care targets", () => {
    const areas = soreAreasOf(
      raw([row({ id: "low-back", text: "my lower back is sore" }), row({ kind: "muscle", id: "hip-flexors" }), row({ kind: "condition", id: "tmj" })]),
      { today: TODAY, date: TODAY, focusAreas: new Map() },
    );
    expect(areas).toEqual([
      { words: "low back", regions: ["low-back"], muscles: [] },
      { words: "hip flexors", regions: [], muscles: ["hip-flexors"] },
      { words: "jaw / head", regions: ["jaw"], muscles: [] },
    ]);
  });

  it("only today's answers, and only for a draft within soreness's freshness (today and the two days after)", () => {
    const rows = raw([row({ id: "glutes", date: "2026-05-12" }), row({ id: "calves" })]);
    expect(soreAreasOf(rows, { today: TODAY, date: TODAY, focusAreas: new Map() }).map((a) => a.words)).toEqual(["calves"]);
    expect(soreAreasOf(rows, { today: TODAY, date: "2026-05-15", focusAreas: new Map() }).map((a) => a.words)).toEqual(["calves"]);
    expect(soreAreasOf(rows, { today: TODAY, date: "2026-05-16", focusAreas: new Map() })).toEqual([]);
    expect(soreAreasOf(null, { today: TODAY, date: TODAY, focusAreas: new Map() })).toEqual([]);
  });
});

describe("title_not_content — a title that promises a pattern the working sets mostly aren't", () => {
  // 2026-11-04's draft: "Rebuild Hinge + Ski Base", its only hinge one 3 × 8 RDL among single-leg and ski-stance work.
  const skiBase = (title: string, summary?: string) =>
    doc({
      title,
      ...(summary ? { summary } : {}),
      parts: [
        { purpose: "warmup", items: [ex("hingeDrill", 1, 8)] },
        { purpose: "main", items: [ex("rdl", 3, 8), ex("bwSplitSquat", 3, 8), ex("skaterSquat", 3, 6)] },
        { purpose: "accessory", items: [ex("lateralLungeToBalance", 2, 6)] },
        { purpose: "cooldown", items: [ex("figureFour", 1, 5)] },
      ],
    });

  it(`11-04's shape: one 3 × 8 hinge among eight other working sets is flagged (under ${TITLE_SHARE_MIN} of the work)`, () => {
    const notes = titleNotes(skiBase("Rebuild Hinge + Ski Base"), find);
    expect(notes).toHaveLength(1);
    expect(notes[0]).toMatchObject({ code: "title_not_content", path: "title", severity: "warning" });
    expect(notes[0]!.message).toBe("The title promises hinge work, but only 3 of its 11 working sets are hinges; most of the work is lunges (8 sets).");
  });

  it("a genuinely hinge-led session is not flagged", () => {
    const hingeLed = doc({
      title: "Hinge strength",
      parts: [
        { purpose: "main", items: [ex("rdl", 4, 6), ex("slRdlReach", 3, 8)] },
        { purpose: "accessory", items: [ex("hamstringBridgeChair", 3, 10), ex("deadBug", 3, 8), ex("cableRow", 3, 10)] },
      ],
    });
    expect(titleNotes(hingeLed, find)).toEqual([]);
  });

  it("a title that names no pattern is never flagged, whatever the work", () => {
    expect(titleNotes(skiBase("Rebuild the ski base"), find)).toEqual([]);
    expect(titleNotes(skiBase("Calm hips"), find)).toEqual([]);
  });

  it("the summary counts when the title names none; a negated pattern never counts", () => {
    const fromSummary = titleNotes(skiBase("Ski base", "A hinge-led session to rebuild the base."), find);
    expect(fromSummary.map((n) => [n.path, n.message.slice(0, 32)])).toEqual([["intent.summary", "The summary promises hinge work,"]]);
    expect(titleNotes(skiBase("Single-leg day, no hinge"), find)).toEqual([]);
    expect(titleNotes(skiBase("Hinge-free ski base"), find)).toEqual([]);
  });

  it("a move named for the pattern counts toward it (a split squat is squatting); two named patterns share the session", () => {
    const squatDay = doc({ title: "Squat day", parts: [{ purpose: "main", items: [ex("bwSplitSquat"), ex("gobletSquat"), ex("deadBug"), ex("pushup")] }] });
    expect(titleNotes(squatDay, find)).toEqual([]);
    const pushPull = doc({ title: "Push and pull", parts: [{ purpose: "main", items: [ex("pushup"), ex("cableRow"), ex("deadBug", 2)] }] });
    expect(titleNotes(pushPull, find)).toEqual([]);
    // Named, and absent from the work: none of it.
    const [none] = titleNotes(doc({ title: "Carry day", parts: [{ purpose: "main", items: [ex("cableRow"), ex("deadBug")] }] }), find);
    expect(none!.message).toMatch(/^The title promises carry work, but none of its 6 working sets are carries; most of the work is /);
    // "Most" only when it is: work spread thin names its largest share.
    const spread = doc({ title: "Hinge day", parts: [{ purpose: "main", items: [ex("rdl", 2), ex("cableRow", 2), ex("pushup", 2), ex("gobletSquat", 2), ex("deadBug", 1)] }] });
    expect(titleNotes(spread, find)[0]!.message).toBe("The title promises hinge work, but only 2 of its 9 working sets are hinges; the largest share is rows (2 sets).");
  });

  it("a session with no working sets (a mobility flow) has nothing to measure", () => {
    const flow = doc({ title: "Hinge mobility", parts: [{ purpose: "main", format: "flow", items: [ex("catCow", 1, 6), ex("seatedHipHinge", 1, 6)] }] });
    expect(titleNotes(flow, find)).toEqual([]);
  });
});

// ── The tools that raise them ───────────────────────────────────────────────────────────────────────────────────────

const ENV = {} as Env;
let db: Db;
let rich: Awaited<ReturnType<typeof seedRichAthlete>>;

beforeAll(async () => {
  db = makeTestDb({ boundVariableCap: 100 });
  rich = await seedRichAthlete(db);
});

const tool = (n: string) => ACT_TOOLS.find((t) => t.name === n)!;
let seq = 0;
async function ctx(userId: string): Promise<ToolContext> {
  const id = `run-hc-${++seq}-${newId().slice(0, 6)}`;
  await db.insert(schema.coachRuns).values({
    id, userId, parentId: null, role: "main", scope: { kind: "now" }, request: "glutes, legs, and back are really sore",
    status: "active", state: null, steps: 0, costUsd: 0, createdAt: NOW.toISOString(), updatedAt: NOW.toISOString(),
  });
  return { db, env: ENV, userId, run: { id, role: "main", scope: { kind: "now" }, parentId: null, rehearsal: false }, now: NOW, toolUseId: `toolu_hc${seq}` };
}
const ok = (r: ToolOk | ToolErr): any => {
  if (isToolErr(r)) throw new Error(`refused: ${r.error} — ${r.why}`);
  return r.data;
};

async function soreToday(userId: string, ids: string[], text: string, date = TODAY): Promise<void> {
  for (const [n, id] of ids.entries()) {
    await db.insert(schema.athleteAnswers).values({
      id: `ra:test:${newId()}:${n}`, userId, questionId: "soreness", subjectKind: "region", subjectId: id, text, source: "request",
      localDate: date, at: at(date, "09:00"), expiresAt: date,
    });
  }
}

const rowsDraft = (title = "Upper body") => ({
  version: 1,
  title,
  intent: { summary: "Pull and brace while the legs rest.", goals: ["strength"], focus: [], effort: "maintain" },
  parts: [{ purpose: "main", format: "straight", items: [ex("bandRow"), ex("deadBug")] }],
});

describe("the tools raise them: validate_workout and propose_workout, read in the athlete's statement", () => {
  it("a soreness answer recorded today makes a draft that loads it a note — at validate, and in the stored draft's costs", async () => {
    const { userId } = await seedRichAthlete(db);
    await soreToday(userId, ["upper-back", "low-back"], "glutes, legs, and back are really sore");
    const c = await ctx(userId);
    const v = ok(await tool("validate_workout").run(c, { doc: rowsDraft(), date: TODAY }));
    const note = v.warnings.find((w: { code: string }) => w.code === "sore_area_loaded");
    expect(note.message).toBe(`You said your back is sore today; ${name("bandRow")} loads it.`);
    expect(v.valid).toBe(true);
    ok(await tool("propose_workout").run(c, { doc: rowsDraft(), target: { kind: "new", date: TODAY } }));
    const [p] = await db.select().from(schema.coachProposals).where(eq(schema.coachProposals.id, designProposalId(c.run.id)));
    expect((p!.ops as DocWorkoutOp[])[0]!.issues.map((i) => i.code)).toContain("sore_area_loaded");
  });

  it("yesterday's soreness is not today's: no note (read_answers still has it)", async () => {
    const { userId } = await seedRichAthlete(db);
    await soreToday(userId, ["upper-back"], "my upper back is sore", "2026-05-12");
    const v = ok(await tool("validate_workout").run(await ctx(userId), { doc: rowsDraft(), date: TODAY }));
    expect(v.warnings.map((w: { code: string }) => w.code)).not.toContain("sore_area_loaded");
  });

  it("a title the work doesn't bear out is a note too, with no answer needed", async () => {
    const v = ok(await tool("validate_workout").run(await ctx(rich.userId), { doc: rowsDraft("Squat focus"), date: TODAY }));
    expect(v.warnings.find((w: { code: string }) => w.code === "title_not_content").message).toMatch(/^The title promises squat work, but none of its 6 working sets are squats/);
  });
});

describe("the reviewer reads them as must-fix unless the draft explains them", () => {
  it("its packet lists them apart from the advisory costs, and says soreness is never an accepted cost", () => {
    const d = doc({ title: "Upper body", parts: [{ purpose: "main", items: [ex("cableRow")] }] });
    const packet = reviewPacket({
      round: 1,
      records: [],
      draft: {
        proposalId: "dp-x",
        target: { kind: "new", date: TODAY },
        date: TODAY,
        doc: d,
        derived: { minutes: 20 },
        issues: [
          { path: "parts[0].items[0].libraryId", code: "sore_area_loaded", message: "You said your back is sore today; Seated cable row loads it." },
          { path: "parts[0]", code: "equipment_unavailable", message: "Seated cable row needs a cable, which this place doesn't have." },
        ],
      },
    });
    const must = packet.slice(packet.indexOf("Must-fix unless the draft explains"));
    expect(must).toContain("soreness is never an accepted cost");
    expect(must).toContain("(sore_area_loaded): You said your back is sore today");
    const advisory = packet.slice(packet.indexOf("Advisory notes"), packet.indexOf("Must-fix unless the draft explains"));
    expect(advisory).toContain("equipment_unavailable");
    expect(advisory).not.toContain("sore_area_loaded");
  });
});
