/**
 * THE RUN VIEW (Stage 3 spec §10; Task 9): what the coach is doing, live, and kept with what it proposed afterwards.
 *
 *   Coach · designing ──────────────── $0.21
 *   “a 30-minute lower-body session at home”
 *   About $4.23; the limit is $6.00            ← a set, once its plan made an estimate
 *   [ the question, while it waits on you ]
 *   ✓ Read today …                             ← one line an event; each opens to its detail
 *   ✓ Review — 4.3 avg · sequencing 5 …
 *   ● Reviewing…                               ← the step in flight
 *   Cancel
 *
 * Built from the events' own lines (never from what the model said between tools). The request, every line, a question
 * and its why are the athlete's or the model's words: rendered as text. A line's detail is a short key: value list, cut
 * to size — never raw JSON. Status is never colour alone: each line's mark is a glyph with its word for a reader.
 */
import { useEffect, useId, useMemo, useRef, useState, type ReactNode } from "react";
import { Link } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api, ApiError, DESIGN_MODEL_DEADLINE_MS, type CoachRunDto, type CoachRunEventDto, type CoachRunRole, type CoachRunStatus } from "@rg/api-client";
import { ConfirmDialog } from "../../components.js";
import { ConditionCheckSheet } from "../../components/condition-check-sheet.js";
import { IconChevron, IconClock } from "../../icons.js";
import {
  askedOf,
  CANCEL_CONFIRM_ABOVE_USD,
  checkAskLabel,
  detailOf,
  estimateLine,
  foldLines,
  isLive,
  isMemoryHandle,
  isSlow,
  LOST_LINE,
  PAUSE_LINE,
  QUICK_BELOW_LINE,
  runLines,
  SLOW_LINE,
  spentWords,
  statusWord,
  STILL_WORKING_LINE,
  tileKindWord,
  TRAIL_FOLD_LINE,
  trailSections,
  usd,
  type Asked,
  type Failure,
  type FallbackTile,
  type RunLine,
} from "./run-model.js";
import { useOneTap } from "./use-one-tap.js";

/** How often the view looks at the clock while a step is at work (for "taking longer than usual"). */
export const SLOW_CHECK_MS = 15_000;

/** Lines the trail shows before the earlier ones fold away (the latest always shows). */
export const LINES_SHOWN = 6;
/** A set's day shows its latest lines; the earlier ones fold away the same way (fix wave 3B, B-I7). */
export const DAY_LINES_SHOWN = 3;
/** The most an answer holds (the server's ANSWER_MAX_CHARS). */
export const ANSWER_MAX_CHARS = 500;

export interface RunViewProps {
  run: CoachRunDto;
  /** The loop's view of the run's status (the run's own when no loop runs). */
  status: CoachRunStatus;
  events: readonly CoachRunEventDto[];
  /** A step request is out: the trail ends with the step in flight. */
  inFlight?: boolean;
  dueRole?: CoachRunRole | null;
  /** The loop lost the connection: say so, with Retry. */
  lost?: boolean;
  /** Since when a step has been at work (the loop's `workingSince`): past the model's deadline, it says so. */
  workingSince?: number | null;
  /** The clock (a test's own). */
  now?: () => number;
  onRetry?: () => void;
  /** The run as the answer, a skip or a cancel left it: the loop takes it from here. */
  onRun?: (run: CoachRunDto) => void;
  /** Read the run again (after an undo, an answer the server refused). */
  onRefresh?: () => void;
  /** A line above the trail (the composer's "You already have the coach working on something"). */
  notice?: ReactNode;
  /**
   * Take the focus to the run's heading (fix wave 3B, B-I9) — after Now (the composer gives way to the run), and after
   * an answer (the question card goes): changing, it moves the focus again.
   */
  focusKey?: string | number | null;
}

export function RunView({
  run,
  status,
  events,
  inFlight = false,
  dueRole = null,
  lost = false,
  workingSince = null,
  now = Date.now,
  onRetry,
  onRun,
  onRefresh,
  notice,
  focusKey = null,
}: RunViewProps) {
  const headingId = useId();
  const trailId = useId();
  const heading = useRef<HTMLHeadingElement>(null);
  const shown = { ...run, status };
  const live = isLive(status);
  const word = statusWord(shown, dueRole);
  const waiting = status === "waiting_athlete";
  // Another request's step at work (another tab or device, or one this page sent before a reload): said, with its ●.
  const elsewhere = live && !inFlight && status === "stepping";
  // Past the model's own deadline, a step at work is taking longer than usual: look at the clock now and then.
  const [clock, setClock] = useState(() => now());
  useEffect(() => {
    if (workingSince === null) return;
    setClock(now());
    const t = setInterval(() => setClock(now()), SLOW_CHECK_MS);
    return () => clearInterval(t);
  }, [workingSince, now]);
  const slow = live && (inFlight || elsewhere) && isSlow(workingSince, clock, DESIGN_MODEL_DEADLINE_MS);
  // While it waits on the athlete, the question is its card on top, not a line of the trail too (lead's QA, Q4).
  const lines = useMemo(() => runLines(events, { waiting }), [events, waiting]);
  const asked = waiting ? askedOf(events) : null;
  const estimate = estimateLine(run);
  // What a screen reader hears as it changes: the state and the newest line — the question it waits on, a stop.
  const question = waiting ? [...events].sort((a, b) => b.seq - a.seq).find((e) => e.kind === "question")?.summary : undefined;
  const newest = question ?? lines.at(-1)?.summary;
  // Once the run is over, its trail folds to one line (B-I7): the card's Approve sits high on a phone, and a stop is
  // said once — under the run (M5). The lines stay one tap down.
  const [trailOpen, setTrailOpen] = useState(false);
  const folded = !live && !trailOpen;
  // An answer moves the focus to the heading too: the card that held it is gone.
  const [answered, setAnswered] = useState(0);
  useEffect(() => {
    if (focusKey === null && answered === 0) return;
    heading.current?.focus();
  }, [focusKey, answered]);
  return (
    <section className="coach-run" aria-labelledby={headingId}>
      <div className="coach-run-head">
        <h2 id={headingId} ref={heading} className="coach-run-title" tabIndex={-1}>
          Coach · {word}
        </h2>
        <span className="coach-run-spend">{spentWords(run.costUsd)}</span>
      </div>
      <p className="visually-hidden" role="status" aria-live="polite">
        {newest ? `Coach · ${word}. ${newest}` : `Coach · ${word}.`}
      </p>
      {notice}
      {run.request ? <p className="coach-run-request">“{run.request}”</p> : null}
      {estimate ? <p className="coach-run-estimate">{estimate}</p> : null}
      {asked ? (
        <QuestionCard
          run={run}
          asked={asked}
          events={events}
          onRun={(r) => {
            setAnswered((n) => n + 1);
            onRun?.(r);
          }}
          onRefresh={onRefresh}
        />
      ) : null}
      {!live && lines.length > 0 ? (
        <button type="button" className="linklike coach-run-fold tap-pad" aria-expanded={trailOpen} aria-controls={trailId} onClick={() => setTrailOpen((v) => !v)}>
          {TRAIL_FOLD_LINE}
          <span className="coach-run-fold-chev" aria-hidden="true">
            <IconChevron size={14} />
          </span>
        </button>
      ) : null}
      <div id={trailId} className="coach-run-trail" hidden={folded && lines.length > 0}>
        <RunLines
          lines={lines}
          live={live}
          inFlight={(inFlight || elsewhere) && live}
          nowWord={elsewhere ? null : word}
          runId={run.id}
          onRefresh={onRefresh}
        />
      </div>
      {slow ? (
        <p className="coach-run-note" role="status">
          {SLOW_LINE}
        </p>
      ) : null}
      {live ? <p className="coach-run-note">{PAUSE_LINE}</p> : null}
      {lost ? (
        <div className="coach-run-lost" role="status">
          <span>{LOST_LINE}</span>
          <button type="button" className="btn btn-small" onClick={() => onRetry?.()}>
            Retry
          </button>
        </div>
      ) : null}
      {live ? <CancelRun run={run} onRun={onRun} /> : null}
    </section>
  );
}

// ── The trail ───────────────────────────────────────────────────────────────

function RunLines({
  lines,
  live,
  inFlight,
  nowWord,
  runId,
  onRefresh,
}: {
  lines: RunLine[];
  live: boolean;
  inFlight: boolean;
  /** The ● line's word ("Designing…"); null: another request's step, "The coach is still working on this…". */
  nowWord: string | null;
  runId: string;
  onRefresh?: () => void;
}) {
  const qc = useQueryClient();
  const oneTap = useOneTap();
  const [undone, setUndone] = useState<ReadonlySet<string>>(new Set());
  const undo = useMutation({
    networkMode: "always",
    mutationFn: (handle: string) => api.coachRunUndoAnswer(runId, handle),
    onSuccess: (_res, handle) => {
      setUndone((s) => new Set([...s, handle]));
      // What the coach remembered is on Settings → Coach's memory list too (Task 10).
      if (isMemoryHandle(handle)) void qc.invalidateQueries({ queryKey: ["coach-memory"] });
      onRefresh?.();
    },
    onError: (e, handle) => {
      // Taken back already (here, or on another device): nothing is left to undo.
      if (e instanceof ApiError && e.status === 404) setUndone((s) => new Set([...s, handle]));
    },
  });
  const gone = undo.error instanceof ApiError && undo.error.status === 404;
  if (lines.length === 0 && !inFlight) return null;
  // The main run's own lines at the top; a set's days under their headings (fix wave 3B, B-I7).
  const { main, days } = trailSections(lines);
  const item = (line: RunLine) => (
    <LineItem
      key={line.key}
      line={line}
      undo={line.undo && !undone.has(line.undo) && (live || isMemoryHandle(line.undo)) ? () => oneTap(() => undo.mutateAsync(line.undo!)) : null}
      undoing={undo.isPending && undo.variables === line.undo}
    />
  );
  const now = inFlight ? (
    <li className="coach-line coach-line--now">
      <span className="coach-line-mark" aria-hidden="true">
        ●
      </span>
      <span className="visually-hidden">Now: </span>
      <span className="coach-line-text">{nowWord === null ? STILL_WORKING_LINE : `${nowWord.charAt(0).toUpperCase()}${nowWord.slice(1)}…`}</span>
    </li>
  ) : null;
  // While it runs, the earlier lines fold away; once it is over and the athlete opened the trail, it is all there.
  return (
    <>
      <FoldedList lines={main} keep={live ? LINES_SHOWN : Infinity} render={item} tail={days.length === 0 ? now : null} />
      {days.map((d) => (
        <section key={d.key} className="coach-day" aria-label={d.heading}>
          <h3 className="coach-day-head">{d.heading}</h3>
          <FoldedList lines={d.lines} keep={live ? DAY_LINES_SHOWN : Infinity} render={item} tail={null} />
        </section>
      ))}
      {days.length > 0 && now ? <ol className="coach-run-lines">{now}</ol> : null}
      {undo.isError ? (
        <p className="coach-run-note" role="status">
          {!gone
            ? "Couldn't take that back — try again."
            : isMemoryHandle(undo.variables ?? "")
              ? "That memory was already taken back."
              : "That was already taken back."}
        </p>
      ) : null}
    </>
  );
}

/**
 * A list of lines, its earlier ones folded behind "Show N earlier lines" — never the athlete's own (M10: a question put
 * to them and their answer stay in view).
 */
function FoldedList({ lines, keep, render, tail }: { lines: RunLine[]; keep: number; render: (line: RunLine) => ReactNode; tail: ReactNode }) {
  const [all, setAll] = useState(false);
  const { hidden, shown } = all ? { hidden: 0, shown: lines } : foldLines(lines, keep);
  if (lines.length === 0 && !tail) return null;
  return (
    <>
      {hidden > 0 ? (
        <button type="button" className="linklike coach-run-earlier tap-pad" onClick={() => setAll(true)}>
          {hidden === 1 ? "Show 1 earlier line" : `Show ${hidden} earlier lines`}
        </button>
      ) : null}
      <ol className="coach-run-lines">
        {shown.map(render)}
        {tail}
      </ol>
    </>
  );
}

const GLYPH: Record<RunLine["glyph"], { mark: string; word: string }> = {
  done: { mark: "✓", word: "Done: " },
  error: { mark: "!", word: "Didn't work: " },
  // An outcome that is no step done (nothing was proposed): a neutral mark, and no word claiming it.
  neutral: { mark: "–", word: "" },
};

function LineItem({ line, undo, undoing }: { line: RunLine; undo: (() => void) | null; undoing: boolean }) {
  const [open, setOpen] = useState(false);
  const detailId = useId();
  const sections = detailOf(line);
  const g = GLYPH[line.glyph];
  return (
    <li className={`coach-line coach-line--${line.glyph}`}>
      <span className="coach-line-mark" aria-hidden="true">
        {g.mark}
      </span>
      {g.word ? <span className="visually-hidden">{g.word}</span> : null}
      {sections.length > 0 ? (
        <button type="button" className="coach-line-text coach-line-open" aria-expanded={open} aria-controls={detailId} onClick={() => setOpen((v) => !v)}>
          {line.summary}
        </button>
      ) : (
        <span className="coach-line-text">{line.summary}</span>
      )}
      {undo ? (
        <button type="button" className="linklike coach-line-undo tap-pad" disabled={undoing} onClick={undo}>
          Undo
        </button>
      ) : null}
      {sections.length > 0 ? (
        <div id={detailId} className="coach-line-detail" hidden={!open}>
          {sections.map((s, i) => (
            <div key={i} className="coach-detail">
              {s.title ? <h3 className="coach-detail-title">{s.title}</h3> : null}
              <dl className="coach-detail-rows">
                {s.rows.map((r, j) => (
                  <div key={j} className="coach-detail-row">
                    <dt>{r.key}</dt>
                    <dd>{r.value}</dd>
                  </div>
                ))}
              </dl>
            </div>
          ))}
        </div>
      ) : null}
    </li>
  );
}

// ── Cancel ──────────────────────────────────────────────────────────────────

function CancelRun({ run, onRun }: { run: CoachRunDto; onRun?: (run: CoachRunDto) => void }) {
  const [asking, setAsking] = useState(false);
  const oneTap = useOneTap();
  const cancel = useMutation({
    networkMode: "always",
    mutationFn: () => api.coachRunCancel(run.id),
    onSuccess: (res) => {
      setAsking(false);
      onRun?.(res.run);
    },
  });
  const stop = () => oneTap(() => cancel.mutateAsync());
  const tap = () => (run.costUsd > CANCEL_CONFIRM_ABOVE_USD ? setAsking(true) : stop());
  return (
    <div className="coach-run-foot">
      <button type="button" className="btn btn-small" disabled={cancel.isPending} onClick={tap}>
        Cancel
      </button>
      {cancel.isError && !asking ? (
        <span className="coach-run-note" role="status">
          Couldn't cancel — try again.
        </span>
      ) : null}
      <ConfirmDialog
        open={asking}
        onClose={() => setAsking(false)}
        title="Stop the coach?"
        confirmLabel="Stop it"
        onConfirm={stop}
        busy={cancel.isPending}
        error={cancel.isError ? "Couldn't cancel — try again." : undefined}
      >
        It has spent {usd(run.costUsd)} on this so far.
      </ConfirmDialog>
    </div>
  );
}

// ── The question ────────────────────────────────────────────────────────────

/** What the server said of an answer it refused: its own plain words when it gave them. */
function answerError(e: unknown): string {
  if (e instanceof ApiError) {
    const why = (e.body as { why?: unknown } | null)?.why;
    if (e.status === 400 && typeof why === "string") return why;
    if (e.status === 409) return "The coach isn't waiting on this any more.";
  }
  return "Couldn't send that — try again.";
}

export function QuestionCard({
  run,
  asked,
  events,
  onRun,
  onRefresh,
}: {
  run: CoachRunDto;
  asked: Asked;
  events: readonly CoachRunEventDto[];
  onRun?: (run: CoachRunDto) => void;
  onRefresh?: () => void;
}) {
  const oneTap = useOneTap();
  const send = useMutation({
    networkMode: "always",
    mutationFn: (body: Parameters<typeof api.coachRunAnswer>[1]) => api.coachRunAnswer(run.id, body),
    onSuccess: (res) => onRun?.(res.run),
    onError: (e) => {
      if (e instanceof ApiError && e.status === 409) onRefresh?.();
    },
  });
  // One answer however many taps: a second Send would be told the coach "isn't waiting on this any more".
  const answer = (body: Parameters<typeof api.coachRunAnswer>[1]) => oneTap(() => send.mutateAsync(body));
  const lead = [...events].sort((a, b) => b.seq - a.seq).find((e) => e.kind === "question")?.summary;
  // The question takes the focus to its first answer when it appears — unless the athlete is typing somewhere (the
  // composer's field): their words keep it.
  const card = useRef<HTMLDivElement>(null);
  const questionSeq = [...events].filter((e) => e.kind === "question").at(-1)?.seq;
  useEffect(() => {
    const active = typeof document === "undefined" ? null : document.activeElement;
    if (active instanceof HTMLTextAreaElement || (active instanceof HTMLInputElement && active.type !== "checkbox" && active.type !== "radio")) return;
    card.current?.querySelector<HTMLElement>("button:not([disabled]), input:not([disabled])")?.focus();
  }, [questionSeq]);
  return (
    <div ref={card} className="coach-ask" role="group" aria-label="The coach asks">
      {asked.kind === "check" ? (
        <CheckAsk lead={lead ?? null} why={asked.why} busy={send.isPending} onCheck={(id) => answer({ conditionCheckId: id })} onSkip={() => answer({ dismissed: true })} />
      ) : (
        <QuestionsAsk asked={asked} busy={send.isPending} onSend={(answers) => answer({ answers })} onSkip={() => answer({ dismissed: true })} />
      )}
      {send.isError ? (
        <p className="coach-ask-error" role="status">
          {answerError(send.error)}
        </p>
      ) : null}
    </div>
  );
}

function QuestionsAsk({
  asked,
  busy,
  onSend,
  onSkip,
}: {
  asked: Extract<Asked, { kind: "questions" }>;
  busy: boolean;
  onSend: (answers: string[]) => void;
  onSkip: () => void;
}) {
  const [chosen, setChosen] = useState<string[]>(() => asked.questions.map(() => ""));
  const [typed, setTyped] = useState<string[]>(() => asked.questions.map(() => ""));
  const answers = asked.questions.map((_, i) => (typed[i]?.trim() ? typed[i]!.trim() : (chosen[i] ?? "")));
  const any = answers.some((a) => a.length > 0);
  const set = (list: string[], i: number, v: string) => list.map((x, j) => (j === i ? v : x));
  return (
    <>
      {asked.questions.map((q, i) => (
        <fieldset key={i} className="coach-ask-q">
          <legend className="coach-ask-text">{q.text}</legend>
          {q.chips.length > 0 ? (
            <div className="stu-chipset">
              {q.chips.map((c) => (
                <button
                  key={c}
                  type="button"
                  className="chip"
                  aria-pressed={chosen[i] === c && !typed[i]?.trim()}
                  disabled={busy}
                  onClick={() => {
                    setChosen((l) => set(l, i, chosen[i] === c ? "" : c));
                    setTyped((l) => set(l, i, ""));
                  }}
                >
                  {/* Chosen: filled, and a ✓ — never colour alone (fix wave 3B, B-C1). */}
                  {chosen[i] === c && !typed[i]?.trim() ? (
                    <span className="coach-chip-tick" aria-hidden="true">
                      ✓
                    </span>
                  ) : null}
                  {c}
                </button>
              ))}
            </div>
          ) : null}
          <input
            className="stu-field coach-ask-words"
            type="text"
            maxLength={ANSWER_MAX_CHARS}
            placeholder="Or in your own words"
            aria-label={`Your answer: ${q.text}`}
            value={typed[i] ?? ""}
            disabled={busy}
            onChange={(e) => {
              const v = e.target.value;
              setTyped((l) => set(l, i, v));
              if (v.trim()) setChosen((l) => set(l, i, ""));
            }}
          />
        </fieldset>
      ))}
      <div className="btn-row coach-ask-actions">
        <button type="button" className="btn btn-primary" disabled={!any || busy} onClick={() => onSend(answers)}>
          Send
        </button>
        <button type="button" className="btn" disabled={busy} onClick={onSkip}>
          Skip
        </button>
      </div>
    </>
  );
}

/**
 * The coach asks for today's condition check (fix A8): the app's own check — the chip a profile wears on Today opens the
 * same sheet — and, once the server has saved it, its id answers the coach. A check the device kept offline has no id:
 * it never answers.
 */
function CheckAsk({ lead, why, busy, onCheck, onSkip }: { lead: string | null; why: string; busy: boolean; onCheck: (id: string) => void; onSkip: () => void }) {
  const today = useQuery({ queryKey: ["today"], queryFn: api.today });
  const [profile, setProfile] = useState<string | null>(null);
  const [unsaved, setUnsaved] = useState(false);
  const conditions = today.data?.conditions ?? [];
  const condition = profile ? conditions.find((c) => c.profileId === profile) : undefined;
  return (
    <>
      {lead ? <p className="coach-ask-text">{lead}</p> : null}
      {why ? <p className="coach-ask-why">{why}</p> : null}
      {/* The check is the primary action, a full button in the profile's own word (M6); Skip is secondary. The sheet
          it opens is the app's own, unchanged. */}
      <div className="btn-row coach-ask-actions">
        {conditions.map((c) => (
          <button key={c.profileId} type="button" className="btn btn-primary" disabled={busy} onClick={() => setProfile(c.profileId)}>
            {checkAskLabel(c.check.label)}
          </button>
        ))}
        <button type="button" className="btn" disabled={busy} onClick={onSkip}>
          Skip
        </button>
      </div>
      {unsaved ? (
        <p className="coach-ask-error" role="status">
          Couldn't save that — try again.
        </p>
      ) : null}
      {condition ? (
        <ConditionCheckSheet
          condition={condition}
          onClose={() => setProfile(null)}
          onSaved={(check, kept) => {
            // Only the check the server saved answers the coach (its id); one kept on the device has none.
            if (kept || !check.id) return setUnsaved(true);
            setUnsaved(false);
            onCheck(check.id);
          }}
        />
      ) : null}
    </>
  );
}

// ── When it stopped ─────────────────────────────────────────────────────────

/**
 * A run that stopped short: what stopped it and what happens next, said once (fix wave 3B, M5: the trail it ended is
 * folded) — then, only when nothing was proposed, the ways to train now the quick starts right below don't already
 * show (today's session, a recent template), and those quick starts. No route to credits: they are the owner's billing.
 */
export function StoppedLine({ failure, proposed, tiles }: { failure: Failure; proposed: boolean; tiles: readonly FallbackTile[] }) {
  const lead = [failure.what, failure.next].filter(Boolean).join(" ");
  if (proposed) {
    return (
      <p className="coach-run-failure" role="status">
        {lead}
      </p>
    );
  }
  if (tiles.length === 0) {
    return (
      <div className="coach-fallback" role="status">
        <p className="coach-run-failure">{`${lead} Pick a quick start below.`}</p>
      </div>
    );
  }
  return (
    <div className="coach-fallback" role="status">
      <p className="coach-run-failure">{lead}</p>
      <div className="stu-quick coach-fallback-tiles">
        {tiles.map((t) => (
          <Link key={t.key} className="stu-qs" to={t.href}>
            <span className="stu-qs-kind">{tileKindWord(t)}</span>
            <span className="stu-qs-name">{t.title}</span>
            {t.minutes !== null ? (
              <span className="stu-qs-min">
                <IconClock />
                {`${t.minutes} min`}
              </span>
            ) : null}
          </Link>
        ))}
      </div>
      <p className="coach-run-note">{QUICK_BELOW_LINE}</p>
    </div>
  );
}
