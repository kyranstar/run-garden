import type { PlanProgression } from "@rg/api-client";
import { ChartFrame } from "../charts.js";
import { niceTicks } from "../chart-kit.js";

const KM_PER_MI = 1.609344;
/** Distance progressions render in the athlete's display units; non-distance
 * units (kg, min, reps) pass through untouched (units sweep 2026-08-14). */
export function progressionInUnits(p: PlanProgression, units: "km" | "mi"): PlanProgression {
  if ((p.unit !== "km" && p.unit !== "mi") || p.unit === units) return p;
  const f = p.unit === "mi" ? KM_PER_MI : 1 / KM_PER_MI;
  const c = (v: number) => Math.round(v * f * 10) / 10;
  return {
    ...p,
    unit: units,
    from: c(p.from),
    to: c(p.to),
    now: p.now === null ? null : c(p.now),
    series: p.series.map((pt) => ({ ...pt, value: c(pt.value), ...(pt.actual !== undefined ? { actual: c(pt.actual) } : {}) })),
  };
}


/**
 * Progression charts for the studio modal (rework spec §7). Honest by
 * construction: lift series are the PRESCRIPTION drawn as steps with
 * completed sessions dotted on it (COROS sends no actual bar weights);
 * run series are planned values, with actual minutes overlaid when known.
 * All SVGs are viewBox-only — width comes from the container (R1).
 */

const VB_W = 320;
const VB_H = 150;
const M = { top: 10, right: 10, bottom: 26, left: 40 };

/** Labeled vertical race-day line, drawn when the race week falls inside
 * the charted span (user request, 2026-08-12). */
function RaceLine({
  raceWeek,
  raceLabel,
  x,
  wMin,
  wMax,
}: {
  raceWeek: number | null | undefined;
  raceLabel: string | undefined;
  x: (week: number) => number;
  wMin: number;
  wMax: number;
}) {
  if (raceWeek == null || raceWeek < wMin || raceWeek > wMax) return null;
  const rx = x(raceWeek);
  return (
    <g>
      <line
        x1={rx}
        y1={M.top}
        x2={rx}
        y2={VB_H - M.bottom}
        stroke="var(--chart-2)"
        strokeWidth="1.5"
        strokeDasharray="5 3"
      />
      <text x={rx} y={M.top - 1} textAnchor="middle" fontSize="9" fontWeight="600" fill="var(--chart-2)">
        {raceLabel ?? "race"}
      </text>
    </g>
  );
}

function scales(progression: PlanProgression) {
  const weeks = progression.series.map((p) => p.week);
  const values = progression.series.flatMap((p) => [p.value, ...(p.actual !== undefined ? [p.actual] : [])]);
  const wMin = Math.min(...weeks);
  const wMax = Math.max(...weeks);
  const ticks = niceTicks(Math.min(...values), Math.max(...values), 3);
  const vMin = ticks[0] ?? Math.min(...values);
  const vMax = ticks[ticks.length - 1] ?? Math.max(...values);
  const x = (week: number) =>
    M.left + (wMax === wMin ? 0.5 : (week - wMin) / (wMax - wMin)) * (VB_W - M.left - M.right);
  const y = (v: number) =>
    M.top + (vMax === vMin ? 0.5 : 1 - (v - vMin) / (vMax - vMin)) * (VB_H - M.top - M.bottom);
  return { x, y, ticks, wMin, wMax };
}

export function ProgressionStepChart({
  progression,
  discipline,
  raceWeek,
  raceLabel,
}: {
  progression: PlanProgression;
  discipline: "run" | "lift";
  raceWeek?: number | null;
  raceLabel?: string;
}) {
  const s = progression.series;
  if (s.length < 2) return null;
  const { x, y, ticks, wMin, wMax } = scales(progression);
  const color = discipline === "lift" ? "var(--chart-2)" : "var(--chart-1)";

  const stepPath = s
    .map((p, i) =>
      i === 0
        ? `M${x(p.week).toFixed(1)} ${y(p.value).toFixed(1)}`
        : `L${x(p.week).toFixed(1)} ${y(s[i - 1]!.value).toFixed(1)} L${x(p.week).toFixed(1)} ${y(p.value).toFixed(1)}`,
    )
    .join(" ");
  const linePath = s
    .map((p, i) => `${i === 0 ? "M" : "L"}${x(p.week).toFixed(1)} ${y(p.value).toFixed(1)}`)
    .join(" ");
  const path = discipline === "lift" ? stepPath : linePath;
  const first = s[0]!;
  const last = s[s.length - 1]!;
  const doneCount = s.filter((p) => p.done).length;
  /**
   * The one number the chart annotates is the PEAK, drawn where the peak
   * actually is. The end label used to print `progression.to` (which IS the
   * peak — see plan-progressions.ts `peak()`) hard against the right edge, on
   * the last week's height: on any block that tapers, race week ended up
   * captioned with a number two weeks older than it ("16.1 km" over a 10 km
   * taper week). The card headline still reads start→peak, deliberately; this
   * says which point that peak belongs to.
   */
  const peak = s.reduce((a, b) => (b.value > a.value ? b : a), first);
  const nowWeek =
    progression.now !== null && progression.now !== last.value
      ? Math.min(wMax, Math.max(wMin, s.find((p) => p.value === progression.now)?.week ?? wMin))
      : null;
  const nowOnPeak = nowWeek !== null && nowWeek === peak.week;
  const peakAnchor = peak.week === wMax ? "end" : peak.week === wMin ? "start" : "middle";
  // Describes what is DRAWN — first, peak, and where the line actually ends —
  // so the alternative text can't caption a taper with the peak either.
  const summary =
    `${progression.label}: prescribed from ${first.value} ${progression.unit} in week ${wMin} to a peak of ` +
    `${peak.value} ${progression.unit} in week ${peak.week}` +
    (peak.value > last.value ? `, easing to ${last.value} ${progression.unit} by week ${wMax}` : "") +
    `; ${doneCount} of ${s.length} weeks completed` +
    (progression.now !== null ? `; currently ${progression.now} ${progression.unit}` : "") +
    ".";

  return (
    <ChartFrame
      title={`${progression.label} — by week`}
      subtitle={`prescribed${doneCount > 0 ? " · dots mark completed weeks" : ""}`}
      summary={summary}
      legend={[]}
    >
      <div className="chartbox-svg">
        <svg viewBox={`0 0 ${VB_W} ${VB_H}`} role="img" aria-hidden focusable="false">
          {ticks.map((t) => (
            <g key={t}>
              <line
                x1={M.left}
                y1={y(t)}
                x2={VB_W - M.right}
                y2={y(t)}
                stroke="var(--chart-grid)"
                strokeDasharray="2 4"
              />
              <text x={M.left - 6} y={y(t) + 3} textAnchor="end" fontSize="9" fill="var(--ink-faint)">
                {t}
              </text>
            </g>
          ))}
          <line x1={M.left} y1={VB_H - M.bottom} x2={VB_W - M.right} y2={VB_H - M.bottom} stroke="var(--chart-grid)" />
          <RaceLine raceWeek={raceWeek} raceLabel={raceLabel} x={x} wMin={wMin} wMax={wMax} />
          <path d={path} fill="none" stroke="var(--ink-faint)" strokeWidth="1.5" strokeDasharray="4 3" />
          {s.filter((p) => p.done).map((p) => (
            <circle
              key={p.week}
              cx={x(p.week)}
              cy={y(p.value)}
              r="4"
              fill={color}
              stroke="var(--bg-raised)"
              strokeWidth="2"
            />
          ))}
          {nowWeek !== null && !nowOnPeak ? (
            <text
              x={x(nowWeek)}
              y={y(progression.now!) - 8}
              textAnchor="middle"
              fontSize="9"
              fontWeight="600"
              fill="var(--ink-soft)"
            >
              {progression.now} · now
            </text>
          ) : null}
          <text
            x={x(peak.week)}
            y={y(peak.value) - 6}
            textAnchor={peakAnchor}
            fontSize="9"
            fontWeight="600"
            fill="var(--ink-soft)"
          >
            peak {peak.value} {progression.unit}
            {nowOnPeak ? " · now" : ""}
          </text>
          <text x={x(wMin)} y={VB_H - M.bottom + 12} textAnchor="middle" fontSize="9" fill="var(--ink-faint)">
            W{wMin}
          </text>
          <text x={x(wMax)} y={VB_H - M.bottom + 12} textAnchor="middle" fontSize="9" fill="var(--ink-faint)">
            W{wMax}
          </text>
        </svg>
      </div>
    </ChartFrame>
  );
}

/** Planned-vs-actual weekly minutes: outline planned, filled actual (run). */
export function PlannedVsActualBars({
  progression,
  raceWeek,
  raceLabel,
}: {
  progression: PlanProgression;
  raceWeek?: number | null;
  raceLabel?: string;
}) {
  const s = progression.series;
  if (s.length < 2) return null;
  const { x, y, ticks, wMin, wMax } = scales(progression);
  const slot = (VB_W - M.left - M.right) / Math.max(1, wMax - wMin + 1);
  const barW = Math.min(26, slot * 0.7);
  const base = VB_H - M.bottom;
  const withActual = s.filter((p) => p.actual !== undefined).length;
  const summary = `${progression.label}: planned ${progression.from} to ${progression.to} ${progression.unit} by week; actuals known for ${withActual} of ${s.length} weeks.`;
  return (
    <ChartFrame
      title={`${progression.label} — planned vs done`}
      subtitle="outline planned · filled done"
      summary={summary}
      legend={[]}
    >
      <div className="chartbox-svg">
        <svg viewBox={`0 0 ${VB_W} ${VB_H}`} role="img" aria-hidden focusable="false">
          {ticks.map((t) => (
            <text key={t} x={M.left - 6} y={y(t) + 3} textAnchor="end" fontSize="9" fill="var(--ink-faint)">
              {t}
            </text>
          ))}
          <line x1={M.left} y1={base} x2={VB_W - M.right} y2={base} stroke="var(--chart-grid)" />
          <RaceLine raceWeek={raceWeek} raceLabel={raceLabel} x={x} wMin={wMin} wMax={wMax} />
          {s.map((p) => {
            const cx = x(p.week);
            return (
              <g key={p.week}>
                <rect
                  x={cx - barW / 2}
                  y={y(p.value)}
                  width={barW}
                  height={Math.max(0, base - y(p.value))}
                  rx="4"
                  fill="none"
                  stroke="var(--ink-faint)"
                  strokeDasharray="3 3"
                />
                {p.actual !== undefined ? (
                  <rect
                    x={cx - barW / 2}
                    y={y(p.actual)}
                    width={barW}
                    height={Math.max(0, base - y(p.actual))}
                    rx="4"
                    fill="var(--chart-1)"
                  />
                ) : null}
              </g>
            );
          })}
          <text x={x(wMin)} y={base + 12} textAnchor="middle" fontSize="9" fill="var(--ink-faint)">
            W{wMin}
          </text>
          <text x={x(wMax)} y={base + 12} textAnchor="middle" fontSize="9" fill="var(--ink-faint)">
            W{wMax}
          </text>
        </svg>
      </div>
    </ChartFrame>
  );
}
