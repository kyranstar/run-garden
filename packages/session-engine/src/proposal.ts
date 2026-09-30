import { UNANSWERED, label, type CheckReading, type EngineData, type HistorySession, type Mode, type ProposalCtx, type Theme } from "@rg/exercise-library";
import { Coverage } from "./coverage.js";
import { Hist } from "./hist.js";
import { Rng } from "./rng.js";

// Today's mode (recovery / consistent / build) and theme, each with plain-language reasons. The active
// profiles decide recovery and the condition's build gates, in their own words; the general rules follow.

export interface ModeArgs {
  checks?: Readonly<Record<string, CheckReading>>;
  sessions?: readonly HistorySession[];
  today: string;
  weeklyGoal?: number;
}

export interface ModeProposal {
  mode: Mode;
  reasons: string[];
}

function mode(data: EngineData, { checks = {}, sessions = [], today, weeklyGoal = 4 }: ModeArgs): ModeProposal {
  const past = Hist.sorted(sessions).filter(s => s.date <= today);
  const last = past[past.length - 1] ?? null;
  const week = past.filter(s => Hist.daysBetween(s.date, today) < 7);
  const profiles = data.profiles.active;
  const ctxFor = (id: string): ProposalCtx => ({ today, reading: checks[id] ?? UNANSWERED, past, last, week });
  const out = (m: Mode, reasons: string[]): ModeProposal => ({ mode: m, reasons });

  for (const p of profiles) {
    const why = p.recoveryReason(ctxFor(p.id));
    if (why) return out("recovery", [why]);
  }
  if (!last) return out("consistent", ["First session — start steady."]);

  const gap = Hist.daysBetween(last.date, today);
  if (gap >= 4) return out("consistent", [`${gap} days since your last session — rebuild the habit before pushing.`]);

  const lastBuild = [...past].reverse().find(s => s.mode === "build");
  const sinceBuild = lastBuild ? Hist.daysBetween(lastBuild.date, today) : null;
  const checksInOrder: Array<[boolean, string]> = [
    ...profiles.flatMap(p => p.buildChecks(ctxFor(p.id))),
    [sinceBuild == null || sinceBuild >= 2, sinceBuild === 0 ? "You built strength earlier today — give it 48 hours." : "You built strength yesterday — give it 48 hours."],
    [week.length >= weeklyGoal - 1, `${week.length} of ${weeklyGoal} sessions in the last 7 days — consistency first.`],
  ];
  const failed = checksInOrder.find(([ok]) => !ok);
  if (!failed) return out("build", [[...profiles.map(p => p.buildLabel(ctxFor(p.id))), `${week.length} sessions in the last 7 days`].join(" · ") + "."]);
  return out("consistent", [failed[1]]);
}

/** Outweighs any debt and the previous-theme penalty, so today's theme only repeats when nothing else suits the mode. */
const SAME_DAY_PENALTY = 1e6;

export interface ThemeArgs {
  mode: Mode;
  sessions?: readonly HistorySession[];
  today: string;
  lastThemeId?: string | null;
}

export interface ThemeProposal {
  theme: Theme | null;
  reasons: string[];
}

function theme(data: EngineData, { mode: m, sessions = [], today, lastThemeId = null }: ThemeArgs): ThemeProposal {
  const options = data.themes.filter(t => t.modes.includes(m));
  if (!options.length) return { theme: null, reasons: [] };
  const debt = Coverage.debt(data, sessions, today);
  const rng = Rng.create(`${today}|${m}|theme`);
  const previous = Hist.sorted(sessions).filter(s => s.date < today && s.theme).pop();
  const avoid = lastThemeId != null ? lastThemeId : previous ? previous.theme : null;
  // A second session today never repeats a theme already done today (spec §5 change 2).
  const doneToday = new Set(sessions.filter(s => s.date === today && s.theme).map(s => s.theme));

  let best: { theme: Theme; score: number; parts: Array<[string, number]> } | null = null;
  for (const t of options) {
    let score = 0;
    const parts: Array<[string, number]> = [];
    for (const [kind, weights] of [["patterns", t.emphasis.patterns ?? {}], ["regions", t.emphasis.regions ?? {}]] as const) {
      for (const [k, w] of Object.entries(weights)) {
        const v = w * (debt[kind][k] || 0);
        score += v;
        if (v > 0) parts.push([label(k), v]);
      }
    }
    if (t.id === avoid) score -= 100;
    if (doneToday.has(t.id)) score -= SAME_DAY_PENALTY;
    score += rng() * 0.5;
    if (!best || score > best.score) best = { theme: t, score, parts };
  }
  const top = best!.parts.sort((a, b) => b[1] - a[1]).slice(0, 2).map(([l]) => l.toLowerCase());
  return { theme: best!.theme, reasons: top.length ? [`Catches up on ${top.join(" and ")}.`] : [] };
}

export const Proposal = { mode, theme };
