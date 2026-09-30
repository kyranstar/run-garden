/**
 * "A restore didn't finish" (audit 1 data finding 8, ruling B2): while the
 * restore marker is set, every screen says so and offers Restore again and
 * Start fresh. The shell carries it on every route but Settings, whose Data
 * card carries it beside the file picker.
 */
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { describe, expect, it } from "vitest";
import { AppShell } from "../src/shell.js";
import { RestorePendingNotice } from "../src/screens/restore-notice.js";

const restore = {
  restoreId: "r1",
  startedAt: "2026-09-30T10:00:00.000Z",
  heartbeatAt: "2026-09-30T10:00:00.000Z",
  running: false,
  fileExportedAt: "2026-09-20T10:00:00.000Z",
  fileExportedFrom: "https://app.test",
};
const running = { ...restore, running: true };

function render(el: React.ReactElement, path = "/"): string {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity, enabled: false } } });
  return renderToStaticMarkup(
    createElement(QueryClientProvider, { client: qc }, createElement(MemoryRouter, { initialEntries: [path] }, el)),
  );
}

describe("RestorePendingNotice", () => {
  it("says a restore didn't finish, with Restore again and Start fresh", () => {
    const html = render(createElement(RestorePendingNotice, { restore, onRestoreAgain: () => undefined }));
    expect(html).toContain("A restore didn&#x27;t finish.");
    expect(html).toContain(">Restore again<");
    expect(html).toContain(">Start fresh<");
    expect(html).toContain('role="alert"');
  });

  it("a restore still running is not 'didn't finish', and offers nothing that would cut it short (B10)", () => {
    const html = render(createElement(RestorePendingNotice, { restore: running, onRestoreAgain: () => undefined }));
    expect(html).toContain("A restore is running — here or on another device.");
    expect(html).not.toContain("didn&#x27;t finish");
    expect(html).not.toContain(">Start fresh<");
    expect(html).not.toContain(">Restore again<");
  });

  it("the device whose own restore just failed may start fresh at once", () => {
    const html = render(createElement(RestorePendingNotice, { restore: running, onRestoreAgain: () => undefined, ownRestoreId: "r1" }));
    expect(html).toContain("A restore didn&#x27;t finish.");
    expect(html).toContain(">Start fresh<");
    const other = render(createElement(RestorePendingNotice, { restore: running, onRestoreAgain: () => undefined, ownRestoreId: "r0" }));
    expect(other).toContain("A restore is running");
  });

  it("renders nothing when no restore is unfinished", () => {
    expect(render(createElement(RestorePendingNotice, { restore: null, onRestoreAgain: () => undefined }))).toBe("");
  });
});

describe("the shell banner", () => {
  it("shows on every screen but Settings while a restore is unfinished", () => {
    for (const path of ["/", "/plan", "/runs"]) {
      expect(render(createElement(AppShell, { restore, children: null }), path), path).toContain("A restore didn&#x27;t finish.");
    }
    expect(render(createElement(AppShell, { restore, children: null }), "/settings")).not.toContain("A restore didn");
    expect(render(createElement(AppShell, { restore: null, children: null }), "/plan")).not.toContain("A restore didn");
    expect(render(createElement(AppShell, { restore: running, children: null }), "/plan")).toContain("A restore is running");
  });
});
