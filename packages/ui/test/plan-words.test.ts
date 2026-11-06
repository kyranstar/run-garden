/** The words a plan's sheet says of it (plans with a purpose §4.3): pure shaping from a plan summary. Synthetic data. */
import { describe, expect, it, vi } from "vitest";
import type { PlanSummaryDto } from "@rg/api-client";
import { changePlanRequest, courseRowState, planSheetWords, STOP_SENDS_MAX, stopInTurns, stopOutcomeWords } from "../src/screens/plan-words.js";

const plan = (over: Partial<PlanSummaryDto> = {}): PlanSummaryDto => ({
  id: "p1",
  kind: "coach",
  name: "Base",
  purpose: null,
  brief: null,
  onEnd: "ask",
  pausedUntil: null,
  objectiveIds: [],
  status: "active",
  lineKey: null,
  listedAs: null,
  course: null,
  prompt: null,
  ...over,
});

describe("planSheetWords", () => {
  it("says how each ending works, in the athlete's words", () => {
    expect(planSheetWords(plan({ onEnd: "ask" })).ending).toBe("Asks you when it ends");
    expect(planSheetWords(plan({ onEnd: "continue" })).ending).toBe("Continues on its own");
    expect(planSheetWords(plan({ onEnd: "finish" })).ending).toBe("Ends when its sessions do");
  });
  it("carries the purpose, the brief and the pause as written; a blank purpose or brief is none", () => {
    expect(planSheetWords(plan({ purpose: "Keep the habit", brief: "Ten sessions, then easier.", pausedUntil: "2026-12-01" }))).toEqual({
      purpose: "Keep the habit",
      ending: "Asks you when it ends",
      brief: "Ten sessions, then easier.",
      pausedUntil: "2026-12-01",
    });
    expect(planSheetWords(plan({ purpose: "   ", brief: "" }))).toMatchObject({ purpose: null, brief: null });
  });
  it("a stopped plan says neither how it ends nor that it's paused: it has done both", () => {
    expect(planSheetWords(plan({ status: "retired", onEnd: "continue", pausedUntil: "2026-12-01", purpose: "Keep the habit", brief: "Ten sessions." }))).toEqual({
      purpose: "Keep the habit",
      ending: null,
      brief: "Ten sessions.",
      pausedUntil: null,
    });
  });
});

describe("changePlanRequest", () => {
  it("opens the coach with the words written and the rest the athlete's to finish", () => {
    expect(changePlanRequest("Base")).toBe("Change how my Base plan works: ");
  });
});

describe("courseRowState: where a course has got to, in the server's numbers and the definition's words", () => {
  const course = (over: Partial<PlanSummaryDto>): PlanSummaryDto => plan({ kind: "course", ...over });
  it("while it counts them", () => {
    expect(courseRowState(course({ course: { session: 3, of: 10 } }))).toBe("Session 3 of 10");
    // Another course's numbers, not a number kept here.
    expect(courseRowState(course({ course: { session: 2, of: 7 } }))).toBe("Session 2 of 7");
  });
  it("once it doesn't: whatever the definition calls what comes next", () => {
    expect(courseRowState(course({ course: { after: "Open practice" } }))).toBe("Open practice");
    expect(courseRowState(course({ course: { after: "Anything a second course says" } }))).toBe("Anything a second course says");
  });
  it("a stopped one says so, wherever it got to", () => {
    expect(courseRowState(course({ status: "retired", course: { session: 3, of: 10 } }))).toBe("Stopped");
    expect(courseRowState(course({ status: "retired", course: { after: "Open practice" } }))).toBe("Stopped");
  });
  it("one the server can't place says nothing: a definition gone", () => {
    expect(courseRowState(course({ course: null }))).toBe("");
  });
});

describe("stopInTurns: a stop sent until it's done, within a bound", () => {
  const answers = (...steps: Array<{ more: boolean; waiting?: true } | Error>) => {
    const send = vi.fn<() => Promise<{ more: boolean; waiting?: true }>>();
    for (const s of steps) {
      if (s instanceof Error) send.mockRejectedValueOnce(s);
      else send.mockResolvedValueOnce(s);
    }
    return send;
  };

  it("sends again while there's more, and stops when there isn't", async () => {
    const send = answers({ more: true }, { more: true }, { more: false });
    expect(await stopInTurns(send)).toBe("stopped");
    expect(send).toHaveBeenCalledTimes(3);
  });

  it("one send is enough when nothing's left", async () => {
    const send = answers({ more: false });
    expect(await stopInTurns(send)).toBe("stopped");
    expect(send).toHaveBeenCalledTimes(1);
  });

  it("stops early on `waiting`: a resend can't help", async () => {
    const send = answers({ more: true }, { more: true, waiting: true }, { more: false });
    expect(await stopInTurns(send)).toBe("waiting");
    expect(send).toHaveBeenCalledTimes(2);
  });

  it("stops at its bound, whatever's left: the hourly pass finishes it", async () => {
    const send = vi.fn(async () => ({ more: true }));
    expect(await stopInTurns(send)).toBe("left");
    expect(send).toHaveBeenCalledTimes(STOP_SENDS_MAX);
    // Room for a course's sessions ahead: one a request, plus a few.
    expect(STOP_SENDS_MAX).toBe(30);
  });

  it("a failure part way isn't a failure: the first send stopped it, and the rest is the hour's", async () => {
    const send = answers({ more: true }, { more: true }, new Error("offline"));
    expect(await stopInTurns(send)).toBe("left");
    expect(send).toHaveBeenCalledTimes(3);
  });

  it("a failure on the first send is: nothing is known to have stopped", async () => {
    const boom = new Error("offline");
    const send = answers(boom);
    await expect(stopInTurns(send)).rejects.toBe(boom);
    expect(send).toHaveBeenCalledTimes(1);
  });
});

describe("stopOutcomeWords: what a stop says happened", () => {
  it("in plain words, each different", () => {
    expect(stopOutcomeWords("stopped")).toBe("Stopped. Its sessions ahead have come off.");
    expect(stopOutcomeWords("waiting")).toBe("Stopped. A session on its way to your watch comes off once it lands.");
    expect(stopOutcomeWords("left")).toBe("Stopped. The rest comes off by itself.");
  });
});
