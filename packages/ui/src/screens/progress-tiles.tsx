/**
 * THE PROGRESS TILES on the Activity page (Phase 2d Task 3; mocks §8). Three kinds, each drawn from a MetricResult
 * the worker computed over the last eight weeks (`progress` on GET /api/insights):
 *
 *  - the condition tile, per switched-on profile: after-session mean "from" the before mean, a before and an after
 *    line, and the flare days. Below four paired sessions it only says how many more it needs (Review Focus 4);
 *  - weekly volume: this week's, in the athlete's unit, over eight weekly bars;
 *  - one tile per core lift: its best as typed, its weekly top set as a line, labelled low and high in the unit the
 *    athlete used last (Review Focus 5). A lift never logged has no tile.
 *
 * Every condition word is the profile's own (`label`, its first word); this file names none. Sparklines size to their
 * box (`useMeasuredWidth`, one viewBox unit per CSS pixel) and carry no text: labels are HTML beside them.
 */
import { useRef } from "react";
import type { ProgressDto } from "@rg/api-client";
import { formatWeight, KG_TO_LB, type WeightUnit } from "@rg/domain";
import { useMeasuredWidth } from "../chart-kit.js";
import { countNoun } from "../components.js";
import { checkWord } from "../components/condition-check-sheet.js";

type Condition = ProgressDto["conditions"][number];
type Lift = ProgressDto["lifts"][number];

/** Kilograms in the athlete's unit, to the half unit (what a label shows). */
function kgIn(kg: number, unit: WeightUnit): number {
  const n = unit === "kg" ? kg : kg * KG_TO_LB;
  return Math.round(n * 2) / 2;
}

/** A shown lift: one with a line, or one logged once (it needs one more week). Never logged: no tile. */
const liftShown = (l: Lift): boolean => l.trend.status === "ok" || l.trend.have > 0;

/** Anything to show: a switched-on profile, a weighted set, or a core lift logged. */
export function progressShown(p: ProgressDto | null | undefined): p is ProgressDto {
  if (!p) return false;
  return p.conditions.length > 0 || p.volume.status === "ok" || p.lifts.some(liftShown);
}

/** The box a sparkline measures; its SVG fills it. */
function useSparkWidth(fallback: number) {
  const ref = useRef<HTMLDivElement>(null);
  const measured = useMeasuredWidth(ref);
  return { ref, width: measured && measured > 0 ? Math.round(measured) : fallback };
}

const SPARK_H = 44;
const PAD = 4;

function ConditionTile({ c }: { c: Condition }) {
  const { ref, width } = useSparkWidth(150);
  const word = checkWord(c.label);
  const head = <span className="progress-eyebrow">{word}, after sessions</span>;
  if (c.trend.status !== "ok") {
    const more = Math.max(1, c.trend.needed - c.trend.have);
    return (
      <div className="progress-tile">
        {head}
        <p className="progress-wait">Needs {countNoun(more, "more session")}</p>
        <div className="progress-spark" ref={ref} />
      </div>
    );
  }
  const v = c.trend.value;
  const values = v.weeks.flatMap((w) => [w.pre, w.post]).filter((x): x is number => x !== null);
  const top = Math.max(4, ...values);
  const n = v.weeks.length;
  const x = (i: number) => (n > 1 ? PAD + (i / (n - 1)) * (width - 2 * PAD) : width / 2);
  const y = (val: number) => SPARK_H - PAD - (val / top) * (SPARK_H - 2 * PAD);
  const line = (key: "pre" | "post") =>
    v.weeks
      .map((w, i) => (w[key] === null ? null : `${x(i).toFixed(1)},${y(w[key]!).toFixed(1)}`))
      .filter(Boolean)
      .join(" ");
  const lastPost = [...v.weeks.keys()].reverse().find((i) => v.weeks[i]!.post !== null);
  return (
    <div className="progress-tile">
      {head}
      <span className="progress-value">
        <b>{v.postMean}</b> <span className="progress-meta">from {v.preMean}</span>
      </span>
      <div className="progress-spark" ref={ref}>
        <svg
          viewBox={`0 0 ${width} ${SPARK_H}`}
          preserveAspectRatio="none"
          role="img"
          aria-label={`${word}: ${v.preMean} before and ${v.postMean} after sessions, over ${n} weeks`}
        >
          <polyline className="progress-line-before" points={line("pre")} />
          <polyline className="progress-line-after" points={line("post")} />
          {lastPost !== undefined ? <circle className="progress-dot-after" cx={x(lastPost)} cy={y(v.weeks[lastPost]!.post!)} r={3} /> : null}
        </svg>
      </div>
      <span className="progress-meta">
        <span className="progress-key-before">before</span> · <span className="progress-key-after">after</span>
      </span>
      <span className="progress-meta">{v.flareDays > 0 ? countNoun(v.flareDays, "flare day") : "No flare days"}</span>
    </div>
  );
}

function VolumeTile({ volume, unit }: { volume: ProgressDto["volume"]; unit: WeightUnit }) {
  const { ref, width } = useSparkWidth(150);
  if (volume.status !== "ok") {
    return (
      <div className="progress-tile">
        <span className="progress-eyebrow">Weekly volume</span>
        <p className="progress-wait">No weighted sets yet</p>
        <div className="progress-spark" ref={ref} />
      </div>
    );
  }
  const weeks = volume.value.weeks;
  const max = Math.max(1, ...weeks.map((w) => w.kg));
  const slot = width / weeks.length;
  const barW = Math.max(2, slot - 6);
  const shown = Math.round(unit === "kg" ? volume.value.thisWeekKg : volume.value.thisWeekKg * KG_TO_LB);
  return (
    <div className="progress-tile">
      <span className="progress-eyebrow">Weekly volume</span>
      <span className="progress-value">
        <b>
          {shown.toLocaleString("en-US")} {unit}
        </b>
      </span>
      <div className="progress-spark" ref={ref}>
        <svg viewBox={`0 0 ${width} ${SPARK_H}`} preserveAspectRatio="none" role="img" aria-label={`Weekly volume, ${weeks.length} weeks`}>
          {weeks.map((w, i) => {
            const h = w.kg > 0 ? Math.max(2, (w.kg / max) * (SPARK_H - PAD)) : 0;
            return (
              <rect
                key={w.weekStart}
                className={i === weeks.length - 1 ? "progress-bar progress-bar-now" : "progress-bar"}
                x={i * slot + (slot - barW) / 2}
                y={SPARK_H - h}
                width={barW}
                height={h}
                rx={2}
              />
            );
          })}
        </svg>
      </div>
      <span className="progress-meta">{weeks.length} weeks</span>
    </div>
  );
}

function LiftTile({ lift }: { lift: Lift }) {
  const { ref, width } = useSparkWidth(320);
  const H = 50;
  if (lift.trend.status !== "ok") {
    const more = Math.max(1, lift.trend.needed - lift.trend.have);
    return (
      <div className="progress-tile progress-tile-wide">
        <span className="progress-eyebrow">{lift.name}</span>
        <p className="progress-wait">Needs {more} more {more === 1 ? "week" : "weeks"}</p>
        <div className="progress-spark" ref={ref} />
      </div>
    );
  }
  const v = lift.trend.value;
  const lo = Math.min(...v.series.map((p) => p.kg));
  const hi = Math.max(...v.series.map((p) => p.kg));
  const span = hi - lo;
  const n = v.series.length;
  const x = (i: number) => PAD + (n > 1 ? (i / (n - 1)) * (width - 2 * PAD) : (width - 2 * PAD) / 2);
  const y = (kg: number) => (span > 0 ? H - PAD - ((kg - lo) / span) * (H - 2 * PAD) : H / 2);
  const last = v.series[n - 1]!;
  const label = (kg: number) => formatWeight({ v: kgIn(kg, v.unit), u: v.unit });
  const best = `best ${formatWeight(v.best.w)}${v.best.reps ? ` × ${v.best.reps}` : ""}`;
  return (
    <div className="progress-tile progress-tile-wide">
      <div className="progress-head">
        <span className="progress-eyebrow">{lift.name}</span>
        <span className="progress-meta">{best}</span>
      </div>
      <div className="progress-spark" ref={ref}>
        <svg
          viewBox={`0 0 ${width} ${H}`}
          preserveAspectRatio="none"
          role="img"
          aria-label={`${lift.name} top set, ${n} weeks, ${label(lo)} to ${label(hi)}`}
          style={{ height: H }}
        >
          <polyline className="progress-line-lift" points={v.series.map((p, i) => `${x(i).toFixed(1)},${y(p.kg).toFixed(1)}`).join(" ")} />
          <circle className="progress-dot-lift" cx={x(n - 1)} cy={y(last.kg)} r={3.5} />
        </svg>
      </div>
      <div className="progress-range progress-meta">
        <span>{label(lo)}</span>
        <span>{label(hi)}</span>
      </div>
    </div>
  );
}

export function ProgressTiles({ progress }: { progress: ProgressDto }) {
  const lifts = progress.lifts.filter(liftShown);
  return (
    <div className="progress-tiles">
      {progress.conditions.map((c) => (
        <ConditionTile key={c.profileId} c={c} />
      ))}
      <VolumeTile volume={progress.volume} unit={progress.weightUnit} />
      {lifts.map((l) => (
        <LiftTile key={l.exerciseId} lift={l} />
      ))}
    </div>
  );
}
