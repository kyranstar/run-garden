import { isPlyometric } from "../record.js";
import { FORMAT_IDS, MODE_IDS, type FormatId, type Mode } from "../vocab.js";
import type { Attrs, AttributeSpec, CheckReading, ConditionProfile, EntryFlags, HistorySession, ProposalCtx, SessionChecks } from "./types.js";

// TMJ: jaw clenching, neck load, and lying face down. The thresholds and every sentence here are the
// standalone tool's, unchanged; the plyometric rule (`allowRecord`) is new with the jumping moves. Every threshold is
// a named constant below, read both by the rules and by `describeRules`, so the coach's prompt states what the code
// does.

const ID = "tmj";
const FLAG = "clenched";
/** A symptom rise this big (post − pre) makes a session rough. */
const SYMPTOM_RISE = 2;
/** A check this high means the jaw is up today. */
const HIGH_PRE = 5;
/** The calm line: jumps and overhead pressing need an answered check at or under it, and so does build. */
const CALM_MAX_PRE = 2;
/** A move rated this much clenching (or more) is never allowed. */
const NEVER_CLENCH = 3;
/** The most a flare-safe move may rate. */
const FLARE_SAFE = { clench: 1, neckLoad: 1, faceDown: false } as const;
/** Build needs the trailing week's after-session checks to average at most this. */
const BUILD_WEEK_POST_MAX = 3;
/** Build needs the last session's rise (post − pre) to be at most this. */
const BUILD_LAST_RISE_MAX = 1;
/** This many flagged moves in the last session call for recovery. */
const RECOVERY_FLAGS = 2;
/** A move flagged in ROTATE_FLAGS of its last ROTATE_WINDOW sessions rotates out. */
const ROTATE_WINDOW = 3;
const ROTATE_FLAGS = 2;

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

const MODE_CAPS: Record<Mode, { clench: number; neckLoad: number; faceDown: boolean }> = {
  recovery: { clench: 1, neckLoad: 1, faceDown: false },
  consistent: { clench: 2, neckLoad: 2, faceDown: true },
  build: { clench: 2, neckLoad: 2, faceDown: true },
};

/** The most clenching each format tolerates. */
const FORMAT_CAPS: Record<FormatId, number> = { straight: 2, superset: 2, circuit: 1, ladder: 1, flow: 1, holds: 2 };

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

const checkOf = (s: SessionChecks | null | undefined): CheckReading | null => (s && s.checks ? s.checks[ID] ?? null : null);
const flagged = (e: EntryFlags | null | undefined): boolean => Boolean(e && Array.isArray(e.flags) && e.flags.includes(FLAG));
const flaggedCount = (s: HistorySession): number => (s.entries || []).filter(e => flagged(e)).length;
const rose = (s: SessionChecks): boolean => {
  const c = checkOf(s);
  return c != null && c.pre != null && c.post != null && c.post - c.pre >= SYMPTOM_RISE;
};
const mean = (xs: number[]): number | null => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);
const calm = (today: CheckReading): boolean => today.pre != null && today.pre <= CALM_MAX_PRE;

/** Today's jaw level for build: today's check, else how the last session ended. */
function level(ctx: ProposalCtx): number | null {
  if (ctx.reading.pre != null) return ctx.reading.pre;
  const l = checkOf(ctx.last);
  return l ? l.post : null;
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

function describeRules(): string[] {
  const ratings = Object.entries(ATTRIBUTES).map(([key, s]) => (s.kind === "scale" ? `${key} ${s.min}–${s.max}` : `${key} (yes or no)`));
  const formatCaps = new Map<number, FormatId[]>();
  for (const f of FORMAT_IDS) formatCaps.set(FORMAT_CAPS[f], [...(formatCaps.get(FORMAT_CAPS[f]) ?? []), f]);
  const flag = `"${SET_FLAG.label}"`;
  const pct = (share: number): string => `${Math.round(share * 100)}%`;
  const care = CARE.block;
  const careShares = MODE_IDS.map((m, i) =>
    i === 0 ? `${pct(care.share[m])} of a ${m} session (${care.min[m]}–${care.max[m]} moves)` : `${pct(care.share[m])} of a ${m} one (${care.min[m]}–${care.max[m]})`,
  );
  const calmWords = `today's check answered at ${CALM_MAX_PRE} or less`;
  return [
    `Ratings: every library move is rated ${list(ratings)}; a move without a rating can't be placed.`,
    `Never: a move rated clench ${NEVER_CLENCH} or more — refused in every workout.`,
    `Overhead pressing (the push-v pattern): only in build mode, and only with ${calmWords} — refused otherwise.`,
    `Plyometric moves (jumps, hops, bounds, landings): never in recovery mode, never while the athlete feels off, otherwise only with ${calmWords} — refused otherwise.`,
    `Mode caps, a cost when exceeded: ${MODE_IDS.map((m) => `${m} — ${caps(MODE_CAPS[m])}`).join("; ")}.`,
    `Format caps, a cost when exceeded: ${[...formatCaps].map(([cap, fs]) => `clench ≤ ${cap} in ${list(fs.map((f) => FORMAT_WORDS[f]))}`).join("; ")}.`,
    `Flare: a check of ${HIGH_PRE} or more. On a flare day keep to flare-safe moves: ${caps(FLARE_SAFE)}.`,
    `Recovery mode is called for (a harder mode is a cost) when the athlete feels off, today's check is ${HIGH_PRE} or more, the last session's check rose by ${SYMPTOM_RISE} or more, or ${RECOVERY_FLAGS} or more moves were flagged ${flag} last session.`,
    `Build mode needs (otherwise it is a cost): a check of ${CALM_MAX_PRE} or less — today's, else how the last session ended; no check of ${HIGH_PRE} or more in the past 7 days, and after-session checks averaging ${BUILD_WEEK_POST_MAX} or less; a clean last session — no move flagged ${flag} and a rise of ${BUILD_LAST_RISE_MAX} or less.`,
    `Progression: a move flagged ${flag}, or every move of a session whose check rose by ${SYMPTOM_RISE} or more, steps down next time; hold rather than progress when today's check is ${HIGH_PRE} or more, or ${SYMPTOM_RISE} or more above the last session's before-check.`,
    `Rotation: a move flagged ${flag} in ${ROTATE_FLAGS} of its last ${ROTATE_WINDOW} sessions rotates out.`,
    `Check: "${CHECK.label}", ${CHECK.min}–${CHECK.max}, before and after a session or on its own; during a session a move can be flagged ${flag}.`,
    `Care: a "${care.label}" part in ${list(care.formats)} — about ${careShares.join(", ")}.`,
  ];
}

export const TMJ: ConditionProfile = {
  id: ID,
  label: "TMJ",
  attributes: ATTRIBUTES,
  check: CHECK,
  setFlag: SET_FLAG,

  never: (a) => read(a).clench >= NEVER_CLENCH,
  fitsMode(a, mode) {
    const r = read(a);
    const cap = MODE_CAPS[mode];
    if (!cap) return false;
    return r.clench <= cap.clench && r.neckLoad <= cap.neckLoad && (!r.faceDown || cap.faceDown);
  },
  fitsFormat: (a, formatId) => read(a).clench <= (FORMAT_CAPS[formatId] ?? -1),
  // Overhead pressing only in build, and only with an answered, calm check.
  allowPattern: (pattern, mode, today) => pattern !== "push-v" || (mode === "build" && calm(today)),
  // Jumps, hops, bounds and landings never in recovery, never when feeling off, and otherwise only with an answered,
  // calm check.
  allowRecord: (ex, mode, today) => !isPlyometric(ex) || (mode !== "recovery" && !today.feelingOff && calm(today)),
  recordReason(ex, mode, today) {
    if (!isPlyometric(ex)) return null;
    if (mode === "recovery") return "No jumps on a recovery day.";
    if (today.feelingOff) return "No jumps while you're feeling off.";
    if (today.pre == null) return "Jumps need a jaw check first.";
    if (today.pre > CALM_MAX_PRE) return `Jumps need a calm jaw (${CALM_MAX_PRE} or less) — you're at ${today.pre}.`;
    return null;
  },
  coreCandidate: (a) => read(a).clench <= 2,
  blockAssignable: (ex) => !ex.patterns.includes("push-v"),
  flareSafe(a) {
    const r = read(a);
    return r.clench <= FLARE_SAFE.clench && r.neckLoad <= FLARE_SAFE.neckLoad && (!r.faceDown || FLARE_SAFE.faceDown);
  },
  // The jaw is up today: the line recovery and the hold rule draw.
  flare: (r) => r.pre != null && r.pre >= HIGH_PRE,

  recoveryReason(ctx) {
    const pre = ctx.reading.pre;
    if (ctx.reading.feelingOff) return "You said you're feeling off.";
    if (pre != null && pre >= HIGH_PRE) return `Jaw/head is at ${pre} right now.`;
    const l = checkOf(ctx.last);
    if (l && l.pre != null && l.post != null && l.post - l.pre >= SYMPTOM_RISE) return `Symptoms rose ${l.pre} → ${l.post} last session.`;
    const clenches = ctx.last ? flaggedCount(ctx.last) : 0;
    if (clenches >= RECOVERY_FLAGS) return `You clenched on ${clenches} lifts last session.`;
    return null;
  },
  buildChecks(ctx) {
    const lvl = level(ctx);
    const l = checkOf(ctx.last);
    const posts = ctx.week.map(s => checkOf(s)?.post).filter((v): v is number => v != null);
    const avgPost = mean(posts);
    const clenches = ctx.last ? flaggedCount(ctx.last) : 0;
    return [
      [lvl != null && lvl <= CALM_MAX_PRE, lvl == null ? "A Develop or Peak day needs a jaw check first." : `A Develop or Peak day needs a calm jaw (${CALM_MAX_PRE} or less) — you're at ${lvl}.`],
      [!ctx.week.some(s => { const c = checkOf(s); return c != null && c.pre != null && c.pre >= HIGH_PRE; }) && (avgPost == null || avgPost <= BUILD_WEEK_POST_MAX), "Your jaw has flared in the last 7 days."],
      [clenches === 0 && !(l && l.pre != null && l.post != null && l.post - l.pre > BUILD_LAST_RISE_MAX), "Last session wasn't clean."],
    ];
  },
  buildLabel: (ctx) => `Jaw calm (${level(ctx)})`,

  entryClean: (e, s) => !flagged(e) && !rose(s),
  stepDownCause: (e, s) => (flagged(e) ? "flag" : rose(s) ? "symptom" : null),
  holdReason(today, last) {
    if (today.pre == null) return null;
    if (today.pre >= HIGH_PRE) return "Jaw/head is up today — hold here and keep it easy.";
    const l = checkOf(last);
    if (l && l.pre != null && today.pre - l.pre >= SYMPTOM_RISE) return "Symptoms are higher than last session — hold here.";
    return null;
  },
  quietPhrase: "with a quiet jaw",

  flagPenaltyWeight: 2,
  rotateReason: (log) =>
    log.slice(0, ROTATE_WINDOW).filter(e => flagged(e)).length >= ROTATE_FLAGS ? `clenched in ${ROTATE_FLAGS} of the last ${ROTATE_WINDOW} sessions` : null,
  calmStreakLabel: "calm-jaw",

  care: CARE,
  describeRules,
};
