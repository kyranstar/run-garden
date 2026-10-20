import { useUnits, useWeightUnit } from "../use-units.js";
import { useEffect, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { api, ApiError, type CoachPlanDto, type PlanDetailResponse, type TrainingLineDto } from "@rg/api-client";
import { ConfirmDialog, formatShortDate, Sheet, Spinner, useEscapeKey } from "../components.js";
import { dayLabel, lineSentenceName, planEnded, startOfIsoWeek } from "@rg/domain";
import { PlannedVsActualBars, progressionInUnits, ProgressionStepChart } from "./plan-charts.js";
import { useCoach } from "./studio/coach-ask.js";
import { NUDGES_QUERY } from "./studio/coach-conversation-model.js";

/** How a plan is named in a request: "my Fall Half Block plan" — never "my Base plan plan". */
const planPhrase = (title: string): string => (/\bplan$/i.test(title.trim()) ? `my ${title.trim()}` : `my ${title.trim()} plan`);

/**
 * The words the sheet's coach actions write in the conversation's box — the athlete's to send, never sent for them:
 * "Ask about this plan", Extend and Wind down (§8 §6: the conversation works on whole plans now).
 */
export function planRequests(title: string): { ask: string; extend: string; windDown: string } {
  return requestsFor(planPhrase(title));
}

/** A training line's words: its end is the line's, so they name the line ("Extend my running plan by two weeks"). */
export function lineRequests(discipline: TrainingLineDto["discipline"]): { ask: string; extend: string; windDown: string } {
  return requestsFor(lineSentenceName(discipline));
}

function requestsFor(plan: string): { ask: string; extend: string; windDown: string } {
  return { ask: `How is ${plan} going?`, extend: `Extend ${plan} by two weeks`, windDown: `Wind down ${plan}` };
}

/** Why a change to a plan didn't happen, in words: the server's own when it gave them, a plan gone, else `otherwise`. */
function refusalWords(e: unknown, otherwise: string): string {
  const body = e instanceof ApiError ? (e.body as { why?: unknown } | null) : null;
  if (typeof body?.why === "string" && body.why) return body.why;
  if (e instanceof ApiError && e.status === 404) return "This plan isn't here any more.";
  return otherwise;
}

/** Why a race day didn't change, in words: the server's own when it gave them. */
export function raceRefusal(e: unknown): string {
  return refusalWords(e, "Couldn't change the race day. Try again.");
}

/**
 * THE PLAN'S RACE (stream G, 2026-10-19: a race was cancelled, and the plan still named it). "Race · Fri 23 Oct" and,
 * for a block the coach wrote, a Change: a day field from the plan's first day, Save, No race and Cancel. Saving asks
 * `POST /api/coach/plans/:id/race`, then reads again what says the race: the plan, the week, the race strip and the
 * coach's chips. A refusal is said in its words and the field stays open. Only the plan's own race — Settings' race day
 * is changed in Settings.
 */
function PlanRace({ planId, race, firstDay, canChange }: { planId: string; race: string; firstDay: string; canChange: boolean }) {
  const qc = useQueryClient();
  const [editing, setEditing] = useState(false);
  const [day, setDay] = useState(race);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const changeBtn = useRef<HTMLButtonElement>(null);
  const editor = useRef<HTMLDivElement>(null);
  const close = () => {
    setEditing(false);
    setError(null);
    changeBtn.current?.focus();
  };
  // Escape closes the field, not the sheet: while it is open, it is the top thing.
  useEscapeKey(editing, close);
  // Opened near the sheet's fold, the field and its answers scroll into view.
  useEffect(() => {
    if (editing) editor.current?.scrollIntoView?.({ block: "nearest" });
  }, [editing]);
  const save = async (raceDate: string | null) => {
    setBusy(true);
    setError(null);
    try {
      await api.coachPlanRace(planId, raceDate);
      for (const queryKey of [["plan-detail", planId], ["coach-plans"], ["plan-week"], ["plan"], ["race-hub"], [...NUDGES_QUERY]]) {
        void qc.invalidateQueries({ queryKey });
      }
      setEditing(false);
    } catch (e) {
      setError(raceRefusal(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="stack plan-race">
      <div className="row plan-race-line">
        <span className="num">Race · {dayLabel(race)}</span>
        {canChange ? (
          <button
            type="button"
            className="btn btn-small"
            ref={changeBtn}
            aria-expanded={editing}
            aria-controls="plan-race-edit"
            onClick={() => {
              if (editing) return close();
              setDay(race);
              setError(null);
              setEditing(true);
            }}
          >
            Change
          </button>
        ) : null}
      </div>
      <div id="plan-race-edit" className="disclosure-body">
        {editing ? (
          <div className="row plan-race-edit" ref={editor}>
            <input
              type="date"
              aria-label="Race day"
              value={day}
              min={firstDay}
              autoFocus
              onChange={(e) => setDay(e.target.value)}
            />
            <button type="button" className="btn btn-primary" disabled={busy || !day || day === race} onClick={() => void save(day)}>
              Save
            </button>
            <button type="button" className="btn" disabled={busy} onClick={() => void save(null)}>
              No race
            </button>
            <button type="button" className="btn" onClick={close}>
              Cancel
            </button>
          </div>
        ) : null}
        {editing && error ? (
          <p className="confirm-error" role="alert" style={{ margin: 0 }}>
            {error}
          </p>
        ) : null}
      </div>
    </div>
  );
}

/**
 * THE PLAN SHEET (the new shape §6; the plan "studio" modal before it): one room per plan — where you are, where it is
 * taking you (graphed), what each week holds, and its actions. Extend, Wind down and "Ask about this plan" open the
 * conversation with the request written (`planRequests`; §8 §6 — the thread coach has stepped back); Rename and Retire…
 * are the app's own. The page routes it by `?plan=<id>`, so links and back work. A plan the retired generator made
 * still opens here.
 *
 * A one-phase training line is this sheet too (training lines §3.3, `LineSheet`): its Retire is "Stop this plan", with a
 * confirm that counts the sessions leaving the calendar (`useStopLine`), and an ended line's sheet is read-only.
 */
export function PlanSheet({
  planId,
  plans,
  onClose,
  onRetire,
  onRename,
  line,
  stop,
}: {
  planId: string;
  plans: CoachPlanDto[];
  onClose: () => void;
  /**
   * Retire the plan; `source` says which kind, so the page asks the right route. Resolves with why it did not happen
   * (said in the confirmation, which stays open), or null. Not asked for a line's block, which is stopped instead.
   */
  onRetire?: (id: string, source: "coach" | "studio") => Promise<string | null>;
  onRename: (id: string, name: string) => void;
  /** The one-phase training line this block is: Retire becomes "Stop this plan". */
  line?: TrainingLineDto;
  /** The line's Stop, held by its `LineSheet`. */
  stop?: LineStop;
}) {
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
  /** So closing the rename editor hands focus back to what opened it. */
  const renameBtn = useRef<HTMLButtonElement>(null);
  const closeRename = () => {
    setRenaming(false);
    renameBtn.current?.focus();
  };
  /** Who made it: the coach, the retired generator ("studio"), or COROS. */
  const source = (detail.data?.plan ?? plan)?.source ?? "coach";
  /** A line that has ended, or that was just stopped, is read: nothing in it changes from here. */
  const readOnly = !!line && (line.ended || !!stop?.stopped);

  const d = detail.data;
  const title = d?.plan.name ?? plan?.name ?? "Plan";
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
                it is not offered a taper. Each opens the coach with its words. */}
            {(d?.plan ?? plan)?.kind === "loose" || !coach || readOnly ? null : (
              <>
                <button type="button" className="btn" onClick={() => coach.open({ request: requests.extend })}>
                  Extend
                </button>
                <button type="button" className="btn" onClick={() => coach.open({ request: requests.windDown })}>
                  Wind down
                </button>
              </>
            )}
            {readOnly ? null : (
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
                  setConfirmingRetire(false);
                  setRenaming(true);
                }}
              >
                Rename
              </button>
            )}
            {line ? null : (
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
            )}
            {/* A line's block is stopped, not retired — once the account's today is known to say what has ended. */}
            {line && stop?.canStop && !readOnly ? (
              <button
                type="button"
                className="btn"
                aria-haspopup="dialog"
                onClick={() => {
                  setRenaming(false);
                  stop.ask(line);
                }}
              >
                Stop this plan…
              </button>
            ) : null}
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
          {/* Escape worked and nothing said so: the editor has Save and Cancel. A rename is not a thing a reader
              should have to guess their way out of. */}
          {renaming && !readOnly ? (
            <RenameEditor
              initial={title}
              label="Plan name"
              onSave={(name) => {
                onRename(planId, name);
                closeRename();
              }}
              onCancel={closeRename}
            />
          ) : null}
        </div>
      </>
    ) : null;

  return (
    <Sheet open onClose={onClose} title={title} footer={footer}>
      <div className="stack studio-modal">
        {stop?.said}
        <PlanDetailBody planId={planId} race={readOnly ? "read" : "own"} />
      </div>
      {line ? (
        stop?.dialog
      ) : (
        <ConfirmDialog
          open={confirmingRetire}
          onClose={() => setConfirmingRetire(false)}
          title="Retire this plan?"
          confirmLabel="Retire the plan"
          busy={retiring}
          error={retireError}
          onConfirm={async () => {
            if (!onRetire) return;
            setRetiring(true);
            const why = await onRetire(planId, source === "studio" ? "studio" : "coach");
            setRetiring(false);
            if (why) setRetireError(why);
          }}
        >
          “{title}” stops here and every session still ahead of it is archived. Sessions you have
          already done are kept.
        </ConfirmDialog>
      )}
    </Sheet>
  );
}

/**
 * What a plan's detail says, from `GET /api/coach/plans/:id/detail`: its kind and state, its dates, the sessions done
 * and its adherence, its race, its progressions graphed, and its weeks. The plan sheet's body, and the open phase's in a
 * training line's sheet. `race`: "own" — the plan's own race, changed here when the coach wrote it; "read" — said, never
 * changed (an ended line); "none" — not said (a line says its race once, on its last phase).
 */
function PlanDetailBody({ planId, race }: { planId: string; race: "own" | "read" | "none" }) {
  const units = useUnits();
  const weightUnit = useWeightUnit();
  const detail = useQuery<PlanDetailResponse>({
    queryKey: ["plan-detail", planId],
    queryFn: () => api.planDetail(planId),
    staleTime: 60_000,
  });
  const d = detail.data;
  // Race day as a labeled vertical line on every by-week chart (user
  // request): week index relative to the plan's own W1.
  const raceWeek = d?.plan.raceDate
    ? Math.floor(
        (Date.parse(d.plan.raceDate) - Date.parse(startOfIsoWeek(d.plan.startDate))) / (7 * 86_400_000),
      ) + 1
    : null;
  const raceLabel = d?.plan.raceDate ? `race · ${formatShortDate(d.plan.raceDate)}` : undefined;
  return (
    <>
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
          </div>
          <p className="faint studio-modal-sub num">
            {d.sessions.done} of {d.sessions.planned} sessions done
            {d.adherencePct !== null ? ` · adherence ${d.adherencePct}%` : ""}
          </p>
          {/* The plan's own race (stream G): a watch plan's or the Studio's race day is Settings', said there. */}
          {d.plan.planRaceDate && race !== "none" ? (
            <PlanRace
              key={d.plan.planRaceDate}
              planId={d.plan.id}
              race={d.plan.planRaceDate}
              firstDay={d.plan.startDate}
              canChange={race === "own" && (d.plan.source ?? "coach") === "coach" && d.plan.kind !== "loose"}
            />
          ) : null}

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
    </>
  );
}

// ── Training lines (2026-10-20, the spec §3.3) ──────────────────────────────

/**
 * Where a phase stands in its line: ended (its last day has passed); current — under way today (an earlier phase still
 * running beside the line's current one is too), or the line's current phase while it is still ahead (before the line
 * starts, or between phases); or later, ahead of that.
 */
export function linePhaseState(line: TrainingLineDto, phase: TrainingLineDto["phases"][number], today: string): "ended" | "current" | "later" {
  if (planEnded(phase.endDate, today)) return "ended";
  return phase.id === line.currentPhaseId || phase.startDate <= today ? "current" : "later";
}

/**
 * What "Stop this plan" retires: every phase that has not ended, in order — the current one, those after it, and an
 * earlier one still running beside it (the lead's ruling, review round 1: stopping a plan ends it; past means ended,
 * §3.5). A phase that has ended is never touched.
 */
function phasesToStop(line: TrainingLineDto, today: string): TrainingLineDto["phases"] {
  return line.phases.filter((p) => !planEnded(p.endDate, today));
}

/** The sessions "Stop this plan" takes off the calendar: those still ahead in the phases it retires. */
export function stopCount(line: TrainingLineDto, today: string): number {
  return phasesToStop(line, today).reduce((n, p) => n + p.futureSessions, 0);
}

/**
 * Stop a line: retire each phase that has not ended, in order — never one that has ended. A retire that fails (or
 * answers not ok) stops the walk there and fails the stop; the phases retired before it stay retired.
 */
export async function stopLine(
  line: TrainingLineDto,
  today: string,
  retire: (id: string) => Promise<{ ok: boolean }>,
): Promise<{ stopped: string[] }> {
  const stopped: string[] = [];
  for (const p of phasesToStop(line, today)) {
    const res = await retire(p.id);
    if (!res.ok) throw new Error("not_stopped");
    stopped.push(p.id);
  }
  return { stopped };
}

/** The confirm's count: "14 sessions leave your calendar." */
function sessionsLeave(n: number): string {
  if (n === 0) return "No sessions leave your calendar.";
  return n === 1 ? "1 session leaves your calendar." : `${n} sessions leave your calendar.`;
}

/** The result line once it stopped: "Stopped. 14 sessions left your calendar." */
function stoppedWords(n: number): string {
  if (n === 0) return "Stopped.";
  return `Stopped. ${n === 1 ? "1 session" : `${n} sessions`} left your calendar.`;
}

/** What a stop that failed for no reason it was given says, in its confirm, which stays open to try again. */
const STOP_FAILED = "That didn't go through — try again.";

/** What a stop reads again: the plans and lines, the phases' details, the week, the coach's view and its chips. */
const STOP_READS = [["coach-plans"], ["plan-detail"], ["plan"], ["plan-week"], ["coach-state"], [...NUDGES_QUERY]];

/** A line sheet's "Stop this plan" (`useStopLine`), held by `LineSheet` and drawn by the sheet it shows. */
export type LineStop = ReturnType<typeof useStopLine>;

/**
 * "Stop this plan" for a line's sheet. `ask(line)` opens its confirm (`dialog`) and takes what it will stop as it is
 * then: the line and the day, so the phases and the count the confirm says. Confirming retires those phases
 * (`stopLine`, each through `api.coachPlanRetire`, which asks again while the server answers `remaining`) — never the
 * line as read since, which a failed press can have split (a retired phase leaves a gap `linesOf` breaks the line at).
 * A phase retired by an earlier press is never asked again, so a second press retires only what is left. A refusal the
 * server gives words to (or a plan gone) is said in them; any other failure asks to try again. Stopped, the sheet says
 * so in `said` and the focus goes there — the button pressed has gone, and the focus must not fall to the page.
 *
 * `today` is the account's, or null while it is not known: then there is no Stop (`canStop`), since a stand-in day can
 * make a phase that has ended look live.
 */
function useStopLine(today: string | null) {
  const qc = useQueryClient();
  const [asking, setAsking] = useState(false);
  const [count, setCount] = useState(0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [begun, setBegun] = useState(false);
  const [stoppedCount, setStoppedCount] = useState<number | null>(null);
  const asked = useRef<{ line: TrainingLineDto; today: string } | null>(null);
  const retired = useRef(new Set<string>());
  const saidRef = useRef<HTMLParagraphElement>(null);
  useEffect(() => {
    if (stoppedCount !== null) saidRef.current?.focus({ preventScroll: true });
  }, [stoppedCount]);
  const confirm = async () => {
    const what = asked.current;
    if (!what || busy) return;
    setBegun(true);
    setBusy(true);
    setError(null);
    try {
      await stopLine(what.line, what.today, async (id) => {
        if (retired.current.has(id)) return { ok: true };
        const res = await api.coachPlanRetire(id);
        if (res.ok) retired.current.add(id);
        return res;
      });
      setAsking(false);
      setStoppedCount(count);
    } catch (e) {
      setError(refusalWords(e, STOP_FAILED));
    } finally {
      setBusy(false);
      for (const queryKey of STOP_READS) void qc.invalidateQueries({ queryKey });
    }
  };
  return {
    /** The account's today is known, so there is a Stop to offer. */
    canStop: today !== null,
    /** A press has been made: the sheet keeps the line it is stopping from here on. */
    begun,
    stopped: stoppedCount !== null,
    ask: (line: TrainingLineDto) => {
      if (today === null) return;
      asked.current = { line, today };
      setError(null);
      setCount(stopCount(line, today));
      setAsking(true);
    },
    said:
      stoppedCount !== null ? (
        <p ref={saidRef} className="line-stopped" role="status" tabIndex={-1}>
          {stoppedWords(stoppedCount)}
        </p>
      ) : null,
    dialog: (
      <ConfirmDialog
        open={asking}
        onClose={() => {
          setError(null);
          setAsking(false);
        }}
        title="Stop this plan?"
        confirmLabel="Stop the plan"
        busy={busy}
        error={error}
        onConfirm={() => void confirm()}
      >
        {sessionsLeave(count)} What you've done stays.
      </ConfirmDialog>
    ),
  };
}

/**
 * A TRAINING LINE'S SHEET (training lines §3.3): the page routes it by `?line=<key>`; an old `?plan=<coach block>`
 * link opens the block's line, scrolled to that phase (`focusPhaseId`). A line of one phase is the plan sheet, Retire
 * become "Stop this plan"; a line of several lists its phases (`LinePhases`). Which of the two is decided as it opens.
 *
 * The line drawn is the one last read — and, once a Stop has been pressed, the one being stopped, whatever the plans
 * read says after: a retired phase can split the line (`linesOf` breaks it at the gap) or take it out of the read, and
 * the sheet neither shrinks nor moves to another line under the confirm, nor goes from under the focus once stopped.
 */
export function LineSheet({
  lineKey,
  lines,
  plans,
  today,
  todayKnown,
  focusPhaseId = null,
  onClose,
  onRename,
}: {
  lineKey: string;
  /** `GET /api/coach/plans` `lines`. */
  lines: readonly TrainingLineDto[] | undefined;
  plans: CoachPlanDto[];
  /** The day the phases are drawn against: the account's today, else the page's stand-in for it. */
  today: string;
  /** `today` is the account's own. Without it there is no Stop: a stand-in day can make an ended phase look live. */
  todayKnown: boolean;
  focusPhaseId?: string | null;
  onClose: () => void;
  onRename: (id: string, name: string) => void;
}) {
  const stop = useStopLine(todayKnown ? today : null);
  const found = lines?.find((l) => l.key === lineKey) ?? null;
  const [held, setHeld] = useState(found);
  if (!stop.begun && found && found !== held) setHeld(found);
  const line = stop.begun ? held : (found ?? held);
  const [many] = useState(() => (line?.phases.length ?? 0) > 1);
  if (!line || line.phases.length === 0) {
    return (
      <Sheet open onClose={onClose} title="Plan">
        <p className="muted">This plan isn't here any more.</p>
      </Sheet>
    );
  }
  return many ? (
    <LinePhases line={line} today={today} stop={stop} focusPhaseId={focusPhaseId} onClose={onClose} onRename={onRename} />
  ) : (
    <PlanSheet planId={line.phases[0]!.id} plans={plans} line={line} stop={stop} onClose={onClose} onRename={onRename} />
  );
}

/**
 * A line of several phases, in order: one that has ended is a heading that opens to its detail (its adherence is its
 * own); one under way — the current one, and an earlier one still running beside it — is open with its detail as the
 * plan sheet draws it, as is the current one while it is still ahead (its heading says when it starts); those after it
 * are a heading and dates. Rename is on each phase's heading; the line's race is its last phase's, said once and
 * changed there; Extend and Wind down write the line's end in the coach's box. An ended line, or one just stopped, is
 * read-only.
 */
function LinePhases({
  line,
  today,
  stop,
  focusPhaseId,
  onClose,
  onRename,
}: {
  line: TrainingLineDto;
  today: string;
  stop: LineStop;
  focusPhaseId: string | null;
  onClose: () => void;
  onRename: (id: string, name: string) => void;
}) {
  const coach = useCoach();
  const readOnly = line.ended || stop.stopped;
  const requests = lineRequests(line.discipline);
  const last = line.phases[line.phases.length - 1]!;
  // The phase an old link named opens, when it is one that has ended.
  const [open, setOpen] = useState<ReadonlySet<string>>(() => new Set(focusPhaseId ? [focusPhaseId] : []));
  const [renaming, setRenaming] = useState<string | null>(null);
  const phaseEls = useRef(new Map<string, HTMLLIElement>());
  const renameBtns = useRef(new Map<string, HTMLButtonElement>());
  const focusAt = useRef(focusPhaseId);
  useEffect(() => {
    if (focusAt.current) phaseEls.current.get(focusAt.current)?.scrollIntoView?.({ block: "start" });
  }, []);
  const closeRename = (id: string) => {
    setRenaming(null);
    renameBtns.current.get(id)?.focus();
  };

  const footer = (
    <div className="btn-row studio-modal-actions">
      {readOnly || !coach ? null : (
        <>
          <button type="button" className="btn" onClick={() => coach.open({ request: requests.extend })}>
            Extend
          </button>
          <button type="button" className="btn" onClick={() => coach.open({ request: requests.windDown })}>
            Wind down
          </button>
        </>
      )}
      {readOnly || !stop.canStop ? null : (
        <button
          type="button"
          className="btn"
          aria-haspopup="dialog"
          onClick={() => {
            setRenaming(null);
            stop.ask(line);
          }}
        >
          Stop this plan…
        </button>
      )}
      <span className="studio-modal-grow" />
      {coach ? (
        <button type="button" className="btn btn-primary" onClick={() => coach.open({ request: requests.ask })}>
          Ask about this plan
        </button>
      ) : null}
    </div>
  );

  return (
    <Sheet open onClose={onClose} title={line.name} footer={footer}>
      <div className="stack line-sheet">
        {stop.said}
        <p className="faint num line-sheet-span">
          {formatShortDate(line.startDate)} → {formatShortDate(line.endDate)} · {line.phases.length}{" "}
          {line.phases.length === 1 ? "phase" : "phases"}
        </p>
        {/* The line's goal is its last phase's race: said once, and changed there. */}
        {last.planRaceDate ? (
          <PlanRace
            key={`${last.id}:${last.planRaceDate}`}
            planId={last.id}
            race={last.planRaceDate}
            firstDay={last.startDate}
            canChange={!readOnly}
          />
        ) : null}
        <ol className="line-phases">
          {line.phases.map((p, i) => {
            const state = linePhaseState(line, p, today);
            const opened = state === "current" || (state === "ended" && open.has(p.id));
            // The current phase while it is still ahead is not "now": it says when it starts.
            const ahead = state === "current" && today < p.startDate;
            const heading = (
              <>
                <span className="line-phase-name">
                  Phase {i + 1} · {p.name}
                </span>
                <span className="line-phase-dates faint num">
                  {ahead
                    ? `Starts ${formatShortDate(p.startDate)} · ends ${formatShortDate(p.endDate)}`
                    : `${formatShortDate(p.startDate)} → ${formatShortDate(p.endDate)}${state === "ended" ? " · ended" : state === "current" ? " · now" : ""}`}
                </span>
              </>
            );
            return (
              <li
                key={p.id}
                id={`line-phase-${p.id}`}
                className={`line-phase is-${state}`}
                ref={(el) => {
                  if (el) phaseEls.current.set(p.id, el);
                  else phaseEls.current.delete(p.id);
                }}
              >
                <div className="line-phase-head">
                  <h3 className="line-phase-h">
                    {state === "ended" ? (
                      <button
                        type="button"
                        className="line-phase-toggle"
                        aria-expanded={opened}
                        aria-controls={`line-phase-body-${p.id}`}
                        onClick={() =>
                          setOpen((was) => {
                            const next = new Set(was);
                            if (next.has(p.id)) next.delete(p.id);
                            else next.add(p.id);
                            return next;
                          })
                        }
                      >
                        {heading}
                      </button>
                    ) : (
                      <span className="line-phase-title">{heading}</span>
                    )}
                  </h3>
                  {readOnly ? null : (
                    <button
                      type="button"
                      className="btn btn-small"
                      ref={(el) => {
                        if (el) renameBtns.current.set(p.id, el);
                        else renameBtns.current.delete(p.id);
                      }}
                      aria-expanded={renaming === p.id}
                      aria-controls={`line-phase-rename-${p.id}`}
                      onClick={() => setRenaming(renaming === p.id ? null : p.id)}
                    >
                      Rename
                    </button>
                  )}
                </div>
                <div id={`line-phase-rename-${p.id}`} className="disclosure-body">
                  {renaming === p.id && !readOnly ? (
                    <RenameEditor
                      initial={p.name}
                      label="Phase name"
                      onSave={(name) => {
                        onRename(p.id, name);
                        closeRename(p.id);
                      }}
                      onCancel={() => closeRename(p.id)}
                    />
                  ) : null}
                </div>
                <div id={`line-phase-body-${p.id}`} className="disclosure-body">
                  {opened ? (
                    <div className="stack studio-modal line-phase-body">
                      <PlanDetailBody planId={p.id} race="none" />
                    </div>
                  ) : null}
                </div>
              </li>
            );
          })}
        </ol>
      </div>
      {stop.dialog}
    </Sheet>
  );
}

/**
 * THE RENAME EDITOR — one for the plan sheet's foot and each phase's heading: the name in a field, Enter or Save keeps
 * it (trimmed; an empty name is never saved), Escape or Cancel leaves it as it was. Escape closes the field, not the
 * sheet: while it is open, it is the top thing. Whoever opened it hands the focus back as it closes.
 */
function RenameEditor({
  initial,
  label,
  onSave,
  onCancel,
}: {
  initial: string;
  /** The field's name for a screen reader: "Plan name", "Phase name". */
  label: string;
  onSave: (name: string) => void;
  onCancel: () => void;
}) {
  const [name, setName] = useState(initial);
  useEscapeKey(true, onCancel);
  const save = () => {
    if (name.trim()) onSave(name.trim());
  };
  return (
    <div className="row studio-modal-rename">
      <input
        value={name}
        autoFocus
        aria-label={label}
        onChange={(e) => setName(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") save();
        }}
      />
      <button type="button" className="btn btn-primary" disabled={!name.trim()} onClick={save}>
        Save
      </button>
      <button type="button" className="btn" onClick={onCancel}>
        Cancel
      </button>
    </div>
  );
}
