import { useUnits, useWeightUnit } from "../use-units.js";
import { useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { api, type CoachPlanDto, type PlanDetailResponse } from "@rg/api-client";
import { ConfirmDialog, formatShortDate, Sheet, Spinner } from "../components.js";
import { startOfIsoWeek } from "@rg/domain";
import { PlannedVsActualBars, progressionInUnits, ProgressionStepChart } from "./plan-charts.js";
import { useCoach } from "./studio/coach-ask.js";

/** How a plan is named in a request: "my Fall Half Block plan" — never "my Base plan plan". */
const planPhrase = (title: string): string => (/\bplan$/i.test(title.trim()) ? `my ${title.trim()}` : `my ${title.trim()} plan`);

/**
 * The words each of the plan's actions writes in the coach's box (the new shape §6): the athlete's to send, never sent
 * for them — no canned chat message.
 */
export function planRequests(title: string): { extend: string; windDown: string; ask: string } {
  const plan = planPhrase(title);
  return {
    extend: `Extend ${plan} by two weeks.`,
    windDown: `Wind down ${plan} with a taper week.`,
    ask: `How is ${plan} going?`,
  };
}

/**
 * THE PLAN SHEET (the new shape §6; the plan "studio" modal before it): one room per plan — where you are, where it is
 * taking you (graphed), what each week holds, and its actions. Extend, Wind down and Ask about this plan open the coach
 * with the request written; Rename and Retire… are the app's own (the coach retires no plan in this wave: §8). The page
 * routes it by `?plan=<id>`, so links and back work. A plan the retired generator made still opens here.
 */
export function PlanSheet({
  planId,
  plans,
  onClose,
  onRetire,
  onRename,
}: {
  planId: string;
  plans: CoachPlanDto[];
  onClose: () => void;
  /**
   * Retire the plan; `source` says which kind, so the page asks the right route. Resolves with why it did not happen
   * (said in the confirmation, which stays open), or null.
   */
  onRetire: (id: string, source: "coach" | "studio") => Promise<string | null>;
  onRename: (id: string, name: string) => void;
}) {
  const units = useUnits();
  const weightUnit = useWeightUnit();
  const coach = useCoach();
  const plan = plans.find((p) => p.id === planId);
  const detail = useQuery<PlanDetailResponse>({
    queryKey: ["plan-detail", planId],
    queryFn: () => api.planDetail(planId),
    staleTime: 60_000,
  });
  const [confirmingRetire, setConfirmingRetireState] = useState(false);
  const [retiring, setRetiring] = useState(false);
  const [retireError, setRetireError] = useState<string | null>(null);
  const setConfirmingRetire = (open: boolean) => {
    setRetireError(null);
    setConfirmingRetireState(open);
  };
  const [renaming, setRenaming] = useState(false);
  const [name, setName] = useState(plan?.name ?? "");
  /** So closing the rename editor hands focus back to what opened it. */
  const renameBtn = useRef<HTMLButtonElement>(null);
  /** Who made it: the coach, the retired generator ("studio"), or COROS. */
  const source = (detail.data?.plan ?? plan)?.source ?? "coach";

  const d = detail.data;
  const title = d?.plan.name ?? plan?.name ?? "Plan";
  // Race day as a labeled vertical line on every by-week chart (user
  // request): week index relative to the plan's own W1.
  const raceWeek = d?.plan.raceDate
    ? Math.floor(
        (Date.parse(d.plan.raceDate) - Date.parse(startOfIsoWeek(d.plan.startDate))) / (7 * 86_400_000),
      ) + 1
    : null;
  const raceLabel = d?.plan.raceDate ? `race · ${formatShortDate(d.plan.raceDate)}` : undefined;
  const requests = planRequests(title);

  /**
   * Every plan action, handed to the Sheet as its pinned footer (System 1
   * §2). This modal is the tallest surface in the app — 1,304px of content
   * in a dialog that shows 564 — and with the whole thing inside one
   * scrolling box every one of these buttons sat below a fold that nothing
   * announced. The body scrolls; the actions do not move.
   */
  const actions =
    plan || d ? (
      <div className="btn-row studio-modal-actions">
        {(d?.plan ?? plan)?.source === "coros" ? (
          <p className="faint" style={{ margin: 0, alignSelf: "center" }}>
            Imported from COROS.
          </p>
        ) : null}
        {((d?.plan ?? plan)?.source ?? "coach") === "coach" ? (
          <>
            {/* "Extend" and "Wind down" are things you do to a block with a
                planned duration. A container of loose sessions has neither, so
                it is not offered a taper. */}
            {(d?.plan ?? plan)?.kind === "loose" || !coach ? null : (
              <>
                <button type="button" className="btn" onClick={() => coach.open({ request: requests.extend })}>
                  Extend
                </button>
                <button type="button" className="btn" onClick={() => coach.open({ request: requests.windDown })}>
                  Wind down
                </button>
              </>
            )}
            <button
              type="button"
              className="btn"
              ref={renameBtn}
              aria-expanded={renaming}
              aria-controls="studio-rename"
              onClick={() => {
                if (renaming) {
                  setRenaming(false);
                  return;
                }
                setName(title);
                setConfirmingRetire(false);
                setRenaming(true);
              }}
            >
              Rename
            </button>
            <button
              type="button"
              className="btn"
              aria-haspopup="dialog"
              onClick={() => {
                setRenaming(false);
                setConfirmingRetire(true);
              }}
            >
              Retire…
            </button>
          </>
        ) : null}
        {/* A plan the retired generator made has no screen of its own any more: it is retired here, as a coach plan
            is, while it runs — what is ahead leaves the watch, what is done stays. */}
        {source === "studio" && ((d?.plan ?? plan)?.status === "active" || (d?.plan ?? plan)?.status === "draft") ? (
          <button type="button" className="btn" aria-haspopup="dialog" onClick={() => setConfirmingRetire(true)}>
            Retire…
          </button>
        ) : null}
        <span className="studio-modal-grow" />
        {coach ? (
          <button type="button" className="btn btn-primary" onClick={() => coach.open({ request: requests.ask })}>
            Ask about this plan
          </button>
        ) : null}
      </div>
    ) : null;

  /* "Rename" opens into the foot, never into the row (System 4 D6/R2/R4): it
     used to be replaced by a bare `<input>` with no way back but the Escape
     key, which also re-wrapped every action beside it because an input is not
     the width of the word "Rename". The foot's own `column-reverse`
     (styles.css) decides which side of the action row it lands on — above it
     on a phone, below it on a desktop — so the row itself never moves.
     Measured at 390 before this: −61.2px.

     "Retire…" is no longer one of these. A destructive confirm is a nested
     dialog now (System 4 P2): in this foot at 390 it opened 169.2px above its
     own trigger with a whole row of unrelated actions in between, and at 1440
     — where this row wraps to two lines and "Retire…" sits on the first — 64px
     below it, under "Talk to your coach about this plan". Still mutually
     exclusive with the rename, so pressing one closes the other. */
  const footer =
    actions !== null ? (
      <>
        {actions}
        <div id="studio-rename" className="disclosure-body">
          {renaming ? (
            <div className="row studio-modal-rename">
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
                  if (e.key === "Escape") {
                    setRenaming(false);
                    renameBtn.current?.focus();
                  }
                }}
              />
              <button
                type="button"
                className="btn btn-primary"
                disabled={!name.trim()}
                onClick={() => {
                  onRename(planId, name.trim());
                  setRenaming(false);
                  renameBtn.current?.focus();
                }}
              >
                Save
              </button>
              {/* Escape worked and nothing said so. A rename is not a thing a
                  reader should have to guess their way out of. */}
              <button
                type="button"
                className="btn"
                onClick={() => {
                  setRenaming(false);
                  renameBtn.current?.focus();
                }}
              >
                Cancel
              </button>
            </div>
          ) : null}
        </div>
      </>
    ) : null;

  return (
    <Sheet open onClose={onClose} title={title} footer={footer}>
      <div className="stack studio-modal">
        {detail.isLoading ? <Spinner label="Loading plan detail" /> : null}
        {detail.isError ? <p className="muted">Couldn't load this plan's detail — the actions below still work.</p> : null}
        {d ? (
          <>
            <div className="row studio-modal-meta">
              <span className={`pill ${d.plan.discipline === "lift" ? "pill-lift" : "pill-run"}`}>
                {d.plan.discipline === "lift" ? "Lift" : d.plan.discipline === "mobility" ? "Mobility" : "Run"}
              </span>
              <span className={`pill ${d.plan.status === "active" ? "pill-ok" : "pill-neutral"}`}>
                {d.plan.source === "studio" && d.plan.status === "active" ? "active · on watch" : d.plan.status}
              </span>
              {/* A container of loose sessions has no span to state: its dates
                  are wherever its one-offs fell. It reports its contents on
                  the line below instead. */}
              {d.plan.kind === "loose" ? (
                <span className="faint">one-offs · no planned duration</span>
              ) : (
                <span className="faint num">
                  {formatShortDate(d.plan.startDate)} → {formatShortDate(d.plan.endDate)}
                </span>
              )}
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
                {d.progressions.map((p) => progressionInUnits(p, units, weightUnit)).map((p) => (
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
                      .map((p) => <ProgressionStepChart key={p.key} progression={progressionInUnits(p, units, weightUnit)} discipline="lift" raceWeek={raceWeek} raceLabel={raceLabel} />)
                  : [
                      ...d.progressions
                        .filter((p) => p.key === "run:long-run")
                        .map((p) => <ProgressionStepChart key={p.key} progression={progressionInUnits(p, units, weightUnit)} discipline="run" raceWeek={raceWeek} raceLabel={raceLabel} />),
                      ...d.progressions
                        .filter((p) => p.key === "run:weekly-minutes")
                        .map((p) => <PlannedVsActualBars key={p.key} progression={p} raceWeek={raceWeek} raceLabel={raceLabel} />),
                    ]}
              </div>
            ) : null}

            {/* No weeks, no Weeks heading — a container of one-offs has none,
                and an empty list under a heading reads as a failed load.
                (`hidden` would not do it: `.studio-modal-weeks` declares
                `display: flex`, which out-specifies the UA's `[hidden]`.) */}
            {d.weeks.length === 0 ? null : (
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
            )}
          </>
        ) : null}
      </div>
      <ConfirmDialog
        open={confirmingRetire}
        onClose={() => setConfirmingRetire(false)}
        title="Retire this plan?"
        confirmLabel="Retire the plan"
        busy={retiring}
        error={retireError}
        onConfirm={async () => {
          setRetiring(true);
          const why = await onRetire(planId, source === "studio" ? "studio" : "coach");
          setRetiring(false);
          if (why) setRetireError(why);
        }}
      >
        “{title}” stops here and every session still ahead of it is archived. Sessions you have
        already done are kept.
      </ConfirmDialog>
    </Sheet>
  );
}
