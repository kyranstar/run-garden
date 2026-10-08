/**
 * The three notes a sent program session can get (Phase 3 Task 7, spec §4.5; ruling 3-R15): "Changed in COROS — Run
 * Garden kept its version", "Removed from your watch" and "Moved to … on your watch". All are dismiss-only: there is
 * nothing to undo — the app kept its version, a copy removed in COROS is not sent again on its own, and moving a sent
 * session back would take its copy off the watch.
 */
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { SyncNoteDto } from "@rg/api-client";
import { SyncNotesStack } from "../src/components.js";

const note = (kind: SyncNoteDto["kind"], payload: Record<string, unknown> = {}): SyncNoteDto => ({
  id: `n-${kind}`,
  kind,
  workoutId: "slot-1",
  payload,
  createdAt: "2026-10-09T19:00:00.000Z",
});

const render = (notes: SyncNoteDto[]) =>
  renderToStaticMarkup(createElement(SyncNotesStack, { notes, onDismiss: () => undefined, onUndo: () => undefined }));

describe("the watch notes", () => {
  const moved = () => note("watch_copy_moved", { previousDate: "2026-10-09", newDate: "2026-10-10" });

  it("say what happened, plainly", () => {
    const html = render([note("watch_copy_changed"), note("watch_copy_removed"), moved()]);
    expect(html).toContain("Changed in COROS — Run Garden kept its version");
    expect(html).toContain("Removed from your watch");
    expect(html).toContain("Moved to Sat Oct 10 on your watch");
  });

  it("are dismiss-only: no Undo, a dismiss button each", () => {
    const html = render([note("watch_copy_changed"), note("watch_copy_removed"), moved()]);
    expect(html).not.toContain(">Undo<");
    expect(html.match(/aria-label="Dismiss note"/g)).toHaveLength(3);
  });

  it("leave the other notes' Undo alone", () => {
    expect(render([note("adopted_coros_change", { newDate: "2026-10-11" })])).toContain(">Undo<");
  });
});
