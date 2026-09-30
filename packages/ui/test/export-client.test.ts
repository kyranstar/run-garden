/**
 * The export client (audit 1 data finding 4, ruling B5): pages follow the
 * worker's keyset cursor, each table's count is checked against the
 * manifest, a short table is read once more, and the file says which app it
 * came from.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { exportAccountData } from "@rg/api-client";

type Row = Record<string, unknown>;

afterEach(() => {
  vi.unstubAllGlobals();
});

function stubWorker(pages: Record<string, Array<Array<{ rows: Row[]; nextCursor: string | null }>>>, manifest: unknown) {
  const calls: string[] = [];
  const reads: Record<string, number> = {};
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) => {
      calls.push(url);
      if (url === "/api/settings/export/manifest") return new Response(JSON.stringify(manifest));
      const m = /\/api\/settings\/export\/table\/([a-z_]+)(\?after=(.*))?$/.exec(url);
      if (!m) return new Response("{}", { status: 404 });
      const table = m[1]!;
      const attempt = m[3] ? (reads[table] ?? 1) - 1 : (reads[table] = (reads[table] ?? 0) + 1) - 1;
      const pageIndex = m[3] ? Number(decodeURIComponent(m[3]).replace("c", "")) : 0;
      return new Response(JSON.stringify(pages[table]![attempt]![pageIndex]));
    }),
  );
  return calls;
}

describe("exportAccountData", () => {
  it("follows the keyset cursor, re-reads a table that came back short once, and stamps exportedFrom", async () => {
    const calls = stubWorker(
      {
        activities: [
          [
            { rows: [{ id: "a1" }], nextCursor: "c1" },
            { rows: [{ id: "a3" }], nextCursor: null },
          ],
          [
            { rows: [{ id: "a1" }, { id: "a2" }], nextCursor: "c1" },
            { rows: [{ id: "a3" }], nextCursor: null },
          ],
        ],
        garden_state: [[{ rows: [{ userId: "u" }], nextCursor: null }]],
      },
      {
        format: "run-garden-export",
        schemaVersion: "0023",
        exportedFrom: "https://app.test",
        tables: [
          { name: "activities", rows: 3 },
          { name: "garden_state", rows: 1 },
        ],
      },
    );
    const file = await exportAccountData();
    expect(file.exportedFrom).toBe("https://app.test");
    expect(file.tables.activities!.map((r) => r.id)).toEqual(["a1", "a2", "a3"]);
    expect(file.tables.garden_state).toHaveLength(1);
    expect(Object.keys(file.tables)).toEqual(["activities", "garden_state"]);
    expect(calls).toEqual([
      "/api/settings/export/manifest",
      "/api/settings/export/table/activities",
      "/api/settings/export/table/activities?after=c1",
      "/api/settings/export/table/activities",
      "/api/settings/export/table/activities?after=c1",
      "/api/settings/export/table/garden_state",
    ]);
  });
});
