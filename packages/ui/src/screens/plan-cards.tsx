import { useQuery } from "@tanstack/react-query";
import { api, type CoachPlanDto, type PlanDetailResponse, type PlanProgression } from "@rg/api-client";
import { formatShortDate, type Units } from "../components.js";

/**
 * Plan title cards (rework spec §6): one card per plan — serif name, week
 * progress, one headline progression with a sparkline — plus a dashed
 * "plan with your coach" card for a discipline with no active plan.
 * Clicking a card opens the studio modal.
 */

const KM_PER_MI = 1.609344;

/** "10.9" from 6.8 mi shown in km — one decimal, trailing .0 dropped. */
function convertedValue(v: number, from: "km" | "mi", to: Units): string {
  const converted = from === to ? v : from === "mi" ? v * KM_PER_MI : v / KM_PER_MI;
  const rounded = converted.toFixed(1);
  return rounded.endsWith(".0") ? rounded.slice(0, -2) : rounded;
}

/**
 * The progression's one-line summary, in the user's display units. A
 * progression carries its OWN unit from the worker ("mi" for a plan written
 * in miles) — when that unit is a distance and disagrees with the display
 * preference, the values convert; non-distance units (kg, min, reps) pass
 * through untouched.
 */
export function progressionHeadline(p: PlanProgression, units: Units): string {
  if ((p.unit === "km" || p.unit === "mi") && p.unit !== units) {
    const from = convertedValue(p.from, p.unit, units);
    const to = convertedValue(p.to, p.unit, units);
    const now = p.now !== null && p.now !== p.to ? ` · now ${convertedValue(p.now, p.unit, units)}` : "";
    return `${p.label} ${from} → ${to} ${units}${now}`;
  }
  const now = p.now !== null && p.now !== p.to ? ` · now ${p.now}` : "";
  return `${p.label} ${p.from} → ${p.to} ${p.unit}${now}`;
}

/** wk n/m from detail weeks when loaded, date arithmetic as the fallback.
 * `into: 0` = the plan hasn't started yet — render "starts <date>". */
function weekLabel(plan: CoachPlanDto, detail?: PlanDetailResponse): { into: number; total: number } {
  const current = detail?.weeks.find((w) => w.current);
  if (current && detail) return { into: current.index, total: detail.weeks.length };
  const total = Math.max(1, Math.round((Date.parse(plan.endDate) - Date.parse(plan.startDate)) / 604_800_000));
  if (Date.now() < Date.parse(plan.startDate)) return { into: 0, total };
  const into = Math.min(total, Math.max(1, Math.ceil((Date.now() - Date.parse(plan.startDate)) / 604_800_000)));
  return { into, total };
}

function Sparkline({ progression, discipline }: { progression: PlanProgression; discipline: "run" | "lift" }) {
  const series = progression.series;
  if (series.length < 2) return null;
  const w = 96;
  const h = 26;
  const min = Math.min(...series.map((p) => p.value));
  const max = Math.max(...series.map((p) => p.value));
  const x = (i: number) => 2 + (i / (series.length - 1)) * (w - 4);
  const y = (v: number) => (max === min ? h / 2 : 2 + (1 - (v - min) / (max - min)) * (h - 6));
  // Lifts prescribe in steps; runs build in lines.
  const d =
    discipline === "lift"
      ? series
          .map((p, i) =>
            i === 0
              ? `M${x(0).toFixed(1)} ${y(p.value).toFixed(1)}`
              : `L${x(i).toFixed(1)} ${y(series[i - 1]!.value).toFixed(1)} L${x(i).toFixed(1)} ${y(p.value).toFixed(1)}`,
          )
          .join(" ")
      : series.map((p, i) => `${i === 0 ? "M" : "L"}${x(i).toFixed(1)} ${y(p.value).toFixed(1)}`).join(" ");
  const lastDone = [...series].reverse().find((p) => p.done);
  const color = discipline === "lift" ? "var(--lift-ink)" : "var(--chart-1)";
  return (
    <svg className="plan-card-spark" viewBox={`0 0 ${w} ${h}`} aria-hidden focusable="false">
      <path d={d} fill="none" stroke={color} strokeWidth="2" strokeLinecap="round" />
      {lastDone ? (
        <circle cx={x(series.indexOf(lastDone))} cy={y(lastDone.value)} r="3" fill={color} />
      ) : null}
    </svg>
  );
}

const STATUS_LABEL: Record<CoachPlanDto["status"], string> = {
  active: "active",
  draft: "draft",
  completed: "done",
  retired: "retired",
};

function PlanRow({
  p,
  detail,
  units,
  onOpen,
}: {
  p: CoachPlanDto;
  detail: PlanDetailResponse | undefined;
  units: Units;
  onOpen: (id: string) => void;
}) {
  const { into, total } = weekLabel(p, detail);
  const prog = detail?.progressions[0];
  // Race day as a tick on the (time-linear) progress track, when it
  // falls inside the plan's span.
  const racePct =
    p.raceDate && p.raceDate >= p.startDate && p.raceDate <= p.endDate
      ? ((Date.parse(p.raceDate) - Date.parse(p.startDate)) /
          (Date.parse(p.endDate) - Date.parse(p.startDate))) *
        100
      : null;
  return (
    <button type="button" className="card plan-card plan-card-row" onClick={() => onOpen(p.id)}>
      <span className="plan-card-top">
        <span className={`pill ${p.status === "active" ? "pill-ok" : "pill-neutral"}`}>
          {p.source === "coros"
            ? "from COROS"
            : p.source === "studio" && p.status === "draft"
              ? "draft — not on watch"
              : STATUS_LABEL[p.status]}
        </span>
        <span className="faint num plan-card-when">
          {into === 0
            ? `upcoming · ${formatShortDate(p.startDate)} → ${formatShortDate(p.endDate)}`
            : `now · ends ${formatShortDate(p.endDate)}`}
        </span>
      </span>
      <span className="plan-card-name">{p.name}</span>
      <span className="plan-card-prog">
        <span className="faint num">{into === 0 ? `${total} wk plan` : `wk ${into}/${total}`}</span>
        <span className={`plan-card-track ${p.discipline === "lift" ? "is-lift" : ""}`}>
          <i style={{ width: `${Math.round((into / total) * 100)}%` }} />
          {racePct !== null ? (
            <b
              className="plan-card-race"
              style={{ left: `${racePct}%` }}
              title={`Race · ${formatShortDate(p.raceDate!)}`}
            />
          ) : null}
        </span>
        <span className="faint num">
          {into === 0 ? `starts ${formatShortDate(p.startDate)}` : `ends ${formatShortDate(p.endDate)}`}
        </span>
      </span>
      {prog ? (
        <span className="plan-card-headline">
          <span className="plan-card-kv">{progressionHeadline(prog, units)}</span>
          <Sparkline progression={prog} discipline={p.discipline} />
        </span>
      ) : null}
    </button>
  );
}

export function PlanCards({
  plans,
  details,
  onOpen,
  onNew,
}: {
  plans: CoachPlanDto[];
  details: Map<string, PlanDetailResponse | undefined>;
  onOpen: (id: string) => void;
  onNew: (discipline: "run" | "lift") => void;
}) {
  const settings = useQuery({ queryKey: ["settings"], queryFn: api.settings, staleTime: 60_000 });
  const units: Units = settings.data?.prefs.units ?? "km";
  const visible = plans.filter((p) => p.status === "active" || p.status === "draft");
  return (
    <div className="plan-sections">
      {(["run", "lift"] as const).map((discipline) => {
        // Vertical time order inside a sport: what's running now sits on
        // top, upcoming blocks follow in the order they'll happen.
        const group = visible
          .filter((p) => p.discipline === discipline)
          .sort(
            (a, b) => a.startDate.localeCompare(b.startDate) || a.name.localeCompare(b.name),
          );
        return (
          <section
            key={discipline}
            className="plan-section"
            aria-label={discipline === "lift" ? "Lifting plans" : "Running plans"}
          >
            <div className="plan-section-head">
              <span className={`pill ${discipline === "lift" ? "pill-lift" : "pill-run"}`}>
                {discipline === "lift" ? "Lift" : "Run"}
              </span>
              <span className="plan-section-rule" aria-hidden />
            </div>
            <div className="plan-section-list">
              {group.map((p) => (
                <PlanRow key={p.id} p={p} detail={details.get(p.id)} units={units} onOpen={onOpen} />
              ))}
              {group.length === 0 ? (
                <button
                  type="button"
                  className="plan-card plan-card-new"
                  onClick={() => onNew(discipline)}
                >
                  + Plan {discipline === "lift" ? "lifting" : "running"} with your coach
                </button>
              ) : null}
            </div>
          </section>
        );
      })}
    </div>
  );
}
