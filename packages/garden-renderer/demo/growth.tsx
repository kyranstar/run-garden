/**
 * Day-by-day growth sampler.
 *
 * Replays the same kind of fixture as matrix.tsx (a steady, healthy training
 * pattern — Tue quality, Thu easy, Sat long, Sun recovery) but, instead of
 * only keeping the final snapshot, captures one snapshot for EVERY simulated
 * day so the sequence can be played back as a timelapse. Each day is shown at
 * a fixed golden-hour, summer look (season/time overridden the same way
 * matrix.tsx's `variant()` overrides display-only state fields on top of a
 * real snapshot) so only the garden itself changes frame to frame — the
 * fixture that build-growth.mjs (esbuild → self-contained HTML) and
 * shoot-growth.mjs (playwright → docs/images/garden-growth.gif) turn into
 * the project's day-by-day growth GIF.
 *
 * Drives the REAL garden engine (`initialSnapshot` + `simulateDay`) and the
 * REAL renderer (`GardenScene`). Self-contained (does NOT import from
 * matrix.tsx or demo/index.tsx) so it can be esbuild-bundled on its own.
 */
import { useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { GardenScene } from "@rg/garden-renderer";
import { initialSnapshot, simulateDay, type GardenDayInput, type GardenSnapshot } from "@rg/garden-engine";
import { addDays } from "@rg/domain";
import type { WorkoutCategory } from "@rg/domain";

const START = "2026-03-02"; // a Monday — same fixture start as matrix.tsx
const WEEKS = 8; // 56 training days + genesis day 0 = 57 frames

/** Golden-hour anchor for summer — see lighting.ts SUNSET.summer (19.9) − 1.2. */
const GOLDEN_HOUR = 18.7;

function emptyDay(date: string): GardenDayInput {
  return {
    date,
    completedRuns: [],
    restObserved: false,
    missedRuns: [],
    restModeActive: false,
    planGap: false,
  };
}

function runDay(
  date: string,
  category: WorkoutCategory,
  extra: Partial<GardenDayInput> = {},
): GardenDayInput {
  return {
    ...emptyDay(date),
    completedRuns: [{ workoutId: `w-${date}`, category }],
    ...extra,
  };
}

/** Same standard training pattern as matrix.tsx: Tue quality, Thu easy, Sat long, Sun recovery. */
function trainingWeeks(startMonday: string, weeks: number): GardenDayInput[] {
  const days: GardenDayInput[] = [];
  for (let w = 0; w < weeks; w++) {
    const mon = addDays(startMonday, w * 7);
    days.push({ ...emptyDay(mon), restObserved: true, weekAdherence: w > 0 ? 1 : undefined });
    days.push(runDay(addDays(mon, 1), "quality"));
    days.push({ ...emptyDay(addDays(mon, 2)), restObserved: true });
    days.push(runDay(addDays(mon, 3), "easy"));
    days.push({ ...emptyDay(addDays(mon, 4)), restObserved: true });
    days.push(runDay(addDays(mon, 5), "long"));
    days.push(runDay(addDays(mon, 6), "recovery"));
  }
  return days;
}

interface Frame {
  day: number;
  date: string;
  snapshot: GardenSnapshot;
}

/** Day 0 is the bare, just-planted garden; day N is after N days of the fixture above. */
function buildFrames(): Frame[] {
  let snapshot = initialSnapshot(START);
  const frames: Frame[] = [{ day: 0, date: START, snapshot }];
  for (const [i, input] of trainingWeeks(START, WEEKS).entries()) {
    snapshot = simulateDay(snapshot, input).snapshot;
    frames.push({ day: i + 1, date: input.date, snapshot });
  }
  return frames;
}

const FRAMES = buildFrames();

/**
 * Force the flattering golden-hour, summer look. Only display-only state
 * fields change (same technique as matrix.tsx's `variant()`) — the
 * underlying growth (plants, species, moisture) is untouched. Real
 * day-to-day weather (rain after a run, clear skies a couple of days later)
 * is left alone: that variation IS the growth story.
 */
function forDisplay(snapshot: GardenSnapshot): GardenSnapshot {
  return { ...snapshot, state: { ...snapshot.state, season: "summer" } };
}

declare global {
  interface Window {
    __growth?: { frameCount: number; setDay: (day: number) => void };
  }
}

function App() {
  const [day, setDay] = useState(0);

  // Exposed for shoot-growth.mjs, which drives the single mounted scene
  // through every day and screenshots it, rather than mounting all ~57 days
  // (and their atmosphere canvases) at once.
  useEffect(() => {
    window.__growth = { frameCount: FRAMES.length, setDay };
  }, []);

  const frame = FRAMES[Math.min(day, FRAMES.length - 1)]!;

  return (
    <div id="stage">
      <section id="growth-frame" data-day={frame.day} className="scene-frame" style={{ width: 720, aspectRatio: "1000/560" }}>
        <GardenScene snapshot={forDisplay(frame.snapshot)} timeOfDay={GOLDEN_HOUR} atmosphere idPrefix="gr" />
        <div className="day-badge">Day {frame.day}</div>
      </section>
    </div>
  );
}

const root = document.getElementById("root");
if (root) createRoot(root).render(<App />);
