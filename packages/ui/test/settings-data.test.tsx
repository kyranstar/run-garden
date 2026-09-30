/**
 * Settings → Your data (Phase 0 Task 9): "Export everything" and "Restore
 * from file…" sit on the card, and choosing a file leads to a confirm sheet
 * naming the export's date and "Replace everything in this account" — with
 * no request sent before that action is pressed.
 *
 * Static-markup harness like settings.test.tsx: the file is parsed by
 * `readExportFile` (what the card's file input calls), and the confirm step
 * renders from that parse.
 */
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, describe, expect, it, vi } from "vitest";
import { EXPORT_FORMAT, exportFileName, NotAnExportError, readExportFile } from "@rg/api-client";
import { DataSection, RestoreConfirm } from "../src/screens/settings.js";

const noop = () => undefined;

function render(el: React.ReactElement): string {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } });
  return renderToStaticMarkup(createElement(QueryClientProvider, { client: qc }, el));
}

const exportFile = (exportedAt: string) =>
  new File(
    [
      JSON.stringify({
        format: EXPORT_FORMAT,
        schemaVersion: "0022",
        exportedAt,
        tables: { users: [{ id: "u1" }], planned_workouts: [] },
      }),
    ],
    "run-garden-export-2026-03-14.json",
    { type: "application/json" },
  );

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("Settings → Your data", () => {
  it("offers Export everything and Restore from file…", () => {
    const html = render(createElement(DataSection));
    expect(html).toContain("Export everything");
    expect(html).toContain("Restore from file…");
    expect(html).toMatch(/<input[^>]*type="file"/);
    expect(html).toContain("Delete all data");
    // The old plain download link is gone — export is assembled page by page.
    expect(html).not.toContain('href="/api/settings/export"');
  });

  it("choosing a file shows a confirm sheet naming the export date and the replace action, before any request", async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);

    const exportedAt = "2026-03-14T12:00:00.000Z";
    const parsed = await readExportFile(exportFile(exportedAt));
    expect(parsed.exportedAt).toBe(exportedAt);

    const html = render(
      createElement(RestoreConfirm, {
        pending: { file: exportFile(exportedAt), exportedAt: parsed.exportedAt },
        progress: null,
        busy: false,
        error: null,
        onCancel: noop,
        onConfirm: noop,
      }),
    );
    expect(html).toContain("Replace everything in this account");
    expect(html).toMatch(/Exported [A-Za-z]+, March 1[34]/);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("shows restore progress on the sheet", () => {
    const html = render(
      createElement(RestoreConfirm, {
        pending: { file: exportFile("2026-03-14T12:00:00.000Z"), exportedAt: "2026-03-14T12:00:00.000Z" },
        progress: { done: 400, total: 1200, table: "planned_workouts" },
        busy: true,
        error: null,
        onCancel: noop,
        onConfirm: noop,
      }),
    );
    expect(html).toContain("400 of 1,200 rows");
  });

  it("renders nothing until a file is chosen", () => {
    const html = render(
      createElement(RestoreConfirm, {
        pending: null,
        progress: null,
        busy: false,
        error: null,
        onCancel: noop,
        onConfirm: noop,
      }),
    );
    expect(html).toBe("");
  });

  it("refuses a file that is not a Run Garden export", async () => {
    await expect(readExportFile(new File(["{}"], "x.json"))).rejects.toBeInstanceOf(NotAnExportError);
    await expect(readExportFile(new File(["not json"], "x.json"))).rejects.toBeInstanceOf(NotAnExportError);
  });

  it("names the download run-garden-export-YYYY-MM-DD.json", () => {
    expect(exportFileName(new Date(2026, 2, 4, 9, 0))).toBe("run-garden-export-2026-03-04.json");
  });
});
