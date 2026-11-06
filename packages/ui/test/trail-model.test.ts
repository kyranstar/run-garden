/**
 * ONE IMPORT'S TRAIL, PURE (design 2026-11-05 §3.4; plan Task 13): the account first (where the post came from, what it
 * is, its moves, what the coach did, corrections, one health word), then a section per stage in pipeline order, each
 * with its one-line result, its steps' facts as key: value rows — never a JSON string, nothing cut without "Show all" —
 * and its raw pieces listed by size, read only when opened. Synthetic data only (Zorbex names, made-up creators).
 */
import { describe, expect, it } from "vitest";
import type { ImportTrailDto, TrailEventDto } from "@rg/saves";
import { blobLabel, moveDetail, readAgainLabel, trailAccount, trailSections, type TrailRow } from "../src/screens/saves/trail-model.js";

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
    expect(lines.find((l) => l.kind === "coach")?.text).toBe("No coach decision on its trail yet");
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
    // REBASED 2026-11-06 (phase 5 backfill; the controller's addition 4): a short label on the page, the words one tap down.
    expect(trailAccount(old).at(-1)).toMatchObject({
      kind: "rebuilt", text: "Rebuilt from what was kept", more: "This post came in before the trail, so its steps are rebuilt from what was kept. The raw replies weren't kept then.",
    });
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
    // REBASED 2026-11-06 (phase 5 backfill): a choice in words.
    expect(rows).toContainEqual({ key: "Choices", value: "Zorbex hip lift: in" });
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
    // REBASED 2026-11-06 (phase 5 backfill): the spec's label, whole (§6.6) — it sits one tap down, in the step.
    expect(step.details[0]!.rows).toContainEqual({ key: "Kept", value: "Rebuilt from what was kept; the raw replies weren't kept then" });
  });
});

describe("the raw pieces (level 3)", () => {
  it("are listed by what they are and their size, with no text in the model — each is read when opened", () => {
    const dto = trail({ events: [ev("extract", { blobs: [{ id: "b1", kind: "raw_reply", chars: 12_345 }, { id: "b2", kind: "prompt_user", chars: 1 }] })] });
    expect(trailSections(dto)[0]!.steps[0]!.blobs).toEqual([
      { id: "b1", kind: "raw_reply", chars: 12_345, label: "The raw reply", size: "12,345 characters" },
      { id: "b2", kind: "prompt_user", chars: 1, label: "The prompt, as the app rebuilt it", size: "1 character" },
    ]);
    expect(blobLabel("transcript")).toBe("The transcript");
  });
  it("calls the prompt 'as sent' only when the extension's hash matched the app's rebuild (final review)", () => {
    const step = (asSent: boolean | null) =>
      trailSections(trail({ events: [ev("extract", { detail: { asSent }, blobs: [{ id: "b2", kind: "prompt_user", chars: 1 }] })] }))[0]!.steps[0]!.blobs[0]!.label;
    expect(step(true)).toBe("The prompt as sent");
    expect(step(false)).toBe("The prompt, as the app rebuilt it");
    expect(step(null)).toBe("The prompt, as the app rebuilt it");
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

describe("a pasted YouTube video's trail (phase 2)", () => {
  const video = (v: Partial<NonNullable<ImportTrailDto["post"]["video"]>> = {}, post: Partial<ImportTrailDto["post"]> = {}) =>
    trail({}, {
      source: "youtube", title: "Zorbex hip flow", durationSec: 2_400, origin: "pasted", ...post,
      video: { watched: false, watchAsked: false, offerWatch: true, watchCostMicros: 185_625, ...v },
    });

  it("a long video read from its words says so and offers Watch it too, with its cost", () => {
    const line = trailAccount(video()).find((l) => l.kind === "video")!;
    expect(line).toMatchObject({ text: "Read from the transcript only (over 20 minutes)", watch: { costMicros: 185_625 } });
  });

  it("asked, it waits for the computer's extension; watched, there is no line", () => {
    expect(trailAccount(video({ watchAsked: true, offerWatch: false, watched: true }, { status: "queued" })).find((l) => l.kind === "video")).toMatchObject({
      text: "Waiting for your computer's extension",
    });
    expect(trailAccount(video({ watched: true, offerWatch: false }, { durationSec: 600 })).some((l) => l.kind === "video")).toBe(false);
  });

  it("a move's own section says when the post says to use it or not, why, and each quote with how it checked out", () => {
    const dto = trail();
    dto.account.moves[0] = {
      ...dto.account.moves[0]!,
      why: "Opens stiff hips",
      useWhen: [{ text: "After easy runs", evidence: "stated" }],
      skipWhen: [{ text: "With a sore knee", evidence: "inferred" }],
      quotes: [
        { field: "dose", text: "ten each side", at: 72, from: "transcript", check: "verified" },
        { field: "why", text: "keeps the knees happy", from: "speech", check: "in_speech" },
        { field: "purpose", text: "cures back pain", from: "caption", check: "not_found" },
      ],
    };
    const said = moveDetail(dto, 0).find((d) => d.title === "What the post says")!;
    expect(said.rows).toEqual([
      { key: "Why", value: "Opens stiff hips" },
      { key: "Use when", value: "After easy runs" },
      { key: "Skip when", value: "With a sore knee (the reader's guess)" },
      { key: "Dose · 1:12", value: "“ten each side” — in the words" },
      { key: "Why", value: "“keeps the knees happy” — what the reader heard in the video" },
      { key: "Purpose", value: "“cures back pain” — the reader quoted words that aren't in the post", struck: true },
    ]);
  });

  it("a reading's step says whether the video was watched and how its quotes checked out; the check step what it left out", () => {
    const dto = trail({
      events: [
        ev("extract", { detail: { kind: "routine", moves: 1, watched: false, videoSeen: null, quotes: { verified: 2, in_speech: 1, not_found: 1 } } }),
        ev("check", { status: "warn", detail: { moves: [], dropped: [{ move: 0, field: "regions", values: ["forearmz"] }] } }),
        ev("read", { source: "youtube", detail: { via: "pasted", youtube: { captions: { lang: "en", kind: "auto" }, segments: 27, transcriptChars: 900, chapters: 3, chaptersFrom: "description", via: "captured", ms: 8_000 } } }),
      ],
    });
    const rows = (stage: string) => trailSections(dto).find((s) => s.stage === stage)!.steps[0]!.details.flatMap((d) => d.rows);
    expect(rows("extract")).toEqual(expect.arrayContaining([
      { key: "Watched", value: "no — over 20 minutes, read from its words" },
      { key: "Quotes", value: "2 in the words · 1 heard by the reader · 1 not in the post" },
    ]));
    expect(rows("check")).toContainEqual({ key: "Left out", value: "Zorbex hip lift: regions — forearmz" });
    const row = rows("read").find((r) => r.key === "The video")!;
    const read = row.full ?? row.value;
    expect(read).toContain("Captions: auto-generated (en)");
    expect(read).toContain("Transcript from: the player's own captions");
    expect(read).toContain("Chapters from: the description");
  });
});

describe("a quote shown on screen (final audit G7)", () => {
  it("reads as the screen's, unchecked — never struck, never as heard", () => {
    const dto = trail();
    dto.account.moves[0] = { ...dto.account.moves[0]!, quotes: [{ field: "dose", text: "3 rounds of 10", from: "screen", check: "on_screen" }] };
    const said = moveDetail(dto, 0).find((d) => d.title === "What the post says")!;
    expect(said.rows).toEqual([{ key: "Dose", value: "“3 rounds of 10” — shown on screen in the video (the app can't check it)" }]);
    const rows = trailSections(trail({ events: [ev("check", { detail: { moves: [], quotes: { verified: 1, in_speech: 0, on_screen: 2, not_found: 0 } } })] }))
      .find((s) => s.stage === "check")!.steps[0]!.details.flatMap((d) => d.rows);
    expect(rows).toContainEqual({ key: "Quotes", value: "1 in the words · 2 shown on screen" });
  });
});

describe("a transcript blob as the trail shows it (final audit G20)", () => {
  it("each line with its [m:ss] clock, never the stored seconds and tab", async () => {
    const { blobDisplayText } = await import("../src/screens/saves/trail-model.js");
    expect(blobDisplayText("transcript", "12.3\tZorbex warm-up\n75\tnext move")).toBe("[0:12] Zorbex warm-up\n[1:15] next move");
    expect(blobDisplayText("raw_reply", "12.3\tkept as is")).toBe("12.3\tkept as is");
  });
});

describe("the coach's word on the trail (the controller's fix pass, E14, E15, E19)", () => {
  const LIFT = "myZorbexHipLift1a2b";
  const line = (summary: string, at: string) => ev("coach", { source: "coach", moveId: LIFT, summary, at, detail: { verdict: "suggested", decision: "in", where: "joins your rotation", dose: null, text: "For stiff hips.", cites: [] } });
  const fix = (summary: string, at: string) => ev("coach", { source: "coach", moveId: LIFT, summary, at, detail: { verdict: "suggested", correction: "fix-move-x-dose" } });
  const read = (at: string) => ev("coach", { source: "coach", moveId: null, summary: "The coach read this post", at, detail: { runId: `run-${at}` } });

  it("E14: a correction's row never hides the move's in/out — the move's line is its latest decision; the correction is its own", () => {
    const lines = trailAccount(trail({ events: [line("The coach suggested it — in · joins your rotation", "2026-11-03T10:00:00.000Z"), fix("The coach suggested a correction — Dose of Zorbex hip lift", "2026-11-03T10:00:00.000Z")] }));
    const coach = lines.filter((l) => l.kind === "coach").map((l) => l.text);
    expect(coach).toContain("The coach suggested it — in · joins your rotation");
    expect(coach).toContain("The coach suggested a correction — Dose of Zorbex hip lift");
  });

  it("E15: the coach's reads of the post are one line, the latest", () => {
    const lines = trailAccount(trail({ events: [read("2026-11-03T10:00:00.000Z"), read("2026-11-03T11:00:00.000Z"), read("2026-11-03T12:00:00.000Z"), line("The coach suggested it — in", "2026-11-03T12:00:00.000Z")] }));
    expect(lines.filter((l) => l.kind === "coach" && l.text === "The coach read this post")).toHaveLength(1);
  });

  it("E19: a step's cites read as their chips' words, and the ids it corrects stay quiet", () => {
    const sections = trailSections(trail({
      events: [
        ev("coach", { source: "coach", moveId: LIFT, summary: "The coach suggested it", detail: { verdict: "suggested", decision: "in", text: "For stiff hips.", cites: [{ id: "q1.1", kind: "quote", label: "said 1:12", postId: "post-1", position: 0, quote: 0 }, { id: "history", kind: "history", label: "your history" }] } }),
        ev("correction", { source: "coach", summary: "Dose fixed", detail: { target: "move", targetId: LIFT, field: "dose", before: null, after: null, basis: "evidence", cites: [{ id: "q1.1", kind: "quote", label: "said 1:12", postId: "post-1", position: 0, quote: 0 }], by: "coach" } }),
      ],
    }));
    const rows = sections.flatMap((s) => s.steps.flatMap((st) => st.details.flatMap((d) => d.rows)));
    const words = rows.map((r) => `${r.key}: ${r.value}`).join("\n");
    expect(words).toContain("Evidence: said 1:12, your history");
    expect(words).not.toMatch(/kind quote|post id|position 0|label said/);
    expect(words).not.toContain(LIFT);
  });
});

describe("an old post's rebuilt trail reads in words (phase 5a, §6.6)", () => {
  // Midday UTC: the same calendar day on any device's clock.
  const CAPTURED = "2026-10-24T12:00:00.000Z";
  const SAVED = "2026-10-26T12:00:00.000Z";
  const r = (stage: TrailEventDto["stage"], summary: string, detail: unknown, at = "", over: Partial<TrailEventDto> = {}) =>
    ev(stage, { id: `rebuilt:${stage}`, rebuilt: true, summary, detail, at, ...over });
  const OLD = trail({
    rebuilt: true,
    events: [
      r("submit", "Found by the extension", { source: "instagram", creator: "Zorbex Coach (zorbex.coach)", mediaType: "video", captured: CAPTURED, posted: "2026-10-20T12:00:00.000Z" }, CAPTURED, { source: "extension" }),
      r("screen", "Kept: a hip mobility routine", { verdict: "training", reason: "a hip mobility routine", stage: "model" }),
      r("extract", "Read 2 moves (a routine)", {
        kind: "routine",
        moves: [
          { position: 0, name: "Zorbex hip lift", dose: "2x30s", purpose: "Opens the hips after a run", evidence: { name: "stated", dose: "inferred", steps: "stated" }, confidence: "high" },
          { position: 1, name: "Zorbex knee sways", dose: null, purpose: null, evidence: null, confidence: "medium" },
        ],
        notes: ["Do these after easy runs, not hard ones"],
      }),
      r("match", "2 moves: 2 already yours — 1 to check, 1 left out", {
        moves: [
          { position: 0, name: "Zorbex hip lift", outcome: "personal", moveId: "myZorbexHipLift1a2b", check: true, like: { id: "myZorbexHipRaise004", name: "Zorbex hip raise" }, now: "saved", confidence: 1 },
          { position: 1, name: "Zorbex knee sways", outcome: "personal", moveId: "myZorbexKneeSway3c4d", check: false, mergedInto: { id: "myZorbexKneeSwing03", name: "Zorbex knee swing" }, now: "removed", confidence: 0.6 },
        ],
      }, "2026-10-24T12:01:00.000Z"),
      r("batch", "Joined a batch — saved and fitted in", { batchId: "batch-old", batch: "saved and fitted in", theme: "Hips" }, "2026-10-25T12:00:00.000Z", { status: "info" }),
      r("choice", "You had it read anyway; your choices: 1 in, 1 edited", { post: "read anyway", choices: { myZorbexHipLift1a2b: "include" }, edited: ["Zorbex hip lift"] }, SAVED, { source: "owner", status: "info" }),
      r("save", "Saved: 1 move joined your library", { moves: [{ position: 0, name: "Zorbex hip lift", note: "Opens the hips after a run" }] }, SAVED),
    ],
  });
  const sectionRows = (dto: ImportTrailDto, stage: string) =>
    trailSections(dto).find((s) => s.stage === stage)!.steps.flatMap((st) => st.details.flatMap((d) => d.rows.map((row) => [d.title, row.key, row.value])));

  it("never a raw key, a JSON fragment or a stored timestamp — every rebuilt detail is words", () => {
    const words = texts(allRows(OLD)).join("\n");
    expect(words).not.toMatch(/[{}"]|\d{4}-\d{2}-\d{2}T/);
    for (const key of ["mergedInto", "Merged into:", "now", "captured", "posted", "notes", "edited", "batchId", "include", "personal", "inferred"]) {
      expect(words.split("\n")).not.toContain(key);
    }
    expect(words).not.toMatch(/\b(mergedInto|batchId|moveId|myZorbex\w+)\b/);
  });

  it("where it came from: the source, the creator, the media, when it was captured and posted", () => {
    expect(sectionRows(OLD, "read")).toEqual(expect.arrayContaining([
      [null, "Source", "Instagram"], [null, "Creator", "Zorbex Coach (zorbex.coach)"], [null, "Media", "video"],
      [null, "Captured", "Sat 24 Oct"], [null, "Posted", "Tue 20 Oct"],
    ]));
  });

  it("the reading: each move under its name — its dose words, what it's for, what it stated or guessed — and the post's notes", () => {
    const rows = sectionRows(OLD, "extract");
    expect(rows).toEqual(expect.arrayContaining([
      [null, "Kind", "a routine"],
      [null, "Notes", "Do these after easy runs, not hard ones"],
      ["1. Zorbex hip lift", "Dose", "2x30s"],
      ["1. Zorbex hip lift", "Purpose", "Opens the hips after a run"],
      ["1. Zorbex hip lift", "Said in the post", "Name: stated\nDose: the reader's guess\nSteps: stated"],
      ["1. Zorbex hip lift", "Confidence", "high"],
      ["2. Zorbex knee sways", "Confidence", "medium"],
    ]));
  });

  it("links and their flags: check this, looks like, merged into, saved or left out", () => {
    expect(sectionRows(OLD, "match")).toEqual(expect.arrayContaining([
      ["1. Zorbex hip lift", "Came out", "already yours"],
      ["1. Zorbex hip lift", "Check this", "yes"],
      ["1. Zorbex hip lift", "Looks like", "Zorbex hip raise"],
      ["1. Zorbex hip lift", "Now", "saved to your library"],
      ["2. Zorbex knee sways", "Merged into", "Zorbex knee swing"],
      ["2. Zorbex knee sways", "Now", "left out"],
    ]));
  });

  it("the batch, the owner's choices and what was saved, in words", () => {
    expect(sectionRows(OLD, "batch")).toEqual(expect.arrayContaining([[null, "Now", "saved and fitted in"], [null, "Theme", "Hips"]]));
    expect(sectionRows(OLD, "choice")).toEqual(expect.arrayContaining([
      [null, "The post", "you had it read anyway"], [null, "Choices", "Zorbex hip lift: in"], [null, "Edited", "Zorbex hip lift"],
    ]));
    expect(sectionRows(OLD, "save")).toEqual(expect.arrayContaining([["1. Zorbex hip lift", "Note", "Opens the hips after a run"]]));
  });

  it("each section of rebuilt steps is marked rebuilt, and a step kept with no time shows none", () => {
    const sections = trailSections(OLD);
    expect(sections.every((s) => s.rebuilt)).toBe(true);
    expect(sections.find((s) => s.stage === "screen")!.steps[0]!.when).toBe("");
    expect(sections.find((s) => s.stage === "read")!.steps[0]!.when).toMatch(/^Sat 24 Oct, /);
    // A section the trail recorded itself is not.
    expect(trailSections(trail({ events: [ev("save", { summary: "Saved" })] }))[0]!.rebuilt).toBe(false);
  });

  it("the coach's line says its decisions from before the trail weren't kept (the controller's addition 1)", () => {
    expect(trailAccount(OLD).find((l) => l.kind === "coach")?.text).toBe("Decisions from before the trail weren't kept");
    expect(trailAccount(trail()).find((l) => l.kind === "coach")?.text).toBe("No coach decision on its trail yet");
  });
});

describe("a filtered post says why at the top, with Import anyway (the controller's addition 3)", () => {
  const why = "3 earlier posts from this creator were all not training";
  const filtered = (rebuilt: boolean) =>
    trail(
      {
        rebuilt,
        account: { kind: null, summary: null, moves: [], health: { status: "ok", line: "Read cleanly" } },
        events: [ev("screen", { rebuilt, summary: `Not training: ${why}`, detail: { verdict: "not", reason: why, stage: "creator" } })],
      },
      { status: "filtered_out" },
    );
  it("new and rebuilt alike: 'Not training: <why>' above the health word, offering Import anyway", () => {
    for (const dto of [filtered(false), filtered(true)]) {
      const lines = trailAccount(dto);
      const screen = lines.find((l) => l.kind === "screen")!;
      expect(screen).toMatchObject({ text: `Not training: ${why}`, importAnyway: true });
      expect(lines.indexOf(screen)).toBeLessThan(lines.findIndex((l) => l.kind === "health"));
    }
  });
  it("a post that isn't filtered out has no such line", () => {
    const read = trail({ events: [ev("screen", { summary: "Kept: a routine", detail: { verdict: "training", reason: "a routine", stage: "model" } })] });
    expect(trailAccount(read).some((l) => l.kind === "screen")).toBe(false);
  });
});

describe("Read it again on an old post's trail (phase 5a)", () => {
  const old = (readAgain: ImportTrailDto["post"]["readAgain"], status = "matched") =>
    trail({ rebuilt: true, events: [ev("screen", { rebuilt: true, summary: "Kept: a hip routine" })] }, { readAgain, status });
  it("is offered beside the rebuilt label, its price said before the tap", () => {
    const line = trailAccount(old({ offer: true, asked: false, costMicros: 11_400 })).find((l) => l.kind === "rebuilt")!;
    expect(line.again).toEqual({ costMicros: 11_400 });
    expect(line.waiting).toBeUndefined();
    expect(readAgainLabel(11_400)).toBe("Read it again (about $0.01)");
    expect(readAgainLabel(3_000)).toBe("Read it again (under $0.01)");
    expect(readAgainLabel(null)).toBe("Read it again");
  });
  it("asked, it waits for the computer's extension; not offered, nothing", () => {
    expect(trailAccount(old({ offer: false, asked: true, costMicros: 11_400 }, "queued")).find((l) => l.kind === "rebuilt")).toMatchObject({ waiting: true });
    const none = trailAccount(old(null)).find((l) => l.kind === "rebuilt")!;
    expect(none.again).toBeUndefined();
    expect(none.waiting).toBeUndefined();
  });
  it("a re-read's steps say what they did, in words: lined up, kept as linked, or the earlier reading kept and why", () => {
    const dto = trail({
      events: [
        ev("extract", { summary: "Read 3 moves (a routine) — read again, lined up with the 2 moves it had", detail: { kind: "routine", moves: 3, reread: { kept: 2, added: [2] } } }),
        ev("match", { detail: { moves: [{ position: 0, name: "Zorbex hip lift", outcome: "personal", moveId: "myZorbexHipLift1a2b", by: "kept", check: false }] } }),
      ],
    });
    const rows = allRows(dto).map((r) => [r.key, r.value]);
    expect(rows).toContainEqual(["Read again", "lined up with the 2 moves it had; 1 new"]);
    expect(rows).toContainEqual(["Matched by", "kept as it was — the post already linked it"]);
    const declined = trail({
      events: [ev("extract", { status: "warn", detail: { kind: "routine", moves: 2, kept: "earlier", missing: ["Zorbex knee sways"] } })],
    });
    const words = allRows(declined).map((r) => [r.key, r.value]);
    expect(words).toContainEqual(["Kept", "the earlier reading: this one didn't line up with the moves it had"]);
    expect(words).toContainEqual(["Not in it", "Zorbex knee sways"]);
  });
});

describe("a dose the reader guessed (audit 2026-11-06, I9)", () => {
  it("is labelled the reader's guess, never the post", () => {
    const dto = trail({
      events: [
        ev("check", { detail: { moves: [{ position: 0, name: "Zorbex hip lift", repairs: [], doseOrigin: "reader's guess", evidence: { name: "stated", dose: "inferred" }, confidence: "high" }] } }),
      ],
    });
    const rows = moveDetail(dto, 0)[0]!.rows;
    expect(rows).toContainEqual({ key: "Dose from", value: "the reader's guess — the post never says" });
  });
});
