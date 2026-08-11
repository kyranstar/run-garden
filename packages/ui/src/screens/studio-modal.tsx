import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { api, type CoachPlanDto, type PlanDetailResponse } from "@rg/api-client";
import { formatShortDate, Sheet, Spinner } from "../components.js";
import { progressionHeadline } from "./plan-cards.js";
import { PlannedVsActualBars, ProgressionStepChart } from "./plan-charts.js";
import { StudioSection } from "./studio.js";

/**
 * The studio modal (rework spec §7): one room per plan — where you are,
 * where it's taking you (graphed), what each week holds, and every plan
 * action. `new-run` / `new-lift` render intake mode: the coach interviews
 * you (the existing canned-message pipeline), or the lifting Studio's form
 * flow. The page routes it by `?plan=<id>`, so links and back work.
 */
export function StudioModal({
  planId,
  plans,
  onClose,
  onCanned,
  onRetire,
  onRename,
}: {
  planId: string;
  plans: CoachPlanDto[];
  onClose: () => void;
  /** Sends a canned coach message and opens the coach surface. */
  onCanned: (body: string) => void;
  onRetire: (id: string) => void;
  onRename: (id: string, name: string) => void;
}) {
  const isNew = planId === "new-run" || planId === "new-lift";
  const plan = plans.find((p) => p.id === planId);
  const detail = useQuery<PlanDetailResponse>({
    queryKey: ["plan-detail", planId],
    queryFn: () => api.planDetail(planId),
    enabled: !isNew,
    staleTime: 60_000,
  });
  const [confirmingRetire, setConfirmingRetire] = useState(false);
  const [renaming, setRenaming] = useState(false);
  const [name, setName] = useState(plan?.name ?? "");

  if (isNew) {
    const discipline = planId === "new-lift" ? "lift" : "run";
    return (
      <Sheet open onClose={onClose} title={`Plan ${discipline === "lift" ? "lifting" : "running"} with your coach`}>
        <div className="stack studio-modal-intake">
          <p className="muted">
            The coach asks only what it can't already answer from memory — a couple of taps, then it
            drafts the whole plan as one proposal you approve.
          </p>
          <button
            type="button"
            className="btn btn-primary"
            onClick={() =>
              onCanned(
                discipline === "lift"
                  ? "I want a new lifting plan — interview me for what you need."
                  : "I want a new running plan — interview me for what you need.",
              )
            }
          >
            Start the interview
          </button>
          {discipline === "lift" ? (
            <details className="studio-revise">
              <summary>Or build it yourself in the Studio</summary>
              <StudioSection />
            </details>
          ) : null}
        </div>
      </Sheet>
    );
  }

  const d = detail.data;
  const title = d?.plan.name ?? plan?.name ?? "Plan";
  return (
    <Sheet open onClose={onClose} title={title}>
      <div className="stack studio-modal">
        {detail.isLoading ? <Spinner label="Loading plan detail" /> : null}
        {detail.isError ? <p className="muted">Couldn't load this plan's detail — the actions below still work.</p> : null}
        {d ? (
          <>
            <div className="row studio-modal-meta">
              <span className={`pill ${d.plan.discipline === "lift" ? "pill-lift" : "pill-run"}`}>
                {d.plan.discipline === "lift" ? "Lift" : "Run"}
              </span>
              <span className={`pill ${d.plan.status === "active" ? "pill-ok" : "pill-neutral"}`}>
                {d.plan.source === "studio" && d.plan.status === "active" ? "active · on watch" : d.plan.status}
              </span>
              <span className="faint num">
                {formatShortDate(d.plan.startDate)} → {formatShortDate(d.plan.endDate)}
              </span>
              {d.plan.raceDate ? (
                <span className="pill pill-neutral num">race {formatShortDate(d.plan.raceDate)}</span>
              ) : null}
            </div>
            <p className="faint studio-modal-sub num">
              {d.sessions.done} of {d.sessions.planned} sessions done
              {d.adherencePct !== null ? ` · adherence ${d.adherencePct}%` : ""}
            </p>

            {d.progressions.length > 0 ? (
              <div className="prog-chips">
                {d.progressions.map((p) => (
                  <span key={p.key} className="prog-chip">
                    <span className="prog-chip-label">{p.label}</span>
                    <span className="prog-chip-value num">
                      {p.from} → <b>{p.to} {p.unit}</b>
                    </span>
                  </span>
                ))}
              </div>
            ) : null}

            {d.progressions.length > 0 ? (
              <div className="studio-modal-charts">
                {d.plan.discipline === "lift"
                  ? d.progressions
                      .filter((p) => p.key.startsWith("lift:") && p.key !== "lift:weekly-sets")
                      .slice(0, 2)
                      .map((p) => <ProgressionStepChart key={p.key} progression={p} discipline="lift" />)
                  : [
                      ...d.progressions
                        .filter((p) => p.key === "run:long-run")
                        .map((p) => <ProgressionStepChart key={p.key} progression={p} discipline="run" />),
                      ...d.progressions
                        .filter((p) => p.key === "run:weekly-minutes")
                        .map((p) => <PlannedVsActualBars key={p.key} progression={p} />),
                    ]}
              </div>
            ) : null}

            <div className="studio-modal-weeks">
              <h3 className="card-title">Weeks</h3>
              {d.weeks.map((w) => (
                <div key={w.weekStart} className={`wkrow ${w.current ? "is-current" : ""}`}>
                  <span className="wkrow-num faint num">W{w.index}</span>
                  <span className="wkrow-desc">{w.summary}</span>
                  {/* Internal states wear plain words: a "firm" week is on
                      the calendar; a "shape" week is an outline the coach
                      fills in as it approaches. */}
                  <span className={`wkrow-state ${w.state === "firm" || w.done ? "is-firm" : ""}`}>
                    {w.done ? "✓ done" : w.current ? "now" : w.state === "firm" ? "scheduled" : "outline"}
                  </span>
                </div>
              ))}
            </div>
          </>
        ) : null}

        {plan || d ? (
          <div className="btn-row studio-modal-actions">
            {(d?.plan ?? plan)?.source !== "studio" ? (
              <>
                <button
                  type="button"
                  className="btn"
                  onClick={() => onCanned(`Extend "${title}" — draft the next weeks in the same shape.`)}
                >
                  Extend
                </button>
                <button
                  type="button"
                  className="btn"
                  onClick={() => onCanned(`Wind down "${title}" — draft the final taper week.`)}
                >
                  Wind down
                </button>
                {renaming ? (
                  <input
                    value={name}
                    autoFocus
                    onChange={(e) => setName(e.target.value)}
                    aria-label="Plan name"
                    onKeyDown={(e) => {
                      if (e.key === "Enter" && name.trim()) {
                        onRename(planId, name.trim());
                        setRenaming(false);
                      }
                      if (e.key === "Escape") setRenaming(false);
                    }}
                  />
                ) : (
                  <button
                    type="button"
                    className="btn"
                    onClick={() => {
                      setName(title);
                      setRenaming(true);
                    }}
                  >
                    Rename
                  </button>
                )}
                {confirmingRetire ? (
                  <button type="button" className="btn btn-danger" onClick={() => onRetire(planId)}>
                    Really retire — archives every remaining session
                  </button>
                ) : (
                  <button type="button" className="btn" onClick={() => setConfirmingRetire(true)}>
                    Retire…
                  </button>
                )}
              </>
            ) : null}
            <span className="studio-modal-grow" />
            <button
              type="button"
              className="btn btn-primary"
              onClick={() => onCanned(`Let's talk about "${title}" — how is it tracking, and would you change anything?`)}
            >
              Talk to your coach about this plan
            </button>
          </div>
        ) : null}

        {(d?.plan ?? plan)?.source === "studio" ? (
          <details className="studio-revise">
            <summary>Revise this plan (Studio)</summary>
            <StudioSection />
          </details>
        ) : null}
      </div>
    </Sheet>
  );
}
