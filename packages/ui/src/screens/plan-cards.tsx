import type { CoachPlanDto, PlanDetailResponse, PlanProgression } from "@rg/api-client";
import { formatShortDate } from "../components.js";

/**
 * Plan title cards (rework spec §6): one card per plan — serif name, week
 * progress, one headline progression with a sparkline — plus a dashed
 * "plan with your coach" card for a discipline with no active plan.
 * Clicking a card opens the studio modal.
 */

export function progressionHeadline(p: PlanProgression): string {
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
  const visible = plans.filter((p) => p.status === "active" || p.status === "draft");
  const missing = (["run", "lift"] as const).filter((d) => !visible.some((p) => p.discipline === d));
  return (
    <div className="plan-cards">
      {visible.map((p) => {
        const detail = details.get(p.id);
        const { into, total } = weekLabel(p, detail);
        const prog = detail?.progressions[0];
        return (
          <button key={p.id} type="button" className="card plan-card" onClick={() => onOpen(p.id)}>
            <span className="plan-card-top">
              <span className={`pill ${p.discipline === "lift" ? "pill-lift" : "pill-run"}`}>
                {p.discipline === "lift" ? "Lift" : "Run"}
              </span>
              <span className={`pill ${p.status === "active" ? "pill-ok" : "pill-neutral"}`}>
                {p.source === "coros"
                  ? "from COROS"
                  : p.source === "studio" && p.status === "draft"
                    ? "draft — not on watch"
                    : STATUS_LABEL[p.status]}
              </span>
            </span>
            <span className="plan-card-name">{p.name}</span>
            <span className="plan-card-prog">
              <span className="faint num">{into === 0 ? `${total} wk plan` : `wk ${into}/${total}`}</span>
              <span className={`plan-card-track ${p.discipline === "lift" ? "is-lift" : ""}`}>
                <i style={{ width: `${Math.round((into / total) * 100)}%` }} />
              </span>
              <span className="faint num">
                {into === 0 ? `starts ${formatShortDate(p.startDate)}` : `ends ${formatShortDate(p.endDate)}`}
              </span>
            </span>
            {prog ? (
              <span className="plan-card-headline">
                <span className="plan-card-kv">{progressionHeadline(prog)}</span>
                <Sparkline progression={prog} discipline={p.discipline} />
              </span>
            ) : null}
          </button>
        );
      })}
      {missing.map((d) => (
        <button key={d} type="button" className="plan-card plan-card-new" onClick={() => onNew(d)}>
          + Plan {d === "lift" ? "lifting" : "running"} with your coach
        </button>
      ))}
    </div>
  );
}
