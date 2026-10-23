import { isPlyometric, type ExerciseRecord } from "../record.js";
import { ROTATED_OUT_DAYS } from "../targets.js";
import { FORMAT_IDS, MODE_IDS, label, type FormatId, type Mode, type MuscleId } from "../vocab.js";
import type { Attrs, AttributeSpec, CheckReading, ConditionProfile, EntryFlags, HistorySession, ProposalCtx, RuleLine, SessionChecks } from "./types.js";

// TMJ: jaw clenching, neck load, and lying face down. The rules began as the standalone tool's. On 2026-10-23, after an
// evidence review (the BMJ 2023 TMD guideline, OPPERA, systematic reviews) found no published evidence that heavy
// lifting or bracing, overhead pressing, jumping and running, face-down positions or neck loading cause or worsen TMD,
// they were relaxed: a top-clench move is build's, in sets with rest; overhead pressing and jumps need no calm check;
// recovery takes face-down positions (a flare day stays flare-safe); neck and posture care work is never held to the
// neck-load caps; build reads how the jaw answered the last session (a 24-hour response rule); a rotated-out move may
// come back. What the review did support — a soft jaw through effort, neck and posture training, breathing — leads the
// cues and the care block, in calm words. Every threshold is a named constant below, read both by the rules and by
// `describeRules`, so the coach's prompt states what the code does.

const ID = "tmj";
const FLAG = "clenched";
/** A symptom rise this big (post − pre) makes a session rough. */
const SYMPTOM_RISE = 2;
/** A check this high is a flare: the jaw is up today. Recovery and the hold rule draw this line, and build opens below it. */
const HIGH_PRE = 5;
/** The most a flare-safe move may rate. */
const FLARE_SAFE = { clench: 1, neckLoad: 1, faceDown: false } as const;
/**
 * Build's 24-hour response: how much higher than the last session the jaw may be — today's check against that session's
 * before-check, or without today's check, that session's after-check against its before-check.
 */
const BUILD_RESPONSE_MAX = 2;
/** This many flagged moves in the last session call for recovery. */
const RECOVERY_FLAGS = 2;
/** A move flagged in ROTATE_FLAGS of its last ROTATE_WINDOW sessions rotates out. */
const ROTATE_WINDOW = 3;
const ROTATE_FLAGS = 2;
/** The muscle whose work is neck care wherever it sits (chin nods, deep-neck-flexor endurance). */
const NECK_CARE_MUSCLE: MuscleId = "deep-neck-flexors";
/** The cue a top-clench move carries. */
const EFFORT_CUE = "breathe out through the effort, jaw soft";
/** The cue a face-down move carries. */
const FACE_DOWN_CUE = "forehead on stacked hands or a towel — nothing presses on the jaw or cheek";

const ATTRIBUTES: Readonly<Record<string, AttributeSpec>> = {
  clench: { kind: "scale", min: 0, max: 3 },
  neckLoad: { kind: "scale", min: 0, max: 3 },
  faceDown: { kind: "flag" },
};
const CHECK = { label: "Jaw / head", min: 0, max: 10 } as const;
const SET_FLAG = { id: FLAG, label: "Clenched", pastTense: "You clenched" };

interface TmjAttrs {
  clench: number;
  neckLoad: number;
  faceDown: boolean;
}

// A missing or malformed rating reads as the worst case, so an unrated move never looks safe.
function read(a: Attrs | undefined): TmjAttrs {
  const clench = a?.clench, neckLoad = a?.neckLoad, faceDown = a?.faceDown;
  return {
    clench: typeof clench === "number" ? clench : 3,
    neckLoad: typeof neckLoad === "number" ? neckLoad : 3,
    faceDown: typeof faceDown === "boolean" ? faceDown : true,
  };
}

/** A rating the profile can read: every attribute present, a whole number on its scale or a yes/no. */
function readable(a: Attrs | undefined): boolean {
  return Object.entries(ATTRIBUTES).every(([key, spec]) => {
    const v = a?.[key];
    return spec.kind === "scale" ? typeof v === "number" && Number.isInteger(v) && v >= spec.min && v <= spec.max : typeof v === "boolean";
  });
}

const MODE_CAPS: Record<Mode, { clench: number; neckLoad: number; faceDown: boolean }> = {
  recovery: { clench: 1, neckLoad: 1, faceDown: true },
  consistent: { clench: 2, neckLoad: 2, faceDown: true },
  build: { clench: 3, neckLoad: 2, faceDown: true },
};

/** The most clenching each format tolerates: least where the work runs on without rest. */
const FORMAT_CAPS: Record<FormatId, number> = { straight: 3, superset: 3, circuit: 1, ladder: 1, flow: 1, holds: 2 };

const CARE: NonNullable<ConditionProfile["care"]> = {
  block: {
    label: "Jaw care",
    roles: ["jaw-care"],
    formats: ["holds"],
    share: { recovery: 0.27, consistent: 0.1, build: 0.07 },
    min: { recovery: 3, consistent: 1, build: 1 },
    max: { recovery: 6, consistent: 3, build: 3 },
  },
  coverageTargets: { regions: { jaw: 4 } },
};

/**
 * Neck and posture care work — a move the care block takes (its roles), or one working the deep neck flexors (chin nods,
 * deep-neck-flexor endurance): training the neck is the care, so the neck-load caps never hold it back.
 */
function neckCare(ex: ExerciseRecord): boolean {
  const roles: readonly string[] = Array.isArray(ex.roles) ? ex.roles : [];
  const primary: readonly string[] = Array.isArray(ex.muscles?.primary) ? ex.muscles.primary : [];
  return roles.some((r) => (CARE.block.roles as readonly string[]).includes(r)) || primary.includes(NECK_CARE_MUSCLE);
}

const checkOf = (s: SessionChecks | null | undefined): CheckReading | null => (s && s.checks ? s.checks[ID] ?? null : null);
const flagged = (e: EntryFlags | null | undefined): boolean => Boolean(e && Array.isArray(e.flags) && e.flags.includes(FLAG));
const flaggedCount = (s: HistorySession): number => (s.entries || []).filter(e => flagged(e)).length;
const rose = (s: SessionChecks): boolean => {
  const c = checkOf(s);
  return c != null && c.pre != null && c.post != null && c.post - c.pre >= SYMPTOM_RISE;
};

/** Today's jaw level for build: today's check, else how the last session ended. */
function level(ctx: ProposalCtx): number | null {
  if (ctx.reading.pre != null) return ctx.reading.pre;
  const l = checkOf(ctx.last);
  return l ? l.post : null;
}

/**
 * How the jaw answered the last session, for build (null: nothing to compare): with today's check, today against that
 * session's before-check; without it, that session's after-check against its before-check.
 */
function response(ctx: ProposalCtx): { rise: number; today: boolean; from: number; to: number } | null {
  const l = checkOf(ctx.last);
  if (!l || l.pre == null) return null;
  const today = ctx.reading.pre;
  if (today != null) return { rise: today - l.pre, today: true, from: l.pre, to: today };
  return l.post != null ? { rise: l.post - l.pre, today: false, from: l.pre, to: l.post } : null;
}

// ── The rules in words (`describeRules`) ──────────────────────────────────────────────────────────────────────────

const FORMAT_WORDS: Record<FormatId, string> = {
  straight: "straight sets", superset: "supersets", circuit: "circuits", ladder: "ladders", flow: "flows", holds: "holds",
};
/** "a", "a and b", "a, b and c". */
const list = (xs: readonly string[]): string => (xs.length <= 1 ? xs.join("") : `${xs.slice(0, -1).join(", ")} and ${xs[xs.length - 1]}`);
const faceDownWords = (allowed: boolean): string => (allowed ? "face-down allowed" : "no face-down positions");
const caps = (c: { clench: number; neckLoad: number; faceDown: boolean }): string =>
  `clench ≤ ${c.clench}, neckLoad ≤ ${c.neckLoad}, ${faceDownWords(c.faceDown)}`;
const topClench = (): number => Math.max(...FORMAT_IDS.map((f) => FORMAT_CAPS[f]));

/** One line per member the coach needs; the reader says how each member is enforced (`RuleLine`). */
function describeRules(): RuleLine[] {
  const ratings = Object.entries(ATTRIBUTES).map(([key, s]) => (s.kind === "scale" ? `${key} ${s.min}–${s.max}` : `${key} (yes or no)`));
  const formatCaps = new Map<number, FormatId[]>();
  for (const f of FORMAT_IDS) formatCaps.set(FORMAT_CAPS[f], [...(formatCaps.get(FORMAT_CAPS[f]) ?? []), f]);
  const flag = `"${SET_FLAG.label}"`;
  const pct = (share: number): string => `${Math.round(share * 100)}%`;
  const care = CARE.block;
  const careShares = MODE_IDS.map((m, i) =>
    i === 0 ? `${pct(care.share[m])} of a ${m} session (${care.min[m]}–${care.max[m]} moves)` : `${pct(care.share[m])} of a ${m} one (${care.min[m]}–${care.max[m]})`,
  );
  const neckWork = `Neck and posture care work (a "${care.label}" move, or one working the ${label(NECK_CARE_MUSCLE).toLowerCase()}) is never held to the neckLoad caps.`;
  return [
    { rule: "attributes", text: `a move with no rating for this profile. Every library move is rated ${list(ratings)}.` },
    { rule: "never", text: "a move whose rating can't be read — a value missing or off its scale — in every workout." },
    { rule: "allowPattern", text: "overhead pressing (the push-v pattern) in recovery mode." },
    { rule: "allowRecord", text: "plyometric moves (jumps, hops, bounds, landings) in recovery mode or while the athlete feels off." },
    { rule: "fitsMode", text: `a move above its mode's caps: ${MODE_IDS.map((m) => `${m} — ${caps(MODE_CAPS[m])}`).join("; ")}. ${neckWork} Cue a face-down move: ${FACE_DOWN_CUE}.` },
    { rule: "fitsFormat", text: `a move above its format's clench cap: ${[...formatCaps].map(([cap, fs]) => `clench ≤ ${cap} in ${list(fs.map((f) => FORMAT_WORDS[f]))}`).join("; ")}. Cue a clench ${topClench()} move: ${EFFORT_CUE}.` },
    { rule: "flare", text: `on a flare day — a check of ${HIGH_PRE} or more — a move that isn't flare-safe (flare-safe: ${caps(FLARE_SAFE)}).` },
    { rule: "recoveryReason", text: `a mode above recovery when the athlete feels off, today's check is ${HIGH_PRE} or more, the last session's check rose by ${SYMPTOM_RISE} or more, or ${RECOVERY_FLAGS} or more moves were flagged ${flag} last session.` },
    { rule: "buildChecks", text: `build mode, unless both hold: the jaw level — today's check, else how the last session ended — is answered and under ${HIGH_PRE}; and the last session didn't leave it worse — today's check at most ${BUILD_RESPONSE_MAX} above that session's before-check, or without today's check, that session's after-check at most ${BUILD_RESPONSE_MAX} above its before-check.` },
    { rule: "stepDownCause", text: `a move flagged ${flag}, or every move of a session whose check rose by ${SYMPTOM_RISE} or more, steps down next time.` },
    { rule: "holdReason", text: `hold a move rather than progress it when today's check is ${HIGH_PRE} or more, or ${SYMPTOM_RISE} or more above the last session's before-check.` },
    { rule: "rotateReason", text: `a move flagged ${flag} in ${ROTATE_FLAGS} of its last ${ROTATE_WINDOW} sessions rotates out; it may come back ${ROTATED_OUT_DAYS} days after the session that rotated it out.` },
    { rule: "care", text: `a "${care.label}" part in ${list(care.formats)}, about ${careShares.join(", ")}.` },
  ];
}

export const TMJ: ConditionProfile = {
  id: ID,
  label: "TMJ",
  attributes: ATTRIBUTES,
  check: CHECK,
  setFlag: SET_FLAG,

  // Only a rating the profile can't read; every rating on the scale has a mode and a format that take it.
  never: (a) => !readable(a),
  fitsMode(a, mode, ex) {
    const r = read(a);
    const cap = MODE_CAPS[mode];
    if (!cap) return false;
    return r.clench <= cap.clench && (r.neckLoad <= cap.neckLoad || (ex != null && neckCare(ex))) && (!r.faceDown || cap.faceDown);
  },
  fitsFormat: (a, formatId) => read(a).clench <= (FORMAT_CAPS[formatId] ?? -1),
  // Overhead pressing on any day above recovery.
  allowPattern: (pattern, mode) => pattern !== "push-v" || mode !== "recovery",
  // Jumps, hops, bounds and landings on any day above recovery, unless the athlete feels off.
  allowRecord: (ex, mode, today) => !isPlyometric(ex) || (mode !== "recovery" && !today.feelingOff),
  recordReason(ex, mode, today) {
    if (!isPlyometric(ex)) return null;
    if (mode === "recovery") return "Jumps sit out a recovery day.";
    if (today.feelingOff) return "Jumps sit out while you're feeling off.";
    return null;
  },
  // A block's lift plays on consistent days too: a top-clench move (build's only) is never one.
  coreCandidate: (a) => read(a).clench <= 2,
  // Overhead pressing was kept out of blocks only while it was build's alone, behind a calm check: it now plays in every
  // mode a block's lift does.
  blockAssignable: () => true,
  flareSafe(a) {
    const r = read(a);
    return r.clench <= FLARE_SAFE.clench && r.neckLoad <= FLARE_SAFE.neckLoad && (!r.faceDown || FLARE_SAFE.faceDown);
  },
  // The jaw is up today: the line recovery and the hold rule draw.
  flare: (r) => r.pre != null && r.pre >= HIGH_PRE,

  recoveryReason(ctx) {
    const pre = ctx.reading.pre;
    if (ctx.reading.feelingOff) return "You said you're feeling off.";
    if (pre != null && pre >= HIGH_PRE) return `Jaw/head is at ${pre} today — an easy day helps it settle.`;
    const l = checkOf(ctx.last);
    if (l && l.pre != null && l.post != null && l.post - l.pre >= SYMPTOM_RISE) return `Jaw/head went ${l.pre} → ${l.post} last session — an easy day helps it settle.`;
    const clenches = ctx.last ? flaggedCount(ctx.last) : 0;
    if (clenches >= RECOVERY_FLAGS) return `Clenched on ${clenches} lifts last session — an easy day, jaw soft.`;
    return null;
  },
  buildChecks(ctx) {
    const lvl = level(ctx);
    const r = response(ctx);
    return [
      [
        lvl != null && lvl < HIGH_PRE,
        lvl == null ? "Log today's jaw check to open a Develop or Peak day." : `Jaw/head is at ${lvl} — a steady day today; Develop and Peak open below ${HIGH_PRE}.`,
      ],
      [
        r == null || r.rise <= BUILD_RESPONSE_MAX,
        r == null ? "" : r.today ? `Jaw/head is up ${r.rise} since last session — a steady day lets it settle.` : `Jaw/head went ${r.from} → ${r.to} last session — a steady day lets it settle.`,
      ],
    ];
  },
  buildLabel: (ctx) => `Jaw steady (${level(ctx)})`,

  entryClean: (e, s) => !flagged(e) && !rose(s),
  stepDownCause: (e, s) => (flagged(e) ? "flag" : rose(s) ? "symptom" : null),
  holdReason(today, last) {
    if (today.pre == null) return null;
    if (today.pre >= HIGH_PRE) return "Jaw/head is up today — hold this weight, jaw soft.";
    const l = checkOf(last);
    if (l && l.pre != null && today.pre - l.pre >= SYMPTOM_RISE) return "Jaw/head is up on last session — hold this weight today.";
    return null;
  },
  quietPhrase: "with the jaw soft",

  flagPenaltyWeight: 2,
  rotateReason: (log) =>
    log.slice(0, ROTATE_WINDOW).filter(e => flagged(e)).length >= ROTATE_FLAGS ? `clenched in ${ROTATE_FLAGS} of the last ${ROTATE_WINDOW} sessions` : null,
  calmStreakLabel: "calm-jaw",

  care: CARE,
  describeRules,
};
