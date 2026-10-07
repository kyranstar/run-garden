/**
 * Seeded histories written as the save writes them, with the odd row a real account has — sets not done, flags on
 * some sets, a slot's pre-check recorded before the save, a daily check now and then — in 5-row inserts (under the
 * test database's 100-bind cap). The same rows as build-history.test.ts writes.
 */
import { newId } from "@rg/domain";
import { schema } from "@rg/database";
import { Rng, type HistorySession } from "@rg/session-engine";
import type { Db } from "../src/services/db.js";

const NOW = "2026-10-01T00:00:00.000Z";

export async function writeHistory(db: Db, userId: string, sessions: readonly HistorySession[], seed: string): Promise<void> {
  const rng = Rng.create(`write|${seed}`);
  for (const [i, s] of sessions.entries()) {
    const workoutId = rng() < 0.6 ? `w-${seed}-${i % 9}` : null;
    await db.insert(schema.performedSessions).values({
      id: s.id, userId, workoutId, activityId: null, buildId: null, source: s.mode ? "app" : "import", sourceRef: s.mode ? null : `ref-${s.id}`,
      localDate: s.date, startedAt: s.startedAt, endedAt: null, seconds: 1800, plannedSeconds: 1800, minutes: 30,
      mode: s.mode, theme: s.theme, locationId: null, blockRef: null, blockNumber: s.blockNumber, completed: true,
      stepsTotal: null, stepsDone: null, movesDone: s.done.map((m) => ({ exerciseId: m.id, seconds: m.secs })), note: null,
      newMove: null, payloadHash: "h", createdAt: NOW, updatedAt: NOW,
    });
    const sets = s.entries.flatMap((e, entryIndex) => {
      const done = e.sets.map((set, setIndex) => ({ set, setIndex, done: true }));
      // A set skipped at the end, and now and then an entry with nothing done (it is not history).
      const skipped = rng() < 0.15 ? [{ set: e.sets[0]!, setIndex: e.sets.length, done: false }] : [];
      const all = rng() < 0.04 ? done.map((d) => ({ ...d, done: false })) : [...done, ...skipped];
      return all.map(({ set, setIndex, done: isDone }) => ({
        id: newId(), performedSessionId: s.id, entryIndex, exerciseId: e.id, implement: e.implement, format: e.format,
        perSide: e.perSide, setIndex, side: null, reps: set.reps, seconds: set.secs, loadValue: set.w?.v ?? null,
        loadUnit: set.w?.u ?? null, loadKg: null, done: isDone,
        // The entry's flags on its first set only, now and then (an entry's flags are all its sets').
        flags: setIndex === 0 || rng() < 0.5 ? [...e.flags] : [],
      }));
    });
    for (let k = 0; k < sets.length; k += 5) await db.insert(schema.performedSets).values(sets.slice(k, k + 5));
    for (const [profileId, c] of Object.entries(s.checks)) {
      if (c.pre != null || c.feelingOff) {
        // The session sheet's pre-check, recorded for the slot before the save, now and then.
        const sheet = workoutId !== null && rng() < 0.3;
        await db.insert(schema.conditionChecks).values({
          id: newId(), userId, profileId, kind: "pre", value: c.pre, feelingOff: c.feelingOff, localDate: s.date,
          at: `${s.date}T07:00:00.000Z`, performedSessionId: sheet ? null : s.id, workoutId: sheet ? workoutId : null,
        });
      }
      if (c.post != null) {
        await db.insert(schema.conditionChecks).values({
          id: newId(), userId, profileId, kind: "post", value: c.post, feelingOff: false, localDate: s.date,
          at: `${s.date}T20:00:00.000Z`, performedSessionId: s.id, workoutId: null,
        });
      }
    }
    if (rng() < 0.1) {
      await db.insert(schema.conditionChecks).values({
        id: newId(), userId, profileId: "tmj", kind: "daily", value: 3, feelingOff: false, localDate: s.date,
        at: `${s.date}T06:00:00.000Z`, performedSessionId: null, workoutId: null,
      });
    }
  }
}
