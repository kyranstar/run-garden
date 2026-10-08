/**
 * The two notes a sent program session can get (Phase 3 Task 7, spec §4.5): "Changed in COROS — Run Garden kept its
 * version" and "Removed from your watch". Both are dismiss-only: there is nothing to undo — the app kept its version,
 * and a copy removed in COROS is not sent again on its own.
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
  it("say what happened, plainly", () => {
    const html = render([note("watch_copy_changed"), note("watch_copy_removed")]);
    expect(html).toContain("Changed in COROS — Run Garden kept its version");
    expect(html).toContain("Removed from your watch");
  });

  it("are dismiss-only: no Undo, a dismiss button each", () => {
    const html = render([note("watch_copy_changed"), note("watch_copy_removed")]);
    expect(html).not.toContain(">Undo<");
    expect(html.match(/aria-label="Dismiss note"/g)).toHaveLength(2);
  });

  it("leave the other notes' Undo alone", () => {
    expect(render([note("adopted_coros_change", { newDate: "2026-10-11" })])).toContain(">Undo<");
  });
});
