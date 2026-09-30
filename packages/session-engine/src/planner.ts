import type { WeightUnit } from "@rg/domain";
import type { CheckReading, EngineData, HistorySession, Mode, Theme } from "@rg/exercise-library";
import { Blocks } from "./blocks.js";
import { Builder } from "./builder.js";
import { Lib } from "./lib.js";
import { Prog } from "./prog.js";
import { Proposal } from "./proposal.js";
import type { Alternative, Block, BuildInput, BuildResult, EngineLocation, Prefs, Swaps } from "./types.js";

// Today's session from stored state: the proposal (with the day's overrides), block upkeep, and the built
// plan. Pure: the program state and the day's state go in; the view and any block change come out, and the
// caller persists them.

export interface DayOverride {
  mode?: Mode;
  /** A theme id. */
  theme?: string;
  minutes?: number;
  /** A location id. */
  location?: string;
}

/** The day's own choices: check readings, overrides and swaps belong to one day only. */
export interface DayState {
  date: string;
  checks: Readonly<Record<string, CheckReading>>;
  /** "I'm feeling off" today, whatever profiles are active. */
  feelingOff?: boolean;
  override: DayOverride;
  swaps: Swaps;
}

export interface PlannerSettings {
  unit: WeightUnit;
  weeklyGoal: number;
  blockWeeks: number;
  defaultMinutes: number;
  /** The default location id for sessions. */
  location: string;
}

/** What the planner reads from storage. Blocks are judged with Home's gear (id "home", else the first place). */
export interface ProgramState {
  /** The program's id: seeds its builds, so two programs don't plan identical sessions. */
  programId?: string;
  settings: PlannerSettings;
  locations: readonly EngineLocation[];
  prefs: Prefs;
  savedIds: readonly string[];
  block: Block | null;
  sessions: readonly HistorySession[];
}

export interface PlanTodayInput {
  today: string;
  /** The stored day state (ignored unless it is today's). */
  day: DayState | null;
}

export interface TodayView {
  today: DayState;
  mode: Mode;
  proposedMode: Mode;
  modeReasons: string[];
  modeOverridden: boolean;
  theme: Theme | null;
  proposedTheme: Theme | null;
  themeReasons: string[];
  themeOverridden: boolean;
  minutes: number;
  location: EngineLocation;
  block: Block;
  blockEvents: string[];
  week: number;
  input: BuildInput;
  plan: BuildResult;
}

export interface BlockUpdate {
  block: Block;
  events: string[];
}

export interface GraduationOffer {
  family: string;
  from: string;
  to: string;
}

const blankDay = (today: string): DayState => ({ date: today, checks: {}, feelingOff: false, override: {}, swaps: {} });

/** The stored day if it is today's; otherwise a fresh one. */
const dayOf = (day: DayState | null | undefined, today: string): DayState => (day && day.date === today ? day : blankDay(today));
const withDay = (day: DayState | null | undefined, today: string, changes: Partial<DayState>): DayState => ({ ...dayOf(day, today), ...changes });

/** A location by id, else Home, else the first. */
function locationOf(locations: readonly EngineLocation[], id: string | null | undefined): EngineLocation {
  const found = locations.find(l => l.id === id) || locations.find(l => l.id === "home") || locations[0];
  if (!found) throw new Error("The program has no locations.");
  return found;
}
const homeOf = (locations: readonly EngineLocation[]): EngineLocation => locationOf(locations, "home");

function context(data: EngineData, input: PlanTodayInput, program: ProgramState) {
  const { today } = input;
  const t = dayOf(input.day, today);
  const home = homeOf(program.locations);
  const ensured = Blocks.ensure(data, program.block, {
    today, equipment: home.equipment, prefs: program.prefs, weeks: program.settings.blockWeeks,
    sessions: program.sessions, kbWeights: Lib.kettlebellsAt(home), unit: program.settings.unit,
  });
  const proposal = Proposal.mode(data, { checks: t.checks, feelingOff: Boolean(t.feelingOff), sessions: program.sessions, today, weeklyGoal: program.settings.weeklyGoal });
  const mode = t.override.mode || proposal.mode;
  const themeProposal = Proposal.theme(data, { mode, sessions: program.sessions, today });
  const chosen = t.override.theme ? data.themes.find(th => th.id === t.override.theme && th.modes.includes(mode)) ?? null : null;
  const theme = chosen || themeProposal.theme;
  const minutes = t.override.minutes || program.settings.defaultMinutes;
  const location = locationOf(program.locations, t.override.location || program.settings.location);
  const buildInput: BuildInput = {
    today, ...(program.programId ? { programId: program.programId } : {}), mode, theme, minutes, location, unit: program.settings.unit,
    sessions: program.sessions, prefs: program.prefs, savedIds: program.savedIds, block: ensured.block, checks: t.checks, swaps: t.swaps,
  };
  return { t, ensured, proposal, mode, themeProposal, chosen, theme, minutes, location, buildInput };
}

/** The day's proposal, the upkept block and the built plan. `blockUpdate` is null when the block didn't change. */
function planToday(data: EngineData, input: PlanTodayInput, program: ProgramState): { view: TodayView; blockUpdate: BlockUpdate | null } {
  const c = context(data, input, program);
  const plan = Builder.build(data, c.buildInput);
  const view: TodayView = {
    today: c.t,
    mode: c.mode, proposedMode: c.proposal.mode, modeReasons: c.proposal.reasons,
    modeOverridden: Boolean(c.t.override.mode && c.t.override.mode !== c.proposal.mode),
    theme: c.theme, proposedTheme: c.themeProposal.theme,
    themeReasons: c.chosen ? [] : c.themeProposal.reasons, themeOverridden: Boolean(c.chosen),
    minutes: c.minutes, location: c.location,
    block: c.ensured.block, blockEvents: c.ensured.events, week: Blocks.weekOf(c.ensured.block, input.today),
    input: c.buildInput, plan,
  };
  // Every block change (a new block, a rotation) comes with an event; no events means nothing to persist.
  return { view, blockUpdate: c.ensured.events.length ? { block: c.ensured.block, events: c.ensured.events } : null };
}

const alternatives = (data: EngineData, input: PlanTodayInput, program: ProgramState, slotKey: string, k = 3): Alternative[] =>
  Builder.alternatives(data, context(data, input, program).buildInput, slotKey, k);

/** "I'm feeling off" today: recovery, whatever profiles are active. */
const setFeelingOff = (day: DayState | null | undefined, today: string, value: boolean): DayState => withDay(day, today, { feelingOff: Boolean(value) });

/** Today's check for one profile (e.g. the pre-session reading). */
function setCheck(day: DayState | null | undefined, today: string, profileId: string, patch: Partial<CheckReading>): DayState {
  const t = dayOf(day, today);
  const current = t.checks[profileId] ?? { pre: null, post: null, feelingOff: false };
  return withDay(t, today, { checks: { ...t.checks, [profileId]: { ...current, ...patch, feelingOff: Boolean(patch.feelingOff ?? current.feelingOff) } } });
}

/** Changing the session's shape clears swaps: their slots no longer mean the same thing. */
function setOverride<K extends keyof DayOverride>(day: DayState | null | undefined, today: string, key: K, value: DayOverride[K] | null): DayState {
  const t = dayOf(day, today);
  const override: DayOverride = { ...t.override };
  if (value == null) delete override[key];
  else override[key] = value;
  return withDay(t, today, { override, swaps: {} });
}

/** A swap always records the slot's original move, so swapping again (or back) works from what the plan chose. */
function swap(day: DayState | null | undefined, today: string, slotKey: string, from: string, to: string): DayState {
  const t = dayOf(day, today);
  const prev = t.swaps[slotKey];
  const original = prev && prev.to === from && prev.from ? prev.from : from;
  const swaps: Record<string, { from?: string | null; to?: string | null } | null | undefined> = { ...t.swaps };
  delete swaps[slotKey];   // stored in the order made, so a re-swap comes after the swaps before it
  if (to !== original) swaps[slotKey] = { from: original, to };
  return withDay(t, today, { swaps });
}

/** Accepting a "ready for the harder move?" offer: the block's lift for that family changes (judged with Home's gear). */
function acceptGraduate(data: EngineData, program: ProgramState, today: string, familyId: string, exId: string): Block | null {
  if (!program.block) return program.block;
  return Blocks.graduate(data, program.block, familyId, exId, today, homeOf(program.locations).equipment);
}

/** Core lifts this session topped out, with the harder move the block can switch to (judged with Home's gear, like the block). */
function graduationOffers(data: EngineData, program: ProgramState, session: HistorySession): GraduationOffer[] {
  const block = program.block;
  if (!block) return [];
  const sessions = [...program.sessions.filter(s => s.id !== session.id), session];
  const loc = homeOf(program.locations);
  const kbWeights = Lib.kettlebellsAt(loc);
  const offers: GraduationOffer[] = [];
  for (const f of data.coreFamilies) {
    const id = block.core[f.id];
    const ex = id ? Lib.get(data, id) : null;
    if (!id || !ex || !(session.entries || []).some(e => e && e.id === id && e.sets && e.sets.length)) continue;
    const ctx = { mode: "build" as const, checks: {}, implement: Lib.implementFor(ex, loc.equipment), kbWeights, unit: program.settings.unit, equipment: loc.equipment };
    const s = Prog.suggest(data, ex, Prog.historyFor(data, sessions, id), ctx);
    if (s.action !== "graduate" || !s.graduate) continue;
    if (Blocks.graduate(data, block, f.id, s.graduate, session.date, loc.equipment) === block) continue;
    offers.push({ family: f.id, from: id, to: s.graduate });
  }
  return offers;
}

export const Planner = { planToday, alternatives, blankDay, dayOf, setCheck, setFeelingOff, setOverride, swap, acceptGraduate, graduationOffers, locationOf };
