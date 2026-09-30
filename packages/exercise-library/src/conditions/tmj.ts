import type { FormatId, Mode } from "../vocab.js";
import type { Attrs, CheckReading, ConditionProfile, EntryFlags, HistorySession, ProposalCtx, SessionChecks } from "./types.js";

// TMJ: jaw clenching, neck load, and lying face down. The thresholds and every sentence here are the
// standalone tool's, unchanged.

const ID = "tmj";
const FLAG = "clenched";
/** A symptom rise this big (post − pre) makes a session rough. */
const SYMPTOM_RISE = 2;
/** A check this high means the jaw is up today. */
const HIGH_PRE = 5;

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

const checkOf = (s: SessionChecks | null | undefined): CheckReading | null => (s && s.checks ? s.checks[ID] ?? null : null);
const flagged = (e: EntryFlags | null | undefined): boolean => Boolean(e && Array.isArray(e.flags) && e.flags.includes(FLAG));
const flaggedCount = (s: HistorySession): number => (s.entries || []).filter(e => flagged(e)).length;
const rose = (s: SessionChecks): boolean => {
  const c = checkOf(s);
  return c != null && c.pre != null && c.post != null && c.post - c.pre >= SYMPTOM_RISE;
};
const mean = (xs: number[]): number | null => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);

/** Today's jaw level for build: today's check, else how the last session ended. */
function level(ctx: ProposalCtx): number | null {
  if (ctx.reading.pre != null) return ctx.reading.pre;
  const l = checkOf(ctx.last);
  return l ? l.post : null;
}

export const TMJ: ConditionProfile = {
  id: ID,
  label: "TMJ",
  attributes: {
    clench: { kind: "scale", min: 0, max: 3 },
    neckLoad: { kind: "scale", min: 0, max: 3 },
    faceDown: { kind: "flag" },
  },
  check: { label: "Jaw / head", min: 0, max: 10 },
  setFlag: { id: FLAG, label: "Clenched", pastTense: "You clenched" },

  never: (a) => read(a).clench >= 3,
  fitsMode(a, mode) {
    const r = read(a);
    const cap = MODE_CAPS[mode];
    if (!cap) return false;
    return r.clench <= cap.clench && r.neckLoad <= cap.neckLoad && (!r.faceDown || cap.faceDown);
  },
  fitsFormat: (a, formatId) => read(a).clench <= (FORMAT_CAPS[formatId] ?? -1),
  // Overhead pressing only in build, and only with an answered, calm check.
  allowPattern: (pattern, mode, today) => pattern !== "push-v" || (mode === "build" && today.pre != null && today.pre <= 2),
  coreCandidate: (a) => read(a).clench <= 2,
  blockAssignable: (ex) => !ex.patterns.includes("push-v"),
  flareSafe(a) {
    const r = read(a);
    return r.clench <= 1 && r.neckLoad <= 1 && !r.faceDown;
  },

  recoveryReason(ctx) {
    const pre = ctx.reading.pre;
    if (ctx.reading.feelingOff) return "You said you're feeling off.";
    if (pre != null && pre >= HIGH_PRE) return `Jaw/head is at ${pre} right now.`;
    const l = checkOf(ctx.last);
    if (l && l.pre != null && l.post != null && l.post - l.pre >= SYMPTOM_RISE) return `Symptoms rose ${l.pre} → ${l.post} last session.`;
    const clenches = ctx.last ? flaggedCount(ctx.last) : 0;
    if (clenches >= 2) return `You clenched on ${clenches} lifts last session.`;
    return null;
  },
  buildChecks(ctx) {
    const lvl = level(ctx);
    const l = checkOf(ctx.last);
    const posts = ctx.week.map(s => checkOf(s)?.post).filter((v): v is number => v != null);
    const avgPost = mean(posts);
    const clenches = ctx.last ? flaggedCount(ctx.last) : 0;
    return [
      [lvl != null && lvl <= 2, lvl == null ? "Build needs a jaw check first." : `Build needs a calm jaw (2 or less) — you're at ${lvl}.`],
      [!ctx.week.some(s => { const c = checkOf(s); return c != null && c.pre != null && c.pre >= HIGH_PRE; }) && (avgPost == null || avgPost <= 3), "Your jaw has flared in the last 7 days."],
      [clenches === 0 && !(l && l.pre != null && l.post != null && l.post - l.pre > 1), "Last session wasn't clean."],
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
  rotateReason: (log) => (log.slice(0, 3).filter(e => flagged(e)).length >= 2 ? "clenched in 2 of the last 3 sessions" : null),
  calmStreakLabel: "calm-jaw",

  care: {
    block: {
      label: "Jaw care",
      roles: ["jaw-care"],
      formats: ["holds"],
      share: { recovery: 0.27, consistent: 0.1, build: 0.07 },
      min: { recovery: 3, consistent: 1, build: 1 },
      max: { recovery: 6, consistent: 3, build: 3 },
    },
    coverageTargets: { regions: { jaw: 4 } },
  },
};
