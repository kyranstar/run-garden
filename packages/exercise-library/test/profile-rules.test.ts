import { describe, expect, it } from "vitest";
import {
  EXERCISES, FORMAT_IDS, MODE_IDS, PROFILES, TMJ,
  type Attrs, type CheckReading, type DescribedRule, type FormatId, type HistoryEntry, type HistorySession, type Mode, type ProposalCtx,
  type SessionChecks,
} from "../src/index.js";

// A profile's rules, written out for the coach designer's prompt (Stage 3 spec §3): generated from the constants the
// rules themselves read, so the prompt and the code cannot disagree. Every number a TMJ line states is found again
// below by probing the rule it describes.

const a = (clench: number, neckLoad = 0, faceDown = false): Attrs => ({ clench, neckLoad, faceDown });
const reading = (pre: number | null, extra: Partial<CheckReading> = {}): CheckReading => ({ pre, post: null, feelingOff: false, ...extra });
const range = (lo: number, hi: number): number[] => Array.from({ length: hi - lo + 1 }, (_, i) => lo + i);
const first = (xs: number[], ok: (x: number) => boolean): number => xs.find(ok)!;
const last = (xs: number[], ok: (x: number) => boolean): number => Math.max(...xs.filter(ok));

function session(date: string, o: { pre?: number | null; post?: number | null; flagged?: number } = {}): HistorySession {
  return {
    id: `s-${date}`, date, startedAt: `${date}T18:00:00`, mode: null, theme: null, blockNumber: null,
    checks: { tmj: { pre: o.pre === undefined ? 1 : o.pre, post: o.post === undefined ? 1 : o.post, feelingOff: false } },
    done: [],
    entries: Array.from({ length: o.flagged ?? 0 }, (_, i) => ({ id: `e${i}`, implement: null, perSide: false, format: null, flags: ["clenched"], sets: [] })),
  };
}
function ctx(o: { pre?: number | null; feelingOff?: boolean; last?: HistorySession | null; week?: HistorySession[] } = {}): ProposalCtx {
  const lastSession = o.last === undefined ? session("2026-09-28") : o.last;
  const week = o.week ?? (lastSession ? [lastSession] : []);
  return { today: "2026-09-29", reading: reading(o.pre ?? null, { feelingOff: o.feelingOff ?? false }), past: week, last: lastSession, week };
}

describe("describeRules — every profile", () => {
  it.each(Object.values(PROFILES))("$id describes each rule once, in plain sentences, the same every time", (p) => {
    const lines = p.describeRules();
    expect(lines.length).toBeGreaterThan(0);
    expect(new Set(lines.map((l) => l.rule)).size).toBe(lines.length);
    for (const { text } of lines) {
      expect(text.trim(), text).toBe(text);
      expect(text, text).toMatch(/[.]$/);
      expect(text, text).not.toMatch(/\n/);
      // How a rule is enforced is the reader's to say, from where the rule is read — never the line's own words.
      expect(text, text).not.toMatch(/\b(refused|a cost|a guide)\b/i);
    }
    expect(p.describeRules()).toEqual(lines);
  });
});

describe("describeRules — TMJ", () => {
  const lines = TMJ.describeRules();
  const line = (rule: DescribedRule): string => {
    const hit = lines.filter((l) => l.rule === rule);
    expect(hit, rule).toHaveLength(1);
    return hit[0]!.text;
  };

  it("reads, exactly", () => {
    expect(lines).toEqual([
      { rule: "attributes", text: "a move with no rating for this profile. Every library move is rated clench 0–3, neckLoad 0–3 and faceDown (yes or no)." },
      { rule: "never", text: "a move rated clench 3 or more, in every workout." },
      { rule: "allowPattern", text: "overhead pressing (the push-v pattern), except in build mode with today's check answered at 2 or less." },
      { rule: "allowRecord", text: "plyometric moves (jumps, hops, bounds, landings) in recovery mode, while the athlete feels off, or without today's check answered at 2 or less." },
      { rule: "fitsMode", text: "a move above its mode's caps: recovery — clench ≤ 1, neckLoad ≤ 1, no face-down positions; consistent — clench ≤ 2, neckLoad ≤ 2, face-down allowed; build — clench ≤ 2, neckLoad ≤ 2, face-down allowed." },
      { rule: "fitsFormat", text: "a move above its format's clench cap: clench ≤ 2 in straight sets, supersets and holds; clench ≤ 1 in circuits, ladders and flows." },
      { rule: "flare", text: "on a flare day — a check of 5 or more — a move that isn't flare-safe (flare-safe: clench ≤ 1, neckLoad ≤ 1, no face-down positions)." },
      { rule: "recoveryReason", text: "a mode above recovery when the athlete feels off, today's check is 5 or more, the last session's check rose by 2 or more, or 2 or more moves were flagged \"Clenched\" last session." },
      { rule: "buildChecks", text: "build mode, unless all of these hold: a check of 2 or less — today's, else how the last session ended; no check of 5 or more in the past 7 days, and after-session checks averaging 3 or less; a clean last session — no move flagged \"Clenched\" and a rise of 1 or less." },
      { rule: "stepDownCause", text: "a move flagged \"Clenched\", or every move of a session whose check rose by 2 or more, steps down next time." },
      { rule: "holdReason", text: "hold a move rather than progress it when today's check is 5 or more, or 2 or more above the last session's before-check." },
      { rule: "rotateReason", text: "a move flagged \"Clenched\" in 2 of its last 3 sessions rotates out." },
      { rule: "care", text: "a \"Jaw care\" part in holds, about 27% of a recovery session (3–6 moves), 10% of a consistent one (1–3), 7% of a build one (1–3)." },
    ]);
  });

  // Each number the text states is found again by probing the rule it describes: a hand-written line would go stale
  // the day its constant changes; a generated one follows it.
  it("attributes: the profile's own rating scales", () => {
    for (const [key, spec] of Object.entries(TMJ.attributes)) {
      expect(line("attributes")).toContain(spec.kind === "scale" ? `${key} ${spec.min}–${spec.max}` : `${key} (yes or no)`);
    }
  });

  it("never: the clench line the rule draws", () => {
    expect(line("never")).toContain(`clench ${first(range(0, 3), (c) => TMJ.never(a(c)))} or more`);
  });

  it("allowPattern and allowRecord: the calm line overhead pressing and jumps draw", () => {
    const plyo = EXERCISES.find((e) => e.contraction.includes("plyometric"))!;
    expect(line("allowPattern")).toContain(`answered at ${last(range(0, 10), (pre) => TMJ.allowPattern("push-v", "build", reading(pre)))} or less`);
    expect(line("allowRecord")).toContain(`answered at ${last(range(0, 10), (pre) => TMJ.allowRecord!(plyo, "build", reading(pre)))} or less`);
    expect(TMJ.allowPattern("push-v", "consistent", reading(0))).toBe(false);
    expect(TMJ.allowRecord!(plyo, "recovery", reading(0))).toBe(false);
    expect(TMJ.allowRecord!(plyo, "build", reading(0, { feelingOff: true }))).toBe(false);
  });

  it("fitsMode: each mode's caps", () => {
    for (const mode of MODE_IDS as readonly Mode[]) {
      const clench = last(range(0, 3), (c) => TMJ.fitsMode(a(c), mode));
      const neck = last(range(0, 3), (n) => TMJ.fitsMode(a(0, n), mode));
      const faceDown = TMJ.fitsMode(a(0, 0, true), mode) ? "face-down allowed" : "no face-down positions";
      expect(line("fitsMode"), mode).toContain(`${mode} — clench ≤ ${clench}, neckLoad ≤ ${neck}, ${faceDown}`);
    }
  });

  it("fitsFormat: each format's cap", () => {
    const words: Record<FormatId, string> = { straight: "straight sets", superset: "supersets", circuit: "circuits", ladder: "ladders", flow: "flows", holds: "holds" };
    const segments = line("fitsFormat").replace(/^[^:]*: /, "").replace(/\.$/, "").split("; ");
    for (const f of FORMAT_IDS) {
      const cap = last(range(0, 3), (c) => TMJ.fitsFormat(a(c), f));
      const segment = segments.find((s) => new RegExp(`(in |, | and )${words[f]}(,| and|$)`).test(s));
      expect(segment, f).toBeDefined();
      expect(segment, f).toMatch(new RegExp(`^clench ≤ ${cap} in `));
    }
  });

  it("flare: the flare line and the flare-safe caps", () => {
    const flareAt = first(range(0, 10), (pre) => TMJ.flare(reading(pre)));
    const faceDown = TMJ.flareSafe(a(0, 0, true)) ? "face-down allowed" : "no face-down positions";
    expect(line("flare")).toContain(`a check of ${flareAt} or more`);
    expect(line("flare")).toContain(
      `clench ≤ ${last(range(0, 3), (c) => TMJ.flareSafe(a(c)))}, neckLoad ≤ ${last(range(0, 3), (n) => TMJ.flareSafe(a(0, n)))}, ${faceDown}`,
    );
  });

  it("recoveryReason: feeling off, a high check, a rise last session, flagged moves last session", () => {
    const text = line("recoveryReason");
    expect(TMJ.recoveryReason(ctx({ pre: 0, feelingOff: true }))).not.toBeNull();
    expect(text).toContain("feels off");
    expect(text).toContain(`today's check is ${first(range(0, 10), (pre) => TMJ.recoveryReason(ctx({ pre })) !== null)} or more`);
    expect(text).toContain(`rose by ${first(range(0, 10), (r) => TMJ.recoveryReason(ctx({ pre: 0, last: session("2026-09-28", { pre: 0, post: r }) })) !== null)} or more`);
    expect(text).toContain(`${first(range(0, 10), (k) => TMJ.recoveryReason(ctx({ pre: 0, last: session("2026-09-28", { flagged: k }) })) !== null)} or more moves were flagged "${TMJ.setFlag!.label}"`);
  });

  it("buildChecks: the calm level, the flared week, the week's after-checks, a clean last session", () => {
    const text = line("buildChecks");
    const fails = (c: ProposalCtx): boolean => TMJ.buildChecks(c).some(([ok]) => !ok);
    const clean = session("2026-09-28", { pre: 0, post: 0 });
    expect(text).toContain(`a check of ${last(range(0, 10), (lvl) => !fails(ctx({ pre: lvl, last: clean })))} or less`);
    const weekWith = (pre: number) => [session("2026-09-25", { pre, post: 0 }), clean];
    expect(text).toContain(`no check of ${first(range(0, 10), (pre) => fails(ctx({ pre: 0, week: weekWith(pre), last: clean })))} or more in the past 7 days`);
    const weekPost = (post: number) => [session("2026-09-25", { pre: 0, post }), session("2026-09-26", { pre: post, post })];
    expect(text).toContain(`averaging ${last(range(0, 10), (post) => !fails(ctx({ pre: 0, week: weekPost(post), last: clean })))} or less`);
    expect(text).toContain(`a rise of ${last(range(0, 10), (r) => !fails(ctx({ pre: 0, week: [clean], last: session("2026-09-28", { pre: 0, post: r }) })))} or less`);
    expect(fails(ctx({ pre: 0, week: [clean], last: session("2026-09-28", { pre: 0, post: 0, flagged: 1 }) }))).toBe(true);
  });

  it("stepDownCause: the flag and the rise that step a move down", () => {
    const entry: Pick<HistoryEntry, "flags"> = { flags: [] };
    const checks = (pre: number, post: number): SessionChecks => ({ checks: { tmj: { pre, post, feelingOff: false } } });
    expect(TMJ.stepDownCause({ flags: ["clenched"] }, checks(0, 0))).toBe("flag");
    expect(line("stepDownCause")).toContain(`"${TMJ.setFlag!.label}"`);
    expect(line("stepDownCause")).toContain(`rose by ${first(range(0, 10), (r) => TMJ.stepDownCause(entry, checks(0, r)) === "symptom")} or more`);
  });

  it("holdReason: a high check today, or a rise since the last session", () => {
    const lastChecks = (pre: number): SessionChecks => ({ checks: { tmj: { pre, post: pre, feelingOff: false } } });
    expect(line("holdReason")).toContain(`today's check is ${first(range(0, 10), (pre) => TMJ.holdReason(reading(pre), null) !== null)} or more`);
    expect(line("holdReason")).toContain(`${first(range(0, 4), (d) => TMJ.holdReason(reading(d), lastChecks(0)) !== null)} or more above`);
  });

  it("rotateReason: flagged in so many of the last sessions", () => {
    const log = (flaggedAt: number[], n = 8): Array<{ flags: string[] }> => range(0, n - 1).map((i) => ({ flags: flaggedAt.includes(i) ? ["clenched"] : [] }));
    const flags = first(range(1, 6), (k) => TMJ.rotateReason(log(range(0, k - 1))) !== null);
    // The window: the furthest back the last of `flags` consecutive flags can sit and still rotate the move.
    const window = last(range(flags - 1, 7), (end) => TMJ.rotateReason(log(range(end - flags + 1, end))) !== null) + 1;
    expect(line("rotateReason")).toContain(`in ${flags} of its last ${window} sessions`);
  });

  it("care: the care block's label, formats and shares", () => {
    const block = TMJ.care!.block;
    expect(line("care")).toContain(`"${block.label}" part in ${block.formats.join(" and ")}`);
    for (const m of MODE_IDS as readonly Mode[]) {
      expect(line("care"), m).toContain(`${Math.round(block.share[m] * 100)}% of a ${m}`);
      expect(line("care"), m).toContain(`${block.min[m]}–${block.max[m]}`);
    }
  });
});
