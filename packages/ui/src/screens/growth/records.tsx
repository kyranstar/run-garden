/**
 * GROWTH'S RECORDS (the new shape §7): runs, as Activity showed them (the never-regressing records of `GET
 * /api/insights`); strength — each core lift's heaviest set, the weekly top sets the Progress tiles already compute
 * (`progress.lifts`, the last eight weeks); and holds — the period's longest hold of each isometric strength move (`GET
 * /api/growth/body`). A record from the last seven days wears "New". What each one compares sits one tap down, in its
 * title. Nothing to show: one quiet line.
 */
import { useId, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { api, type InsightsResponse } from "@rg/api-client";
import { formatWeight, type GrowthHold, type GrowthPeriod } from "@rg/domain";
import { formatShortDate, localTodayGuess } from "../../components.js";
import { isRecentRecord } from "../../charts-math.js";

/** A record as a row says it. */
export interface RecordRow {
  id: string;
  title: string;
  value: string;
  date: string;
  /** What it compares, for its title. */
  rule: string;
}

/** Seconds as a hold reads: "45 s", "1:35". */
export function holdWords(seconds: number): string {
  const s = Math.round(seconds);
  return s < 60 ? `${s} s` : `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

/** Each core lift with a line: its heaviest set as typed ("24 kg × 8"). */
export function strengthRows(progress: InsightsResponse["progress"] | undefined): RecordRow[] {
  return (progress?.lifts ?? []).flatMap((l) =>
    l.trend.status === "ok"
      ? [
          {
            id: `lift:${l.exerciseId}`,
            title: l.name,
            value: `${formatWeight(l.trend.value.best.w)}${l.trend.value.best.reps ? ` × ${l.trend.value.best.reps}` : ""}`,
            date: l.trend.value.best.date,
            rule: "The heaviest set in the last eight weeks.",
          },
        ]
      : [],
  );
}

/** The period's longest holds. */
export function holdRows(holds: readonly GrowthHold[] | undefined, period: GrowthPeriod): RecordRow[] {
  return (holds ?? []).map((h) => ({
    id: `hold:${h.exerciseId}`,
    title: h.name,
    value: holdWords(h.seconds),
    date: h.date,
    rule: `The longest hold this ${period}.`,
  }));
}

function Rows({ rows, today }: { rows: readonly RecordRow[]; today: string }) {
  return (
    <ul className="dash-recs">
      {rows.map((r) => (
        <li key={r.id} className="dash-rec" title={r.rule}>
          <b>{r.title}</b> — {r.value}
          <span className="dash-rec-when">
            {formatShortDate(r.date)}
            {isRecentRecord(r.date, today) ? <span className="new-ring">New</span> : null}
          </span>
        </li>
      ))}
    </ul>
  );
}

/** Runs shown before "All N records". */
const RUNS_SHOWN = 3;

export function GrowthRecords({ holds, period }: { holds: readonly GrowthHold[] | undefined; period: GrowthPeriod }) {
  const insights = useQuery({ queryKey: ["insights", "run"], queryFn: () => api.insights("run"), staleTime: 60_000 });
  const [allRuns, setAllRuns] = useState(false);
  const headingId = useId();
  const today = localTodayGuess();
  const runs: RecordRow[] = (insights.data?.records ?? []).map((r) => ({ id: r.id, title: r.title, value: r.value, date: r.achievedOn, rule: r.rule }));
  const strength = strengthRows(insights.data?.progress);
  const held = holdRows(holds, period);
  const groups = [
    { key: "runs", label: "Runs", rows: allRuns ? runs : runs.slice(0, RUNS_SHOWN) },
    { key: "strength", label: "Strength", rows: strength },
    { key: "holds", label: "Holds", rows: held },
  ].filter((g) => g.rows.length > 0);
  return (
    <section className="growth-sect stack" aria-labelledby={headingId}>
      <h2 id={headingId} className="rank-item growth-h">
        Records
      </h2>
      {groups.length === 0 ? (
        <p className="muted">{insights.isLoading ? "Reading your records…" : "No records yet."}</p>
      ) : (
        groups.map((g) => (
          <div key={g.key} className="dash-sect growth-recs">
            <h3 className="dash-eyebrow">{g.label}</h3>
            <Rows rows={g.rows} today={today} />
            {g.key === "runs" && runs.length > RUNS_SHOWN ? (
              <button type="button" className="linklike dash-more" aria-expanded={allRuns} onClick={() => setAllRuns((v) => !v)}>
                All {runs.length} records
                <span className="disclosure-caret" aria-hidden>
                  {allRuns ? "▾" : "▸"}
                </span>
              </button>
            ) : null}
          </div>
        ))
      )}
    </section>
  );
}
