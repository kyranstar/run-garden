/**
 * A kept change says what COROS did. A note whose two days are the same day (posted before the worker stopped writing
 * them) read "Kept your Thu Oct 8 — COROS had moved it to Thu Oct 8": COROS hadn't moved it, so the stack leaves it out.
 */
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { SyncNoteDto } from "@rg/api-client";
import { SyncNotesStack } from "../src/components.js";

const note = (id: string, payload: Record<string, unknown>): SyncNoteDto => ({
  id,
  kind: "kept_local_change",
  workoutId: "w1",
  payload,
  createdAt: "2026-10-08T07:00:00Z",
});

const render = (notes: SyncNoteDto[]): string =>
  renderToStaticMarkup(createElement(SyncNotesStack, { notes, onDismiss: () => {}, onUndo: () => {}, undoPendingId: null, undoErrors: {} }));

describe("SyncNotesStack — kept_local_change", () => {
  it("names both days when COROS moved the session elsewhere", () => {
    const html = render([note("n1", { keptDate: "2026-10-08", displacedDate: "2026-10-09" })]);
    expect(html).toContain("Kept your Thu Oct 8 — COROS had moved it to Fri Oct 9");
  });

  it("leaves out a note whose two days are the same day", () => {
    const html = render([
      note("n1", { keptDate: "2026-10-08", displacedDate: "2026-10-08" }),
      note("n2", { keptDate: "2026-10-08", displacedDate: "2026-10-09" }),
    ]);
    expect(html).not.toContain("moved it to Thu Oct 8");
    expect(html.match(/class="sync-note /g)?.length).toBe(1);
  });
});
