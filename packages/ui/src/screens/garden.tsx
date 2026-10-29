import { useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Link } from "react-router-dom";
import { keepPreviousData, useQuery, useQueryClient } from "@tanstack/react-query";
import { api, type DisciplineBalance, type TodayResponse, type WorkoutDto } from "@rg/api-client";
import {
  addDays,
  dayLabel,
  GARDEN_CONDITION_LABELS,
  sportLabel,
  type GardenConditionWord,
  type GardenEvent,
  type GardenWeatherState,
  type ReadinessLevel,
  type ReadinessVerdict,
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
import { IconClose, IconCoach } from "../icons.js";
import { Banner, CategoryDot, EmptyState, formatDayShort, formatMinutes, formatTime, localTodayGuess, relativeDay, retrying, settling, Sheet, Spinner, syncActionShort, TRYING_AGAIN, useSpaceAbove, watchCoverageShort, workoutKindLabel } from "../components.js";
import { Drawer } from "../drawer.js";
import { cap, eventSentence, selectArrival, type ArrivalEvent } from "./arrival.js";
import { CeremonyCard } from "./arrival-block.js";
import { useArrivalShown } from "./growth/moments.js";
import { BotanicalCard } from "./botanical.js";
import {
  isAppSession,
  sessionDone,
  sessionSkipped,
  todayCardLayout,
  TodayProgramLead,
  TodayProgramLines,
  usePendingSaves,
  useRefusedReviews,
} from "../components/today-program.js";
import { useSignedInUserId } from "../components/outbox-sync.js";
import { SceneMarkContext } from "../scene-mark.js";
import { watchReviewQuery } from "../components/watch-review-sheet.js";
import { SessionsInProgress } from "../components/sessions-in-progress.js";
import { SavesTodayCard } from "../components/saves-today-card.js";
import { ConditionCheckSheet, ConditionChips } from "../components/condition-check-sheet.js";
import { ReviewPull, SyncPanel, TimezoneNudge } from "./today.js";
import { useUnits } from "../use-units.js";
import { AskCoach, useCoachSeeing } from "./studio/coach-ask.js";
import { dayFocus, workoutFocus } from "./studio/coach-focus.js";
import { BodyCheck } from "./today/body-check.js";
import { useWatchCatchUp } from "../components/watch-catch-up.js";
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
  unlockGrownBy,
  WildlifeShelf,
  type CodexEntry,
  type LandingUnlock,
  type PlannedLite,
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

/**
 * The loop, stated on every visit (System 1 §2): one sentence that names the
 * weather AND the cause→effect that drives it, in both directions. This
 * replaces three prose voices (the weather-why line, the on-page forecast
 * line, and the conditionStory paragraph) — a first-time visitor learns how
 * the garden works from this line alone, without opening "How the garden
 * works". Exported for the copy test.
 */
export function loopLine(weather: GardenWeatherState, daysSinceRun: number): string {
  const dry = `${daysSinceRun} day${daysSinceRun === 1 ? "" : "s"} without a run`;
  switch (weather) {
    case "fresh_rain":
      return "Fresh rain — today's workout is watering everything.";
    case "recovery_rain":
      return "Recovery rain — you're back, and the garden is drinking it in.";
    case "soft_sun":
      return "Soft sun — a rest day; the soil recovers with you.";
    case "clear_sun":
      return "Clear sun — every workout you finish waters it.";
    case "seasonal_breeze":
      return "A seasonal breeze — steady training keeps it calm.";
    case "light_clouds":
    case "dry_spell":
      return `A dry spell — ${dry}, and the air is drying.`;
    case "mild_drought":
      return `Drought — ${dry}. Your next run starts the rain.`;
  }
}

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
  // The third axis's name (Phase 2d): a mobility session grows it too. The `yoga` key stays.
  { key: "yoga", label: "Yoga & mobility" },
];

const WEAKEST_COPY: Record<DisciplineKey, string> = {
  run: "The garden misses your runs.",
  strength: "The garden misses your lifting.",
  yoga: "The garden misses your yoga & mobility.",
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
 * shrunk past its notch turns amber — at EVERY width (audit#4 D5: the base
 * layer and the stage block used to disagree about whether a fill's colour
 * meant "which discipline" or "this one is in the damage zone", purely by
 * source order, so the same three classes encoded two different things
 * depending on the viewport).
 *
 * There is no `variant` prop. The on-scene treatment is a property of WHERE
 * this renders, not of what it is: the stage's positioning box
 * (`.hud-topright`) is what selects it, and that box only exists as a
 * positioned thing from lg. The prop it replaces was passed unconditionally
 * and every rule it enabled lived inside `@media (min-width: 1024px)`, so
 * below lg it was inert — a dead prop that read like a mobile/desktop switch.
 */
export function BalanceStrip({
  balance,
  runPaused,
  runSheltered,
  runTrueRecencyDays,
  quiet,
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
  activeKey?: DisciplineKey | null;
  onToggle?: (key: DisciplineKey) => void;
}) {
  return (
    <div className="balance-strip">
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
              {/* Not `.faint`: --ink-faint measured 3.07:1 on the page
                  background at 11.2px/400, under AA. The caption owns its own
                  colour token now (audit#4 D9). */}
              <div className="balance-bar-caption" aria-hidden="true">
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
    feeds: "Yoga & mobility tend the meadow's life — variety, blooms, and the butterflies they bring.",
    damageNow: "The meadow is quieting now — one session wakes it.",
  },
};

/**
 * The per-discipline detail panel behind each bar: how long until this axis
 * starts costing the garden, what it feeds (with the live stat), the nearest
 * unlock this workout type is walking toward, and the week's trio.
 */
export function BalanceDetail({
  k,
  balance,
  snapshot,
  trio,
  todayDate,
  onOpenSpecies,
  onClose,
}: {
  k: DisciplineKey;
  balance: DisciplineBalance;
  snapshot: GardenSnapshot;
  trio: Partial<Record<NudgeDiscipline, CodexEntry>>;
  todayDate: string;
  onOpenSpecies: (speciesId: string) => void;
  onClose: () => void;
}) {
  const units = useUnits();
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
    <div className="balance-detail" role="region" aria-label={`${label} details`}>
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
            ? progressText(next.progress, units)
            : `${Math.max(0, next.progress.target - next.progress.current)} to go`}{" "}
          →
        </button>
      ) : null}
      <p className="balance-detail-week">
        This week: Run {wkMark(wk.run)} · Lift {wkMark(wk.strength)} · Yoga &amp; mobility {wkMark(wk.yoga)}
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

interface ForecastInput {
  snapshot: GardenSnapshot;
  todayDate: string;
  daysAhead: number;
  nextWorkout: WorkoutDto | null | undefined;
  /** Projected balance — lets soil/life decay speak when the rain is fine. */
  balance?: DisciplineBalance;
  /** The adventure shield — frozen today or still in its grace window. Outranks every loss line. */
  adventure?: { frozenToday: boolean; graceDay: boolean; lastSport: string | null; lastDate: string | null };
  /** Dew this morning (option C, 0020) — a settled night on a tended garden.
   * A calm voice like the shields; the adventure branches outrank it only
   * because an adventure names a concrete thing the athlete did. */
  dew?: boolean;
}

/**
 * The garden's one-sentence forecast — the countdown, spoken as weather —
 * and, the part a second reader needs, what KIND of thing it is saying.
 * `loss` is a line about the garden paying for something; `calm` is
 * reassurance (an adventure shield, recovery rain, a taper); `null` is
 * silence (a plan gap has nothing to count down to). Exactly one
 * loss-flavored line at a time.
 *
 * This exists because two call sites need the same answer and one of them
 * used to restate the branch conditions rather than ask (audit#4 D9): a
 * `lossVoiced` boolean in `GardenScreen` re-derived "is the forecast speaking
 * a loss?" from `gardenForecast` directly, drifted out of agreement with the
 * component (it claimed a voice in the `!nextWorkout` branch, where this
 * renders NOTHING), and then went dead entirely when `quiet` was hardcoded —
 * dead in a way `tsc` cannot see, because a `const` that is never read is not
 * an error. One function, two readers, no restatement.
 */
export function forecastVoice({
  snapshot,
  todayDate,
  daysAhead,
  nextWorkout,
  balance,
  adventure,
  dew,
}: ForecastInput): { kind: "loss" | "calm"; line: ReactNode } | null {
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
  // Reassurance until a branch says otherwise: the three shield/recovery
  // branches and the taper are the garden saying it is FINE, and a strip of
  // bars underneath is then the only thing that can voice a loss.
  let kind: "loss" | "calm" = "calm";
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
  } else if (dew) {
    line = (
      <>
        <strong>Dew</strong> from a settled night — the garden holds its water today.
      </>
    );
  } else if (f.next?.stage === "dry" && (soilOver > 0 || lifeOver > 0)) {
    kind = "loss";
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
      kind = "loss";
      line = (
        <>
          Rain needed by <strong>{weekdayFull(threshold)}</strong> — after that the soil starts
          to dry.
        </>
      );
    } else if (f.next.stage === "drought") {
      kind = "loss";
      line = (
        <>
          <strong>{f.next.inDays === 1 ? "Drought tomorrow" : `Drought in ${f.next.inDays} days`}</strong>{" "}
          — your next run turns it around.
        </>
      );
    } else {
      kind = "loss";
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
    kind = "loss";
    line = <>Deep drought — your next run begins the recovery.</>;
  }
  if (!line) return null;
  return { kind, line };
}

/** Monday of the ISO week containing `date`. */
function mondayOf(date: string): string {
  const dow = (new Date(`${date}T12:00:00Z`).getUTCDay() + 6) % 7;
  return addDays(date, -dow);
}

const DONE_STATES = new Set(["completed", "provisionally_completed", "skipped", "missed"]);

function ordinalOf(n: number): string {
  const s = ["th", "st", "nd", "rd"];
  const v = n % 100;
  return `${n}${s[(v - 20) % 10] ?? s[v] ?? s[0]}`;
}

/**
 * System 4 D8 — ONE derivation of "what needs you", and one phrase for it.
 *
 * There were two. The dock's jump link counted `needsAttention + unresolved`
 * and said "3 workouts need attention ↓"; the banner it jumped to counted
 * `needsAttention` alone and spoke for 1. So the app told you three, you
 * tapped, and you landed on one — and not even on that, because the anchor
 * was pinned to the whole lower region and resolved 352px above the banner.
 * A count the user can check is a correctness bug when it is wrong, not a
 * layout nit.
 *
 * Both readers now come through here, and `attentionPhrase` is the only place
 * the sentence exists, so the number and the wording cannot drift apart
 * again. `d` is settled before either reader runs (the screen's gate covers
 * `today`); the `?? []` is for the errored case, where "no items" and "no
 * block" are the same honest answer.
 */
export function gardenAttention(d: { needsAttention: WorkoutDto[]; unresolved: WorkoutDto[] } | undefined): {
  mismatched: WorkoutDto[];
  unresolved: WorkoutDto[];
  count: number;
} {
  const mismatched = d?.needsAttention ?? [];
  const unresolved = d?.unresolved ?? [];
  return { mismatched, unresolved, count: mismatched.length + unresolved.length };
}

/** The one sentence. The link appends "↓"; nothing else restates the count. */
/**
 * A session on Today's page updating on the watch (the watch mirrors the plan §3.9): its row's `syncAction` says the
 * mirror's `watch_updating` — a push or a delete of its copy on its way. What Today drains for on open (Task 8's trigger,
 * narrowed: never for a coach job or any other COROS write, which a watch drain would not run).
 */
export function watchUpdatingOnToday(t: Pick<TodayResponse, "todaySessions" | "upcoming"> & { nextWorkout?: WorkoutDto | null }): boolean {
  const rows = [...(t.todaySessions ?? []).map((s) => s.workout), ...(t.upcoming ?? []), ...(t.nextWorkout ? [t.nextWorkout] : [])];
  return rows.some((w) => w.syncAction?.code === "watch_updating");
}

export function attentionPhrase(count: number): string {
  return count === 1 ? "1 workout needs attention" : `${count} workouts need attention`;
}

/**
 * The week's plan, for the garden drawer's "next to bloom" (the day a workout crosses an unlock). Its one reader is
 * `NextToBloom`, which exists only while the drawer is open — so it is never read for, nor holds, Today's first paint.
 */
function useWeekWorkouts(monday: string) {
  return useQuery({
    queryKey: ["week-workouts", monday],
    queryFn: () => api.workouts(monday, addDays(monday, 6)),
    staleTime: 5 * 60_000,
    // If the server's idea of today lands in a different ISO week from the client's opening guess, the key changes but
    // the drawer keeps what it already has in hand.
    placeholderData: keepPreviousData,
  });
}

/**
 * The drawer's "Next to bloom": what finishing today's session grows, the day this week's plan crosses an unlock (once
 * the week has answered — nothing is claimed while it is read), and the next species per kind of workout.
 */
export function NextToBloom({
  codex,
  todayDate,
  grows,
  onOpenSpecies,
}: {
  codex: CodexEntry[];
  todayDate: string;
  /** What finishing today's session grows (the card's old line), when it grows anything. */
  grows: ReactNode;
  onOpenSpecies: (speciesId: string) => void;
}) {
  const week = useWeekWorkouts(mondayOf(todayDate));
  const landing = week.data ? landingUnlock(codex, (week.data.workouts as WorkoutDto[]).map(plannedLiteOf), todayDate) : null;
  const trio = nextUnlocksByDiscipline(codex);
  const nothing = !grows && !landing && !trio.run && !trio.strength && !trio.yoga;
  return (
    <>
      {grows}
      {landing ? <WeekPull landing={landing} onOpenSpecies={onOpenSpecies} /> : null}
      <DisciplineNudges codex={codex} onOpenSpecies={onOpenSpecies} />
      {nothing ? <p className="muted">Every species you can grow right now has bloomed.</p> : null}
    </>
  );
}

/** A planned workout as the week's quest reads it: its day, its kind, whether it is still to do, and who made it. */
export function plannedLiteOf(w: WorkoutDto): PlannedLite {
  return {
    effectiveDate: w.effectiveDate,
    category: w.category,
    pending: !DONE_STATES.has(w.completionState),
    ...(w.appMade !== undefined ? { appMade: w.appMade } : {}),
    origin: w.origin ?? null,
  };
}

/** The week strip's line under the dots: the day whose workout crosses an unlock gate, and what arrives. */
export function WeekPull({ landing, onOpenSpecies }: { landing: LandingUnlock; onOpenSpecies: (speciesId: string) => void }) {
  return (
    <button
      type="button"
      className="week-pull"
      onClick={() => onOpenSpecies(landing.entry.speciesId)}
    >
      <strong>{weekdayFull(landing.date)}&rsquo;s{" "}
      {(workoutKindLabel(landing.category, landing) ?? landing.category).toLowerCase()}</strong> is your{" "}
      {ordinalOf(landing.ordinal)} — the {landing.entry.name} arrives.
    </button>
  );
}

/** The Today card's line under a workout's title: its time, its length and its kind. */
export function TodayMeta({ w }: { w: WorkoutDto }) {
  return (
    <p className="today-meta">
      {formatTime(w.effectiveTime)} · {formatMinutes(w.workoutSeconds)} ·{" "}
      <CategoryDot category={w.category} />{" "}
      {(workoutKindLabel(w.category, w) ?? w.category).toLowerCase()}
    </p>
  );
}


/**
 * The dock's verdict phrases. Copy lives client-side (the house split — the
 * server sends `level` + evidence, never prose, the same way `deriveHeadline`
 * sends a state and brief-copy names it). Each phrase says the thing on its
 * own: the coloured dot beside it is decoration, never the only signal.
 */
export const VERDICT_PHRASE: Record<ReadinessLevel, string> = {
  good: "Good to go",
  caution: "Take it easy",
  poor: "Recovery is low",
};

/**
 * The coach's readiness-derived clause (System 1 spec §Today): the morning's
 * verdict APPLIED to today's session, in the coach's voice — so the card has
 * a coach even when the weekly focus line is stale, and "Ask me" is always
 * reachable from home. Derived client-side from data already on the payload;
 * no LLM call. It never RESTATES the chip's phrase — the chip names the
 * level, this clause says what to do with it. Null on rest days (there is
 * nothing to pace) and when there is no verdict to derive from.
 */
export function coachClause(
  level: ReadinessLevel | null | undefined,
  category: string | undefined,
): string | null {
  if (!level || !category || category === "rest") return null;
  switch (level) {
    case "poor":
      return "With recovery low, ride the easy end of today — effort, not pace.";
    case "caution":
      return "Take today steady — save the extra gear for later in the week.";
    case "good":
      return "Green lights this morning — today can take its full effort.";
  }
}

/**
 * The card's one coach line is one sentence (the new shape §4): the coach's own words for the week cut at its first
 * sentence's end, never mid-sentence; text with no sentence end stays whole.
 */
export function oneSentence(text: string): string {
  const t = text.trim();
  const m = /^(.+?[.!?])(?=\s|$)/s.exec(t);
  return m ? m[1]! : t;
}

/** The rest day's one gentle suggestion line. */
export const REST_LINE = "The garden rests with you today. A short walk or some easy mobility suits it, if you'd like.";

/** 7h10m-style clock for the slept vital. */
function sleepClock(seconds: number): string {
  const h = Math.floor(seconds / 3600);
  const m = Math.round((seconds % 3600) / 60);
  return `${h}:${String(m).padStart(2, "0")} h`;
}

function sleepStages(sleep: { deepSeconds: number | null; remSeconds: number | null }): string {
  const parts: string[] = [];
  if (sleep.deepSeconds != null) parts.push(`${(sleep.deepSeconds / 3600).toFixed(1)}h deep`);
  if (sleep.remSeconds != null) parts.push(`${(sleep.remSeconds / 3600).toFixed(1)}h REM`);
  return parts.length ? ` · ${parts.join(" · ")}` : "";
}

/**
 * The last 7 nights as cells: settled, low (✕ — colour is never the only
 * signal), or a dashed gap when the watch didn't read. Renders nothing until
 * at least one night has a reading — an all-gap row is noise, not data.
 */
function NightRow({ nights }: { nights: TodayResponse["readiness"]["nights"] }) {
  if (!nights || !nights.some((n) => n.state !== "gap")) return null;
  return (
    <div className="ready-nights">
      {nights.map((n) => (
        <i key={n.date} className={`ready-night ready-night-${n.state}`} aria-hidden="true">
          {n.state === "low" ? "✕" : ""}
        </i>
      ))}
      <small>last 7 nights</small>
    </div>
  );
}

/**
 * The Readiness sheet — the ONE place the morning numbers live (System 1 v2).
 * The Today card's chip opens it; nothing on the page repeats it. Numbers are
 * phrased without jargon ("usually 46", never "baseline median"), and the
 * provenance paragraph keeps the honesty contract the old card carried:
 * a single morning reading, context not instructions.
 */
export function ReadinessSheet({
  readiness,
  onClose,
}: {
  readiness: TodayResponse["readiness"];
  onClose: () => void;
}) {
  const verdict = readiness.verdict;
  const latest = readiness.latest;
  const baseline = readiness.baseline;
  return (
    <Sheet open onClose={onClose} title="Readiness">
      {verdict ? (
        <p className={`ready-verdict ready-${verdict.level}`}>
          <span className="ready-dot" aria-hidden="true" />
          {VERDICT_PHRASE[verdict.level]}
        </p>
      ) : null}
      {latest ? (
        <div className="ready-vitals">
          {latest.hrv != null ? (
            <div className="ready-vital">
              <b>{Math.round(latest.hrv)} ms</b>
              <small>
                sleep HRV
                {readiness.band
                  ? ` · your band ${readiness.band.lo}–${readiness.band.hi}`
                  : baseline?.hrv != null
                    ? ` · usually ${Math.round(baseline.hrv)}`
                    : ""}
              </small>
            </div>
          ) : null}
          {latest.restingHeartRate != null ? (
            <div className="ready-vital">
              <b>{Math.round(latest.restingHeartRate)}</b>
              <small>
                resting HR
                {baseline?.restingHeartRate != null
                  ? ` · usually ${Math.round(baseline.restingHeartRate)}`
                  : ""}
              </small>
            </div>
          ) : null}
          {readiness.sleep ? (
            <div className="ready-vital">
              <b>{sleepClock(readiness.sleep.durationSeconds)}</b>
              <small>slept{sleepStages(readiness.sleep)}</small>
            </div>
          ) : null}
          {latest.recoveryScore != null ? (
            <div className="ready-vital">
              <b>{Math.round(latest.recoveryScore)}%</b>
              <small>COROS recovery</small>
            </div>
          ) : null}
          {latest.fullRecoveryHours != null && latest.fullRecoveryHours > 0 ? (
            <div className="ready-vital">
              <b>{Math.round(latest.fullRecoveryHours)} h</b>
              <small>until full recovery, says COROS</small>
            </div>
          ) : null}
        </div>
      ) : null}
      <NightRow nights={readiness.nights} />
      <p className="faint ready-prov">
        {latest?.date ? `From COROS, as of ${formatDayShort(latest.date)} — ` : ""}
        {readiness.sampleDays >= 3
          ? `a single morning reading against your last ${readiness.sampleDays} days. `
          : ""}
        Context, not instructions — you know your body best.
      </p>
    </Sheet>
  );
}

/**
 * Every piece of information the garden shows, named once, in the order the
 * page reads them: the scene (with the condition word and the loop sentence
 * printed on it), the streak band, what changed, today's card, and the
 * "Lately" strip. ONE place places each (`GardenBody`); a part cannot land on
 * one viewport only, because there is only one place to put it
 * (`responsive.test.tsx` renders a marker in every slot and asserts all of
 * them land).
 */
export interface GardenParts {
  /** The picture, plus its quiet tool chips (collection / log / timeline /
   *  fullscreen). A cropped hero below lg, the full-viewport stage from lg. */
  scene: ReactNode;
  /** The condition word and the ONE cause→effect loop sentence — printed on
   *  the scene at every width. */
  condition: ReactNode;
  /** What changed since you last looked — one dismissible line. */
  beat: ReactNode;
  /** An unlock celebrating itself. */
  ceremony: ReactNode;
  /** Conditional banners only (timezone, calendar, sync). Empty = invisible. */
  plumbing: ReactNode;
  /** The one card (the new shape §4): the eyebrow, the session, its facts, the coach's line, the body check, Start
   *  and Ask — then, at its foot, the garden drawer's handle. */
  today: ReactNode;
  /** The history scrubber, when it is open. */
  timeline: ReactNode;
  /** Drawers and sheets — dialogs, so their position is their own (the garden drawer among them). */
  overlays: ReactNode;
}

export const GARDEN_PART_KEYS = [
  "plumbing",
  "scene",
  "condition",
  "ceremony",
  "today",
  "beat",
  "timeline",
  "overlays",
] as const satisfies ReadonlyArray<keyof GardenParts>;

/**
 * The garden, at every width. Below lg the stage is the reading column these
 * parts stack in; from lg the same nodes are positioned onto the artwork.
 *
 * DOM ORDER IS THE STACK ORDER below lg, with no `order` anywhere in the base
 * layer (System 3/4). The two wrappers that exist here are geometry, not
 * reshuffling: `.stage-hero` is the positioned box the condition overlay
 * needs below lg (from lg it is an inset-0 layer and every stage rule reads
 * through it), and `.stage-ledger` is `display: contents` below lg (streak
 * then beat, exactly the stack) and becomes the bottom-right corner box on
 * the stage.
 *
 * `plumbing` sits ABOVE the stage: a banner there is exactly what
 * `useSpaceAbove` already subtracts from the lg stage height, and on a phone
 * an actionable banner belongs before the picture, not woven into the story.
 */
export function GardenBody({
  parts,
  stageRef,
}: {
  parts: GardenParts;
  stageRef?: (el: HTMLElement | null) => void;
}) {
  const sceneMark = useContext(SceneMarkContext);
  return (
    <div className="garden-home">
      {/* The stage's largest type is the condition word, not this — the <h1>
          is hidden at both widths and the labelling stays consistent. */}
      <h1 className="visually-hidden">Today</h1>
      {parts.plumbing ? <div className="garden-plumbing">{parts.plumbing}</div> : null}
      <div className="garden-stage" ref={stageRef}>
        <div className="stage-hero">
          {parts.scene}
          <div className="stage-scrim stage-scrim-top" aria-hidden="true" />
          <div className="stage-scrim stage-scrim-bottom" aria-hidden="true" />
          <div className="hud-topleft">{parts.condition}</div>
          {/* The athlete's mark at the picture's top-right, on a phone (the shell hands it over: scene-mark.ts). */}
          {sceneMark ? <div className="athlete-row athlete-on-scene">{sceneMark}</div> : null}
        </div>
        {/* The celebration gets its own moment — centred on the stage, after
            the picture in the reading column below it. */}
        {parts.ceremony ? <div className="hud-ceremony">{parts.ceremony}</div> : null}
        <div className="hud-dock">{parts.today}</div>
        {/* The news of the day comes after the card (the integrated review, I1): on a phone the card leads, just
            under the picture; on the stage this is the bottom corner's box, wherever it sits in the DOM. */}
        <div className="stage-ledger">{parts.beat}</div>
        {parts.timeline ? <div className="stage-timeline">{parts.timeline}</div> : null}
      </div>
      {parts.overlays}
    </div>
  );
}

/** How far up a pull on the handle travels before it opens the drawer: past a thumb's wobble. */
export const PULL_OPENS_PX = 24;

/**
 * The garden drawer's handle, at the Today card's foot (the new shape §4): a real button — a tap opens "Your garden",
 * and so does a pull upward past a thumb's wobble (the pointer is held by the handle while it pulls). The grip is
 * drawn, never announced: the words say what it opens.
 */
export function GardenHandle({ open, onOpen }: { open: boolean; onOpen: () => void }) {
  const from = useRef<number | null>(null);
  return (
    <button
      type="button"
      className="garden-handle"
      aria-haspopup="dialog"
      aria-expanded={open}
      onClick={onOpen}
      onPointerDown={(e) => {
        from.current = e.clientY;
        if (typeof e.pointerId === "number") e.currentTarget.setPointerCapture?.(e.pointerId);
      }}
      onPointerMove={(e) => {
        if (from.current === null || from.current - e.clientY < PULL_OPENS_PX) return;
        from.current = null;
        onOpen();
      }}
      onPointerUp={() => {
        from.current = null;
      }}
      onPointerCancel={() => {
        from.current = null;
      }}
    >
      <span className="garden-handle-grip" aria-hidden="true" />
      Your garden
    </button>
  );
}

export function GardenScreen() {
  const units = useUnits();
  const sceneMark = useContext(SceneMarkContext);
  const garden = useQuery({ queryKey: ["garden"], queryFn: api.garden });
  const today = useQuery({ queryKey: ["today"], queryFn: api.today });
  // Sessions saved on this device and not yet taken by the server (Phase 2b) — read only on a day with an app session.
  const outboxRead = (today.data?.todaySessions ?? []).some((s) => isAppSession(s.workout)) || (today.data?.watchReviews?.length ?? 0) > 0;
  const pendingSaves = usePendingSaves(outboxRead);
  // The quick reviews offered (Phase 3) — less any this device saved that the server refused, the slot saved first.
  const refusedReviews = useRefusedReviews(outboxRead);
  const watchReviews = (today.data?.watchReviews ?? []).filter((o) => !refusedReviews.has(o.workoutId));
  // …each read ahead (audit 3-B UI-9): the service worker keeps the answer, so "Log your session" opens offline too —
  // Today itself comes from its cache — and online the sheet opens on it. Nothing is read while nothing is offered.
  const qc = useQueryClient();
  // Opened while a session on the page is updating on the watch (the watch mirrors the plan §3.7, §3.9: its row's
  // `watch_updating` — a push or a delete of its copy on its way): the app drains them now, one a request, rather than
  // leave them to the hourly's one an hour; then Today reads again what they changed. Not for any other COROS write (a
  // coach job is the coach drain's), so Today never asks a drain that would run nothing. Decided once, on the first
  // answer (`useWatchCatchUp`).
  useWatchCatchUp(today.data === undefined ? undefined : watchUpdatingOnToday(today.data), () => {
    for (const k of ["today", "plan", "plan-week"]) void qc.invalidateQueries({ queryKey: [k] });
  });
  const offered = watchReviews.map((o) => o.workoutId).join(" ");
  useEffect(() => {
    for (const id of offered ? offered.split(" ") : []) void qc.prefetchQuery(watchReviewQuery(id));
  }, [qc, offered]);
  const signedIn = useSignedInUserId();
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
  // The readiness sheet — the ONE place the morning numbers live (System 1
  // v2: the chip on the Today card opens it; no card repeats it).
  const [readinessOpen, setReadinessOpen] = useState(false);
  // The garden drawer ("Your garden"), pulled up from the card's foot (the new shape §4).
  const [gardenOpen, setGardenOpen] = useState(false);
  // The condition check sheet, opened from its chip beside readiness (Phase 2a).
  const [checkProfile, setCheckProfile] = useState<string | null>(null);

  // The arrival block: which ceremony is showing, and whether the text
  // lines were dismissed this mount. What counts as "new" comes from the
  // server-side watermark (selectArrival) — localStorage plays no part.
  const [ceremonyIndex, setCeremonyIndex] = useState(0);
  const [blockDismissed, setBlockDismissed] = useState(false);
  const seenPostedKeyRef = useRef<string | null>(null);
  const [replaying, setReplaying] = useState(false);
  const reducedMotion = usePrefersReducedMotion();
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
  // A deliberate tap on the ceremony's "taken root" line outranks the
  // arrival glow schedule — once the athlete points, the tour stops.
  const manualGlowRef = useRef(false);
  /**
   * The plant being PEEKED at while the pointer or keyboard focus rests on
   * the "taken root" line. It overlays `highlightPlantId` rather than
   * replacing it (see the scene's `highlightPlantId` prop below), so letting
   * go restores whatever was lit without this needing to remember it — and a
   * stray mouse-over can never corrupt the arrival tour's own state.
   */
  const [previewPlantId, setPreviewPlantId] = useState<string | null>(null);

  // The desktop stage is sized against the space it actually has, not the
  // window — one banner above it used to push the whole bottom HUD row off
  // the bottom of the screen (System 1 §4). A callback ref, not a ref object:
  // this component returns a <Spinner> until its query lands, so the stage
  // does not exist on the first commit and an effect keyed on a ref never
  // learns that it arrived.
  const stageRef = useSpaceAbove();

  // What the coach sees from Today: today's session (a rest day, the day) — the nav's Coach and the card's Ask pick it
  // up. Read from the payload as it stands, before the first paint's gate, as every hook must be.
  const seenLayout = todayCardLayout(today.data?.nextWorkout ?? null, today.data?.todaySessions ?? []);
  const seenLead =
    seenLayout.title?.kind === "program" ? seenLayout.title.session.workout : seenLayout.title?.kind === "run" ? seenLayout.title.workout : null;
  useCoachSeeing(!seenLead ? null : seenLead.category === "rest" ? dayFocus(seenLead.effectiveDate, { rest: true }) : workoutFocus(seenLead));

  // Fetched only once the scrubber is opened, then cached — scrubbing itself
  // is then all client-side (no per-frame requests).
  // not-structural: `enabled: timelineOpen`, so it cannot be in flight during
  // the first paint at all — it fills a panel the user deliberately opened,
  // and the panel says "Loading timeline…" in its own head while it does.
  const timeline = useQuery({
    queryKey: ["garden-timeline"],
    queryFn: api.gardenTimeline,
    enabled: timelineOpen,
    staleTime: 5 * 60_000,
  });

  // The next two weeks of the plan — keeps the forward scrub honest about
  // planned rest days (the run clock pauses on them) and plan gaps.
  // not-structural: same as `timeline` — `enabled: timelineOpen`, and it only
  // refines the projected days INSIDE the scrubber, never what exists.
  const clientToday = localTodayGuess();
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
  // What the block shows: the plan with the objectives' garden moments in its lines (Growth, the new shape §7).
  const arrivalShown = useArrivalShown(arrivalPlan, garden.data, today.data?.today);

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
    manualGlowRef.current = false;
    let i = 0;
    let timer = 0;
    const step = () => {
      if (manualGlowRef.current) return;
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

  // BOTH queries, not just the garden's. `/api/plan/today` feeds the card, the forecast and the drawer — so rendering
  // before it lands means rendering holes and then filling them: measured on a 390px phone with a 2.5s delay, the
  // card's sentence slid 141px sideways while the whole lower page dropped 621px.
  //
  // This is the recurring bug class in this codebase (a value derived while
  // its query is in flight), and its established answer here is: hold the
  // screen, then paint once. A background REFETCH is not `isLoading`, so a
  // stale-while-revalidate pass still paints immediately from cache — see
  // `settling` in components.tsx, which is this rule with a name.
  // No picture yet (loading, or it couldn't load): the athlete's mark keeps its way to Settings on a row of its own.
  const markRow = sceneMark ? <div className="athlete-row">{sceneMark}</div> : null;
  if (settling(garden, today))
    return (
      <>
        {markRow}
        <Spinner label="Loading the garden" />
      </>
    );
  // Read again after it failed: trying again, in the failure's place — not the failure, no longer so (`retrying`).
  if (!garden.data)
    return (
      <>
        {markRow}
        <EmptyState title={retrying(garden) ? TRYING_AGAIN : "Couldn't load the garden"} />
      </>
    );

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

  // The timeline is a mode of the scene, opened from the drawer: the drawer closes so the scene can be scrubbed, and
  // the card steps aside until the timeline closes (on the stage the two would share the same pixels; in the column the
  // card would push the scrubber below the picture it scrubs). A state, never a tier: the same at every width.
  function openTimeline() {
    setGardenOpen(false);
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
  const arrival = arrivalShown!;
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
  const sheltered = !!(adventure?.frozenToday || adventure?.graceDay);
  // C2: the run bar's decay clock (daysSinceCompletedRun) freezes under the
  // same two conditions — it must stop claiming "N d ago" recency while
  // frozen, or the HUD contradicts the very log/cards it sits above.
  const runClockSheltered = sheltered || restMode.active;
  // One loss voice at a time — and the forecast is ASKED which voice it is
  // using rather than having its branch conditions restated here (audit#4 D9;
  // the restatement had drifted, then died).
  const forecast =
    viewingLive && !restMode.active
      ? forecastVoice({
          snapshot,
          todayDate,
          daysAhead: daysSinceSimulated,
          nextWorkout: d?.nextWorkout,
          balance: liveBalance,
          adventure,
          dew: (garden.data.dewToday as boolean | undefined) ?? false,
        })
      : null;
  // Rest mode is not silence: `.hud-weather` prints "Rest mode — nothing
  // declines while you're away" in the same block the forecast would occupy,
  // and "The garden misses your runs" underneath would contradict it outright.
  // Everywhere else the forecast is quiet or reassuring (a shield, recovery
  // rain, a taper, or a plan gap with nothing to count down to), the bars are
  // the only thing that can speak for a starved discipline — so they do.
  const balanceQuiet = forecast?.kind === "loss" || restMode.active;

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

  // ONE derivation, read by the one row that voices it (D8, tightened in v2).
  const attention = gardenAttention(d);
  // The card exists when there is a workout to put in it — and steps aside while the timeline is open.
  const cardShown = planActive && !timelineOpen;
  // The best next thing, per axis — and what today's planned workout grows.
  const trio = nextUnlocksByDiscipline(codex);
  // Which session titles the card (Phase 2a): a run still to do today keeps it and each program session is a line
  // under it; on a program day the program session takes it. `todaySessions` is absent only from a payload cached
  // before it existed, which knows no program sessions.
  const todayLayout = todayCardLayout(d?.nextWorkout ?? null, d?.todaySessions ?? []);
  const lead =
    todayLayout.title?.kind === "program"
      ? todayLayout.title.session.workout
      : todayLayout.title?.kind === "run"
        ? todayLayout.title.workout
        : null;
  const grows = lead ? unlockGrownBy(codex, lead.category) : null;
  // A program session heading the card that is skipped, done or saved here is not today's to-do (2a UI re-review U6):
  // no pacing clause for it, no "Finishing it grows…".
  const leadPending = lead && todayLayout.title?.kind === "program" ? (pendingSaves[lead.id] ?? null) : null;
  // Its quick review, when the watch did it and the review is offered (Phase 3).
  const leadOffer = lead && todayLayout.title?.kind === "program" ? (watchReviews.find((o) => o.workoutId === lead.id) ?? null) : null;
  const leadSettled =
    todayLayout.title?.kind === "program" && !!lead && (sessionSkipped(lead) || sessionDone(lead) || leadPending !== null);
  const toggleBalanceKey = (k: DisciplineKey) =>
    setOpenBalanceKey((cur) => (cur === k ? null : k));

  // ── The "Lately" strip's content ──────────────────────────────────────
  // One loss voice, as ever (audit#4 D9) — but it now lives beside the meters
  // it is about, not on the scene. A calm forecast line (a shield, recovery
  // rain, a taper) speaks here too; when nothing speaks and no practiced axis
  // is in its damage zone, the meters collapse to one healthy sentence.
  const anyAxisLow =
    !!liveBalance &&
    BALANCE_BARS.some(({ key }) => {
      const { days, health } = liveBalance[key];
      return days !== null && health < DAMAGE_NOTCH[key];
    });
  const latelyCaption =
    forecast?.line ??
    (anyAxisLow && liveBalance ? WEAKEST_COPY[weakestDiscipline(liveBalance)] : null);
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
        <div className="row" style={{ gap: "var(--space-3)" }}>
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

  // The whole log. There used to be a twelve-item `historyItems` beside this
  // for a phone-only "Garden log" card; the rail opens the same drawer at
  // every width now, so there is one list.
  const fullLog = events
    .map((e) => ({ e, text: eventSentence(e) }))
    .filter((x): x is { e: GardenEvent; text: string } => !!x.text);

  const howItWorks = showWeather ? (
    <Banner kind="info" id="garden-how-it-works">
      Completing a planned run brings <strong>rain</strong>, which waters the garden and grows
      new plants; a rest day brings gentle <strong>sun</strong>. Go a few days without running
      and clouds gather, then a dry spell, then <strong>drought</strong> after about two weeks —
      your next run turns it back to recovery rain. Consistency unlocks new species; the same
      running history always grows the exact same garden. Tap any plant to see what it came
      from.
    </Banner>
  ) : null;

  // Conditional banners ONLY — on a healthy, home-timezone day this whole
  // part is null and the slot does not exist. The attention cards and the
  // readiness/evidence cards that used to live down here are gone: attention
  // is one row on the Today card (the answers live on Plan), readiness lives
  // in its sheet, evidence in the Lately strip.
  const calendarBanner =
    d && !d.sync.calendarConnected ? (
      <Banner kind="info">Calendar mirroring is paused.</Banner>
    ) : null;

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

  /* ── ONE tree, at every width (System 3 §D) ─────────────────────────────
     The garden used to return two DIFFERENT React trees — a full-viewport
     stage above 1024px and a flat card stack below it — and the difference
     had stopped being a difference of presentation. The readiness verdict
     (`DockVerdict`, shipped 2026-08-14), the coach's weekly line and the
     "N workouts need attention" link existed in the stage tree ONLY, so on a
     phone they were not styled differently, they were absent: a phone user
     had never seen the readiness card at all.

     So there is now one tree. `parts` names every piece of information the
     garden shows, `GardenBody` places all of them, and CSS decides whether
     that placement is a stack in the reading column or furniture positioned
     on the artwork. A new part cannot land on one viewport only, because
     there is only one place to put it. */
  // The workout the card is titled by — the next workout, unless today's sessions say otherwise (above).
  const w = lead;
  const verdict = d?.readiness.verdict ?? null;
  const streakData = d?.consistency ?? null;

  // ── The card's words ─────────────────────────────────────────────────────
  // The eyebrow names the day in the domain's words ("Today · Mon 5 Oct": one date format with the coach's chips).
  const eyebrow = w ? `${cap(relativeDay(w.effectiveDate, d?.today ?? todayDate))} · ${dayLabel(w.effectiveDate)}` : "";
  // ONE coach line, one sentence: the coach's own words for the week when it has written some, else the morning's
  // verdict applied to the day — never for a session already settled (there is nothing left to pace).
  const clause = leadSettled ? null : coachClause(verdict?.level, w?.category);
  const coachWords = d?.focus ? oneSentence(d.focus.text) : clause;
  const coachLine = coachWords ? (
    <div className="today-coach">
      <span className="today-coach-mark" aria-hidden="true">
        <IconCoach size={18} />
      </span>
      <p
        className="today-coach-body"
        title={
          d?.focus
            ? `Your coach's focus for the week, written ${formatDayShort(d.focus.at.slice(0, 10))} — not a comment on today's readiness.`
            : undefined
        }
      >
        <span className="today-coach-who">Coach</span> — {coachWords}
      </p>
    </div>
  ) : null;
  // What needs the athlete on the Plan, folded into the card's facts whatever leads it (D8: one derivation, one phrase;
  // the integrated review, I6).
  const attentionLink =
    attention.count > 0 ? (
      <Link
        className="today-attention"
        to={attention.count === 1 && attention.unresolved[0] ? `/plan?workout=${attention.unresolved[0].id}` : "/plan"}
      >
        ⚠ {attentionPhrase(attention.count)} <span aria-hidden="true">›</span>
      </Link>
    ) : null;
  // How's your body? — today's session, still to do (the body check keeps the answer and adapts the day: stream E). A
  // rest day's card has no place for it.
  const bodyCheck =
    lead && lead.effectiveDate === (d?.today ?? todayDate) && lead.completionState === "scheduled" && !leadSettled ? (
      <BodyCheck workout={lead} />
    ) : null;
  // What finishing today's session grows: the drawer's "next to bloom" leads with it.
  const growsLine =
    grows?.progress && lead && lead.category !== "rest" && !leadSettled ? (
      <button type="button" className="linklike garden-grows" onClick={() => setOpenSpeciesId(grows.speciesId)}>
        Finishing today&rsquo;s session grows the <span className="garden-grows-name">{grows.name}</span>
        {Math.max(0, grows.progress.target - grows.progress.current) === 1
          ? " — the last one needed"
          : grows.progress.target >= 1000
            ? ` · ${progressText(grows.progress, units)}`
            : ` — ${Math.max(0, grows.progress.target - grows.progress.current)} to go`}
      </button>
    ) : null;

  const parts: GardenParts = {
    scene: (
      <div className={`garden-scene${sceneFull ? " garden-scene-fullscreen" : ""}`}>
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
            // A peek wins while it lasts; underneath, the tour (or a
            // committed tap) keeps whatever it had.
            highlightPlantId={viewingLive ? (previewPlantId ?? highlightPlantId) : null}
            impulse={viewingLive ? impulse : null}
            // `slice` fills the hero crop below lg and the stage above it —
            // the box, not the svg's own aspect ratio, decides the height.
            preserveAspectRatio="xMidYMax slice"
            className="stage-scene-svg"
          />
        </div>
        {/* The scene's one tool (below lg): its fullscreen crop. The collection, the log and the timeline live in the
            garden drawer now (the new shape §4). */}
        <div className="scene-tools">
          <button
            type="button"
            className="scene-chip scene-full-toggle"
            aria-label={sceneFull ? "Exit fullscreen garden" : "View garden fullscreen"}
            onClick={() => setSceneFull((f) => !f)}
          >
            {sceneFull ? <IconClose size={14} /> : "⤢"}
          </button>
        </div>
      </div>
    ),

    condition: (
      <>
        <h2 className="hud-condition">{GARDEN_CONDITION_LABELS[displayCondition]}</h2>
        <p className="hud-weather">
          {viewingLive
            ? loopLine(weather, displaySnapshot.state.daysSinceCompletedRun)
            : viewingFuture
              ? `Projected: ${WEATHER_LABEL[weather]}`
              : `That day: ${WEATHER_LABEL[weather]}`}
        </p>
        {restMode.active ? (
          <p className="hud-weather">Rest mode — nothing declines while you're away.</p>
        ) : null}
      </>
    ),

    beat:
      viewingLive && (beatLinesAll.length > 0 || todayLinesAll.length > 0) ? (
        <p className="hud-beat">
          <span className="hud-beat-label">
            {beatLinesAll.length > 0 ? `Since ${formatDayShort(sinceLabel)}` : "Today"}
          </span>
          <span>{[...beatLinesAll, ...todayLinesAll].join(" ")}</span>
          {arrival.beatOverflow || arrival.todayOverflow ? (
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
      ) : null,

    ceremony: currentCeremony ? (
      <CeremonyCard
        ceremony={currentCeremony}
        codexEntry={codex.find((c) => c.speciesId === currentCeremony.speciesId)}
        queueLeft={arrival.ceremonies.length - ceremonyIndex - 1}
        snapshot={snapshot}
        onSeePlant={seePlantFromCeremony}
        onDismiss={dismissCeremony}
        onPreview={setPreviewPlantId}
        onHighlight={(plantId) => {
          manualGlowRef.current = true;
          setHighlightPlantId(plantId);
          // Below lg the ceremony sits under the hero — bring the plant's
          // scene back on screen so the glow is actually visible.
          document
            .querySelector(".stage-hero")
            ?.scrollIntoView({ behavior: reducedMotion ? "auto" : "smooth", block: "start" });
        }}
        variant="hud"
      />
    ) : null,

    plumbing:
      d ? (
        <>
          <TimezoneNudge />
          {d.sync.calendarConnected ? <SyncPanel quietWhenHealthy /> : calendarBanner}
        </>
      ) : null,

    /* THE one card (the new shape §4): about four parts where there were twelve — the eyebrow, the session (title and
       one line of facts), one coach line, the body check, Start and Ask; another session today one quiet row under
       "Also today". At its foot, the handle of the garden drawer. */
    today: (
      <>
        {/* An open batch of saved moves: at the top while it is open, Fit them in one tap away (the saves flow
            redesigned §3.1). */}
        <SavesTodayCard />
        {/* A session left in progress on this device — yesterday's, after midnight — stays one tap away (ruling
            2b-R16); today's own keep their Continue on the card below. */}
        <SessionsInProgress
          today={d?.today ?? todayDate}
          shown={(d?.todaySessions ?? []).map((s) => s.workout.id)}
          userId={signedIn}
        />
        {cardShown && w ? (
          <section className="dock-panel today-card" id="dock-panel" aria-label="Today">
            <div className="today-head">
              <span className="today-eyebrow">{eyebrow}</span>
              <span className="today-chips">
                {verdict ? (
                  <button
                    type="button"
                    className={`ready-chip ready-${verdict.level}`}
                    onClick={() => setReadinessOpen(true)}
                  >
                    <span className="ready-dot" aria-hidden="true" />
                    {VERDICT_PHRASE[verdict.level]} ›
                  </button>
                ) : null}
                {/* The condition check (Phase 2a): one chip per switched-on profile, only while a program is
                    active — the server sends none otherwise. */}
                <ConditionChips conditions={d?.conditions ?? []} onOpen={setCheckProfile} />
              </span>
            </div>
            {todayLayout.title?.kind === "program" ? (
              // A programme day's session leads with its own actions (Start, Open); the coach's line and the body check
              // sit between its lines and them, and Ask is the last of them.
              <TodayProgramLead
                session={todayLayout.title.session}
                today={d!.today}
                pending={leadPending}
                offer={leadOffer}
                beforeActions={
                  <>
                    {attentionLink}
                    {coachLine}
                    {bodyCheck}
                  </>
                }
                ask={<AskCoach focus={workoutFocus(todayLayout.title.session.workout)} />}
              />
            ) : w.category === "rest" ? (
              <>
                <h3 className="today-title">Rest day</h3>
                <p className="today-meta today-rest-line">{REST_LINE}</p>
                {attentionLink}
                {coachLine}
                <div className="btn-row today-actions">
                  <AskCoach focus={dayFocus(w.effectiveDate, { rest: true })} />
                </div>
              </>
            ) : (
              <>
                <h3 className="today-title">{w.title}</h3>
                <div className="today-facts">
                  <TodayMeta w={w} />
                  {watchCoverageShort(w.watchCoverage) ? (
                    <p className="faint watch-note-short">{watchCoverageShort(w.watchCoverage)}</p>
                  ) : null}
                  {syncActionShort(w.syncAction) ? (
                    <p className="faint watch-note-short">{syncActionShort(w.syncAction)}</p>
                  ) : null}
                  {attentionLink}
                </div>
                {coachLine}
                {bodyCheck}
                <div className="btn-row today-actions">
                  <Link className="btn btn-primary" to={`/plan?workout=${w.id}`}>
                    View workout
                  </Link>
                  {/* The coach, asked about this workout: the card's own Ask (the one per-object Ask left). */}
                  <AskCoach focus={workoutFocus(w)} />
                </div>
              </>
            )}
            <TodayProgramLines
              sessions={todayLayout.lines}
              today={d!.today}
              pending={pendingSaves}
              offers={watchReviews}
              leadId={todayLayout.title?.kind === "program" ? todayLayout.title.session.workout.id : null}
              heading="Also today"
            />
          </section>
        ) : null}
        {/* No plan: this is the guidance a new athlete's first screen needs (audit#4 D1). */}
        {!planActive ? (
          <div className="dock-panel dock-noplan">
            <EmptyState art="🌿" title="Nothing planned yet">
              Ask the coach for a run, a strength session or some mobility — or start a plan in COROS; it syncs in
              once COROS is connected in Settings.
            </EmptyState>
          </div>
        ) : null}
        <GardenHandle open={gardenOpen} onOpen={() => setGardenOpen(true)} />
      </>
    ),

    timeline: timelineOpen ? timelinePanel : null,

    overlays: (
      <>
        {/* THE GARDEN DRAWER (the new shape §4): everything of the garden's that is not the picture — next to bloom,
            twelve weeks, last trained, the collection, the log and the timeline, Growth, and how the garden works. */}
        <Sheet open={gardenOpen} onClose={() => setGardenOpen(false)} title="Your garden">
          <div className="garden-drawer">
            <section className="garden-drawer-sec" aria-labelledby="garden-bloom-h">
              <h3 className="garden-drawer-h" id="garden-bloom-h">
                Next to bloom
              </h3>
              <NextToBloom codex={codex} todayDate={todayDate} grows={growsLine} onOpenSpecies={setOpenSpeciesId} />
            </section>
            {streakData && streakData.adherencePct !== null ? (
              <section className="garden-drawer-sec" aria-labelledby="garden-weeks-h">
                <h3 className="garden-drawer-h" id="garden-weeks-h">
                  Twelve weeks
                </h3>
                <div className="streak-band">
                  <div className="streak-row">
                    {streakData.streakWeeks > 0 ? (
                      <>
                        <span className="streak-n">
                          {streakData.streakWeeks} week{streakData.streakWeeks === 1 ? "" : "s"}
                        </span>
                        <span className="streak-word">consistent</span>
                        <span className="streak-pct">{streakData.adherencePct}% of plan</span>
                      </>
                    ) : (
                      <>
                        <span className="streak-n">{streakData.adherencePct}%</span>
                        <span className="streak-word">of plan done</span>
                      </>
                    )}
                  </div>
                  <div
                    className="streak-weeks"
                    role="img"
                    aria-label={`Last 12 weeks: ${streakData.weeks.filter((x) => x.band === "full").length} on plan, ${streakData.weeks.filter((x) => x.band === "partial").length} partial`}
                  >
                    {streakData.weeks.map((x) => (
                      <span key={x.weekStart} className={`streak-week streak-${x.band}`} title={`Week of ${formatDayShort(x.weekStart)}`} />
                    ))}
                  </div>
                </div>
              </section>
            ) : null}
            {liveBalance ? (
              <section className="garden-drawer-sec lately" aria-labelledby="garden-trained-h">
                <h3 className="garden-drawer-h" id="garden-trained-h">
                  Last trained
                </h3>
                <BalanceStrip
                  balance={liveBalance}
                  runPaused={!planActive && runDecayPaused}
                  runSheltered={runClockSheltered}
                  runTrueRecencyDays={runTrueRecencyDays}
                  quiet
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
                {latelyCaption ? (
                  <p className={`lately-cap${forecast?.kind === "loss" || anyAxisLow ? " lately-cap-loss" : ""}`}>
                    {latelyCaption}
                  </p>
                ) : null}
              </section>
            ) : null}
            <div className="garden-drawer-tools">
              <button
                type="button"
                className="btn btn-small"
                onClick={() => {
                  setGardenOpen(false);
                  setOpenDrawer("collection");
                }}
              >
                Collection · {unlockedCount} of {codex.length}
              </button>
              <button
                type="button"
                className="btn btn-small"
                onClick={() => {
                  setGardenOpen(false);
                  setOpenDrawer("log");
                }}
              >
                Garden log
              </button>
              <button type="button" className="btn btn-small" aria-expanded={timelineOpen} onClick={openTimeline}>
                Timeline
              </button>
            </div>
            <ReviewPull />
            <Link className="garden-drawer-growth" to="/growth">
              All of your growth <span aria-hidden="true">›</span>
            </Link>
            <div className="garden-drawer-foot">
              <p className="howworks">
                {/* The label does NOT change (System 4 D4) — aria-expanded and the caret carry the state, so the box
                    never re-wraps under the finger that opened it. */}
                <button
                  type="button"
                  className="linklike"
                  aria-expanded={showWeather}
                  aria-controls="garden-how-it-works"
                  onClick={() => setShowWeather((v) => !v)}
                >
                  How the garden works
                  <span className="disclosure-caret" aria-hidden>
                    {showWeather ? "▾" : "▸"}
                  </span>
                </button>
              </p>
              {howItWorks}
            </div>
          </div>
        </Sheet>
        <Drawer
          open={openDrawer === "collection"}
          onClose={() => setOpenDrawer(null)}
          title={`Collection · ${unlockedCount} of ${codex.length}`}
        >
          <div className="drawer-section">
            <h3 className="card-title">Growing next — per workout type</h3>
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
        {readinessOpen && d ? (
          <ReadinessSheet readiness={d.readiness} onClose={() => setReadinessOpen(false)} />
        ) : null}
        {(() => {
          const c = checkProfile ? d?.conditions?.find((x) => x.profileId === checkProfile) : undefined;
          return c ? <ConditionCheckSheet condition={c} onClose={() => setCheckProfile(null)} /> : null;
        })()}
        {sheets}
      </>
    ),
  };

  return <GardenBody parts={parts} stageRef={stageRef} />;
}
