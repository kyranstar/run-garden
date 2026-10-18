/**
 * A DESIGNED RUN'S CARD BODY (§8 §3): what the coach's run is, step by step, before the athlete approves it — read from
 * the suggestion's manifest line (`line.run`), whose numbers are the wire's own (the server builds them with the function
 * the watch's program is built from: the preview is the wire).
 *
 *   Warm-up   10 min · Easy · 5:49–6:49 /km
 *   3 ×       8 min · Tempo · 4:59–5:14 /km
 *             2 min · Recovery · 6:19–7:19 /km
 *   Cool-down 2 km · Easy · 5:49–6:49 /km · on your watch as 13 min
 *   50 min · 8.7 km
 *   Goes to your watch when you approve
 *
 * Each step: its time or its distance, its effort in words, its pace band in the athlete's units (none for by feel,
 * strides or hills; none before a threshold is known); a distance says what the watch runs it as (the wire carries time).
 * Each part's steps once with its rounds; the totals; and the watch line while the run is still to decide. The step's why
 * is one tap down (the card's open state). Plain words, the athlete's units, real list semantics.
 */
import { formatDurationShort, formatStageDuration, RUN_EFFORT_LABELS, type RunEffort } from "@rg/domain";
import type { DesignRunDto, DesignRunStepDto } from "@rg/api-client";
import { formatDistance, formatPace, type Units } from "../../components.js";

/** What the watch does once the run is approved, in the card's words; null when there is nothing to say. */
export const RUN_WATCH_LINES: Record<NonNullable<DesignRunDto["watch"]>, string> = {
  goes: "Goes to your watch when you approve",
  time_only: "Your watch will show time only",
  needs_threshold: "Stays off your watch until your threshold pace is known",
};

const ROLE_WORDS: Record<DesignRunStepDto["role"], string> = { warmup: "Warm-up", work: "", recovery: "", cooldown: "Cool-down" };

/** "4:59–5:14 /km": a band in the athlete's units, faster edge first. */
export function paceBandWords(pace: NonNullable<DesignRunStepDto["pace"]>, units: Units): string {
  return `${formatPace(pace.fastSecPerKm, units).replace(` /${units}`, "")}–${formatPace(pace.slowSecPerKm, units)}`;
}

const METERS_PER_MILE = 1609.344;

/** "2 km", "1.24 mi", "400 m": a prescribed distance in the athlete's units, as a coach writes it (no padded decimals). */
export function runDistanceWords(meters: number, units: Units): string {
  if (units === "km" && meters < 1000) return `${Math.round(meters)} m`;
  const v = units === "mi" ? meters / METERS_PER_MILE : meters / 1000;
  return `${Number(v.toFixed(2))} ${units}`;
}

/** "8 min · Tempo · 4:59–5:14 /km", "2 km · Easy · 5:49–6:49 /km · on your watch as 13 min", "Rest 1 min". */
export function runStepWords(step: DesignRunStepDto, units: Units): string {
  const amount = step.meters !== null ? runDistanceWords(step.meters, units) : step.seconds !== null ? formatStageDuration(step.seconds) : "";
  if (step.effort === null) return `Rest ${amount}`.trim();
  const effort = RUN_EFFORT_LABELS[step.effort as RunEffort] ?? step.effort;
  return [
    amount,
    effort,
    step.pace ? paceBandWords(step.pace, units) : null,
    step.meters !== null && step.seconds !== null ? `on your watch as ${formatDurationShort(step.seconds)}` : null,
  ]
    .filter((x): x is string => !!x)
    .join(" · ");
}

/** "50 min · 8.7 km": the run's totals, what can be read of them. */
export function runTotalsWords(run: Pick<DesignRunDto, "totalSeconds" | "totalMeters">, units: Units): string | null {
  const parts = [run.totalSeconds !== null ? formatDurationShort(run.totalSeconds) : null, run.totalMeters !== null ? formatDistance(run.totalMeters, units) : null];
  const out = parts.filter((x): x is string => !!x);
  return out.length > 0 ? out.join(" · ") : null;
}

/** The label beside a part's first step: its rounds ("3 ×"), else what the part is for (warm-up, cool-down), else none. */
function partLabel(segment: DesignRunDto["segments"][number]): string {
  if (segment.rounds > 1) return `${segment.rounds} ×`;
  return ROLE_WORDS[segment.steps[0]?.role ?? "work"];
}

export function RunSteps({ run, units, open, decided }: { run: DesignRunDto; units: Units; open: boolean; decided: boolean }) {
  const totals = runTotalsWords(run, units);
  return (
    <div className="coach-pc-run">
      <ol className="coach-pc-run-steps">
        {run.segments.map((segment, i) => (
          <li key={i} className="coach-pc-run-part">
            <span className="coach-pc-run-label" aria-hidden={segment.rounds > 1 ? true : undefined}>
              {partLabel(segment)}
            </span>
            {segment.rounds > 1 ? <span className="visually-hidden">Repeat {segment.rounds} times: </span> : null}
            <ul className="coach-pc-run-items">
              {segment.steps.map((step, k) => (
                <li key={k}>
                  <span className="coach-pc-run-step">{runStepWords(step, units)}</span>
                  {open && step.why ? <span className="coach-pc-move-why">{step.why}</span> : null}
                </li>
              ))}
              {segment.restBetweenRoundsSec ? <li className="coach-pc-run-step">{`Rest ${formatStageDuration(segment.restBetweenRoundsSec)} between rounds`}</li> : null}
            </ul>
          </li>
        ))}
      </ol>
      {totals ? <p className="coach-pc-facts">{totals}</p> : null}
      {!decided && run.watch ? <p className="coach-pc-run-watch">{RUN_WATCH_LINES[run.watch]}</p> : null}
    </div>
  );
}
