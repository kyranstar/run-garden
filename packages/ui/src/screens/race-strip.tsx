import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api, type RaceHubResponse } from "@rg/api-client";
import { formatClock, formatDistance, formatPace, formatShortDate, type Units } from "../components.js";

/**
 * The race strip (race hub, 2026-08-14): a collapsed one-line bar above the
 * weekly brief while a race day is set, expanding into countdown arc, the
 * COROS-threshold goal band, the stamina trend, the checklist, and the
 * coach's race line. Post-race it becomes a short debrief, then hides
 * (server returns race: null two weeks after race day).
 */

/** Races are named by their metric distance the world over ("a 10K"), so
 * the common ones keep their name in either unit system; anything else
 * renders as a plain distance. */
function raceDistanceLabel(km: number, units: Units): string {
  if (Math.abs(km - 5) < 0.05) return "5K";
  if (Math.abs(km - 10) < 0.05) return "10K";
  if (Math.abs(km - 21.0975) < 0.3) return "Half marathon";
  if (Math.abs(km - 42.195) < 0.5) return "Marathon";
  return formatDistance(km * 1000, units);
}

const PHASE_LABEL: Record<NonNullable<RaceHubResponse["race"]>["phase"], string> = {
  build: "building",
  taper: "tapering",
  race_week: "race week",
  post: "raced",
};

function StaminaSpark({ points }: { points: Array<{ date: string; value: number }> }) {
  if (points.length < 2) return null;
  const w = 120;
  const h = 28;
  const min = Math.min(...points.map((p) => p.value));
  const max = Math.max(...points.map((p) => p.value));
  const x = (i: number) => 2 + (i / (points.length - 1)) * (w - 4);
  const y = (v: number) => (max === min ? h / 2 : 3 + (1 - (v - min) / (max - min)) * (h - 6));
  const d = points.map((p, i) => `${i === 0 ? "M" : "L"}${x(i).toFixed(1)} ${y(p.value).toFixed(1)}`).join(" ");
  return (
    <svg className="race-stamina-spark" viewBox={`0 0 ${w} ${h}`} aria-hidden focusable="false">
      <path d={d} fill="none" stroke="var(--chart-1)" strokeWidth="2" strokeLinecap="round" />
      <circle cx={x(points.length - 1)} cy={y(points.at(-1)!.value)} r="3" fill="var(--chart-1)" />
    </svg>
  );
}

/** build → taper → race, today marked. Pure time geometry, no adherence. */
function TaperArc({ race }: { race: NonNullable<RaceHubResponse["race"]> }) {
  // The span must always contain TODAY: a fixed 63-day window welded the
  // marker to the left edge whenever the race was further out (audit#3-b #5).
  const total = Math.max(63, race.daysToRace + 7);
  const spanStart = Date.parse(race.raceDate) - total * 86_400_000;
  const pct = (d: string) =>
    Math.min(100, Math.max(0, ((Date.parse(d) - spanStart) / 86_400_000 / total) * 100));
  const taperPct = pct(race.taperStartDate);
  const todayPct = Math.min(100, Math.max(0, 100 - (race.daysToRace / total) * 100));
  return (
    <div className="race-arc" aria-label={`Race in ${race.daysToRace} days, taper starts ${race.taperStartDate}`}>
      <div className="race-arc-track">
        <i className="race-arc-taper" style={{ left: `${taperPct}%` }} />
        <b className="race-arc-today" style={{ left: `${todayPct}%` }} />
      </div>
      {/* Labels sit under their own ticks rather than spreading evenly. */}
      <div className="race-arc-labels faint num">
        <span style={{ left: 0 }}>build</span>
        <span style={{ left: `${taperPct}%`, transform: "translateX(-50%)" }}>
          taper · {formatShortDate(race.taperStartDate)}
        </span>
        <span style={{ right: 0 }}>race · {formatShortDate(race.raceDate)}</span>
      </div>
    </div>
  );
}

/**
 * One subscription, two readers (System 4 D7): the strip renders from it, and
 * the plan page gates its first paint on it. Same key, so react-query serves
 * both from one fetch — and the strip is therefore either present in the
 * page's very first paint or the page has not painted yet. It can no longer
 * arrive 1.5s late and shove the brief, the plan cards and the week grid 80px
 * down the screen.
 */
export function useRaceHub() {
  return useQuery({ queryKey: ["race-hub"], queryFn: api.raceHub, staleTime: 60_000 });
}

export function RaceStrip({ units }: { units: Units }) {
  const qc = useQueryClient();
  const hub = useRaceHub();
  const [open, setOpen] = useState(false);
  const save = useMutation({
    mutationFn: (items: Array<{ id: string; label: string; done: boolean }>) =>
      api.saveRaceChecklist(items),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ["race-hub"] }),
  });
  const race = hub.data?.race;
  if (!race) return null;

  const paceOnly = (s: number) => formatPace(s, units).replace(` /${units}`, "");
  const pred = race.goal?.prediction ?? null;
  const goalMini = pred
    ? `${paceOnly(pred.fastSecPerKm)}–${formatPace(pred.slowSecPerKm, units)}`
    : null;
  const checklistDone = race.checklist.filter((i) => i.done).length;
  const userItems = race.checklist.filter((i) => i.kind === "user");
  const toggle = (id: string) =>
    save.mutate(userItems.map((i) => (i.id === id ? { ...i, done: !i.done } : i)));

  if (race.phase === "post") {
    return (
      <section className="card race-strip race-strip-open" aria-label="Race day">
        {/* The post-race state is the same section, so it wears the same
            label — and it had no heading at all before, which left a hole in
            the page outline where a whole card used to be. */}
        <h2 className="race-strip-h">
          <span className="card-title race-strip-eyebrow">Race day</span>
        </h2>
        <div className="race-strip-head">
          <span className="race-flag" aria-hidden>🏁</span>
          <b>Race day was {formatShortDate(race.raceDate)}.</b>
          {race.debrief ? (
            <span>
              {" "}
              {formatClock(race.debrief.durationSeconds)}
              {race.debrief.avgPaceSecPerKm ? ` · ${formatPace(race.debrief.avgPaceSecPerKm, units)}` : ""} — congratulations.
            </span>
          ) : (
            <span> Once the run syncs, its result shows here.</span>
          )}
        </div>
        {race.raceLine ? (
          <p className="race-line">
            <span className="plan-brief-who">Coach</span> {race.raceLine.text}
          </p>
        ) : null}
      </section>
    );
  }

  return (
    <section className={`card race-strip${open ? " race-strip-open" : ""}`} aria-label="Race day">
      {/* The `<h2>` carries the outline and `.race-strip-h` carries no type of
          its own, leaving the button's own row untouched. The section had no
          name of any kind — a bare countdown asks the reader to work out what
          it counts down to — so the heading now shows one, in the app's own
          eyebrow (`.card-title`, the single uppercase rule). */}
      <h2 className="race-strip-h">
      <span className="card-title race-strip-eyebrow">Race day</span>
      <button
        type="button"
        className="race-strip-toggle"
        aria-expanded={open}
        onClick={() => setOpen(!open)}
      >
        {/* Two rows on a phone, one from `sm` up. The countdown and the
            checklist are the headline; the date, the phase and the goal band
            are its meta line. It used to be one wrapping flex row, which at
            390 broke as "🏁 55 days · Oct 11 · building 4:24–4:32 /km" over
            "0/5 ▸" — an orphaned fraction and a caret on their own line. */}
        <span className="race-strip-lead">
          <span className="race-flag" aria-hidden>🏁</span>
          <b className="num">
            {race.daysToRace === 0 ? "Race day!" : race.daysToRace === 1 ? "Tomorrow" : `${race.daysToRace} days`}
          </b>
          <span className="faint num race-check-mini">
            prep {checklistDone}/{race.checklist.length}
          </span>
        </span>
        <span className="faint race-strip-meta">
          <span className="num">{formatShortDate(race.raceDate)}</span> · {PHASE_LABEL[race.phase]}
          {goalMini && !open ? <> · <span className="race-goal-mini num">{goalMini}</span></> : null}
        </span>
        <span className="race-caret" aria-hidden>{open ? "▾" : "▸"}</span>
      </button>
      </h2>
      {open ? (
        <div className="race-strip-body">
          <TaperArc race={race} />
          <div className="race-cols">
            <div className="race-col">
              <h3 className="race-h">Goal pace</h3>
              {race.goal && pred ? (
                <>
                  <div className="race-goal num">
                    {paceOnly(pred.fastSecPerKm)} – {formatPace(pred.slowSecPerKm, units)}
                  </div>
                  <div className="faint num">
                    {raceDistanceLabel(pred.distanceKm, units)} in {formatClock(pred.fastSeconds)}–
                    {formatClock(pred.slowSeconds)}
                  </div>
                  <div className="faint">
                    scaled from your COROS threshold ({formatPace(race.goal.thresholdPaceSecPerKm, units)},{" "}
                    {formatShortDate(race.goal.asOf)})
                  </div>
                </>
              ) : race.goal ? (
                <>
                  <div className="race-goal num">{formatPace(race.goal.thresholdPaceSecPerKm, units)}</div>
                  <div className="faint">
                    your COROS threshold — roughly one-hour race pace ({formatShortDate(race.goal.asOf)})
                  </div>
                  <div className="faint">
                    Set the race distance in Settings for a goal time.
                  </div>
                </>
              ) : (
                <div className="faint">Arrives with your next COROS sync.</div>
              )}
              {race.terrain.comparison ? (
                <div className="race-terrain faint">
                  {race.terrain.comparison.verdict === "under_prepared"
                    ? `Your running is flatter than the course — ${race.terrain.recent!.metresPerKm} m/km recently vs ${race.terrain.raceMetresPerKm} m/km on race day.`
                    : race.terrain.comparison.verdict === "over_prepared"
                      ? `You're training hillier than the course — ${race.terrain.recent!.metresPerKm} m/km recently vs ${race.terrain.raceMetresPerKm} m/km on race day.`
                      : `Your terrain matches the course — ${race.terrain.recent!.metresPerKm} m/km recently vs ${race.terrain.raceMetresPerKm} m/km on race day.`}
                </div>
              ) : race.terrain.recent ? (
                <div className="race-terrain faint">
                  {race.terrain.recent.metresPerKm} m/km of climb in your recent running. Set the
                  course in Settings to compare.
                </div>
              ) : null}
              {race.stamina.length >= 2 ? (
                <div className="race-stamina">
                  <StaminaSpark points={race.stamina} />
                  <span className="faint num">
                    fitness {race.stamina.at(-1)!.value}
                    {race.stamina.at(-1)!.value !== race.stamina[0]!.value
                      ? ` (${race.stamina.at(-1)!.value > race.stamina[0]!.value ? "+" : ""}${Math.round((race.stamina.at(-1)!.value - race.stamina[0]!.value) * 10) / 10} since ${formatShortDate(race.stamina[0]!.date)})`
                      : ""}
                  </span>
                </div>
              ) : race.stamina.length === 1 ? (
                <div className="faint">Fitness trend starts plotting from today ({race.stamina[0]!.value}).</div>
              ) : null}
            </div>
            <div className="race-col">
              <h3 className="race-h">Race prep</h3>
              <ul className="race-checklist">
                {race.checklist.map((item) => (
                  <li key={item.id}>
                    {item.kind === "coach" ? (
                      <span className={`race-check race-check-derived ${item.done ? "is-done" : ""}`}>
                        {/* A dash, never the tappable circle — these are
                            observations, not checkboxes (live UX audit). */}
                        <i aria-hidden>{item.done ? "✓" : "–"}</i> {item.label}
                        <span className="faint"> · {item.note ?? "coach"}</span>
                      </span>
                    ) : (
                      <button
                        type="button"
                        className={`race-check race-check-btn ${item.done ? "is-done" : ""}`}
                        disabled={save.isPending}
                        onClick={() => toggle(item.id)}
                      >
                        <i aria-hidden>{item.done ? "✓" : "○"}</i> {item.label}
                      </button>
                    )}
                  </li>
                ))}
              </ul>
            </div>
          </div>
          {race.raceLine ? (
            <p className="race-line">
              <span className="plan-brief-who">Coach</span> {race.raceLine.text}
            </p>
          ) : null}
        </div>
      ) : null}
    </section>
  );
}
