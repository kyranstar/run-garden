/**
 * A DESIGNED RUN ON THE v2 WIRE, THERE AND BACK (§8 phase 2): the designed document → its session → the v2 builder →
 * a COROS that re-encodes what it stores (renormalizing-coros.ts: its own ids, links, container targets, duration and
 * distance) → the real normalizer → the stage rows the import writes → the stage converter (`docFromStages`) — and the
 * document that comes back is the designed one: its parts, rounds, efforts, and every time and distance. (Not its whys,
 * title or summary, which the wire has no place for; and every banded step comes back with its pace written, as the
 * import reads one.) On v1 the same run comes back written out: its repeat and its distances gone.
 */
import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { runWatchSessionOf, type WorkoutDoc } from "@rg/domain";
import { CorosClient, createWorkout } from "@rg/coros";
import { normalizeCorosSchedule } from "@rg/providers";
import { docFromStages } from "@rg/workout";
import { renormalizingCoros } from "../../../packages/coros/test/renormalizing-coros.js";
import { nextMonday } from "../../../packages/coros/test/mock-coros-server.js";
import { importedStageRows } from "../src/services/import-plan.js";
import { plannedStageOfRow } from "../src/services/workout-doc-store.js";

const DOC: WorkoutDoc = {
  version: 1,
  title: "Tempo blocks",
  intent: { summary: "Three tempo blocks.", goals: [], focus: [], effort: "develop" },
  parts: [
    { purpose: "warmup", format: "steady", items: [{ kind: "run", effort: "easy", target: { durationSec: 600 }, why: "Ease in." }] },
    {
      purpose: "run",
      format: "intervals",
      rounds: 3,
      items: [
        { kind: "run", effort: "tempo", target: { distanceM: 800 }, why: "Comfortably hard." },
        { kind: "run", effort: "recovery", target: { durationSec: 90 } },
      ],
    },
    { purpose: "cooldown", format: "steady", items: [{ kind: "run", effort: "easy", target: { distanceM: 2000 } }] },
  ],
  source: { kind: "coach" },
};

/** What the wire carries of a document: its parts, rounds, efforts, and each time or distance. */
const carried = (d: WorkoutDoc) =>
  d.parts.map((p) => ({
    purpose: p.purpose,
    rounds: p.rounds ?? 1,
    items: p.items.map((i) =>
      i.kind === "run" ? { effort: i.effort, ...(i.target.durationSec !== undefined ? { durationSec: i.target.durationSec } : { distanceM: i.target.distanceM }) } : { rest: i.kind === "rest" ? i.seconds : null },
    ),
  }));

async function thereAndBack(wire: "v1" | "v2"): Promise<WorkoutDoc> {
  const server = renormalizingCoros({ baseMonday: nextMonday() });
  const client = new CorosClient({ region: "us", fetchImpl: server.fetchImpl, logger: () => undefined });
  await client.loginWithHash(server.email, createHash("md5").update(server.password, "utf8").digest("hex"));
  const today = new Date().toISOString().slice(0, 10);
  const day = new Date(`${today}T00:00:00Z`);
  day.setUTCDate(day.getUTCDate() + 10);
  const iso = day.toISOString().slice(0, 10);
  const made = runWatchSessionOf(DOC, wire);
  if (!("session" in made)) throw new Error(made.refused);
  const name = `Tempo blocks — ${iso}`;
  const result = await createWorkout(client, { happenDay: iso.replaceAll("-", ""), name, session: made.session, thresholdPaceSecPerKm: 289, runWire: wire }, { today, catalog: new Map(), log: () => undefined });
  expect(result.ok, result.error).toBe(true);
  expect(server.reencoded).toBe(1);
  const workout = normalizeCorosSchedule(await client.getRawSchedule(iso, iso)).workouts.find((w) => w.title === name)!;
  const rows = importedStageRows("wo-1", workout.stages);
  return docFromStages(rows.map(plannedStageOfRow), { title: workout.title, sport: "run", category: "quality", qualitySubtype: "tempo", corosKeyToLibraryId: () => null }).doc;
}

describe("a designed run on the v2 wire, there and back", () => {
  it("comes back the designed document: its parts, its 3 ×, its efforts, every time and distance", async () => {
    const back = await thereAndBack("v2");
    expect(carried(back)).toEqual(carried(DOC));
    // Its tempo comes back with the band it went with (4:59–5:14), the recovery with none, a distance as metres.
    const reps = back.parts[1]!;
    expect(reps.items[0]).toMatchObject({ kind: "run", effort: "tempo", target: { distanceM: 800, pace: { fastSecPerKm: 299, slowSecPerKm: 314 } } });
    expect((reps.items[1] as { target: { pace?: unknown } }).target.pace).toBeUndefined();
  });

  it("on v1 the same run comes back written out — its repeat and its distances gone, as phase 1 writes it", async () => {
    const back = await thereAndBack("v1");
    expect(back.parts.some((p) => (p.rounds ?? 1) > 1)).toBe(false);
    expect(back.parts.flatMap((p) => p.items).some((i) => i.kind === "run" && i.target.distanceM !== undefined)).toBe(false);
  });
});
