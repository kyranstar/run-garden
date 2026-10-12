/**
 * The sync line names a partial COROS read as what it is (Task 11, fix round 3): the read worked and some workouts
 * from it could not be saved — not an outage, not a clean sync.
 */
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { SyncStatusDto } from "@rg/api-client";
import { SyncStatusLine } from "../src/components.js";

const status = (error: string | null): SyncStatusDto => ({
  state: "in_sync",
  pendingCount: 0,
  issueCount: 0,
  lastCorosReadAt: null,
  writesEnabled: true,
  registered: true,
  cloud: { connected: true, lastSyncAt: "2026-10-11T10:00:00.000Z", error },
});

const line = (error: string | null) => renderToStaticMarkup(createElement(SyncStatusLine, { status: status(error) }));

describe("the sync line", () => {
  it("a partial read says some workouts could not be saved, not that COROS is unreachable", () => {
    expect(line("partial_import")).toContain("Some COROS workouts couldn&#x27;t be saved — retrying");
    expect(line("partial_import")).not.toContain("unreachable");
  });

  it("a read that failed is still COROS unreachable, and a clean one synced", () => {
    expect(line("api_error")).toContain("COROS unreachable — retrying");
    expect(line(null)).toContain("Synced with COROS");
  });
});
