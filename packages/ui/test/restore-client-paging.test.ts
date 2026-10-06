/**
 * The restore client sends each table in pages budgeted in BYTES as well as rows (Ruling 2a-R9, audit 2a-model
 * I3): a session build carries 107–142 KB of JSON, and 200 of them in one request would be ~25 MB for the worker to
 * parse, canonicalise and hash. A row larger than the budget still goes, alone.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { checkRestore, type AccountExportFile } from "@rg/api-client";

type Row = Record<string, unknown>;

afterEach(() => {
  vi.unstubAllGlobals();
});

/** About `bytes` of build-shaped JSON (a running length: re-stringifying the whole list per step took seconds). */
function heavy(seed: number, bytes = 130_000): Row {
  const steps: Row[] = [];
  for (let i = 0, size = 2; size < bytes; i++) {
    const step = { id: `step-${seed}-${i}`, exerciseId: `ex-${i % 300}`, reps: 8, seconds: 45, cues: ["Keep the ribs down"] };
    steps.push(step);
    size += JSON.stringify(step).length + 1;
  }
  return { build: { steps }, view: { mode: "consistent" } };
}

describe("checkRestore paging", () => {
  it("sends heavy rows in pages of at most 192 KB unless a page is one row, small rows 200 at a time", async () => {
    const checks: Array<{ table: string; rows: Row[]; offset: number }> = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init?: RequestInit) => {
        if (url === "/api/settings/restore/tables") {
          return new Response(JSON.stringify({ schemaVersion: "0027", tables: ["users", "planned_workouts", "session_builds"], skip: [] }));
        }
        if (url === "/api/settings/restore/check/start") {
          return new Response(JSON.stringify({ ok: true, session: "s", restoreId: "r" }));
        }
        if (url === "/api/settings/restore/check") {
          const body = JSON.parse(String(init?.body)) as { table: string; rows: Row[]; offset: number };
          checks.push(body);
          return new Response(JSON.stringify({ ok: true, token: `t${checks.length}`, rows: body.rows.length }));
        }
        return new Response("{}", { status: 404 });
      }),
    );
    const builds = Array.from({ length: 6 }, (_, i) => ({ id: `b${i}`, workoutId: `w${i}`, version: 1, payload: heavy(i) }));
    const workouts = Array.from({ length: 450 }, (_, i) => ({ id: `w${String(i).padStart(3, "0")}`, title: "Easy run" }));
    const file: AccountExportFile = {
      format: "run-garden-export",
      schemaVersion: "0027",
      exportedAt: "2026-10-05T12:00:00.000Z",
      tables: { users: [{ id: "u" }], planned_workouts: workouts, session_builds: builds },
    };

    const res = await checkRestore(file);
    expect(res.ok).toBe(true);
    if (!res.ok) return;

    const heavyPages = checks.filter((c) => c.table === "session_builds");
    expect(heavyPages.length).toBeGreaterThanOrEqual(6);
    for (const page of heavyPages) {
      expect(page.rows.length === 1 || JSON.stringify(page.rows).length <= 192 * 1024).toBe(true);
    }
    // Pages are contiguous: each starts where the last ended, and together they are the table.
    let offset = 0;
    for (const page of heavyPages) {
      expect(page.offset).toBe(offset);
      offset += page.rows.length;
    }
    expect(heavyPages.flatMap((p) => p.rows.map((r) => r.id))).toEqual(builds.map((b) => b.id));
    // Small rows still travel 200 to a page.
    expect(checks.filter((c) => c.table === "planned_workouts").map((c) => [c.offset, c.rows.length])).toEqual([
      [0, 200],
      [200, 200],
      [400, 50],
    ]);
    // What runRestore will send is exactly what was checked.
    expect(res.checked.pages.filter((p) => p.table === "session_builds").map((p) => p.rows.length)).toEqual(
      heavyPages.map((p) => p.rows.length),
    );
  });
});
