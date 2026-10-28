/**
 * Stage 2 Task 5 — Add, pure (spec §7): the move lands in the part its purpose belongs to (the part made when the
 * document has none, in a workout's own order); an edit the editor refuses changes nothing and says why; the planned
 * workouts offered are only those the Studio may change — never a programme's own session.
 */
import { describe, expect, it } from "vitest";
import type { WorkoutDto } from "@rg/api-client";
import type { WorkoutDoc } from "@rg/domain";
import { EXERCISES, type ExerciseRecord } from "@rg/exercise-library";
import { newDoc, startEditing, tryEdit } from "@rg/workout";
import {
  addedText,
  addMove,
  addTargetHref,
  editableWorkout,
  editableWorkouts,
  freshDoc,
  plannedLabel,
  rejectionText,
} from "../src/screens/studio/add-model.js";

const rec = (id: string): ExerciseRecord => EXERCISES.find((e) => e.id === id)!;
const TODAY = "2026-10-11";

/** A document with only a main part holding one move. */
const mainOnly = (): WorkoutDoc => ({
  version: 1,
  title: "Hips & posture",
  intent: { summary: "Open the hips", goals: [], focus: [], effort: "maintain" },
  parts: [{ purpose: "main", format: "straight", items: [{ kind: "exercise", libraryId: "gobletSquat", dose: { sets: 2, reps: 8 } }] }],
  source: { kind: "studio" },
});

const purposes = (doc: WorkoutDoc) => doc.parts.map((p) => p.purpose);
const idsIn = (doc: WorkoutDoc, purpose: string) =>
  doc.parts.find((p) => p.purpose === purpose)?.items.map((i) => (i.kind === "exercise" ? i.libraryId : i.kind)) ?? [];

describe("Add lands by purpose", () => {
  const cases: Array<[string, string]> = [
    ["catCow", "warmup"], // warm-up
    ["hingeDrill", "activation"], // activation
    ["gobletSquat", "main"], // strength
    ["pogoHop", "power"], // power
    ["doorwayPecStretch", "cooldown"], // stretch
    ["legsUp", "cooldown"], // recovery, passive
    ["jawOpen", "care"], // condition care
  ];

  it.each(cases)("%s goes to %s, the part made where a workout keeps it", (id, part) => {
    const r = addMove(mainOnly(), rec(id), EXERCISES);
    if ("rejected" in r) throw new Error(r.rejected);
    expect(r.part).toBe(part);
    expect(idsIn(r.doc, part)).toContain(id);
    // A part the document lacked is made, in the workout's order: warm-up, activation and power before main, the rest
    // after.
    const order = purposes(r.doc);
    const at = order.indexOf(part as never);
    const main = order.indexOf("main");
    if (["warmup", "activation", "power"].includes(part)) expect(at).toBeLessThan(main);
    else if (part !== "main") expect(at).toBeGreaterThan(main);
    // Nothing else moved.
    expect(idsIn(r.doc, "main").slice(0, 1)).toEqual(["gobletSquat"]);
  });

  it("a balance move goes to the accessory part, a conditioning move to conditioning", () => {
    const balance = { ...rec("gobletSquat"), id: "gobletSquat", purposes: ["balance"] } as ExerciseRecord;
    const lib = EXERCISES.map((r) => (r.id === "gobletSquat" ? balance : r));
    const r = addMove(mainOnly(), balance, lib);
    expect("part" in r && r.part).toBe("accessory");
    const cond = { ...rec("gobletSquat"), purposes: ["conditioning"] } as ExerciseRecord;
    const r2 = addMove(mainOnly(), cond, EXERCISES.map((x) => (x.id === "gobletSquat" ? cond : x)));
    expect("part" in r2 && r2.part).toBe("conditioning");
  });

  it("into a part that already exists, at its end", () => {
    const r = addMove(mainOnly(), rec("boxSquat"), EXERCISES);
    if ("rejected" in r) throw new Error(r.rejected);
    expect(idsIn(r.doc, "main")).toEqual(["gobletSquat", "boxSquat"]);
    expect(r.doc.parts).toHaveLength(1);
  });

  it("with the dose Add puts in: its part's dose (`doseFor`), as the row said it", () => {
    const r = addMove(mainOnly(), rec("boxSquat"), EXERCISES);
    if ("rejected" in r) throw new Error(r.rejected);
    const item = r.doc.parts[0]!.items[1]!;
    expect(item).toEqual({ kind: "exercise", libraryId: "boxSquat", dose: { sets: 2, reps: { min: 8, max: 12 }, restSec: 45 } });
  });

  it("a new workout is warm-up, main and cool-down, the move in its own part", () => {
    const r = addMove(freshDoc(), rec("doorwayPecStretch"), EXERCISES);
    if ("rejected" in r) throw new Error(r.rejected);
    expect(purposes(r.doc)).toEqual(["warmup", "main", "cooldown"]);
    expect(idsIn(r.doc, "cooldown")).toEqual(["doorwayPecStretch"]);
    expect(r.doc.title).toBe("New workout");
    expect(r.doc.source).toEqual({ kind: "studio" });
  });

  it("a full part refuses, and the document is untouched", () => {
    const full = mainOnly();
    full.parts[0]!.items = Array.from({ length: 60 }, () => ({ kind: "exercise" as const, libraryId: "boxSquat", dose: { reps: 8 } }));
    const before = JSON.stringify(full);
    const r = addMove(full, rec("gobletSquat"), EXERCISES);
    expect(r).toEqual({ rejected: "full" });
    expect(JSON.stringify(full)).toBe(before);
  });

  it("a document with no room for another part refuses", () => {
    let st = startEditing(newDoc("blank", { title: "Many", source: { kind: "studio" } }));
    for (let i = 0; i < 20; i++) st = tryEdit(st, { type: "addPart", purpose: "main", at: 0 }, EXERCISES).state;
    expect(st.doc.parts).toHaveLength(20);
    expect(addMove(st.doc, rec("catCow"), EXERCISES)).toEqual({ rejected: "full" });
  });

  it("says why in plain words", () => {
    expect(rejectionText("full")).toBe("That part is full.");
    expect(rejectionText("invalid")).toBe("That move can't go in here.");
    expect(addedText("main", "Hips & posture")).toBe("Added to Main in “Hips & posture”.");
    expect(addedText("cooldown", "New workout")).toBe("Added to Cool-down in “New workout”.");
  });

  it("Open goes to the builder, on what the move went into", () => {
    expect(addTargetHref({ kind: "draft" })).toBe("/studio/build/new");
    expect(addTargetHref({ kind: "new" })).toBe("/studio/build/new");
    expect(addTargetHref({ kind: "workout", id: "w 1" })).toBe("/studio/build/workout/w%201");
    expect(addTargetHref({ kind: "template", id: "t1" })).toBe("/studio/build/template/t1");
  });
});

// ── Which planned workouts the sheet offers ────────────────────────────────

function workout(over: Partial<WorkoutDto>): WorkoutDto {
  return {
    id: "w1",
    title: "Strength",
    category: "strength",
    sport: "strength",
    originalPlanDate: TODAY,
    lastVerifiedCorosDate: "",
    effectiveDate: "2026-10-14",
    effectiveTime: "18:00",
    workoutSeconds: 1800,
    calendarSeconds: 1800,
    calendarSyncState: "synced",
    corosSyncState: "calendar_only",
    completionState: "scheduled",
    archived: false,
    origin: "studio",
    contentState: "outline",
    programId: "studio-u1",
    ...over,
  } as WorkoutDto;
}

describe("the planned workouts the sheet offers", () => {
  it("a document workout still to be done — the Studio's or a template's — is offered", () => {
    expect(editableWorkout(workout({ origin: "studio" }), TODAY)).toBe(true);
    expect(editableWorkout(workout({ origin: "template" }), TODAY)).toBe(true);
    expect(editableWorkout(workout({ origin: "studio", contentState: "built" }), TODAY)).toBe(true);
    expect(editableWorkout(workout({ effectiveDate: TODAY }), TODAY)).toBe(true);
  });

  it("a programme's own session never is (the engine builds it: the sheet offers Pin), nor an on-demand one or a run", () => {
    expect(editableWorkout(workout({ origin: "program", programId: "p1" }), TODAY)).toBe(false);
    expect(editableWorkout(workout({ origin: "on_demand" }), TODAY)).toBe(false);
    expect(editableWorkout(workout({ origin: null, category: "easy" }), TODAY)).toBe(false);
  });

  it("a coach or watch session (no origin) that is not a run, rest or race is: the revise adopts it into a document", () => {
    expect(editableWorkout(workout({ origin: null, id: "cw-1", hasDoc: true } as Partial<WorkoutDto>), TODAY)).toBe(true);
    expect(editableWorkout(workout({ origin: undefined }), TODAY)).toBe(true);
    expect(editableWorkout(workout({ origin: null, category: "rest" }), TODAY)).toBe(false);
    expect(editableWorkout(workout({ origin: null, category: "race" }), TODAY)).toBe(false);
    expect(editableWorkout(workout({ origin: null, sport: "run", category: "tempo" }), TODAY)).toBe(false);
  });

  it("nor one done, skipped, missed, under way, past or archived", () => {
    for (const completionState of ["completed", "skipped", "missed"] as const) {
      expect(editableWorkout(workout({ completionState }), TODAY), completionState).toBe(false);
    }
    expect(editableWorkout(workout({ contentState: "started" }), TODAY)).toBe(false);
    expect(editableWorkout(workout({ contentState: "done" }), TODAY)).toBe(false);
    expect(editableWorkout(workout({ effectiveDate: "2026-10-10" }), TODAY)).toBe(false);
    expect(editableWorkout(workout({ archived: true }), TODAY)).toBe(false);
  });

  it("names each by its day and title — and its time when another offered shares both", () => {
    const a = workout({ id: "a", effectiveDate: "2026-10-13", effectiveTime: "07:00" });
    const b = workout({ id: "b", effectiveDate: "2026-10-13", effectiveTime: "18:30" });
    const c = workout({ id: "c", effectiveDate: "2026-10-14", title: "Hips & posture" });
    const offered = [a, b, c];
    expect(plannedLabel(a, offered)).toBe("Tue Oct 13 · Strength · 7 AM");
    expect(plannedLabel(b, offered)).toBe("Tue Oct 13 · Strength · 6:30 PM");
    expect(plannedLabel(c, offered)).toBe("Wed Oct 14 · Hips & posture");
    expect(plannedLabel(a, [a, c])).toBe("Tue Oct 13 · Strength");
  });

  it("soonest first", () => {
    const list = editableWorkouts(
      [
        workout({ id: "late", effectiveDate: "2026-10-20" }),
        workout({ id: "prog", origin: "program", effectiveDate: "2026-10-12" }),
        workout({ id: "eve", effectiveDate: "2026-10-13", effectiveTime: "19:00" }),
        workout({ id: "morn", effectiveDate: "2026-10-13", effectiveTime: "07:00" }),
      ],
      TODAY,
    );
    expect(list.map((w) => w.id)).toEqual(["morn", "eve", "late"]);
  });
});
