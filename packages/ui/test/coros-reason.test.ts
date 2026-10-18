/**
 * THE SHEET'S SENTENCE ABOUT WHAT COROS HOLDS (review-3, R): a session COROS has never been given said so whatever
 * its sync state, so a just-approved designed run read "Syncing" beside "COROS has never been given it", and a failed
 * create never said it failed. Each state, said for what it is; a dated one as it always was.
 */
import { describe, expect, it } from "vitest";
import { corosReasonSentence } from "../src/screens/plan.js";

const never = (syncView: string) => corosReasonSentence({ syncView, lastVerifiedCorosDate: "", effectiveDate: "2026-10-20" });
const dated = (syncView: string) => corosReasonSentence({ syncView, lastVerifiedCorosDate: "2026-10-19", effectiveDate: "2026-10-20" });

describe("never on the watch", () => {
  it("on its way: said so, not 'never given it'", () => {
    expect(never("syncing")).toBe("On its way to your COROS watch.");
  });
  it("its send failed: said plainly", () => {
    expect(never("sync_issue")).toBe("Sending this to your COROS watch failed. It's in Run Garden and your Google Calendar.");
  });
  it("truly calendar-only (nothing sent, or waiting on a connection): the sentence it always had", () => {
    for (const view of ["calendar_only", "waiting_for_device"]) {
      expect(never(view)).toBe("This lives in Run Garden and your Google Calendar. COROS has never been given it.");
    }
  });
});

describe("on the watch on another day: as it always was", () => {
  it("each dated state names both days or the one COROS still shows", () => {
    expect(dated("needs_attention")).toBe("COROS has this on Monday, October 19; Run Garden has Tuesday, October 20.");
    expect(dated("calendar_only")).toBe("Your COROS watch still has this on Monday, October 19 — this move hasn't been written to COROS.");
    expect(dated("sync_issue")).toBe("The last update to COROS failed — your watch still shows Monday, October 19.");
    expect(dated("syncing")).toBe("COROS still shows Monday, October 19 — the update is on its way.");
  });
});
