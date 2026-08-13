import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Link } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { api, type ActivityDto, type DisciplineBalance, type WorkoutDto } from "@rg/api-client";
import {
  addDays,
  GARDEN_CONDITION_LABELS,
  isAdventureSport,
  sportLabel,
  type GardenConditionWord,
  type GardenEvent,
  type GardenWeatherState,
} from "@rg/domain";
import type { GardenSnapshot } from "@rg/garden-engine";
import {
  BALANCE_TUNING,
  conditionWord,
  DAMAGE_NOTCH,
  DEFAULT_GARDEN_CONFIG,
  gardenForecast,
  projectedBalance,
  simulateDay,
  SPECIES_BY_ID,
} from "@rg/garden-engine";
import { GardenScene, type SceneImpulse } from "@rg/garden-renderer";
import { IconClock, IconClose } from "../icons.js";
import {
  Banner,
  Card,
  CATEGORY_LABELS,
  EmptyState,
  formatDayShort,
  formatTime,
  relativeDay,
  Sheet,
  Spinner,
  useIsDesktop,
} from "../components.js";
import { Drawer } from "../drawer.js";
import { cap, eventSentence, selectArrival, type ArrivalEvent } from "./arrival.js";
import { CeremonyCard } from "./arrival-block.js";
import { BotanicalCard } from "./botanical.js";
import { EvidenceCard, NextWorkout, Readiness, ReviewPull, SyncPanel, UnresolvedCard } from "./today.js";
import {
  CATEGORY_ORDER,
  DisciplineNudges,
  GroundsShelf,
  landingUnlock,
  VisitorsShelf,
  nextUnlocksByDiscipline,
  NUDGE_DISCIPLINE_LABEL,
  progressText,
  RARITY_LABEL,
  SpeciesCodex,
  SpeciesSpriteCard,
  unlockGrownBy,
  WildlifeShelf,
  type CodexEntry,
  type NudgeDiscipline,
  type VisitorEntry,
  type WildlifeEntry,
} from "./codex.js";

/** One point on the timeline scrubber — either a replayed past day (from
 * `api.gardenTimeline()`) or the live "today" view already loaded above. */
interface TimelinePoint {
  date: string;
  snapshot: GardenSnapshot;
  condition: GardenConditionWord;
}

function usePrefersReducedMotion(): boolean {
  return useMemo(
    () =>
      typeof window !== "undefined" && window.matchMedia("(prefers-reduced-motion: reduce)").matches,
    [],
  );
}

/** A timeline day worth a tick mark — derived from snapshot deltas. */
interface TimelineChapter {
  index: number;
  label: string;
}

function deriveChapters(points: TimelinePoint[]): TimelineChapter[] {
  const out: TimelineChapter[] = [];
  const dead = (s: GardenSnapshot) => s.plants.filter((p) => p.state === "dead").length;
  for (let i = 1; i < points.length; i++) {
    const prev = points[i - 1]!.snapshot;
    const cur = points[i]!.snapshot;
    if (cur.unlockedSpeciesIds.length > prev.unlockedSpeciesIds.length) {
      out.push({ index: i, label: "New species unlocked" });
    } else if (cur.state.unlockedRegions > prev.state.unlockedRegions) {
      out.push({ index: i, label: "The garden expanded into new ground" });
    } else if (prev.state.weatherState !== "mild_drought" && cur.state.weatherState === "mild_drought") {
      out.push({ index: i, label: "Drought set in" });
    } else if (prev.state.weatherState === "mild_drought" && cur.state.weatherState === "recovery_rain") {
      out.push({ index: i, label: "The comeback began" });
    } else if (dead(cur) > dead(prev)) {
      out.push({ index: i, label: "A plant died back" });
    } else if (dormant(cur) > dormant(prev)) {
      out.push({ index: i, label: "Plants go dormant" });
    }
  }
  return out;
}

function dormant(s: GardenSnapshot): number {
  return s.plants.filter((p) => p.state === "dormant").length;
}

// eventSentence, cap and the arrival-selection logic live in arrival.ts —
// pure, unit-tested, shared by the beat, the log, and the ceremony queue.

const WEATHER_LABEL: Record<GardenWeatherState, string> = {
  fresh_rain: "fresh rain",
  recovery_rain: "recovery rain",
  soft_sun: "soft sun",
  clear_sun: "clear sun",
  seasonal_breeze: "a seasonal breeze",
  light_clouds: "light clouds",
  dry_spell: "a dry spell",
  mild_drought: "drought",
};

const WEATHER_WHY: Record<GardenWeatherState, string> = {
  fresh_rain: "a planned run landed today, so rain is watering everything.",
  recovery_rain: "you're back after a dry stretch — recovery rain is restoring the soil.",
  soft_sun: "a rest day, so gentle sun while the soil recovers.",
  clear_sun: "warm and steady between runs.",
  seasonal_breeze: "calm and seasonal — all is well.",
  light_clouds: "a few days without a run — the air is starting to dry.",
  dry_spell: "a few days without a run — the air is starting to dry.",
  mild_drought: "about two weeks without a run, so the garden is in drought.",
};

/** Unobtrusive breakdown of plant-family diversity in the garden. */
function DiversityStrip({ snapshot }: { snapshot: GardenSnapshot }) {
  const counts = new Map<string, number>();
  let total = 0;
  for (const pl of snapshot.plants) {
    if (pl.state === "dead") continue;
    counts.set(pl.category, (counts.get(pl.category) ?? 0) + 1);
    total += 1;
  }
  if (total === 0) return null;
  const present = CATEGORY_ORDER.filter((c) => (counts.get(c.key) ?? 0) > 0);
  return (
    <div className="diversity">
      <div className="diversity-bar" role="img" aria-label={`${present.length} of 8 plant families`}>
        {present.map((c) => (
          <span
            key={c.key}
            className="diversity-seg"
            style={{ flexGrow: counts.get(c.key)!, background: c.color }}
            title={`${c.label}: ${counts.get(c.key)}`}
          />
        ))}
      </div>
      <div className="diversity-legend">
        <span className="faint">
          {present.length} of 8 plant families · {total} plants
        </span>
        {present.map((c) => (
          <span key={c.key} className="diversity-tag">
            <span className="dot" style={{ background: c.color }} /> {c.label} {counts.get(c.key)}
          </span>
        ))}
      </div>
    </div>
  );
}

type DisciplineKey = "run" | "strength" | "yoga";

const BALANCE_BARS: Array<{ key: DisciplineKey; label: string }> = [
  { key: "run", label: "Run" },
  { key: "strength", label: "Lift" },
  { key: "yoga", label: "Yoga" },
];

const WEAKEST_COPY: Record<DisciplineKey, string> = {
  run: "The garden misses your runs.",
  strength: "The garden misses your lifting.",
  yoga: "The garden misses your yoga.",
};

function healthDescriptor(health: number): string {
  if (health >= 2 / 3) return "healthy";
  if (health >= 1 / 3) return "fading";
  return "wilting";
}

function daysCaption(days: number | null): string {
  if (days === null) return "not yet";
  return days === 0 ? "today" : `${days} d ago`;
}

/** The lowest-health *practiced* discipline; ties broken run > strength > yoga. */
function weakestDiscipline(balance: DisciplineBalance): DisciplineKey {
  let weakest: DisciplineKey = "run";
  for (const { key } of BALANCE_BARS) {
    if (balance[key].days === null) continue;
    if (balance[key].health < balance[weakest].health) weakest = key;
  }
  return weakest;
}

/**
 * Three mini-bars for run/lift/yoga health. Each track carries a notch at the
 * point where neglect starts visibly damaging the garden; a fill that has
 * shrunk past its notch turns amber. Every bar is a button opening its detail
 * panel (countdowns + what that discipline feeds). `variant="hud"` renders
 * the on-scene treatment for the desktop stage.
 */
export function BalanceStrip({
  balance,
  runPaused,
  runSheltered,
  runTrueRecencyDays,
  quiet,
  variant,
  activeKey,
  onToggle,
}: {
  balance: DisciplineBalance;
  /** No active plan — the run clock is paused, say so instead of a count. */
  runPaused?: boolean;
  /** The run clock is frozen by the adventure shield (today's adventure or
   * its grace window) or by rest mode — its "N d ago" count is not the real
   * recency of the last run, so the caption must say so rather than present
   * a stale, decay-paused count as fresh fact (C2). */
  runSheltered?: boolean;
  /** True calendar days since the last completed run (any discipline-
   * agnostic run, matched or not), independent of the decay clock's
   * freezes — takes over the run bar's caption whenever known. The clock
   * (`balance.run.days`) never advances on a shielded/rest day and never
   * catches back up once the shield ends, so on its own it can sit BEHIND
   * real recency (C2 round 2). null when no run has ever been recorded —
   * the clock's own count is the only fallback then. Ignored when
   * runPaused/runSheltered apply (those outrank any day count). */
  runTrueRecencyDays?: number | null;
  /** A forecast line is already speaking for the garden — stay visual only. */
  quiet?: boolean;
  variant?: "hud";
  activeKey?: DisciplineKey | null;
  onToggle?: (key: DisciplineKey) => void;
}) {
  return (
    <div className={`balance-strip${variant === "hud" ? " balance-strip-hud" : ""}`}>
      <div className="balance-bars">
        {BALANCE_BARS.map(({ key, label }) => {
          const { days, health } = balance[key];
          const notch = DAMAGE_NOTCH[key];
          const low = days !== null && health < notch;
          const isRun = key === "run";
          const caption = isRun && runPaused
            ? "plan paused"
            : isRun && runSheltered
              ? "sheltered"
              : isRun && runTrueRecencyDays != null
                ? daysCaption(runTrueRecencyDays)
                : daysCaption(days);
          // The paused/sheltered captions don't fit the generic "last run
          // <caption>" recency clause grammatically ("last run plan paused"
          // reads as nonsense) — give them their own sensible phrasing;
          // every other case (including true-recency) keeps the original
          // "last {label} {caption}" pattern, so the aria stays in sync with
          // whatever the visible caption says.
          const recencyPhrase = isRun && runPaused
            ? "no active plan, so the run clock is paused"
            : isRun && runSheltered
              ? "sheltered today, so the run clock is paused"
              : days === null
                ? `no ${label.toLowerCase()} yet`
                : `last ${label.toLowerCase()} ${caption}`;
          return (
            <button
              type="button"
              key={key}
              className={`balance-bar${activeKey === key ? " balance-bar-active" : ""}`}
              aria-expanded={activeKey === key}
              onClick={() => onToggle?.(key)}
              aria-label={`${label}: ${healthDescriptor(health)}${low ? ", the garden is paying for it" : ""}, ${recencyPhrase}. Details`}
            >
              <div className="balance-bar-label" aria-hidden="true">
                {label}
              </div>
              <div className="balance-bar-track" aria-hidden="true">
                <div
                  className={`balance-bar-fill balance-${key}${low ? " balance-low" : ""}`}
                  style={{ width: `${Math.round(health * 100)}%` }}
                />
                <span className="balance-notch" style={{ left: `${notch * 100}%` }} />
              </div>
              <div className="balance-bar-caption faint" aria-hidden="true">
                {caption}
              </div>
            </button>
          );
        })}
      </div>
      {!quiet && balance.overall < 0.5 ? (
        <p className="balance-copy muted">{WEAKEST_COPY[weakestDiscipline(balance)]}</p>
      ) : null}
    </div>
  );
}

/** What each axis feeds in the ecosystem — the tri-discipline story, spelled out. */
const AXIS_ECO: Record<DisciplineKey, { feeds: string; damageNow: string }> = {
  run: {
    feeds: "Runs are the rain — hydration, growth, and every new planting.",
    damageNow: "The garden is drying now — one run brings the rain back.",
  },
  strength: {
    feeds: "Lifting feeds the soil — saplings grow faster and the meadow thickens.",
    damageNow: "The soil is thinning now — one session feeds it.",
  },
  yoga: {
    feeds: "Yoga tends the meadow's life — variety, blooms, and the butterflies they bring.",
    damageNow: "The meadow is quieting now — one session wakes it.",
  },
};

/**
 * The per-discipline detail panel behind each bar: how long until this axis
 * starts costing the garden, what it feeds (with the live stat), the nearest
 * unlock this workout type is walking toward, and the week's trio.
 */
function BalanceDetail({
  k,
  balance,
  snapshot,
  trio,
  todayDate,
  onOpenSpecies,
  onClose,
  variant,
}: {
  k: DisciplineKey;
  balance: DisciplineBalance;
  snapshot: GardenSnapshot;
  trio: Partial<Record<NudgeDiscipline, CodexEntry>>;
  todayDate: string;
  onOpenSpecies: (speciesId: string) => void;
  onClose: () => void;
  variant?: "hud";
}) {
  const label = BALANCE_BARS.find((b) => b.key === k)!.label;
  const { days, health } = balance[k];
  const t = BALANCE_TUNING[k];
  const eco = AXIS_ECO[k];
  const s = snapshot.state;

  let countdown: ReactNode;
  if (days === null) {
    countdown = (
      <>No {label.toLowerCase()} sessions yet — the garden only counts what you start.</>
    );
  } else {
    const toDamage = t.damageStartDay - days;
    countdown =
      toDamage > 0 ? (
        <>
          Damage begins in <strong>{toDamage === 1 ? "1 day" : `${toDamage} days`}</strong> —{" "}
          {weekdayFull(addDays(todayDate, toDamage))}.
        </>
      ) : (
        <>{eco.damageNow}</>
      );
  }

  const stat =
    k === "run"
      ? `Moisture ${Math.round(s.moisture * 100)}%`
      : k === "strength"
        ? `Soil health ${Math.round(s.soilHealth * 100)}%`
        : `Life bonus +${Math.round((s.lifeBonusBiodiversity + s.lifeBonusFlowering) * 100)}%`;

  const next = trio[k];
  const wk = s.weekDisciplines;
  const wkMark = (done: boolean) => (done ? "✓" : "–");
  const wkDone = [wk.run, wk.strength, wk.yoga].filter(Boolean).length;

  return (
    <div
      className={`balance-detail${variant === "hud" ? " balance-detail-hud" : ""}`}
      role="region"
      aria-label={`${label} details`}
    >
      <div className="balance-detail-head">
        <strong>{label}</strong>
        <span className="balance-detail-status">{healthDescriptor(health)}</span>
        <button
          type="button"
          className="balance-detail-close"
          onClick={onClose}
          aria-label="Close details"
        >
          <IconClose size={13} />
        </button>
      </div>
      <p className="balance-detail-line">{countdown}</p>
      <p className="balance-detail-line balance-detail-eco">
        {eco.feeds} <span className="balance-detail-stat">{stat}</span>
      </p>
      {next?.progress ? (
        <button
          type="button"
          className="balance-detail-next"
          onClick={() => onOpenSpecies(next.speciesId)}
        >
          Next unlock: {next.name} ·{" "}
          {next.progress.target >= 1000
            ? progressText(next.progress)
            : `${Math.max(0, next.progress.target - next.progress.current)} to go`}{" "}
          →
        </button>
      ) : null}
      <p className="balance-detail-week">
        This week: Run {wkMark(wk.run)} · Lift {wkMark(wk.strength)} · Yoga {wkMark(wk.yoga)}
        {wk.adventure ? " · Adventure ✓" : ""}
        {wkDone === 2 ? " — one more discipline makes a balanced week (the Harmony willow is watching)." : ""}
      </p>
    </div>
  );
}

/** Whole days from `a` to `b` (ISO dates, b ≥ a). */
function daysBetween(a: string, b: string): number {
  return Math.round((Date.parse(b) - Date.parse(a)) / 86_400_000);
}

const WEEKDAYS_FULL = [
  "Sunday",
  "Monday",
  "Tuesday",
  "Wednesday",
  "Thursday",
  "Friday",
  "Saturday",
];

/** "Friday" — a deadline reads as an appointment, never an abbreviation. */
function weekdayFull(date: string): string {
  return WEEKDAYS_FULL[new Date(`${date}T12:00:00Z`).getUTCDay()]!;
}

const RUN_CATEGORIES = new Set(["easy", "long", "quality", "recovery", "race", "unknown"]);

/**
 * The garden's one-sentence forecast — the countdown, spoken as weather.
 * Exactly one loss-flavored line at a time; rest mode and plan gaps silence
 * it; a taper (no run due before the threshold) flips it to reassurance.
 */
function ForecastLine({
  snapshot,
  todayDate,
  daysAhead,
  nextWorkout,
  balance,
  adventure,
  className,
}: {
  snapshot: GardenSnapshot;
  todayDate: string;
  daysAhead: number;
  nextWorkout: WorkoutDto | null | undefined;
  /** Projected balance — lets soil/life decay speak when the rain is fine. */
  balance?: DisciplineBalance;
  /** The adventure shield — frozen today or still in its grace window. Outranks every loss line. */
  adventure?: { frozenToday: boolean; graceDay: boolean; lastSport: string | null; lastDate: string | null };
  className?: string;
}) {
  const f = gardenForecast(snapshot, daysAhead);
  // Active soil/life decay outranks a merely-pending dry spell: when the rain
  // is basically fine but the soil is already thinning, the header should say
  // so — running is not the only thing this garden eats.
  const soilOver =
    balance && balance.strength.days !== null
      ? balance.strength.days - BALANCE_TUNING.strength.damageStartDay
      : -1;
  const lifeOver =
    balance && balance.yoga.days !== null
      ? balance.yoga.days - BALANCE_TUNING.yoga.damageStartDay
      : -1;
  let line: ReactNode = null;
  if (adventure?.frozenToday) {
    const noun = adventure.lastSport ? sportLabel(adventure.lastSport).toLowerCase() : "adventure";
    line = (
      <>
        Today's <strong>{noun}</strong> tends the garden from afar — no rain owed.
      </>
    );
  } else if (adventure?.graceDay) {
    const noun = adventure.lastSport ? sportLabel(adventure.lastSport).toLowerCase() : "adventure";
    line = adventure.lastDate ? (
      <>
        {weekdayFull(adventure.lastDate)}'s <strong>{noun}</strong> is still keeping the beds shaded.
      </>
    ) : (
      <>Still restoring from your adventure — the garden holds its water.</>
    );
  } else if (f.recovering) {
    line = <>Recovery rain — the garden is drinking it in.</>;
  } else if (f.next?.stage === "dry" && (soilOver > 0 || lifeOver > 0)) {
    line =
      soilOver >= lifeOver ? (
        <>
          The <strong>soil is thinning</strong> — strength work feeds it.
        </>
      ) : (
        <>
          The <strong>meadow is quieting</strong> — a yoga session brings it back to life.
        </>
      );
  } else if (f.next) {
    const threshold = addDays(todayDate, f.next.inDays);
    // No plan at all: the run clock is paused, a countdown would over-alarm.
    if (!nextWorkout) return null;
    const runComing =
      RUN_CATEGORIES.has(nextWorkout.category) && nextWorkout.effectiveDate <= threshold;
    if (!runComing && nextWorkout.category === "rest") {
      line = <>Taper week — the garden holds its water.</>;
    } else if (f.next.stage === "dry") {
      line = (
        <>
          Rain needed by <strong>{weekdayFull(threshold)}</strong> — after that the soil starts
          to dry.
        </>
      );
    } else if (f.next.stage === "drought") {
      line = (
        <>
          <strong>{f.next.inDays === 1 ? "Drought tomorrow" : `Drought in ${f.next.inDays} days`}</strong>{" "}
          — your next run turns it around.
        </>
      );
    } else {
      const name = f.victim ? SPECIES_BY_ID.get(f.victim.speciesId)?.name : null;
      line = name ? (
        <>
          If the dry spell holds, the <strong>{name.toLowerCase()}</strong> goes dormant soon — one
          run brings it back.
        </>
      ) : (
        <>The dry spell is deepening — one run turns it around.</>
      );
    }
  } else if (f.victim) {
    line = <>Deep drought — your next run begins the recovery.</>;
  }
  if (!line) return null;
  return <p className={`forecast-line${className ? ` ${className}` : ""}`}>{line}</p>;
}

/** Monday of the ISO week containing `date`. */
function mondayOf(date: string): string {
  const dow = (new Date(`${date}T12:00:00Z`).getUTCDay() + 6) % 7;
  return addDays(date, -dow);
}

const DOW_LETTERS = ["M", "T", "W", "T", "F", "S", "S"];
const DONE_STATES = new Set(["completed", "provisionally_completed", "skipped", "missed"]);

function ordinalOf(n: number): string {
  const s = ["th", "st", "nd", "rd"];
  const v = n % 100;
  return `${n}${s[(v - 20) % 10] ?? s[v] ?? s[0]}`;
}

/**
 * The week as a quest: seven dots from the plan, and — when completing the
 * plan genuinely crosses an unlock gate — that day carries the species'
 * sprite. At most one sprite per week; a quest, not a slot row.
 */
function WeekRibbon({
  todayDate,
  codex,
  onOpenSpecies,
}: {
  todayDate: string;
  codex: CodexEntry[];
  onOpenSpecies: (speciesId: string) => void;
}) {
  const monday = mondayOf(todayDate);
  const week = useQuery({
    queryKey: ["week-workouts", monday],
    queryFn: () => api.workouts(monday, addDays(monday, 6)),
    staleTime: 5 * 60_000,
  });
  const workouts = (week.data?.workouts ?? []) as WorkoutDto[];
  // Reuses the history screen's exact queryKey/fn so the two screens share one cache entry.
  const acts = useQuery({ queryKey: ["runs"], queryFn: () => api.activities(40), staleTime: 5 * 60_000 });
  const adventureDates = useMemo(
    () =>
      new Set(
        ((acts.data?.activities ?? []) as ActivityDto[])
          .filter((a) => a.date >= monday && a.date <= addDays(monday, 6) && isAdventureSport(a.sport))
          .map((a) => a.date),
      ),
    [acts.data, monday],
  );
  const landing = useMemo(
    () =>
      landingUnlock(
        codex,
        workouts.map((w) => ({
          effectiveDate: w.effectiveDate,
          category: w.category,
          pending: !DONE_STATES.has(w.completionState),
        })),
        todayDate,
      ),
    [codex, workouts, todayDate],
  );
  if (workouts.length === 0) return null;
  return (
    <div className="week-ribbon">
      <div className="week-ribbon-strip" aria-label="This week's plan">
        {Array.from({ length: 7 }, (_, i) => addDays(monday, i)).map((date, i) => {
          const w = workouts
            .filter((x) => x.effectiveDate === date)
            .sort((a, b) => (a.category === "rest" ? 1 : 0) - (b.category === "rest" ? 1 : 0))[0];
          const lands = landing?.date === date;
          return (
            <div key={date} className={`week-day${date === todayDate ? " week-day-today" : ""}`}>
              {lands && landing ? (
                <span className="week-day-sprite" aria-hidden="true">
                  <SpeciesSpriteCard speciesId={landing.entry.speciesId} locked />
                </span>
              ) : null}
              <span
                className={`week-day-dot${w ? ` cat-${w.category}` : " week-day-empty"}${adventureDates.has(date) ? " week-day-adventure" : ""}`}
                title={w?.title}
              />
              <span className="week-day-dow" aria-hidden="true">
                {DOW_LETTERS[i]}
              </span>
            </div>
          );
        })}
      </div>
      {landing ? (
        <button
          type="button"
          className="week-pull"
          onClick={() => onOpenSpecies(landing.entry.speciesId)}
        >
          <strong>{weekdayFull(landing.date)}&rsquo;s{" "}
          {(CATEGORY_LABELS[landing.category] ?? landing.category).toLowerCase()}</strong> is your{" "}
          {ordinalOf(landing.ordinal)} — the {landing.entry.name} arrives.
        </button>
      ) : null}
    </div>
  );
}

function conditionStory(
  condition: GardenConditionWord,
  snapshot: GardenSnapshot,
  plants: number,
  speciesCount: number,
): string {
  const days = snapshot.state.daysSinceCompletedRun;
  const base: Record<GardenConditionWord, string> = {
    flourishing: "Your running has been steady, so it's lush and flowering.",
    well_watered: "Recent runs are keeping the soil moist and growing.",
    growing: "It's coming along — keep running to fill it in.",
    a_little_dry: `It's been ${days} day${days === 1 ? "" : "s"} since a run, so it's drying out — a run brings the rain.`,
    in_drought: `${days} days without a run, so it's in drought. Your next run starts the recovery.`,
    recovering: "You're back — it's drinking in recovery rain.",
    dormant: "Rest mode is on, so it's peacefully dormant and won't decline.",
  };
  const counts = `${plants} plant${plants === 1 ? "" : "s"}${speciesCount ? `, ${speciesCount} species` : ""}.`;
  return `${base[condition] ?? ""} ${counts}`;
}

// Mirrors .dock-panel's cap in styles.css (`max-height: min(32rem, calc(100dvh
// - 12rem))`) at a 16px root, so the two never drift apart silently.
const DOCK_PANEL_MAX_PX = 512; // 32rem
const DOCK_PANEL_RESERVE_PX = 192; // 12rem

/**
 * Would the expanded dock panel cover more than ~55% of a stage this tall?
 * (C1/C23.) The panel is bottom-anchored and absolutely positioned over the
 * same scene the condition word/forecast/beat lines read from — on a short
 * laptop window it can eat the whole top-left HUD. Exported for a focused
 * unit test; pure arithmetic, no DOM.
 */
export function dockCoversStage(stageHeightPx: number): boolean {
  const panelHeight = Math.min(DOCK_PANEL_MAX_PX, stageHeightPx - DOCK_PANEL_RESERVE_PX);
  return panelHeight > 0.55 * stageHeightPx;
}

export function GardenScreen() {
  const garden = useQuery({ queryKey: ["garden"], queryFn: api.garden });
  const today = useQuery({ queryKey: ["today"], queryFn: api.today });
  const [selectedPlantId, setSelectedPlantId] = useState<string | null>(null);
  const [openSpeciesId, setOpenSpeciesId] = useState<string | null>(null);
  const [showWeather, setShowWeather] = useState(false);
  const [timelineOpen, setTimelineOpen] = useState(false);
  // Mobile-only fullscreen stage (desktop is already full-viewport immersive).
  const [sceneFull, setSceneFull] = useState(false);
  useEffect(() => {
    if (!sceneFull) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setSceneFull(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [sceneFull]);
  const [dayIndexOverride, setDayIndexOverride] = useState<number | null>(null);
  const [openDrawer, setOpenDrawer] = useState<"collection" | "log" | null>(null);
  const [openBalanceKey, setOpenBalanceKey] = useState<DisciplineKey | null>(null);
  const [dockOpen, setDockOpenState] = useState(() => {
    if (typeof window === "undefined") return true;
    const stored = window.localStorage.getItem("rg-dock");
    if (stored === "open" || stored === "collapsed") return stored === "open";
    // No saved preference yet: on a short stage the panel would cover most
    // of the HUD above it (C1/C23) — default to the pill there instead.
    return !dockCoversStage(window.innerHeight);
  });
  // The arrival block: which ceremony is showing, and whether the text
  // lines were dismissed this mount. What counts as "new" comes from the
  // server-side watermark (selectArrival) — localStorage plays no part.
  const [ceremonyIndex, setCeremonyIndex] = useState(0);
  const [blockDismissed, setBlockDismissed] = useState(false);
  const seenPostedKeyRef = useRef<string | null>(null);
  const [replaying, setReplaying] = useState(false);
  const reducedMotion = usePrefersReducedMotion();
  const isDesktop = useIsDesktop();
  const dayIndexRef = useRef(0);
  const maxDayIndexRef = useRef(0);
  // The sun moves while you watch: live wall-clock hour, ticked once a
  // minute (the ambient screensaver's proven pattern). A discrete step, so
  // no reduced-motion gate.
  const [hourOfDay, setHourOfDay] = useState(
    () => new Date().getHours() + new Date().getMinutes() / 60,
  );
  useEffect(() => {
    const id = window.setInterval(
      () => setHourOfDay(new Date().getHours() + new Date().getMinutes() / 60),
      60_000,
    );
    return () => window.clearInterval(id);
  }, []);
  // System-driven arrival glow: new plants take the outline filter one at a
  // time (rarest first). The renderer lets a user selection win, so the
  // one-filtered-plant budget holds either way.
  const [highlightPlantId, setHighlightPlantId] = useState<string | null>(null);

  const setDockOpen = (open: boolean) => {
    setDockOpenState(open);
    try {
      window.localStorage.setItem("rg-dock", open ? "open" : "collapsed");
    } catch {
      // Private-mode storage failures only cost the remembered state.
    }
  };

  // Fetched only once the scrubber is opened, then cached — scrubbing itself
  // is then all client-side (no per-frame requests).
  const timeline = useQuery({
    queryKey: ["garden-timeline"],
    queryFn: api.gardenTimeline,
    enabled: timelineOpen,
    staleTime: 5 * 60_000,
  });

  // The next two weeks of the plan — keeps the forward scrub honest about
  // planned rest days (the run clock pauses on them) and plan gaps.
  const clientToday = new Date().toISOString().slice(0, 10);
  const scrubPlan = useQuery({
    queryKey: ["scrub-plan", clientToday],
    queryFn: () => api.workouts(clientToday, addDays(clientToday, 14)),
    enabled: timelineOpen,
    staleTime: 5 * 60_000,
  });

  // The do-nothing future: fold simulateDay over empty days, client-side and
  // never persisted. Capped so the projection stops short of the death window
  // — deterioration is the story here, not corpses.
  const futurePoints = useMemo<TimelinePoint[]>(() => {
    if (!timelineOpen || !garden.data) return [];
    const snap = garden.data.snapshot as unknown as GardenSnapshot;
    const rest = (garden.data.restMode as { active: boolean } | undefined)?.active ?? false;
    const planned = (scrubPlan.data?.workouts ?? []) as WorkoutDto[];
    const restDays = new Set(
      planned.filter((w) => w.category === "rest").map((w) => w.effectiveDate),
    );
    const planEnd =
      (scrubPlan.data?.plan as { endDate?: string } | null | undefined)?.endDate ?? null;
    const horizon = Math.max(
      0,
      Math.min(14, DEFAULT_GARDEN_CONFIG.deathStartDays - 1 - snap.state.daysSinceCompletedRun),
    );
    const out: TimelinePoint[] = [];
    let cur = snap;
    let date = snap.state.lastSimulatedDate;
    for (let i = 0; i < horizon; i++) {
      date = addDays(date, 1);
      cur = simulateDay(cur, {
        date,
        completedRuns: [],
        missedRuns: [],
        restObserved: restDays.has(date),
        restModeActive: rest,
        planGap: planEnd ? date > planEnd : false,
      }).snapshot;
      out.push({
        date,
        snapshot: cur,
        condition: conditionWord(cur.state, DEFAULT_GARDEN_CONFIG),
      });
    }
    return out;
  }, [timelineOpen, garden.data, scrubPlan.data]);

  // App-open freshness: this is the actual "/" landing screen (Today's
  // content lives here — see the garden-lower section below), so this is
  // where a mount-time COROS read nudge belongs. Server-deduped, errors
  // ignored, safe on every mount.
  useEffect(() => {
    void api.readNow().catch(() => undefined);
  }, []);

  // A refetch that changes the garden payload restarts the arrival
  // presentation (structural sharing keeps identity when nothing changed).
  useEffect(() => {
    setCeremonyIndex(0);
    setBlockDismissed(false);
  }, [garden.data]);

  // One arrival plan per payload — shared by the render, the glow schedule,
  // the impulses and the mark-seen post below.
  const arrivalPlan = useMemo(() => {
    if (!garden.data) return null;
    const seenState = garden.data.seen ?? null;
    const evts = (garden.data.events as ArrivalEvent[]) ?? [];
    const snap = garden.data.snapshot as unknown as GardenSnapshot;
    const live = today.data?.today ?? snap.state.lastSimulatedDate;
    return selectArrival(evts, seenState, live);
  }, [garden.data, today.data]);

  // Glow schedule for newly arrived plants: rarest first, 4s each, max 3.
  useEffect(() => {
    if (!garden.data || !arrivalPlan) return;
    const plan = arrivalPlan;
    const snap = garden.data.snapshot as unknown as GardenSnapshot;
    const rank = { rare: 0, uncommon: 1, common: 2 } as const;
    const ranked = plan.enteringPlantIds
      .map((id) => snap.plants.find((pl) => pl.id === id))
      .filter((pl): pl is NonNullable<typeof pl> => !!pl && pl.state !== "dead")
      .sort(
        (a, b) =>
          rank[SPECIES_BY_ID.get(a.speciesId)?.rarity ?? "common"] -
          rank[SPECIES_BY_ID.get(b.speciesId)?.rarity ?? "common"],
      )
      .slice(0, 3)
      .map((pl) => pl.id);
    if (ranked.length === 0) return;
    let i = 0;
    let timer = 0;
    const step = () => {
      if (i >= ranked.length) {
        setHighlightPlantId(null);
        return;
      }
      setHighlightPlantId(ranked[i]!);
      i += 1;
      timer = window.setTimeout(step, 4000);
    };
    step();
    return () => {
      window.clearTimeout(timer);
      setHighlightPlantId(null);
    };
  }, [garden.data, arrivalPlan]);

  // The impulse channel (spec §6): rain sweeping in when the weather turns
  // to rain across refetches — exactly the moment a synced run lands — and
  // a sparkle over the first rare arrival, staggered clear of the front.
  const [impulse, setImpulse] = useState<SceneImpulse | null>(null);
  const prevWeatherRef = useRef<GardenWeatherState | null>(null);
  const impulseSeqRef = useRef(0);
  useEffect(() => {
    if (!garden.data) return;
    const w = (garden.data.snapshot as unknown as GardenSnapshot).state.weatherState;
    const prev = prevWeatherRef.current;
    prevWeatherRef.current = w;
    if (prev && prev !== w && (w === "fresh_rain" || w === "recovery_rain")) {
      impulseSeqRef.current += 1;
      setImpulse({ kind: "rain_front", key: `rain:${impulseSeqRef.current}` });
    }
  }, [garden.data]);
  const sparkleFiredRef = useRef<string | null>(null);
  useEffect(() => {
    if (!garden.data || !arrivalPlan || arrivalPlan.sparkles.length === 0) return;
    const s = arrivalPlan.sparkles[0]!;
    const sparkKey = s.kind === "plant" ? `sp:${s.plantId}` : `sw:${s.wildlifeId}`;
    if (sparkleFiredRef.current === sparkKey) return;
    const snap = garden.data.snapshot as unknown as GardenSnapshot;
    let x = 0.5;
    let y = 0.45;
    if (s.kind === "plant") {
      const pl = snap.plants.find((p) => p.id === s.plantId);
      if (pl) {
        x = pl.position.x;
        y = Math.min(0.9, 0.5 + 0.4 * pl.position.y);
      }
    }
    const id = window.setTimeout(() => {
      sparkleFiredRef.current = sparkKey;
      setImpulse({ kind: "sparkle", key: sparkKey, x, y });
    }, 3000);
    return () => window.clearTimeout(id);
  }, [garden.data, arrivalPlan]);

  // Mark the arrival seen: brand-new gardens immediately and silently;
  // otherwise on dismissing the last ceremony (or the block), or 6s after a
  // ceremony-less block presents. Keyed on the watermark tip so each new
  // arrival posts exactly once; a failed POST (after one retry) just means
  // the same arrivals re-present next visit — never lossy.
  useEffect(() => {
    if (!arrivalPlan) return;
    const plan = arrivalPlan;
    const key = `${plan.nextSeen.lastSeenDate}:${plan.nextSeen.lastSeenSeq}:${plan.nextSeen.celebratedSpeciesIds.join(",")}`;
    if (seenPostedKeyRef.current === key) return;
    const post = () => {
      seenPostedKeyRef.current = key;
      void api
        .gardenSeen(plan.nextSeen)
        .catch(() => api.gardenSeen(plan.nextSeen))
        .catch(() => undefined);
    };
    if (plan.markSeenImmediately) {
      post();
      return;
    }
    if (ceremonyIndex < plan.ceremonies.length) return; // ceremonies still showing
    if (plan.ceremonies.length > 0 || blockDismissed) {
      post();
      return;
    }
    const id = window.setTimeout(post, 6000);
    return () => window.clearTimeout(id);
  }, [arrivalPlan, ceremonyIndex, blockDismissed]);

  // Timeline week replay: step one day forward on a calm cadence. The refs
  // are written during render below, so the interval always sees the live
  // clamp without re-subscribing.
  useEffect(() => {
    if (!replaying) return;
    const id = window.setInterval(() => {
      if (dayIndexRef.current >= maxDayIndexRef.current) {
        setReplaying(false);
        return;
      }
      setDayIndexOverride((v) => (v === null ? null : v + 1));
    }, 650);
    return () => window.clearInterval(id);
  }, [replaying]);

  if (garden.isLoading) return <Spinner label="Loading the garden" />;
  if (!garden.data) return <EmptyState title="Couldn't load the garden" />;

  const snapshot = garden.data.snapshot as unknown as GardenSnapshot;
  const condition = garden.data.condition as GardenConditionWord;
  const events = (garden.data.events as GardenEvent[]) ?? [];
  const species = (garden.data.species as Array<Record<string, unknown>>) ?? [];
  const restMode = garden.data.restMode as { active: boolean; until: string | null };
  // Old cached payloads (pre-balance) may not carry this field — guard rather than crash.
  const balance = garden.data.balance as DisciplineBalance | undefined;
  // Old cached payloads (pre-adventure) may not carry this field either.
  const adventure = garden.data.adventure as
    | { frozenToday: boolean; graceDay: boolean; lastSport: string | null; lastDate: string | null }
    | undefined;
  // Old cached payloads (pre-lastRunDate) may not carry this field either.
  const lastRunDate = (garden.data.lastRunDate as string | null | undefined) ?? null;

  // Timeline: every replayed past day, plus the live view already loaded
  // above standing in for "today" (its date is always later than the last
  // replayed day, since `buildGardenTimeline` never includes the in-progress
  // preview day — see the route).
  const pastDays: TimelinePoint[] = (timeline.data?.days ?? []).map((d) => ({
    date: d.date,
    snapshot: d.view.snapshot as unknown as GardenSnapshot,
    condition: d.view.condition,
  }));
  const liveDate = today.data?.today ?? snapshot.state.lastSimulatedDate;
  // Past → today → the projected do-nothing future. The slider spans all of
  // it; `todayIndex` is where history ends and the projection begins.
  const timelinePoints: TimelinePoint[] = [
    ...pastDays,
    { date: liveDate, snapshot, condition },
    ...futurePoints,
  ];
  const todayIndex = pastDays.length;
  const maxDayIndex = Math.max(0, timelinePoints.length - 1);
  const dayIndex = Math.min(dayIndexOverride ?? todayIndex, maxDayIndex);
  dayIndexRef.current = dayIndex;
  maxDayIndexRef.current = todayIndex; // replay stops at today, never the projection
  const dayView = timelinePoints[dayIndex] ?? timelinePoints[timelinePoints.length - 1]!;
  const viewingLive = !timelineOpen || dayIndex === todayIndex;
  const viewingFuture = timelineOpen && dayIndex > todayIndex;
  const timelineLoading = timelineOpen && timeline.isLoading;

  function closeTimeline() {
    setTimelineOpen(false);
    setDayIndexOverride(null);
  }

  // C26: the timeline and the expanded dock panel both float over the same
  // stage real estate and can overlap at common laptop widths — minimize the
  // dock the moment the timeline opens so they never fight for the same
  // pixels. Transient only (setDockOpenState, not setDockOpen): it doesn't
  // touch the persisted `rg-dock` preference, and restoring on close isn't
  // required.
  function openTimeline() {
    setDockOpenState(false);
    setTimelineOpen(true);
  }

  // What's actually drawn: the live garden, or the scrubbed day. Disabling
  // the canvas atmosphere layer while the scrubber is open keeps dragging
  // instant — its particle systems re-key on every weather/light change
  // (see AtmosphereLayer), which would otherwise re-init on every step.
  const displaySnapshot = timelineOpen ? dayView.snapshot : snapshot;
  const displayCondition = timelineOpen ? dayView.condition : condition;

  const selectedPlant = displaySnapshot.plants.find((p) => p.id === selectedPlantId);
  const livingPlantsCount = displaySnapshot.plants.filter((p) => p.state !== "dead").length;
  const weather = displaySnapshot.state.weatherState;

  const historyItems = events
    .map((e) => ({ e, text: eventSentence(e) }))
    .filter((x): x is { e: GardenEvent; text: string } => !!x.text)
    .slice(0, 12);

  const codex = (garden.data.codex as CodexEntry[]) ?? [];
  const wildlife = (garden.data.wildlife as WildlifeEntry[]) ?? [];
  const unlockedCount = codex.filter((c) => c.unlocked).length;
  const visitor =
    (garden.data.visitor as { kind: "deer" | "heron" | "owl" | "fox"; line: string } | null) ??
    null;
  const visitorLedger = (garden.data.visitors as VisitorEntry[]) ?? [];

  // The arrival block: ceremonies, beat and today lines, all selected
  // against the server-side watermark — refresh-proof, cross-device, and
  // same-day unlocks celebrate immediately (arrival.ts).
  const seen = garden.data.seen ?? null;
  // Non-null past the early returns: the memo runs whenever garden.data exists.
  const arrival = arrivalPlan!;
  const currentCeremony =
    viewingLive && !blockDismissed ? (arrival.ceremonies[ceremonyIndex] ?? null) : null;
  const ceremoniesDone = ceremonyIndex >= arrival.ceremonies.length;
  const sinceLabel = seen?.lastSeenDate ?? addDays(liveDate, -1);
  const dismissCeremony = () => setCeremonyIndex((i) => i + 1);
  const seePlantFromCeremony = (plantId: string) => {
    dismissCeremony();
    setSelectedPlantId(plantId);
  };
  // C12: the X on the beat block dismisses the WHOLE arrival presentation,
  // ceremonies included — it must not just hide the card, or a queued
  // ceremony strands (never dismissable again) and the mark-seen effect's
  // `ceremonyIndex < plan.ceremonies.length` guard blocks the watermark post
  // forever, replaying every already-dismissed beat line on the next visit.
  const dismissBlock = () => {
    setBlockDismissed(true);
    setCeremonyIndex(arrival.ceremonies.length);
  };
  const beatLines = blockDismissed ? [] : arrival.beatLines;
  const todayLines = blockDismissed || !viewingLive ? [] : arrival.todayLines;

  // Today's rare visitor (and, once a year, the garden's birthday) leads
  // whichever arrival line is showing.
  const anniversary = (garden.data.anniversary as string | null) ?? null;
  const leads = viewingLive
    ? [...(anniversary ? [anniversary] : []), ...(visitor ? [visitor.line] : [])]
    : [];
  const beatLinesAll = beatLines.length > 0 ? [...leads, ...beatLines] : beatLines;
  const todayLinesAll = leads.length > 0 || todayLines.length > 0 ? [...leads, ...todayLines] : todayLines;

  const d = today.data;

  // The clocks are as-of the end of `lastSimulatedDate` (≤ yesterday). Project
  // wall-clock elapsed time on top so the bars keep shrinking between visits
  // and the day captions stop calling yesterday's run "today". Display-only.
  const todayDate = d?.today ?? liveDate;
  const daysSinceSimulated = Math.max(
    0,
    daysBetween(snapshot.state.lastSimulatedDate, todayDate) - 1 + hourOfDay / 24,
  );
  // C2 (round 2): the decay clock (balance.run.days) freezes on shielded/
  // rest days and never catches back up — once the shield ends, the clock
  // can sit BEHIND true recency (a run that's really N days old reads as
  // fewer). lastRunDate is the true calendar date of the most recent run,
  // independent of the clock's freezes — used for the caption whenever
  // known; the clock itself still drives health/fill (decay, correctly).
  const runTrueRecencyDays = lastRunDate ? Math.max(0, daysBetween(lastRunDate, todayDate)) : null;
  const planActive = !!d?.nextWorkout;
  // audit#2: freeze the projected run decay exactly when the sim's own clock
  // holds still today — plan gap, observed/taper rest, adventure shelter,
  // rest mode — as computed by the server's own fold (runDecayPausedToday).
  // The old proxy (`!planActive`) froze the DISPLAY after the plan's last
  // day while the durable sim kept decaying toward race-morning drought —
  // display and simulation openly contradicted. Old cached payloads
  // (pre-field) fall back to that proxy rather than crash.
  const runDecayPaused =
    (garden.data.runDecayPausedToday as boolean | undefined) ?? !planActive;
  const liveBalance = balance
    ? projectedBalance(snapshot.state, {
        daysSinceSimulated,
        freezeRun: runDecayPaused,
        freezeAll: restMode.active,
      })
    : undefined;
  // One loss voice at a time: when the forecast line is speaking a decay
  // stage, the balance strip stays purely visual. The adventure shield
  // (frozen today, or still in its grace window) is reassurance, never
  // loss — a sheltered day must never voice a loss line either.
  const fc = gardenForecast(snapshot, daysSinceSimulated);
  const sheltered = !!(adventure?.frozenToday || adventure?.graceDay);
  // C2: the run bar's decay clock (daysSinceCompletedRun) freezes under the
  // same two conditions — it must stop claiming "N d ago" recency while
  // frozen, or the HUD contradicts the very log/cards it sits above.
  const runClockSheltered = sheltered || restMode.active;
  const lossVoiced =
    viewingLive &&
    !restMode.active &&
    !sheltered &&
    !fc.recovering &&
    (fc.next !== null || fc.victim !== null);

  // Timeline chapters: worth-a-tick days, derived from snapshot deltas.
  const chapters = timelineOpen && !timelineLoading ? deriveChapters(timelinePoints) : [];
  const currentChapter = chapters.find((c) => c.index === dayIndex);
  const startReplay = () => {
    if (reducedMotion || todayIndex === 0) {
      setDayIndexOverride(todayIndex);
      return;
    }
    setDayIndexOverride(Math.max(0, todayIndex - 7));
    setReplaying(true);
  };

  const attentionCount = (d?.needsAttention.length ?? 0) + (d?.unresolved.length ?? 0);
  // The best next thing, per axis — and what today's planned workout grows.
  const trio = nextUnlocksByDiscipline(codex);
  const grows = d?.nextWorkout ? unlockGrownBy(codex, d.nextWorkout.category) : null;
  const toggleBalanceKey = (k: DisciplineKey) =>
    setOpenBalanceKey((cur) => (cur === k ? null : k));

  const todayFrac = maxDayIndex > 0 ? todayIndex / maxDayIndex : 1;
  const timelinePanel = (
    <div className={`timeline-panel${viewingFuture ? " timeline-projected" : ""}`}>
      <div className="timeline-panel-head">
        <span className="timeline-label">
          {timelineLoading
            ? "Loading timeline…"
            : viewingFuture
              ? `+${dayIndex - todayIndex} days — ${formatDayShort(dayView.date)} · projected`
              : `${formatDayShort(dayView.date)} — day ${dayIndex}${viewingLive ? " (today)" : ""}`}
        </span>
        <div className="row" style={{ gap: "0.35rem" }}>
          {!timelineLoading && viewingFuture ? (
            <button
              type="button"
              className="btn btn-small"
              onClick={() => setDayIndexOverride(todayIndex)}
            >
              Back to today
            </button>
          ) : null}
          {!timelineLoading && !viewingFuture && todayIndex > 7 ? (
            <button type="button" className="btn btn-small" onClick={startReplay} disabled={replaying}>
              Replay week
            </button>
          ) : null}
          <button
            type="button"
            className="btn btn-small"
            onClick={closeTimeline}
            aria-label="Close timeline"
          >
            <IconClose size={14} />
          </button>
        </div>
      </div>
      {!timelineLoading ? (
        <>
          <div className="timeline-track">
            {futurePoints.length > 0 ? (
              <>
                <div
                  className="timeline-future"
                  style={{ left: `${todayFrac * 100}%` }}
                  aria-hidden="true"
                />
                <span
                  className="timeline-todaymark"
                  style={{ left: `${todayFrac * 100}%` }}
                  aria-hidden="true"
                />
              </>
            ) : null}
            <input
              type="range"
              className="timeline-slider"
              min={0}
              max={maxDayIndex}
              step={1}
              value={dayIndex}
              disabled={maxDayIndex === 0}
              onChange={(e) => {
                setReplaying(false);
                setDayIndexOverride(Number(e.target.value));
              }}
              aria-label="Day in the garden's history and projected future"
            />
            {maxDayIndex > 0 && chapters.length > 0 ? (
              <div className="timeline-ticks" aria-hidden="true">
                {chapters.map((c) => (
                  <span
                    key={c.index}
                    className={c.index > todayIndex ? "tick-future" : undefined}
                    style={{ left: `${(c.index / maxDayIndex) * 100}%` }}
                  />
                ))}
              </div>
            ) : null}
          </div>
          {currentChapter ? (
            <div className={`timeline-chapter${viewingFuture ? " timeline-chapter-future" : ""}`}>
              {currentChapter.label}
            </div>
          ) : null}
          {viewingFuture ? (
            <div className="timeline-foot">
              This is the garden if nothing changes — one run rewrites it.
            </div>
          ) : null}
        </>
      ) : null}
    </div>
  );

  const renderLog = (items: Array<{ e: GardenEvent; text: string }>) =>
    items.length === 0 ? (
      <p className="muted">Complete your first planned run to bring the rain.</p>
    ) : (
      <ul className="garden-history">
        {items.map(({ e, text }) => (
          <li key={e.id}>
            <span className="date">{formatDayShort(e.date)}</span>
            <span>{text}</span>
          </li>
        ))}
      </ul>
    );

  const fullLog = events
    .map((e) => ({ e, text: eventSentence(e) }))
    .filter((x): x is { e: GardenEvent; text: string } => !!x.text);

  const howItWorks = showWeather ? (
    <Banner kind="info">
      Completing a planned run brings <strong>rain</strong>, which waters the garden and grows
      new plants; a rest day brings gentle <strong>sun</strong>. Go a few days without running
      and clouds gather, then a dry spell, then <strong>drought</strong> after about two weeks —
      your next run turns it back to recovery rain. Consistency unlocks new species; the same
      running history always grows the exact same garden. Tap any plant to see what it came
      from.
    </Banner>
  ) : null;

  const plumbing = (
    <>
      {d ? (
        d.sync.calendarConnected ? (
          <SyncPanel />
        ) : (
          <Banner kind="info">Your training plan is safe, but Calendar mirroring is paused.</Banner>
        )
      ) : null}
      {d && d.needsAttention.length > 0 ? (
        <Banner kind="warn">
          {d.needsAttention.length === 1
            ? `“${d.needsAttention[0]!.title}” needs attention — COROS and Run Garden disagree.`
            : `${d.needsAttention.length} workouts need attention.`}{" "}
          <Link to="/plan">Review</Link>
        </Banner>
      ) : null}
      {d?.unresolved.map((w) => (
        <UnresolvedCard key={w.id} w={w} />
      ))}
      {d ? <Readiness readiness={d.readiness} /> : null}
      <EvidenceCard />
      <ReviewPull />
    </>
  );

  const sheets = (
    <>
      {openSpeciesId ? (
        <Sheet
          open
          onClose={() => setOpenSpeciesId(null)}
          title={SPECIES_BY_ID.get(openSpeciesId)?.name ?? "Species"}
        >
          <BotanicalCard
            speciesId={openSpeciesId}
            entry={codex.find((c) => c.speciesId === openSpeciesId)}
            chainWeeks={snapshot.state.consecutiveConsistentWeeks}
          />
        </Sheet>
      ) : null}
      {selectedPlant ? (
        <Sheet
          open
          onClose={() => setSelectedPlantId(null)}
          title={SPECIES_BY_ID.get(selectedPlant.speciesId)?.name ?? "Plant"}
        >
          <BotanicalCard
            speciesId={selectedPlant.speciesId}
            plant={selectedPlant}
            entry={codex.find((c) => c.speciesId === selectedPlant.speciesId)}
            chainWeeks={snapshot.state.consecutiveConsistentWeeks}
          />
        </Sheet>
      ) : null}
    </>
  );

  /* ── Desktop: the garden is the page — a full-viewport stage with a
     typographic HUD. Hierarchy: scene → condition word → forecast → bars →
     dock (the action) → rail (utilities). Text sits directly on the scene
     with soft shadows, ambient-caption style; boxes only where lists live. */
  if (isDesktop) {
    return (
      <div className="garden-home garden-home--stage">
        <h1 className="visually-hidden">Garden</h1>
        <div className="garden-stage">
          <div className="stage-scene">
            <GardenScene
              snapshot={displaySnapshot}
              reducedMotion={reducedMotion}
              selectedPlantId={selectedPlantId}
              onSelectPlant={setSelectedPlantId}
              timeOfDay={hourOfDay}
              atmosphere={!timelineOpen}
              visitor={viewingLive && visitor ? visitor.kind : null}
              enteringPlantIds={viewingLive ? arrival.enteringPlantIds : undefined}
              highlightPlantId={viewingLive ? highlightPlantId : null}
              impulse={viewingLive ? impulse : null}
              preserveAspectRatio="xMidYMax slice"
              className="stage-scene-svg"
            />
          </div>
          <div className="stage-scrim stage-scrim-top" aria-hidden="true" />
          <div className="stage-scrim stage-scrim-bottom" aria-hidden="true" />

          <div className="hud-topleft">
            <h2 className="hud-condition">{GARDEN_CONDITION_LABELS[displayCondition]}</h2>
            <p className="hud-weather">
              {viewingLive
                ? cap(WEATHER_LABEL[weather])
                : viewingFuture
                  ? `Projected: ${WEATHER_LABEL[weather]}`
                  : `That day: ${WEATHER_LABEL[weather]}`}{" "}
              — {WEATHER_WHY[weather]}
            </p>
            {viewingLive && !restMode.active ? (
              <ForecastLine
                snapshot={snapshot}
                todayDate={todayDate}
                daysAhead={daysSinceSimulated}
                nextWorkout={d?.nextWorkout}
                balance={liveBalance}
                adventure={adventure}
                className="hud-forecast"
              />
            ) : null}
            {restMode.active ? (
              <p className="hud-weather">Rest mode — nothing declines while you're away.</p>
            ) : null}
            {viewingLive && beatLinesAll.length > 0 ? (
              <p className="hud-beat">
                <span className="hud-beat-label">Since {formatDayShort(sinceLabel)}</span>
                <span>{beatLinesAll.join(" ")}</span>
                {arrival.beatOverflow ? (
                  <button
                    type="button"
                    className="linklike hud-beat-seeall"
                    onClick={() => setOpenDrawer("log")}
                  >
                    See all →
                  </button>
                ) : null}
                <button
                  type="button"
                  className="hud-beat-dismiss"
                  onClick={dismissBlock}
                  aria-label="Dismiss"
                >
                  <IconClose size={12} />
                </button>
              </p>
            ) : null}
            {viewingLive && todayLinesAll.length > 0 ? (
              <p className="hud-beat">
                <span className="hud-beat-label">Today</span>
                <span>{todayLinesAll.join(" ")}</span>
                {arrival.todayOverflow ? (
                  <button
                    type="button"
                    className="linklike hud-beat-seeall"
                    onClick={() => setOpenDrawer("log")}
                  >
                    See all →
                  </button>
                ) : null}
              </p>
            ) : null}
          </div>

          {/* The celebration gets its own stage moment — centered in the empty
              sky, never crowding the condition header or the bars. */}
          {currentCeremony ? (
            <div className="hud-ceremony">
              <CeremonyCard
                ceremony={currentCeremony}
                codexEntry={codex.find((c) => c.speciesId === currentCeremony.speciesId)}
                queueLeft={arrival.ceremonies.length - ceremonyIndex - 1}
                snapshot={snapshot}
                onSeePlant={seePlantFromCeremony}
                onDismiss={dismissCeremony}
                variant="hud"
              />
            </div>
          ) : null}

          {liveBalance && viewingLive ? (
            <div className="hud-topright">
              <BalanceStrip
                balance={liveBalance}
                // audit#2: only claim "plan paused" when the sim's clock IS
                // paused — a no-plan day the sim still decays through must
                // not be captioned as a pause it isn't getting.
                runPaused={!planActive && runDecayPaused}
                runSheltered={runClockSheltered}
                runTrueRecencyDays={runTrueRecencyDays}
                quiet
                variant="hud"
                activeKey={openBalanceKey}
                onToggle={toggleBalanceKey}
              />
              {openBalanceKey ? (
                <BalanceDetail
                  k={openBalanceKey}
                  balance={liveBalance}
                  snapshot={snapshot}
                  trio={trio}
                  todayDate={todayDate}
                  onOpenSpecies={setOpenSpeciesId}
                  onClose={() => setOpenBalanceKey(null)}
                  variant="hud"
                />
              ) : null}
            </div>
          ) : null}

          <div className="hud-dock">
            {dockOpen && d?.nextWorkout ? (
              <div className="dock-panel">
                <NextWorkout w={d.nextWorkout} today={d.today} />
                {grows?.progress ? (
                  <button
                    type="button"
                    className="linklike dock-grows"
                    onClick={() => setOpenSpeciesId(grows.speciesId)}
                  >
                    This workout grows the {grows.name}
                    {Math.max(0, grows.progress.target - grows.progress.current) === 1
                      ? " — the last one needed"
                      : grows.progress.target >= 1000
                        ? ` · ${progressText(grows.progress)}`
                        : ` · ${Math.max(0, grows.progress.target - grows.progress.current)} more to go`}
                  </button>
                ) : null}
                <div className="dock-week">
                  <WeekRibbon todayDate={todayDate} codex={codex} onOpenSpecies={setOpenSpeciesId} />
                </div>
                <button type="button" className="linklike dock-collapse" onClick={() => setDockOpen(false)}>
                  Minimize
                </button>
              </div>
            ) : (
              <button type="button" className="dock-pill" onClick={() => setDockOpen(true)}>
                {d?.nextWorkout
                  ? d.nextWorkout.category === "rest"
                    ? `Rest day · ${relativeDay(d.nextWorkout.effectiveDate, d.today)}`
                    : `Next: ${d.nextWorkout.title} · ${relativeDay(d.nextWorkout.effectiveDate, d.today)} ${formatTime(d.nextWorkout.effectiveTime)}`
                  : "No active training plan"}
              </button>
            )}
            {attentionCount > 0 ? (
              <a className="dock-attention" href="#garden-attention">
                {attentionCount === 1 ? "1 workout needs attention" : `${attentionCount} workouts need attention`} ↓
              </a>
            ) : null}
          </div>

          <div className="hud-corner">
            {(["run", "strength", "yoga"] as const).map((dk) => {
              const c = trio[dk];
              if (!c?.progress) return null;
              const remaining =
                c.progress.target >= 1000
                  ? progressText(c.progress)
                  : `${Math.max(0, c.progress.target - c.progress.current)} to go`;
              return (
                <button
                  type="button"
                  key={dk}
                  className="hud-nudge"
                  onClick={() => setOpenSpeciesId(c.speciesId)}
                >
                  {NUDGE_DISCIPLINE_LABEL[dk]} grows {c.name} · {remaining}
                </button>
              );
            })}
            <nav className="hud-rail" aria-label="Garden panels">
              <button type="button" onClick={() => setOpenDrawer("collection")}>
                Collection · {unlockedCount}/{codex.length}
              </button>
              <button type="button" onClick={() => setOpenDrawer("log")}>
                Log
              </button>
              <button
                type="button"
                onClick={() => (timelineOpen ? closeTimeline() : openTimeline())}
              >
                Timeline
              </button>
            </nav>
          </div>

          {timelineOpen ? <div className="stage-timeline">{timelinePanel}</div> : null}
        </div>

        <div className="garden-below" id="garden-attention">
          <p className="muted garden-below-intro">
            {conditionStory(
              displayCondition,
              displaySnapshot,
              livingPlantsCount,
              viewingLive ? species.length : displaySnapshot.unlockedSpeciesIds.length,
            )}{" "}
            <button type="button" className="linklike" onClick={() => setShowWeather((v) => !v)}>
              {showWeather ? "Hide" : "How the garden works"}
            </button>
          </p>
          {howItWorks}
          {plumbing}
        </div>

        <Drawer
          open={openDrawer === "collection"}
          onClose={() => setOpenDrawer(null)}
          title={`Collection · ${unlockedCount} of ${codex.length}`}
        >
          <div className="drawer-section">
            <div className="card-title">Growing next — per workout type</div>
            <DisciplineNudges codex={codex} onOpenSpecies={setOpenSpeciesId} />
          </div>
          <DiversityStrip snapshot={snapshot} />
          <SpeciesCodex codex={codex} today={todayDate} onOpenSpecies={setOpenSpeciesId} />
          <GroundsShelf grounds={snapshot.state.grounds ?? []} />
          <WildlifeShelf wildlife={wildlife} />
          <VisitorsShelf visitors={visitorLedger} />
        </Drawer>
        <Drawer open={openDrawer === "log"} onClose={() => setOpenDrawer(null)} title="Garden log">
          {renderLog(fullLog)}
        </Drawer>
        {sheets}
      </div>
    );
  }

  /* ── Mobile: the familiar stack, with the upgraded pieces. */
  return (
    <div className="garden-home">
      <h1 className="visually-hidden">Garden</h1>

      {/* The garden itself — big and central; expandable to the full screen. */}
      <div
        className={`garden-scene-wrap garden-scene-big${sceneFull ? " garden-scene-fullscreen" : ""}`}
      >
        {/* display:contents normally; in portrait fullscreen it becomes the
            rotated box that lays the wide scene sideways across the tall
            screen — the composition is a panorama, and portrait-cropping it
            hid most of the garden. */}
        <div className="scene-rotor">
        <GardenScene
          snapshot={displaySnapshot}
          reducedMotion={reducedMotion}
          selectedPlantId={selectedPlantId}
          onSelectPlant={setSelectedPlantId}
          timeOfDay={hourOfDay}
          atmosphere={!timelineOpen}
          visitor={viewingLive && visitor ? visitor.kind : null}
          enteringPlantIds={viewingLive ? arrival.enteringPlantIds : undefined}
          highlightPlantId={viewingLive ? highlightPlantId : null}
          impulse={viewingLive ? impulse : null}
          // Fullscreen fills the phone's tall viewport by cropping the wide
          // scene (same slice the desktop immersive stage uses) — without it
          // the svg letterboxes into a strip at the bottom of the screen.
          preserveAspectRatio={sceneFull ? "xMidYMax slice" : undefined}
        />
        </div>
        <button
          type="button"
          className="scene-full-toggle"
          aria-label={sceneFull ? "Exit fullscreen garden" : "View garden fullscreen"}
          onClick={() => setSceneFull((f) => !f)}
        >
          {sceneFull ? <IconClose size={16} /> : "⤢"}
        </button>
      </div>

      {/* Drag through the garden's history: one fetch, then the scrubber is
          all client-side re-renders of already-loaded days. */}
      <div className="timeline-bar">
        {timelineOpen ? (
          timelinePanel
        ) : (
          <button type="button" className="btn btn-small" onClick={() => setTimelineOpen(true)}>
            <IconClock size={14} /> Timeline
          </button>
        )}
      </div>

      {liveBalance ? (
        <>
          <BalanceStrip
            balance={liveBalance}
            // audit#2: same honesty rule as the HUD strip above — "plan
            // paused" only when the sim's clock is actually pausing.
            runPaused={!planActive && runDecayPaused}
            runSheltered={runClockSheltered}
            runTrueRecencyDays={runTrueRecencyDays}
            quiet={lossVoiced || sheltered}
            activeKey={openBalanceKey}
            onToggle={toggleBalanceKey}
          />
          {openBalanceKey ? (
            <BalanceDetail
              k={openBalanceKey}
              balance={liveBalance}
              snapshot={snapshot}
              trio={trio}
              todayDate={todayDate}
              onOpenSpecies={setOpenSpeciesId}
              onClose={() => setOpenBalanceKey(null)}
            />
          ) : null}
        </>
      ) : null}

      {/* What the garden is telling you, and why it looks this way. */}
      <div className="garden-readout">
        <h2 className="garden-condition">{GARDEN_CONDITION_LABELS[displayCondition]}</h2>
        {viewingLive && !restMode.active ? (
          <ForecastLine
            snapshot={snapshot}
            todayDate={todayDate}
            daysAhead={daysSinceSimulated}
            nextWorkout={d?.nextWorkout}
            balance={liveBalance}
            adventure={adventure}
          />
        ) : null}
        {currentCeremony ? (
          <CeremonyCard
            ceremony={currentCeremony}
            codexEntry={codex.find((c) => c.speciesId === currentCeremony.speciesId)}
            queueLeft={arrival.ceremonies.length - ceremonyIndex - 1}
            snapshot={snapshot}
            onSeePlant={seePlantFromCeremony}
            onDismiss={dismissCeremony}
          />
        ) : null}
        {viewingLive && beatLinesAll.length > 0 ? (
          <p className="garden-nowline">
            <span className="now-chip">since {formatDayShort(sinceLabel)}</span>
            {beatLinesAll.join(" ")}
            {arrival.beatOverflow ? <span className="faint"> See the log below.</span> : null}
          </p>
        ) : null}
        {viewingLive && todayLinesAll.length > 0 ? (
          <p className="garden-nowline">
            <span className="now-chip">today</span>
            {todayLinesAll.join(" ")}
          </p>
        ) : null}
        <p className="muted">
          {conditionStory(
            displayCondition,
            displaySnapshot,
            livingPlantsCount,
            viewingLive ? species.length : displaySnapshot.unlockedSpeciesIds.length,
          )}
        </p>
        <p className="faint">
          {viewingLive ? "Weather right now is" : "Weather that day was"}{" "}
          <strong>{WEATHER_LABEL[weather]}</strong> — {WEATHER_WHY[weather]}{" "}
          {viewingLive ? (
            <button type="button" className="linklike" onClick={() => setShowWeather((v) => !v)}>
              {showWeather ? "Hide" : "How the garden works"}
            </button>
          ) : null}
        </p>
        {howItWorks}
        {restMode.active ? (
          <Banner kind="info">Rest mode is on — nothing declines while you're away.</Banner>
        ) : null}
      </div>

      {/* The pull forward: the best next thing, per workout type. */}
      <Card title="Growing next — per workout type">
        <DisciplineNudges codex={codex} onOpenSpecies={setOpenSpeciesId} />
      </Card>

      {/* Today's actionable elements (formerly the Today page). */}
      {d?.nextWorkout ? (
        <NextWorkout w={d.nextWorkout} today={d.today} />
      ) : d ? (
        <EmptyState art="🌿" title="No active COROS training plan was found">
          Start a plan in COROS — it syncs in automatically once COROS is connected in Settings.
        </EmptyState>
      ) : null}
      {d?.nextWorkout ? (
        <Card title="This week">
          <WeekRibbon todayDate={todayDate} codex={codex} onOpenSpecies={setOpenSpeciesId} />
        </Card>
      ) : null}
      {plumbing}

      {/* The event log — trace what happened, and your species. */}
      <div className="garden-lower">
        <Card title="Garden log">{renderLog(historyItems)}</Card>
        <Card title={`Species collection · ${unlockedCount} of ${codex.length}`}>
          <DiversityStrip snapshot={snapshot} />
          <SpeciesCodex codex={codex} today={todayDate} onOpenSpecies={setOpenSpeciesId} />
          <GroundsShelf grounds={snapshot.state.grounds ?? []} />
          <WildlifeShelf wildlife={wildlife} />
          <VisitorsShelf visitors={visitorLedger} />
        </Card>
      </div>

      {sheets}
    </div>
  );
}
