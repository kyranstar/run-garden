/**
 * THE OBJECTIVES BOARD (Stage 3 Task 11; spec §11; principles §2.9, §2.10, §5.2) — `/studio/objectives`, behind the coach
 * switch (`coachOn`): the board belongs to the coach stage. Off, the route goes back to the Studio and nothing links here.
 *
 *   ‹ Studio
 *   Objectives                                              [＋ New objective]
 *   ┌──────────────────────────────────────────────────────────────────┐
 *   │ (58%)  Stronger legs for ski season                            ⋯ │
 *   │        Ski the whole day                    ← the athlete's why  │
 *   │        Ski · Strength   3 weeks in a row                         │
 *   │  Wall sit hold                                       [Measured]  │
 *   │  Longest hold · Wall sit · last 90 days · 3 points               │
 *   │  Now 95 s   Start 60 s   Target 120 s                            │
 *   │  [ the trend, the target dashed, the best ever ringed ]          │
 *   │  Best ever 95 s · Oct 12                                         │
 *   │  RECENTLY  Mon Oct 12 · Lower body strength ›   (up to three)    │
 *   │  Coach  Single-leg strength, with a hold test on Thursday.       │
 *   └──────────────────────────────────────────────────────────────────┘
 *   COMPLETED
 *   …
 *
 * One read (`GET /api/objectives/board`) brings every card. ⋯ holds the rest, one tap down: Edit… (the sheet,
 * objectives-sheet.tsx), Pause / Resume, Mark complete… (asked once, plainly) / Reopen — each a status change through
 * `PUT /api/objectives/:id`.
 *
 * Gentle (§2.10): a streak from one week and never at zero; a best ever only when it is on the trend (an old one is not
 * brought up); a stalled objective only its facts and one neutral line with a next step; no red anywhere. Evidence in
 * plain words — Measured, Few readings, At least, Not measured yet — and one not measured yet offers to ask the coach for
 * a test (fix wave 3B, B-I11); a stalled objective's "Ask the coach" offers a request toward it (Task 13, D13) — both
 * open the app's coach sheet seeing the objective, the request written in its box. A card has no Ask of its own (the
 * new shape: the nav's coach sees an open quest). A key result is a "measure" to the athlete. The athlete's words and
 * the coach's line are text.
 *
 * In Growth (the new shape §7) the same board is the quests (`variant="quests"`): each objective a row with its bar and
 * line (growth/quests.tsx) that opens this card in a sheet; the same actions.
 */
import { useEffect, useId, useRef, useState } from "react";
import { Link, Navigate } from "react-router-dom";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "@rg/api-client";
import type { ObjectiveBoardCard, ObjectiveBoardDto, ObjectiveDto, ObjectiveStatus } from "@rg/domain";
import { EmptyState, formatDayShort, formatShortDate, Sheet, Spinner } from "../../components.js";
import { coachOn } from "../../features.js";
import { IconBack, IconMore, IconPlus } from "../../icons.js";
import { useUnits, useWeightUnit } from "../../use-units.js";
import { CoachBoundary } from "./coach-boundary.js";
import { KrTrendChart } from "./objectives-chart.js";
import {
  boardSections,
  emptyObjective,
  evidenceWord,
  formatKr,
  goalWords,
  measureWords,
  objectiveDraftOf,
  objectiveFraction,
  pointsWords,
  stalled,
  stalledRequest,
  STALL_DAYS,
  streakWords,
  testRequest,
  windowWords,
  writeError,
  type BoardUnits,
  type ObjectiveDraft,
} from "./objectives-model.js";
import { AskCoach, useCoachSeeing } from "./coach-ask.js";
import { objectiveFocus } from "./coach-focus.js";
import { ObjectiveSheet } from "./objectives-sheet.js";
import { planDayHref } from "./run-model.js";
import { QuestRow } from "../growth/quests.js";

export const OBJECTIVE_BOARD_QUERY = ["objectives", "board"] as const;
export const OBJECTIVES_HREF = "/studio/objectives";

/** The route: the board with the coach on; the Studio without it. */
export function ObjectivesRoute() {
  if (!coachOn()) return <Navigate to="/studio" replace />;
  // A render error on the board stays on the board (the robustness pass): it says so, with a reload.
  return (
    <CoachBoundary what="your objectives">
      <ObjectivesScreen />
    </CoachBoundary>
  );
}

const STATUS_WORD: Partial<Record<ObjectiveStatus, string>> = { paused: "Paused", done: "Completed" };

type Editing = { id: string | null; draft: ObjectiveDraft; n: number };

/**
 * The board — or Growth's quests (`variant="quests"`, the new shape §7): the same objectives and the same actions, each
 * objective a quest row (growth/quests.tsx) that opens its full card in a sheet, under a "Quests" heading in place of
 * the board's page head; the completed ones one tap down.
 */
export function ObjectivesScreen({ variant = "board" }: { variant?: "board" | "quests" } = {}) {
  const quests = variant === "quests";
  const qc = useQueryClient();
  const q = useQuery({ queryKey: OBJECTIVE_BOARD_QUERY, queryFn: api.objectiveBoard, staleTime: 30_000 });
  const units: BoardUnits = { units: useUnits(), weightUnit: useWeightUnit() };
  const [menuId, setMenuId] = useState<string | null>(null);
  const [completing, setCompleting] = useState<{ o: ObjectiveDto; busy: boolean; error: string | null } | null>(null);
  const [editing, setEditing] = useState<Editing | null>(null);
  const [status, setStatus] = useState<string | null>(null);
  /** The quest whose card is open (quests only). */
  const [questId, setQuestId] = useState<string | null>(null);
  const [doneOpen, setDoneOpen] = useState(false);
  const headingId = useId();
  const opened = useRef(0);
  const root = useRef<HTMLDivElement>(null);
  const focusNext = useRef<string | null>(null);

  // Focus never falls to <body>: after a change, to the card's ⋯ (or the page's New objective).
  useEffect(() => {
    const want = focusNext.current;
    if (!want || !root.current) return;
    const el =
      want === "new"
        ? root.current.querySelector<HTMLElement>(".obj-new")
        : quests
          ? [...root.current.querySelectorAll<HTMLElement>(".quest")].find((c) => c.dataset.id === want)?.querySelector<HTMLElement>(".quest-open")
          : [...root.current.querySelectorAll<HTMLElement>(".obj-card")].find((c) => c.dataset.id === want)?.querySelector<HTMLElement>(".obj-more");
    if (!el) return;
    focusNext.current = null;
    el.focus();
  });

  const board = q.data;
  const cardOf = (id: string) => board?.objectives.find((c) => c.objective.id === id) ?? null;
  /** The objective as the server now has it, in its place on the board; then the board read again. */
  const put = (o: ObjectiveDto) => {
    qc.setQueryData<ObjectiveBoardDto>(OBJECTIVE_BOARD_QUERY, (old) =>
      old ? { ...old, objectives: old.objectives.map((c) => (c.objective.id === o.id ? { ...c, objective: o } : c)) } : old,
    );
    void qc.invalidateQueries({ queryKey: ["objectives"] });
  };

  const setStatusOf = async (o: ObjectiveDto, next: ObjectiveStatus): Promise<string | null> => {
    try {
      const res = await api.updateObjective(o.id, { status: next });
      put(res.objective);
      focusNext.current = o.id;
      const said = next === "paused" ? "Paused" : next === "done" ? "Completed" : o.status === "done" ? "Reopened" : "Resumed";
      setStatus(`${said} “${res.objective.title}”.`);
      return null;
    } catch (e) {
      return writeError(e, null)[0]!;
    }
  };

  const change = async (o: ObjectiveDto, next: ObjectiveStatus) => {
    setMenuId(null);
    const why = await setStatusOf(o, next);
    if (why) setStatus(why);
  };

  const complete = async () => {
    const c = completing;
    if (!c || c.busy) return;
    setCompleting({ ...c, busy: true, error: null });
    const why = await setStatusOf(c.o, "done");
    if (why) setCompleting({ ...c, busy: false, error: why });
    else setCompleting(null);
  };

  const openSheet = (o: ObjectiveDto | null) => {
    setMenuId(null);
    opened.current += 1;
    setEditing({ id: o?.id ?? null, draft: o ? objectiveDraftOf(o, units) : emptyObjective(), n: opened.current });
  };

  const save = async (draft: ObjectiveDraft, body: { title: string; why: string | null; goalIds: string[]; keyResults: unknown[] }): Promise<string[] | null> => {
    const e = editing;
    if (!e) return null;
    try {
      if (e.id === null) {
        const { why, ...rest } = body;
        const res = await api.createObjective({ ...rest, ...(why !== null ? { why } : {}) } as Parameters<typeof api.createObjective>[0]);
        void qc.invalidateQueries({ queryKey: ["objectives"] });
        focusNext.current = res.objective.id;
        setStatus(`Added “${res.objective.title}”.`);
      } else {
        const res = await api.updateObjective(e.id, body as Parameters<typeof api.updateObjective>[1]);
        put(res.objective);
        focusNext.current = e.id;
        setStatus(`Saved “${res.objective.title}”.`);
      }
      setEditing(null);
      return null;
    } catch (err) {
      return writeError(err, draft);
    }
  };

  const menu = menuId ? cardOf(menuId)?.objective ?? null : null;
  const quest = questId ? cardOf(questId) : null;
  const waiting = q.isPending && q.fetchStatus === "paused";
  let body;
  if (q.isPending && !waiting) body = <Spinner label="Loading your objectives" />;
  else if (!board && (waiting || q.isError)) {
    body = (
      <EmptyState title={waiting ? "Your objectives need a connection." : "Couldn't load your objectives."}>
        {waiting ? null : (
          <button type="button" className="btn" onClick={() => void q.refetch()}>
            Try again
          </button>
        )}
      </EmptyState>
    );
  } else if (!board || board.objectives.length === 0) {
    body = quests ? <p className="muted">No objectives yet.</p> : <EmptyState title="No objectives yet." />;
  } else if (quests) {
    const { current, done } = boardSections(board.objectives);
    const list = (cards: ObjectiveBoardCard[]) => (
      <ul className="quest-list" role="list">
        {cards.map((c) => (
          <li key={c.objective.id}>
            <QuestRow card={c} today={board.today} onOpen={() => setQuestId(c.objective.id)} />
          </li>
        ))}
      </ul>
    );
    body = (
      <>
        {current.length ? list(current) : <p className="muted">No objectives under way.</p>}
        {done.length ? (
          <>
            <button type="button" className="linklike dash-more" aria-expanded={doneOpen} onClick={() => setDoneOpen((v) => !v)}>
              {`${done.length} completed`}
              <span className="disclosure-caret" aria-hidden>
                {doneOpen ? "▾" : "▸"}
              </span>
            </button>
            {doneOpen ? list(done) : null}
          </>
        ) : null}
      </>
    );
  } else {
    const { current, done } = boardSections(board.objectives);
    const list = (cards: ObjectiveBoardCard[]) => (
      <ul className="obj-list">
        {cards.map((c) => (
          <li key={c.objective.id}>
            <ObjectiveCard card={c} today={board.today} units={units} onMore={() => setMenuId(c.objective.id)} />
          </li>
        ))}
      </ul>
    );
    body = (
      <>
        {current.length ? list(current) : null}
        {done.length ? (
          <section className="obj-done" aria-labelledby="obj-done-h">
            <h2 id="obj-done-h" className="eyebrow">
              Completed
            </h2>
            {list(done)}
          </section>
        ) : null}
      </>
    );
  }

  const newButton = (
    <button type="button" className={`btn obj-new${quests ? " btn-small" : ""}`} aria-haspopup="dialog" onClick={() => openSheet(null)}>
      <IconPlus size={16} />
      New objective
    </button>
  );
  return (
    <div ref={root} className={quests ? "growth-sect quests stack" : "obj"} {...(quests ? { role: "region", "aria-labelledby": headingId } : {})}>
      {quests ? (
        <div className="row-between growth-sect-head">
          <h2 id={headingId} className="rank-item growth-h">
            Quests
          </h2>
          {newButton}
        </div>
      ) : (
        <>
          <div className="stu-build-bar">
            <Link className="btn stu-build-back" to="/studio">
              <IconBack size={16} />
              Studio
            </Link>
          </div>
          <div className="obj-head">
            <h1 tabIndex={-1}>Objectives</h1>
            {newButton}
          </div>
        </>
      )}
      {/* Empty, it is visually hidden — never display: none — so the region stays in the page and is heard when it speaks. */}
      <p className={status ? "obj-status" : "obj-status visually-hidden"} role="status">
        {status}
      </p>
      {body}

      {quest && board ? (
        <QuestSheet
          card={quest}
          today={board.today}
          units={units}
          onMore={() => {
            setQuestId(null);
            setMenuId(quest.objective.id);
          }}
          onClose={() => {
            focusNext.current = quest.objective.id;
            setQuestId(null);
          }}
        />
      ) : null}
      {menu ? (
        <Sheet open onClose={() => setMenuId(null)} title={menu.title}>
          <div className="stu-tpl-menu">
            <button type="button" className="btn" onClick={() => openSheet(menu)}>
              Edit…
            </button>
            {menu.status === "active" ? (
              <button type="button" className="btn" onClick={() => void change(menu, "paused")}>
                Pause
              </button>
            ) : null}
            {menu.status === "paused" ? (
              <button type="button" className="btn" onClick={() => void change(menu, "active")}>
                Resume
              </button>
            ) : null}
            {menu.status === "done" ? (
              <button type="button" className="btn" onClick={() => void change(menu, "active")}>
                Reopen
              </button>
            ) : (
              <button
                type="button"
                className="btn"
                onClick={() => {
                  setMenuId(null);
                  setCompleting({ o: menu, busy: false, error: null });
                }}
              >
                Mark complete…
              </button>
            )}
          </div>
        </Sheet>
      ) : null}
      {completing ? (
        <Sheet
          open
          centered
          onClose={() => setCompleting(null)}
          title="Mark it complete?"
          footer={
            <div className="btn-row">
              <button type="button" className="btn" onClick={() => setCompleting(null)}>
                Not yet
              </button>
              <button type="button" className="btn btn-primary" disabled={completing.busy} onClick={() => void complete()}>
                Mark complete
              </button>
            </div>
          }
        >
          {completing.error ? (
            <p className="stu-build-error" role="alert">
              {completing.error}
            </p>
          ) : (
            <p>{`“${completing.o.title}” moves to Completed. You can reopen it.`}</p>
          )}
        </Sheet>
      ) : null}
      {editing ? (
        <ObjectiveSheet
          key={editing.n}
          initial={editing.draft}
          editing={editing.id !== null}
          units={units}
          onSave={save}
          onClose={() => {
            focusNext.current = editing.id ?? "new";
            setEditing(null);
          }}
        />
      ) : null}
    </div>
  );
}

/** A quest's full card, in a sheet; while it is open the app's coach sees the objective. */
function QuestSheet({ card, today, units, onMore, onClose }: { card: ObjectiveBoardCard; today: string; units: BoardUnits; onMore: () => void; onClose: () => void }) {
  useCoachSeeing(objectiveFocus(card.objective));
  return (
    <Sheet open onClose={onClose} title={card.objective.title}>
      <ObjectiveCard card={card} today={today} units={units} onMore={onMore} />
    </Sheet>
  );
}

/** A quiet ring: how far the objective's key results are toward their targets, the share in its middle. */
function ProgressRing({ fraction }: { fraction: number }) {
  const pct = Math.round(fraction * 100);
  const r = 18;
  const c = 2 * Math.PI * r;
  return (
    <span className="obj-ring" role="img" aria-label={`${pct}% of the way to its targets`}>
      <svg viewBox="0 0 44 44" aria-hidden="true">
        <circle className="obj-ring-track" cx={22} cy={22} r={r} />
        <circle
          className="obj-ring-arc"
          cx={22}
          cy={22}
          r={r}
          strokeDasharray={c.toFixed(2)}
          strokeDashoffset={(c * (1 - fraction)).toFixed(2)}
          transform="rotate(-90 22 22)"
          style={{ ["--obj-ring-c" as string]: c.toFixed(2) }}
        />
      </svg>
      <span className="obj-ring-pct" aria-hidden="true">
        {`${pct}%`}
      </span>
    </span>
  );
}

function ObjectiveCard({ card, today, units, onMore }: { card: ObjectiveBoardCard; today: string; units: BoardUnits; onMore: () => void }) {
  const o = card.objective;
  const headingId = useId();
  const fraction = objectiveFraction(card);
  const streak = streakWords(card.streakWeeks);
  const goals = goalWords(o.goalIds);
  const statusWord = STATUS_WORD[o.status];
  return (
    <article className={`obj-card obj-card--${o.status}`} data-id={o.id} aria-labelledby={headingId}>
      <div className="obj-card-head">
        {fraction !== null ? <ProgressRing fraction={fraction} /> : null}
        <div className="obj-card-titles">
          <h2 id={headingId} className="obj-title">
            {o.title}
          </h2>
          {o.why ? <p className="obj-why">{o.why}</p> : null}
          {statusWord || goals || streak ? (
            <p className="obj-facts">
              {statusWord ? <span className="pill pill-neutral obj-state">{statusWord}</span> : null}
              {goals ? <span className="obj-goals">{goals}</span> : null}
              {streak ? <span className="obj-streak">{streak}</span> : null}
            </p>
          ) : null}
        </div>
        <button type="button" className="btn stu-icon-btn obj-more" aria-label={`${o.title}: more`} aria-haspopup="dialog" onClick={onMore}>
          <IconMore size={18} />
        </button>
      </div>

      {card.keyResults.length ? (
        <ul className="obj-krs">
          {card.keyResults.map((k) => (
            <KeyResultRow key={k.keyResult.id} k={k} units={units} objective={o} />
          ))}
        </ul>
      ) : (
        <p className="obj-quiet">No measures yet.</p>
      )}

      {card.served.length ? (
        <section className="obj-served" aria-label="Recently">
          <h3 className="eyebrow">Recently</h3>
          <ul>
            {card.served.map((s) => (
              <li key={s.workoutId}>
                <Link className="obj-served-link" to={planDayHref(s.workoutId, s.date)}>
                  {`${formatDayShort(s.date)} · ${s.title}`}
                </Link>
              </li>
            ))}
          </ul>
        </section>
      ) : null}
      {stalled(card, today) ? (
        <p className="obj-quiet">
          {`Nothing done toward this in the last ${STALL_DAYS / 7} weeks. `}
          {/* The coach's sheet opens on it, about this objective, a request toward it in the field (Task 13, D13; coach
              everywhere, A3: in place of the link to the Studio's composer), as the test line does. */}
          <AskCoach variant="link" label="Ask the coach" focus={objectiveFocus(o)} request={stalledRequest(card.objective.title)} />
        </p>
      ) : null}
      {card.note ? (
        <p className="obj-note">
          <span className="obj-note-who">Coach</span> {card.note.text}
        </p>
      ) : null}
    </article>
  );
}

function KeyResultRow({
  k,
  units,
  objective,
}: {
  k: ObjectiveBoardCard["keyResults"][number];
  units: BoardUnits;
  /** Whose measure it is: what the coach is asked about for a test. */
  objective: { id: string; title: string };
}) {
  const { keyResult: kr, progress: p, best } = k;
  const m = kr.measure;
  const fmt = (v: number) => formatKr(v, kr.unit, m);
  const current = p.display.current;
  const facts = [m ? measureWords(m, units) : "A measure that can no longer be read", m ? windowWords(m) : null, p.sampleSize > 0 ? pointsWords(p.sampleSize) : null].filter(
    (x): x is string => !!x,
  );
  const bestOnTrend = best !== null && p.series.some((pt) => pt.date === best.date && pt.value === best.value);
  return (
    <li className="obj-kr">
      <div className="obj-kr-head">
        <h3 className="obj-kr-label">{kr.label}</h3>
        <span className={`pill obj-ev obj-ev--${p.evidence}`}>{evidenceWord(p.evidence)}</span>
      </div>
      <p className="obj-kr-facts">{facts.join(" · ")}</p>
      <dl className="obj-kr-nums">
        {current !== null ? (
          <div>
            <dt>Now</dt>
            <dd>{`${p.evidence === "capped" ? "at least " : ""}${fmt(current)}`}</dd>
          </div>
        ) : null}
        {kr.baseline !== null ? (
          <div>
            <dt>Start</dt>
            <dd>{fmt(kr.baseline)}</dd>
          </div>
        ) : null}
        {kr.target !== null ? (
          <div>
            <dt>Target</dt>
            <dd>{fmt(kr.target)}</dd>
          </div>
        ) : null}
        {kr.dueDate ? (
          <div>
            <dt>By</dt>
            <dd>{formatShortDate(kr.dueDate)}</dd>
          </div>
        ) : null}
      </dl>
      {p.series.length ? (
        <KrTrendChart label={kr.label} series={p.series} unit={kr.unit} measure={m} target={kr.target} best={best} />
      ) : (
        <p className="obj-quiet">{p.missing ?? "Nothing measured yet."}</p>
      )}
      {/* Not measured yet: the coach can plan a test — its sheet opens about the objective, the request in the field
          (fix wave 3B, B-I11; coach everywhere, A3). */}
      {p.evidence === "none" ? (
        <AskCoach variant="link" label="Ask the coach for a test" className="obj-ask-test" focus={objectiveFocus(objective)} request={testRequest(kr.label)} />
      ) : null}
      {bestOnTrend ? (
        <p className="obj-best">
          <span className="obj-best-glyph" aria-hidden="true">
            ◎
          </span>
          {`Best ever ${fmt(best.display)} · ${formatShortDate(best.date)}`}
        </p>
      ) : null}
    </li>
  );
}
