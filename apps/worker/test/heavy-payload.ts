/**
 * A synthetic session-build payload the size of a real one (Phase 2a ledger: a stored build is 107–142 KB of JSON),
 * shaped like one — plan steps with targets and cues, alternatives per slot, the library slice — so the CPU and
 * memory a page of them costs is realistic. Deterministic in its seed; nothing in it is anyone's data.
 */
import { newId, nowInstant } from "@rg/domain";
import { schema } from "@rg/database";
import type { Db } from "../src/services/db.js";

export const HEAVY_PAYLOAD_BYTES = 130_000;

function step(seed: number, i: number) {
  return {
    id: `step-${seed}-${i}`,
    exerciseId: `ex-${(i * 7 + seed) % 300}`,
    block: ["warmup", "core", "care", "cooldown"][i % 4],
    kind: i % 3 === 0 ? "timed" : "reps",
    seconds: 30 + (i % 5) * 15,
    reps: 8 + (i % 4),
    restSeconds: 45,
    side: i % 2 ? "left" : "both",
    target: { load: 12.5 + (i % 9), unit: "kg", rpe: 7 },
    cues: ["Keep the ribs down", "Breathe out on the effort"],
  };
}

/** One build-shaped payload of about `bytes` bytes of JSON. */
export function heavyPayload(seed: number, bytes = HEAVY_PAYLOAD_BYTES): Record<string, unknown> {
  const steps: unknown[] = [];
  const alternatives: unknown[] = [];
  const exercises: unknown[] = [];
  const payload = {
    build: { engineVersion: "synthetic", inputsHash: "0".repeat(64), builtAt: "2026-10-05T12:00:00.000Z", steps, alternatives, exercises },
    view: { mode: "consistent", theme: { id: "hips", name: "Hips" }, minutes: 30 },
  };
  let size = JSON.stringify(payload).length;
  for (let i = 0; size < bytes; i++) {
    const s = step(seed, i);
    steps.push(s);
    size += JSON.stringify(s).length + 1;
    if (i % 3 === 0) {
      const alt = { slot: i, options: [step(seed, i + 1000), step(seed, i + 2000)] };
      alternatives.push(alt);
      size += JSON.stringify(alt).length + 1;
    }
    if (i % 4 === 0) {
      const ex = { id: `ex-${i}`, name: `Exercise ${i}`, howTo: "Stand tall and move slowly. ".repeat(6), equipment: ["mat"] };
      exercises.push(ex);
      size += JSON.stringify(ex).length + 1;
    }
  }
  return payload;
}

/** `n` session_builds rows for `userId`, each carrying a heavy payload. Returns their ids in key order. */
export async function seedHeavyBuilds(db: Db, userId: string, n: number): Promise<string[]> {
  const ids: string[] = [];
  for (let i = 0; i < n; i++) {
    const id = `build-${String(i).padStart(3, "0")}-${newId()}`;
    ids.push(id);
    await db.insert(schema.sessionBuilds).values({
      id,
      userId,
      workoutId: `slot-synthetic-${i}`,
      version: 1,
      engineVersion: "synthetic",
      inputsHash: `hash-${i}`,
      payload: heavyPayload(i),
      lockedAt: null,
      createdAt: nowInstant(),
    });
  }
  return ids.sort();
}
