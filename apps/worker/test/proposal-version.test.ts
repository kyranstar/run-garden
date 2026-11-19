/**
 * A PROPOSAL'S VERSION COVERS WHAT IT PROPOSES (R1; DESIGN-3 §3.4.4; review B N-3: the mutant that hashed only `status`
 * survived): the same proposal, in any key order, is the same version; a change to any op's content — a workout's
 * document, a move's day, an op added or decided — or to its status is another. Synthetic data only.
 */
import { describe, expect, it } from "vitest";
import { canonicalJson, proposalVersion } from "../src/services/proposal-version.js";
import { calmDoc } from "./doc-workout-fixture.js";

const workout = (title: string) => ({ kind: "doc_workout", id: "op-1", date: "2026-11-20", target: { kind: "new", date: "2026-11-20", time: "07:00" }, doc: calmDoc({ title }) });
const move = (toDate: string) => ({ kind: "plan_adjust", id: "op-2", date: "2026-11-20", op: { kind: "move", workoutId: "w-1", toDate, toTime: "18:00" } });

describe("proposalVersion", () => {
  it("the same proposal in any key order is the same version; undefined is dropped", async () => {
    const a = { status: "pending", ops: [workout("Calm hips"), move("2026-11-21")] };
    const b = JSON.parse(JSON.stringify({ ops: a.ops, status: "pending" }, (_k, v) => (v && typeof v === "object" && !Array.isArray(v) ? Object.fromEntries(Object.entries(v).reverse()) : v)));
    expect(await proposalVersion(b)).toBe(await proposalVersion(a));
    expect(canonicalJson({ a: 1, b: undefined })).toBe(canonicalJson({ a: 1 }));
    expect(await proposalVersion(a)).toMatch(/^[0-9a-f]{64}$/);
  });

  it("any change to what it proposes is another version", async () => {
    const base = await proposalVersion({ status: "pending", ops: [workout("Calm hips"), move("2026-11-21")] });
    const changed = [
      { status: "pending", ops: [workout("Calm hips, longer"), move("2026-11-21")] },
      { status: "pending", ops: [workout("Calm hips"), move("2026-11-22")] },
      { status: "pending", ops: [workout("Calm hips")] },
      { status: "pending", ops: [workout("Calm hips"), { ...move("2026-11-21"), outcome: { status: "declined" } }] },
      { status: "partially_approved", ops: [workout("Calm hips"), move("2026-11-21")] },
    ];
    for (const p of changed) expect(await proposalVersion(p)).not.toBe(base);
  });
});
