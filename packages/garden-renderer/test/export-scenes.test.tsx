import { writeFileSync } from "node:fs";
import { renderToStaticMarkup } from "react-dom/server";
import { it } from "vitest";
import { addDays } from "@rg/domain";
import { replay, simulateDay, type GardenDayInput, type GardenSnapshot } from "@rg/garden-engine";
import { GardenScene } from "../src/index";

/**
 * Env-gated visual-review exporter, not a test: with EXPORT_DIR set it writes
 * the four review scenes (golden / noon / night / drought) as standalone HTML
 * for `dev/shots.sh` to screenshot. Skipped entirely in normal runs.
 */

const START = "2026-03-02"; // a Monday

const emptyDay = (date: string): GardenDayInput => ({
  date,
  completedRuns: [],
  restObserved: false,
  missedRuns: [],
  restModeActive: false,
  planGap: false,
});

function trainingWeeks(startMonday: string, weeks: number): GardenDayInput[] {
  const days: GardenDayInput[] = [];
  for (let w = 0; w < weeks; w++) {
    const mon = addDays(startMonday, w * 7);
    days.push({ ...emptyDay(mon), restObserved: true, weekAdherence: w > 0 ? 1 : undefined });
    days.push({ ...emptyDay(addDays(mon, 1)), completedRuns: [{ workoutId: `w-q${w}`, category: "quality" }] });
    days.push({ ...emptyDay(addDays(mon, 2)), restObserved: true });
    days.push({ ...emptyDay(addDays(mon, 3)), completedRuns: [{ workoutId: `w-e${w}`, category: "easy" }] });
    days.push({ ...emptyDay(addDays(mon, 4)), restObserved: true });
    days.push({ ...emptyDay(addDays(mon, 5)), completedRuns: [{ workoutId: `w-l${w}`, category: "long" }] });
    days.push({ ...emptyDay(addDays(mon, 6)), completedRuns: [{ workoutId: `w-r${w}`, category: "recovery" }] });
  }
  return days;
}

function droughtSnapshot(): GardenSnapshot {
  let s = replay(START, trainingWeeks(START, 4)).snapshot;
  let date = addDays(START, 28);
  for (let i = 0; i < 16; i++) {
    s = simulateDay(s, emptyDay(date)).snapshot;
    date = addDays(date, 1);
  }
  return s;
}

function matureSnapshot(): GardenSnapshot {
  // 20 weeks of training, then two observed rest days to settle off fresh_rain.
  let s = replay(START, trainingWeeks(START, 20)).snapshot;
  s = simulateDay(s, { ...emptyDay(addDays(START, 140)), restObserved: true }).snapshot;
  s = simulateDay(s, { ...emptyDay(addDays(START, 141)), restObserved: true }).snapshot;
  return s;
}

it.runIf(process.env.EXPORT_DIR)("exports grainlight review scenes", () => {
  const healthy = replay(START, trainingWeeks(START, 6)).snapshot;
  const scenes: Array<[string, GardenSnapshot, number]> = [
    ["golden", healthy, 17.5],
    ["noon", healthy, 13],
    ["night", healthy, 22.5],
    ["drought", droughtSnapshot(), 17.5],
    ["mature", matureSnapshot(), 17.5],
  ];
  for (const [name, snap, hour] of scenes) {
    const svg = renderToStaticMarkup(<GardenScene snapshot={snap} timeOfDay={hour} reducedMotion={true} />);
    writeFileSync(
      `${process.env.EXPORT_DIR}/${name}.html`,
      `<!doctype html><html><head><meta charset="utf-8"><style>body{margin:0}svg{display:block;width:100vw;height:100vh}</style></head><body>${svg}</body></html>`,
    );
  }
});
