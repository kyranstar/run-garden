/**
 * Standalone Run Garden garden showcase.
 *
 * This drives the REAL garden engine (initialSnapshot → simulateDay) with a
 * realistic ~9-month training history and renders the REAL SVG renderer
 * (GardenScene) at each stage — so it's a faithful demo of the living garden's
 * visuals and animations across every progression, not a mock-up.
 *
 * Built to a single self-contained HTML file via esbuild (see build.mjs).
 */
import { useMemo, useRef, useState, useEffect } from "react";
import { createRoot } from "react-dom/client";
import { GardenScene } from "@rg/garden-renderer";
import {
  initialSnapshot,
  simulateDay,
  conditionWord,
  DEFAULT_GARDEN_CONFIG,
  type GardenSnapshot,
  type GardenDayInput,
  type CompletedRunInput,
} from "@rg/garden-engine";
import { GARDEN_CONDITION_LABELS, type GardenWeatherState } from "@rg/domain";

const START = "2026-01-01";
const DAYS = 288;

function isoOf(d: Date): string {
  return d.toISOString().slice(0, 10);
}
function addDays(iso: string, n: number): string {
  const d = new Date(iso + "T00:00:00Z");
  d.setUTCDate(d.getUTCDate() + n);
  return isoOf(d);
}
function weekday(iso: string): number {
  return new Date(iso + "T00:00:00Z").getUTCDay(); // 0 = Sun
}

/** A believable week: rest Mon, quality Tue, easy mid-week, long on the weekend,
 *  with a deliberate ~3-week drought (days 132–152) to show wilting → drought →
 *  comeback rain, plus the occasional missed run. */
function dayInputFor(date: string, idx: number): GardenDayInput {
  const wd = weekday(date);
  const inDrought = idx >= 132 && idx < 152;
  const runs: CompletedRunInput[] = [];
  let restObserved = false;
  const missedRuns: GardenDayInput["missedRuns"] = [];

  if (!inDrought) {
    switch (wd) {
      case 1:
        restObserved = true;
        break;
      case 2:
        runs.push({ workoutId: `w-${date}`, category: "quality" });
        break;
      case 3:
        runs.push({ workoutId: `w-${date}`, category: "easy" });
        break;
      case 4:
        runs.push({ workoutId: `w-${date}`, category: "easy", window: "evening" });
        break;
      case 5:
        runs.push({ workoutId: `w-${date}`, category: "recovery" });
        break;
      case 6:
        runs.push({ workoutId: `w-${date}`, category: idx % 14 < 7 ? "easy" : "long" });
        break;
      case 0:
        runs.push({ workoutId: `w-${date}`, category: "long" });
        break;
    }
    // A stray real-life miss now and then.
    if (idx % 41 === 0 && wd !== 1 && runs.length) {
      runs.length = 0;
      missedRuns.push({ workoutId: `w-${date}` });
    }
    // One bonus, unplanned run to show the "extra run" reward.
    if (idx === 200) runs.push({ workoutId: `bonus-${date}`, category: "easy", unplanned: true });
  }

  return {
    date,
    completedRuns: runs,
    restObserved,
    missedRuns,
    restModeActive: false,
    planGap: false,
    weekAdherence: wd === 1 ? (inDrought ? 0.15 : 0.85) : undefined,
  };
}

interface Frame {
  idx: number;
  date: string;
  snapshot: GardenSnapshot;
}

function buildProgression(): Frame[] {
  let snap = initialSnapshot(START);
  const frames: Frame[] = [{ idx: 0, date: START, snapshot: snap }];
  for (let i = 1; i <= DAYS; i++) {
    const date = addDays(START, i);
    snap = simulateDay(snap, dayInputFor(date, i), DEFAULT_GARDEN_CONFIG).snapshot;
    frames.push({ idx: i, date, snapshot: snap });
  }
  return frames;
}

function livingPlants(s: GardenSnapshot): number {
  return s.plants.filter((p) => p.state !== "dead").length;
}
function conditionLabel(s: GardenSnapshot): string {
  return GARDEN_CONDITION_LABELS[conditionWord(s.state, DEFAULT_GARDEN_CONFIG)] ?? "—";
}
function prettyDate(iso: string): string {
  return new Date(iso + "T00:00:00Z").toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
    year: "numeric",
    timeZone: "UTC",
  });
}

const WEATHERS: { state: GardenWeatherState; label: string }[] = [
  { state: "clear_sun", label: "Clear sun" },
  { state: "soft_sun", label: "Soft sun" },
  { state: "light_clouds", label: "Light clouds" },
  { state: "seasonal_breeze", label: "Seasonal breeze" },
  { state: "fresh_rain", label: "Fresh rain" },
  { state: "recovery_rain", label: "Recovery rain" },
  { state: "dry_spell", label: "Dry spell" },
  { state: "mild_drought", label: "Mild drought" },
];

function withWeather(s: GardenSnapshot, weather: GardenWeatherState): GardenSnapshot {
  return { ...s, state: { ...s.state, weatherState: weather } };
}

/** Curated milestones, picked from the real progression. */
function milestones(frames: Frame[]): { frame: Frame; title: string; blurb: string }[] {
  const at = (i: number) => frames[Math.min(i, frames.length - 1)]!;
  const genesisCount = livingPlants(frames[0]!.snapshot);
  const firstGrowth = frames.find((f) => livingPlants(f.snapshot) > genesisCount) ?? at(14);
  const droughtPeak = frames[151]!;
  const comeback = frames[168]!;
  const last = frames[frames.length - 1]!;
  return [
    { frame: frames[0]!, title: "Genesis", blurb: "Day one — bare, hopeful ground." },
    { frame: firstGrowth, title: "First growth", blurb: "The earliest runs take root." },
    { frame: at(70), title: "Established", blurb: "A steady block of training fills the garden in." },
    { frame: droughtPeak, title: "Drought", blurb: "Three weeks off — the garden wilts and dries." },
    { frame: comeback, title: "Comeback rain", blurb: "The first run back brings the rain." },
    { frame: last, title: "Flourishing", blurb: "Nine months of consistency — a full ecosystem." },
  ];
}

function Stat({ label, value }: { label: string; value: string | number }) {
  return (
    <div className="stat">
      <div className="stat-value">{value}</div>
      <div className="stat-label">{label}</div>
    </div>
  );
}

function App() {
  const frames = useMemo(buildProgression, []);
  const [day, setDay] = useState(frames.length - 1);
  const [playing, setPlaying] = useState(false);
  const [reduced, setReduced] = useState(false);
  const timer = useRef<number | null>(null);

  useEffect(() => {
    if (!playing) return;
    timer.current = window.setInterval(() => {
      setDay((d) => {
        if (d >= frames.length - 1) return 0;
        return d + 3;
      });
    }, 90);
    return () => {
      if (timer.current) window.clearInterval(timer.current);
    };
  }, [playing, frames.length]);

  const frame = frames[Math.min(day, frames.length - 1)]!;
  const lushFrame = frames[frames.length - 1]!;
  const stones = useMemo(() => milestones(frames), [frames]);

  return (
    <div className="wrap">
      <header className="hero">
        <div className="leaf" aria-hidden>
          🌿
        </div>
        <h1>Run Garden</h1>
        <p className="tagline">
          A living garden that grows from your running. Every stage below is the real garden
          engine and renderer, driven by a realistic nine-month training history.
        </p>
        <label className="motion">
          <input type="checkbox" checked={reduced} onChange={(e) => setReduced(e.target.checked)} />
          Reduce motion
        </label>
      </header>

      <section className="panel">
        <div className="panel-head">
          <h2>Grow it in real time</h2>
          <p className="muted">Scrub through nine months, or press play and watch it grow.</p>
        </div>
        <div className="scene-frame big">
          <GardenScene snapshot={frame.snapshot} reducedMotion={reduced} idPrefix="rg-timeline" />
        </div>
        <div className="stats">
          <Stat label="Day" value={frame.idx} />
          <Stat label="Date" value={prettyDate(frame.date)} />
          <Stat label="Condition" value={conditionLabel(frame.snapshot)} />
          <Stat label="Living plants" value={livingPlants(frame.snapshot)} />
          <Stat label="Species" value={frame.snapshot.unlockedSpeciesIds.length} />
          <Stat label="Season" value={cap(frame.snapshot.state.season)} />
        </div>
        <div className="controls">
          <button className="play" onClick={() => setPlaying((p) => !p)}>
            {playing ? "❚❚ Pause" : "► Play"}
          </button>
          <input
            className="scrub"
            type="range"
            min={0}
            max={frames.length - 1}
            value={day}
            onChange={(e) => {
              setPlaying(false);
              setDay(Number(e.target.value));
            }}
          />
        </div>
      </section>

      <section className="panel">
        <div className="panel-head">
          <h2>Milestones</h2>
          <p className="muted">Key moments pulled straight from the progression above.</p>
        </div>
        <div className="grid">
          {stones.map((m) => (
            <figure className="card" key={m.title}>
              <div className="scene-frame">
                <GardenScene
                  snapshot={m.frame.snapshot}
                  reducedMotion={reduced}
                  idPrefix={`rg-m-${m.frame.idx}`}
                />
              </div>
              <figcaption>
                <div className="card-title">{m.title}</div>
                <div className="muted">{m.blurb}</div>
                <div className="faint">
                  Day {m.frame.idx} · {conditionLabel(m.frame.snapshot)} ·{" "}
                  {livingPlants(m.frame.snapshot)} plants
                </div>
              </figcaption>
            </figure>
          ))}
        </div>
      </section>

      <section className="panel">
        <div className="panel-head">
          <h2>Every kind of weather</h2>
          <p className="muted">
            The same flourishing garden under all eight weather states — rain, sun, clouds, breeze,
            and drought each animate differently.
          </p>
        </div>
        <div className="grid">
          {WEATHERS.map((w) => (
            <figure className="card" key={w.state}>
              <div className="scene-frame">
                <GardenScene
                  snapshot={withWeather(lushFrame.snapshot, w.state)}
                  reducedMotion={reduced}
                  idPrefix={`rg-w-${w.state}`}
                />
              </div>
              <figcaption>
                <div className="card-title">{w.label}</div>
              </figcaption>
            </figure>
          ))}
        </div>
      </section>

      <footer className="foot">
        Deterministic by design — the same running history always grows the same garden. Tap any
        plant to inspect it.
      </footer>
    </div>
  );
}

function cap(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

const root = document.getElementById("root");
if (root) createRoot(root).render(<App />);
