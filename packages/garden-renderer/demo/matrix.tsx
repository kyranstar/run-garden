/**
 * State-matrix sampler.
 *
 * Renders the design spec's 18 signature weather/season/time-of-day states
 * side by side, each in its own labeled, addressable `<section id>` — the
 * fixture that build-matrix.mjs (esbuild → self-contained HTML) and
 * shoot-matrix.mjs (playwright → docs/images/matrix/*.png) turn into the
 * project's second visual checkpoint.
 *
 * Drives the REAL garden engine (`replay`) to build one healthy training
 * snapshot, then forces state fields per shot — snapshots are plain objects,
 * so overriding is just object-spread (`variant` below). This file is
 * self-contained (does NOT import from demo/index.tsx or any test file) so
 * it can be esbuild-bundled on its own.
 */
import { createRoot } from "react-dom/client";
import { GardenScene } from "@rg/garden-renderer";
import { replay, type GardenDayInput, type GardenSnapshot } from "@rg/garden-engine";
import { addDays } from "@rg/domain";
import type { GardenSeason, GardenWeatherState, WorkoutCategory } from "@rg/domain";

const START = "2026-03-02"; // a Monday

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

/** Simulate a standard training pattern for n weeks: Tue quality, Thu easy, Sat long, Sun recovery. */
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

/** 6 training weeks ending on a Sunday recovery run → fresh_rain, healthy garden. */
function healthySnapshot(): GardenSnapshot {
  return replay(START, trainingWeeks(START, 6)).snapshot;
}

function variant(
  base: GardenSnapshot,
  weather: GardenWeatherState,
  season: GardenSeason,
  extra: Partial<GardenSnapshot["state"]> = {},
): GardenSnapshot {
  return { ...base, state: { ...base.state, weatherState: weather, season, ...extra } };
}

// The spec's 18 shots:
const SHOTS: Array<{
  id: string;
  weather: GardenWeatherState;
  season: GardenSeason;
  hour: number;
  extra?: Partial<GardenSnapshot["state"]>;
}> = [
  { id: "fresh_rain--summer--13", weather: "fresh_rain", season: "summer", hour: 13 },
  {
    id: "recovery_rain--summer--18.9",
    weather: "recovery_rain",
    season: "summer",
    hour: 18.9,
    extra: { inComeback: true },
  },
  { id: "clear_sun--summer--10", weather: "clear_sun", season: "summer", hour: 10 },
  { id: "soft_sun--summer--6.2", weather: "soft_sun", season: "summer", hour: 6.2 },
  { id: "soft_sun--summer--9", weather: "soft_sun", season: "summer", hour: 9 },
  { id: "soft_sun--summer--13", weather: "soft_sun", season: "summer", hour: 13 },
  { id: "soft_sun--summer--18.9", weather: "soft_sun", season: "summer", hour: 18.9 },
  { id: "soft_sun--summer--20.5", weather: "soft_sun", season: "summer", hour: 20.5 },
  { id: "soft_sun--summer--23.5", weather: "soft_sun", season: "summer", hour: 23.5 },
  { id: "light_clouds--summer--13", weather: "light_clouds", season: "summer", hour: 13 },
  { id: "seasonal_breeze--summer--15", weather: "seasonal_breeze", season: "summer", hour: 15 },
  {
    id: "dry_spell--summer--13",
    weather: "dry_spell",
    season: "summer",
    hour: 13,
    extra: { moisture: 0.35, droughtDays: 5 },
  },
  {
    id: "mild_drought--summer--13",
    weather: "mild_drought",
    season: "summer",
    hour: 13,
    extra: { moisture: 0.15, droughtDays: 9 },
  },
  { id: "soft_sun--spring--18", weather: "soft_sun", season: "spring", hour: 18 },
  { id: "soft_sun--summer--18.9-golden", weather: "soft_sun", season: "summer", hour: 18.9 },
  { id: "soft_sun--autumn--17", weather: "soft_sun", season: "autumn", hour: 17 },
  { id: "soft_sun--winter--16", weather: "soft_sun", season: "winter", hour: 16 },
  {
    id: "clear_sun--summer--23.5-fireflies",
    weather: "clear_sun",
    season: "summer",
    hour: 23.5,
  },
];

function App() {
  const base = healthySnapshot();
  return (
    <div className="wrap">
      <header className="hero">
        <h1>Run Garden — state matrix</h1>
        <p className="tagline">
          The spec's 18 signature weather × season × time-of-day states, rendered from the same
          healthy garden snapshot with only state fields overridden. Reference set for the visual
          checkpoint.
        </p>
      </header>
      <div className="grid">
        {SHOTS.map((shot, i) => (
          <figure className="cell" key={shot.id}>
            <section id={shot.id} className="scene-frame" style={{ width: 900, aspectRatio: "1000/560" }}>
              <GardenScene
                snapshot={variant(base, shot.weather, shot.season, shot.extra)}
                timeOfDay={shot.hour}
                atmosphere
                idPrefix={`mx${i}`}
              />
            </section>
            <figcaption>{shot.id}</figcaption>
          </figure>
        ))}
      </div>
    </div>
  );
}

const root = document.getElementById("root");
if (root) createRoot(root).render(<App />);
