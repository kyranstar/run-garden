import { describe, expect, it } from "vitest";
import {
  EXERCISES, FORMAT_IDS, MODE_IDS, PROFILES, ROTATED_OUT_DAYS, TMJ,
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
      { rule: "never", text: "a move whose rating can't be read — a value missing or off its scale — in every workout." },
      { rule: "allowPattern", text: "overhead pressing (the push-v pattern) in recovery mode, and in every mode on a flare day — today's check of 5 or more (a day with no check yet stays open)." },
      { rule: "allowRecord", text: "plyometric moves (jumps, hops, bounds, landings) in recovery mode or while the athlete feels off, and in every mode on a flare day — today's check of 5 or more (a day with no check yet stays open)." },
      { rule: "fitsMode", text: "a move above its mode's caps: recovery — clench ≤ 1, neckLoad ≤ 1, face-down allowed; consistent — clench ≤ 2, neckLoad ≤ 2, face-down allowed; build — clench ≤ 3, neckLoad ≤ 2, face-down allowed. Neck and posture care work (a \"Jaw care\" move, or one working the deep neck flexors) is never held to the neckLoad caps. Cue a face-down move: forehead on stacked hands or a towel — nothing presses on the jaw or cheek." },
      { rule: "fitsFormat", text: "a move above its format's clench cap: clench ≤ 3 in straight sets and supersets; clench ≤ 1 in circuits, ladders and flows; clench ≤ 2 in holds. Cue a clench 3 move: breathe out through the effort, jaw soft." },
      { rule: "flare", text: "on a flare day — a check of 5 or more — a move that isn't flare-safe (flare-safe: clench ≤ 1, neckLoad ≤ 1, no face-down positions)." },
      { rule: "recoveryReason", text: "a mode above recovery when the athlete feels off, today's check is 5 or more, the last session's check rose by 2 or more, or 2 or more moves were flagged \"Clenched\" last session." },
      { rule: "buildChecks", text: "build mode, unless both hold: the jaw level — today's check, else how the last session ended — is answered and under 5; and the last session didn't leave it worse — today's check at most 2 above that session's before-check, or without today's check, that session's after-check at most 2 above its before-check." },
      { rule: "stepDownCause", text: "a move flagged \"Clenched\", or every move of a session whose check rose by 2 or more, steps down next time." },
      { rule: "holdReason", text: "hold a move rather than progress it when today's check is 5 or more, or 2 or more above the last session's before-check." },
      { rule: "rotateReason", text: "a move flagged \"Clenched\" in 2 of its last 3 sessions rotates out; it may come back 21 days after the session that rotated it out." },
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

  it("never: no rating on the scale, only one off it", () => {
    for (const c of range(0, 3)) expect(TMJ.never(a(c)), String(c)).toBe(false);
    expect(TMJ.never(a(4))).toBe(true);
    expect(line("never")).toContain("off its scale");
  });

  it("allowPattern and allowRecord: the modes, the day and the flare line that close overhead pressing and jumps", () => {
    const plyo = EXERCISES.find((e) => e.contraction.includes("plyometric"))!;
    const closedIn = (ok: (m: Mode) => boolean): Mode[] => (MODE_IDS as readonly Mode[]).filter((m) => !ok(m));
    // Below the flare line, or with no check yet, only recovery closes them; from the flare line up, every mode does.
    const pressAt = first(range(0, 10), (pre) => !TMJ.allowPattern("push-v", "build", reading(pre)));
    const jumpAt = first(range(0, 10), (pre) => !TMJ.allowRecord!(plyo, "build", reading(pre)));
    expect(pressAt).toBe(first(range(0, 10), (pre) => TMJ.flare(reading(pre))));
    expect(jumpAt).toBe(pressAt);
    for (const pre of [null, ...range(0, 10)]) {
      const closed = pre !== null && pre >= pressAt ? [...MODE_IDS] : ["recovery"];
      expect(closedIn((m) => TMJ.allowPattern("push-v", m, reading(pre))), String(pre)).toEqual(closed);
      expect(closedIn((m) => TMJ.allowRecord!(plyo, m, reading(pre))), String(pre)).toEqual(closed);
    }
    for (const l of [line("allowPattern"), line("allowRecord")]) {
      expect(l).toContain("in recovery mode");
      expect(l).toContain(`in every mode on a flare day — today's check of ${pressAt} or more (a day with no check yet stays open)`);
      expect(l).not.toMatch(/or less/);
    }
    expect(TMJ.allowRecord!(plyo, "build", reading(0, { feelingOff: true }))).toBe(false);
    expect(line("allowRecord")).toContain("feels off");
  });

  it("fitsMode: each mode's caps, the neck-work exemption and the face-down cue", () => {
    for (const mode of MODE_IDS as readonly Mode[]) {
      const clench = last(range(0, 3), (c) => TMJ.fitsMode(a(c), mode));
      const neck = last(range(0, 3), (n) => TMJ.fitsMode(a(0, n), mode));
      const faceDown = TMJ.fitsMode(a(0, 0, true), mode) ? "face-down allowed" : "no face-down positions";
      expect(line("fitsMode"), mode).toContain(`${mode} — clench ≤ ${clench}, neckLoad ≤ ${neck}, ${faceDown}`);
    }
    const neckWork = EXERCISES.find((e) => e.id === "chinNodHold")!;
    expect(TMJ.fitsMode(a(0, 3), "recovery", neckWork)).toBe(true);
    expect(line("fitsMode")).toContain(`(a "${TMJ.care!.block.label}" move, or one working the deep neck flexors) is never held to the neckLoad caps`);
    expect(line("fitsMode")).toContain("forehead on stacked hands or a towel — nothing presses on the jaw or cheek");
  });

  it("fitsFormat: each format's cap, and the cue for a top-clench move", () => {
    const words: Record<FormatId, string> = { straight: "straight sets", superset: "supersets", circuit: "circuits", ladder: "ladders", flow: "flows", holds: "holds" };
    const caps = line("fitsFormat").split(". ")[0]!;
    const segments = caps.replace(/^[^:]*: /, "").replace(/\.$/, "").split("; ");
    for (const f of FORMAT_IDS) {
      const cap = last(range(0, 3), (c) => TMJ.fitsFormat(a(c), f));
      const segment = segments.find((s) => new RegExp(`(in |, | and )${words[f]}(,| and|$)`).test(s));
      expect(segment, f).toBeDefined();
      expect(segment, f).toMatch(new RegExp(`^clench ≤ ${cap} in `));
    }
    const top = last(range(0, 3), (c) => FORMAT_IDS.some((f) => TMJ.fitsFormat(a(c), f)));
    expect(line("fitsFormat")).toContain(`Cue a clench ${top} move: breathe out through the effort, jaw soft.`);
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

  it("buildChecks: the level line, today against the last session, the last session's own rise — and nothing else", () => {
    const text = line("buildChecks");
    const fails = (c: ProposalCtx): boolean => TMJ.buildChecks(c).some(([ok]) => !ok);
    // (a) The level, today's check else the last session's after-check: answered and under the line.
    const level = first(range(0, 10), (lvl) => fails(ctx({ pre: lvl, last: null })));
    expect(level).toBe(first(range(0, 10), (lvl) => fails(ctx({ pre: null, last: session("2026-09-28", { pre: lvl, post: lvl }) }))));
    expect(text).toContain(`is answered and under ${level}`);
    expect(fails(ctx({ pre: null, last: null }))).toBe(true);
    // (b) Today against the last session's before-check; without today's check, that session's own rise.
    const todayRise = last(range(0, 4), (d) => !fails(ctx({ pre: d, last: session("2026-09-28", { pre: 0, post: 0 }) })));
    expect(text).toContain(`today's check at most ${todayRise} above that session's before-check`);
    const ownRise = last(range(0, 4), (r) => !fails(ctx({ pre: null, last: session("2026-09-28", { pre: 0, post: r }) })));
    expect(text).toContain(`that session's after-check at most ${ownRise} above its before-check`);
    // The rules it no longer has: a flare earlier in the week, the week's after-checks, a flagged move last session.
    const lastClean = session("2026-09-28", { pre: 0, post: 0 });
    expect(fails(ctx({ pre: 0, week: [session("2026-09-25", { pre: 9, post: 9 }), lastClean], last: lastClean }))).toBe(false);
    expect(fails(ctx({ pre: 0, last: session("2026-09-28", { pre: 0, post: 0, flagged: 1 }) }))).toBe(false);
    expect(text).not.toMatch(/7 days|averag|flagged/);
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
    // The engine's rest for a rotated-out lift (`Blocks.ensure` reads the same constant).
    expect(line("rotateReason")).toContain(`it may come back ${ROTATED_OUT_DAYS} days after the session that rotated it out`);
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
