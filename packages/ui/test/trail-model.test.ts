/**
 * ONE IMPORT'S TRAIL, PURE (design 2026-11-05 §3.4; plan Task 13): the account first (where the post came from, what it
 * is, its moves, what the coach did, corrections, one health word), then a section per stage in pipeline order, each
 * with its one-line result, its steps' facts as key: value rows — never a JSON string, nothing cut without "Show all" —
 * and its raw pieces listed by size, read only when opened. Synthetic data only (Zorbex names, made-up creators).
 */
import { describe, expect, it } from "vitest";
import type { ImportTrailDto, TrailEventDto } from "@rg/saves";
import { blobLabel, moveDetail, trailAccount, trailSections, type TrailRow } from "../src/screens/saves/trail-model.js";

// Midday UTC: the same calendar day on any device's clock.
const AT = "2026-11-03T12:00:00.000Z";

let seq = 0;
const ev = (stage: TrailEventDto["stage"], over: Partial<TrailEventDto> = {}): TrailEventDto => ({
  id: `e${++seq}`,
  stage,
  source: "worker",
  status: "ok",
  summary: `${stage} done`,
  detail: null,
  moveId: null,
  model: null,
  promptVersion: null,
  costMicros: null,
  latencyMs: null,
  attempt: null,
  runId: null,
  proposalId: null,
  rebuilt: false,
  blobs: [],
  at: AT,
  ...over,
});

const trail = (over: Partial<ImportTrailDto> = {}, post: Partial<ImportTrailDto["post"]> = {}): ImportTrailDto => ({
  post: {
    id: "p1", source: "instagram", url: "https://example.com/p/k1", title: null, creator: { handle: "maker" }, mediaType: "video",
    postedAt: null, firstSeenAt: AT, status: "matched", origin: "saved", durationSec: null, videoSeen: null, ...post,
  },
  account: {
    kind: "routine",
    summary: "Three slow hip moves for after a run.",
    moves: [
      { position: 0, name: "Zorbex hip lift", outcome: "new", moveId: "myZorbexHipLift1a2b", purpose: "Opens the hips after a run." },
      { position: 1, name: "Zorbex knee sway", outcome: "yours", moveId: "myZorbexKneeSway3c4d", purpose: null },
      { position: 2, name: "90/90 hip switches", outcome: "library", moveId: "hip_switch_90_90", purpose: "Rotation." },
    ],
    health: { status: "ok", line: "Read cleanly" },
  },
  events: [],
  rebuilt: false,
  ...over,
});

const texts = (rows: readonly TrailRow[]) => rows.flatMap((r) => [r.key, r.value, r.full ?? ""]);
const allRows = (dto: ImportTrailDto) => trailSections(dto).flatMap((s) => s.steps.flatMap((st) => st.details.flatMap((d) => d.rows)));

describe("the account (level 1)", () => {
  it("opens with where it came from: From <title or creator> · <source> · <when>", () => {
    expect(trailAccount(trail())[0]).toMatchObject({ kind: "from", text: "From maker · Instagram · Tue 3 Nov" });
    expect(trailAccount(trail({}, { title: "Zorbex hip flow", creator: { handle: "maker", name: "Maker Z" } }))[0]!.text).toBe(
      "From Zorbex hip flow by Maker Z · Instagram · Tue 3 Nov",
    );
    // A pasted YouTube video, with its length.
    expect(trailAccount(trail({}, { source: "youtube", origin: "pasted", durationSec: 754 }))[0]!.text).toBe("From maker · YouTube · 12:34 · pasted Tue 3 Nov");
  });

  it("then what it is — its kind and the reader's summary", () => {
    expect(trailAccount(trail()).find((l) => l.kind === "what")?.text).toBe("A routine: Three slow hip moves for after a run.");
    const bare = trail({ account: { ...trail().account, kind: null, summary: null } });
    expect(trailAccount(bare).find((l) => l.kind === "what")).toBeUndefined();
  });

  it("then the moves, one line each — new, the same as one of yours, or the library's — with the reader's line on what it's for", () => {
    const match = ev("match", {
      detail: { moves: [{ position: 0, name: "Zorbex hip lift" }, { position: 1, name: "Zorbex knee sways" }, { position: 2, name: "Ninety ninety" }] },
    });
    const moves = trailAccount(trail({ events: [match] })).filter((l) => l.kind === "move");
    expect(moves.map((m) => [m.text, m.sub ?? null, m.position])).toEqual([
      ["Zorbex hip lift — new", "Opens the hips after a run.", 0],
      ["Zorbex knee sways — same as your Zorbex knee sway", null, 1],
      ["Ninety ninety — the library's 90/90 hip switches", "Rotation.", 2],
    ]);
    // With no match step to say the post's own words: the move it came out as.
    expect(trailAccount(trail()).filter((l) => l.kind === "move").map((m) => m.text)).toEqual([
      "Zorbex hip lift — new",
      "Zorbex knee sway — already yours",
      "90/90 hip switches — from the library",
    ]);
  });

  it("what the coach did — or that it hasn't looked yet — then corrections, then one health word", () => {
    const lines = trailAccount(trail());
    expect(lines.find((l) => l.kind === "coach")?.text).toBe("The coach hasn't reviewed it yet");
    expect(lines.at(-1)).toMatchObject({ kind: "health", text: "Read cleanly", status: "ok" });

    const coached = trail({
      events: [
        ev("coach", { source: "coach", moveId: "myZorbexHipLift1a2b", summary: "Proposed Zorbex hip lift for Thursday's mobility" }),
        ev("correction", { source: "coach", summary: "Dose fixed: 2×30 s (was 8–12 reps)" }),
      ],
      account: { ...trail().account, health: { status: "warn", line: "The reader couldn't watch the video; it read the transcript only" } },
    });
    const kinds = trailAccount(coached).map((l) => l.kind);
    expect(kinds).toEqual(["from", "what", "move", "move", "move", "coach", "correction", "health"]);
    const more = trailAccount(coached);
    expect(more.find((l) => l.kind === "coach")?.text).toBe("Proposed Zorbex hip lift for Thursday's mobility");
    expect(more.find((l) => l.kind === "correction")?.text).toBe("Dose fixed: 2×30 s (was 8–12 reps)");
    expect(more.at(-1)).toMatchObject({ text: "The reader couldn't watch the video; it read the transcript only", status: "warn" });
  });

  it("a post with no moves has no coach line", () => {
    const none = trail({ account: { ...trail().account, kind: "not_training", summary: null, moves: [] } });
    expect(trailAccount(none).map((l) => l.kind)).toEqual(["from", "what", "health"]);
    expect(trailAccount(none)[1]!.text).toBe("Not training");
  });

  it("a trail rebuilt from what was kept ends by saying so (Review Focus 3)", () => {
    const old = trail({ rebuilt: true, events: [ev("screen", { rebuilt: true, summary: "Kept: a hip routine" })] });
    expect(trailAccount(old).at(-1)).toMatchObject({ kind: "rebuilt", text: "Kept from before the trail: the raw replies weren't kept then." });
  });
});

describe("the stages (level 2)", () => {
  it("one section per stage present, in pipeline order whatever the events' order — read and submit both under Reading", () => {
    const dto = trail({
      events: [
        ev("match"), ev("screen"), ev("submit", { source: "extension" }), ev("extract", { source: "gateway" }),
        ev("read", { source: "instagram" }), ev("save"), ev("choice", { source: "owner" }), ev("batch"), ev("check"),
        ev("correction"), ev("coach", { source: "coach" }),
      ],
    });
    expect(trailSections(dto).map((s) => s.title)).toEqual([
      "Reading", "Screening", "Reading the moves", "Checking the reading", "Matching", "Batch", "Your choices", "Saved", "The coach", "Corrections",
    ]);
    const reading = trailSections(dto)[0]!;
    expect(reading.steps.map((s) => s.summary)).toEqual(["read done", "submit done"]);
  });

  it("a section's result is its step's own line", () => {
    const dto = trail({ events: [ev("screen", { summary: "Kept: a hip routine", detail: { verdict: "training", reason: "a hip routine", stage: "model" } })] });
    expect(trailSections(dto)[0]).toMatchObject({ title: "Screening", result: "Kept: a hip routine", status: "ok" });
  });

  it("reading the moves in two attempts says so, and why the first failed; each attempt keeps its own raw reply", () => {
    const dto = trail({
      events: [
        ev("extract", {
          source: "gateway", status: "fail", attempt: 1, summary: "The reply didn't match the format: moves.0.dose: Required",
          detail: { code: "model_failed", issues: ["moves.0.dose: Required", "moves.1.name: Required"], finishReason: "stop" },
          blobs: [{ id: "b1", kind: "raw_reply", chars: 812 }, { id: "b2", kind: "prompt_user", chars: 3_402 }],
        }),
        ev("extract", {
          source: "gateway", attempt: 2, summary: "Read 3 moves (a routine)", detail: { kind: "routine", moves: 3, finishReason: "stop" },
          blobs: [{ id: "b3", kind: "raw_reply", chars: 12_345 }],
        }),
      ],
    });
    const [s] = trailSections(dto);
    expect(s).toMatchObject({ title: "Reading the moves", result: "2 attempts — the first failed: moves.0.dose: Required", status: "warn" });
    expect(s!.steps.map((st) => st.blobs.map((b) => b.id))).toEqual([["b1", "b2"], ["b3"]]);
  });

  it("every attempt failing says so", () => {
    const fail = (attempt: number, issue: string) =>
      ev("extract", { status: "fail", attempt, summary: `The reply didn't match the format: ${issue}`, detail: { code: "model_failed", issues: [issue] } });
    const [s] = trailSections(trail({ events: [fail(1, "moves: Required"), fail(2, "kind: Invalid")] }));
    expect(s).toMatchObject({ result: "2 attempts — both failed: kind: Invalid", status: "fail" });
  });

  it("several choices: how many, and the latest", () => {
    const dto = trail({ events: [ev("choice", { source: "owner", status: "info", summary: "You edited Zorbex hip lift: name" }), ev("choice", { source: "owner", status: "info", summary: "You chose Fit them in" })] });
    expect(trailSections(dto)[0]).toMatchObject({ title: "Your choices", result: "2 choices — the latest: You chose Fit them in", status: "info" });
  });

  it("a step's facts are rows in words: the decision, then the call — model, prompt, tokens, cost, time, attempt", () => {
    const dto = trail({
      events: [
        ev("screen", {
          source: "gateway", summary: "Kept: a hip routine", model: "google/gemini-3.6-flash", promptVersion: "filter-1", costMicros: 1_200,
          latencyMs: 1_234, detail: { verdict: "training", reason: "a hip routine", stage: "model", tokens: { in: 1_200, out: 80 } },
        }),
      ],
    });
    const step = trailSections(dto)[0]!.steps[0]!;
    const [decision, call] = step.details;
    expect(decision!.rows).toEqual(expect.arrayContaining([
      { key: "Verdict", value: "training" },
      { key: "Why", value: "a hip routine" },
      { key: "Decided by", value: "the model" },
    ]));
    expect(call!.title).toBe("The call");
    expect(call!.rows).toEqual(expect.arrayContaining([
      { key: "Model", value: "google/gemini-3.6-flash" },
      { key: "Prompt", value: "filter-1" },
      { key: "Tokens", value: "1,200 in · 80 out" },
      { key: "Cost", value: "$0.0012" },
      { key: "Time", value: "1.2 s" },
    ]));
  });

  it("matching opens to each move: how it came out, by what, the candidates by name, the judge — never an id", () => {
    const dto = trail({
      events: [
        ev("match", {
          detail: {
            judge: "not_needed",
            moves: [
              {
                position: 1, name: "Zorbex knee sways", outcome: "personal", moveId: "myZorbexKneeSway3c4d", by: "name", confidence: 1,
                candidates: [{ id: "myZorbexKneeSway3c4d", name: "Zorbex knee sway", score: 0.97, kind: "personal" }],
                judge: "not_needed", judgeAnswer: null, like: null, check: false,
              },
            ],
          },
        }),
      ],
    });
    const details = trailSections(dto)[0]!.steps[0]!.details;
    const move = details.find((d) => d.title === "2. Zorbex knee sways")!;
    expect(move.rows).toEqual(expect.arrayContaining([
      { key: "Came out", value: "already yours" },
      { key: "Matched by", value: "its name" },
      { key: "Confidence", value: "100%" },
      { key: "Candidates", value: "Zorbex knee sway (97%, yours)" },
      { key: "Judge", value: "not needed" },
    ]));
    expect(details.flatMap((d) => texts(d.rows)).join("\n")).not.toContain("myZorbex");
  });

  it("an owner's choices name the moves, not their ids", () => {
    const dto = trail({ events: [ev("choice", { source: "owner", status: "info", summary: "You chose Fit them in", detail: { batchId: "bt1", choices: { myZorbexHipLift1a2b: "include" } } })] });
    const rows = allRows(dto);
    expect(rows).toContainEqual({ key: "Choices", value: "Zorbex hip lift: include" });
    expect(texts(rows).join("\n")).not.toContain("bt1");
  });

  it("a value longer than 160 characters is a preview with the whole kept for Show all — nothing cut", () => {
    const long = `${"a slow and careful reason ".repeat(10)}end`;
    const rows = allRows(trail({ events: [ev("screen", { detail: { verdict: "training", reason: long } })] }));
    const why = rows.find((r) => r.key === "Why")!;
    expect(why.value.length).toBeLessThanOrEqual(160);
    expect(why.value.endsWith("…")).toBe(true);
    expect(why.full).toBe(long);
    // A short one is whole, with nothing more to show.
    expect(rows.find((r) => r.key === "Verdict")!.full).toBeUndefined();
  });

  it("detail rows never render a JSON string — a nested object reads as key: value lines", () => {
    const dto = trail({
      events: [
        ev("read", { source: "instagram", detail: { via: "saved_list", extVersion: "1.4.0", page: 2, coverSent: true, mediaCount: 1, extra: { deep: { deeper: 3 }, note: "fine" } } }),
        ev("extract", { detail: { kind: "routine", moves: 3, readFacts: { variantWidth: 720, bytes: 2_400_000, byLink: false, images: 0 }, list: [{ a: 1 }, { b: "two" }] } }),
        ev("check", { detail: { moves: [{ position: 0, name: "Zorbex hip lift", repairs: ["dose.range: set from the text"], problems: [], doseOrigin: "default", evidence: { name: "stated", dose: "inferred" }, confidence: "high" }] } }),
      ],
    });
    const words = allRows(dto).flatMap((r) => [r.value, r.full ?? ""]).join("\n");
    expect(words).not.toMatch(/[{}[\]]/);
    expect(words).not.toContain('":');
    expect(allRows(dto)).toEqual(expect.arrayContaining([
      { key: "How it came", value: "your saved list" },
      { key: "Extra", value: "Deep: deeper 3\nNote: fine" },
      { key: "What was sent", value: "Video size: 720 px wide\nBytes: 2.4 MB\nBy link: no\nImages: 0" },
      { key: "Dose from", value: "a default — the post gave none" },
      { key: "Said in the post", value: "Name: stated\nDose: the reader's guess" },
      { key: "Repairs", value: "dose.range: set from the text" },
    ]));
  });

  it("a detail too long for its event is never its JSON head: it says so, and the whole is one tap down", () => {
    const dto = trail({ events: [ev("match", { detail: { cut: true, head: '{"moves":[{"position":0' }, blobs: [{ id: "bd", kind: "detail", chars: 70_000 }] })] });
    const rows = allRows(dto);
    expect(rows).toEqual([{ key: "Detail", value: "Too long to show here — the whole of it is below" }]);
    expect(trailSections(dto)[0]!.steps[0]!.blobs[0]).toMatchObject({ id: "bd", label: "The whole detail", size: "70,000 characters" });
  });

  it("a rebuilt step says it was rebuilt from what was kept", () => {
    const dto = trail({ rebuilt: true, events: [ev("screen", { id: "rebuilt:screen", rebuilt: true, summary: "Kept: a hip routine", detail: { verdict: "training", reason: "a hip routine", stage: "model" } })] });
    const step = trailSections(dto)[0]!.steps[0]!;
    expect(step.rebuilt).toBe(true);
    expect(step.details[0]!.rows).toContainEqual({ key: "Kept", value: "Rebuilt from what was kept" });
  });
});

describe("the raw pieces (level 3)", () => {
  it("are listed by what they are and their size, with no text in the model — each is read when opened", () => {
    const dto = trail({ events: [ev("extract", { blobs: [{ id: "b1", kind: "raw_reply", chars: 12_345 }, { id: "b2", kind: "prompt_user", chars: 1 }] })] });
    expect(trailSections(dto)[0]!.steps[0]!.blobs).toEqual([
      { id: "b1", kind: "raw_reply", chars: 12_345, label: "The raw reply", size: "12,345 characters" },
      { id: "b2", kind: "prompt_user", chars: 1, label: "The prompt as sent", size: "1 character" },
    ]);
    expect(blobLabel("transcript")).toBe("The transcript");
  });
});

describe("a move's own section (from its account line)", () => {
  it("gathers that move's checks, match and choices", () => {
    const dto = trail({
      events: [
        ev("check", { detail: { moves: [{ position: 0, name: "Zorbex hip lift", repairs: [], doseOrigin: "post", evidence: { name: "stated", dose: "stated" }, confidence: "high" }] } }),
        ev("match", { detail: { moves: [{ position: 0, name: "Zorbex hip lift", outcome: "new", moveId: "myZorbexHipLift1a2b", by: "new", confidence: 0.3, candidates: [], judge: "not_needed", judgeAnswer: null, like: null, check: false }] } }),
        ev("choice", { source: "owner", status: "info", moveId: "myZorbexHipLift1a2b", summary: "You edited Zorbex hip lift: name", detail: { fields: ["name"] } }),
      ],
    });
    const d = moveDetail(dto, 0);
    expect(d.map((x) => x.title)).toEqual(["Checking the reading", "Matching", "Your choices"]);
    expect(d[1]!.rows).toContainEqual({ key: "Came out", value: "a new move" });
    expect(d[2]!.rows).toEqual([{ key: "Tue 3 Nov", value: "You edited Zorbex hip lift: name" }]);
  });
});
