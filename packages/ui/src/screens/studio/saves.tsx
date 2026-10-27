/**
 * "FROM YOUR SAVES" (saved-posts import, Task 15; the saves flow redesigned §3.3): where the owner sees what the import
 * brought and says, per new move, what the coach does with it. Two pages under the Studio:
 *
 *   /studio/saves                 ‹ Studio
 *                                 From your saves
 *                                 Fri 23 Oct                       2 new · 1 linked
 *                                 Thu 15 Oct          2 new · Put aside   [ Fit them in ]
 *
 *   /studio/saves/:batchId        ‹ Saves
 *                                 3 new moves
 *                                 On Coach, the coach decides. Include is in. Skip stays out.     (three words bold)
 *                                 Zorbex quad shuffle                       [Skip|Coach|Include]
 *                                 Loosens the quads before a run.
 *                                 Zorbex neck nod                           [Skip|Coach|Include]
 *                                 Nod slowly. · Check this · like Lantern reach
 *                                 ▸ Already yours · 1
 *                                 NOTES …
 *                                 ┌ 1 in · 1 out · 1 on the coach's call ┐
 *                                 └ [ Fit these in ]                      ┘   (sticky)
 *
 * One row per new move (two posts that show one move: one row), its name, one line of what it is for and Skip | Coach
 * | Include — never its creator or dose. A flagged move keeps "Check this", then the move it looks like: `like {name}`,
 * a tap merging it into that move while the row is the owner's to change. The moves the owner already has fold under
 * one line. Fit these in saves the batch with the choices (Coach sent as nothing) and opens the coach with the fit,
 * which sends the request; while that fit is at work, "Fitting in… open the coach" in its place. A fitted batch reads
 * the same, with no control and no foot. On the list, a batch put aside reads so, and Fit them in brings it back (the
 * coach card's fit: every move on the coach's call).
 *
 * A name opens the move's sheet: its words, the post (its creator, and a link that opens it apart), the dose as the
 * post gave it and as it would be saved, and — while the row is pending — Edit (a new move, or one of the owner's own),
 * Not this move (the post's move becomes a new move of its own, from the post's reading), Same as… (another new move of
 * the batch — two the matcher missed — or a library move or one of the owner's own, from what the Studio offers), Remove,
 * and Ask the coach (the coach, seeing the move). A row is a move, so Same as…, Remove and the like's merge write each
 * of the move's pending links. Notes, under the rows, is what the kept posts say about when, why or how often (spec §17)
 * — one line each, with its creator, read-only: what the coach keeps in memory once the batch is saved.
 *
 * A model wrote the names, summaries, purposes, notes and creators: drawn as text, never as markup; a post's address is
 * a link only when it is a web page's (`postHref`). Every write reads the batch again; one that changes the owner's
 * moves (a fit, an edit, either re-match) reads the whole library again (`["library"]`: their moves, the Studio's list,
 * a move's own detail), so search, the builder and a move's detail see a saved or edited move at once.
 */
import { useEffect, useId, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import { Link, useParams } from "react-router-dom";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { api, ApiError, SAVES_BATCHES_QUERY, SAVES_STATUS_QUERY, savesBatchQuery } from "@rg/api-client";
import { PROFILES, searchLibrary, type ExerciseRecord } from "@rg/exercise-library";
import type { CheckWhy, FitChoice, SaveBatchDetailDto, SaveBatchInsightDto, SaveBatchRowDto } from "@rg/saves";
import { EmptyState, Sheet, Spinner } from "../../components.js";
import { SearchField } from "../../components/search-field.js";
import { IconBack } from "../../icons.js";
import { useAccountLibrary } from "../../library/account-library.js";
import { AskCoach, useCoach, useCoachSeeing } from "./coach-ask.js";
import { moveFocus } from "./coach-focus.js";
import { useFitThemIn } from "./coach-saves.js";
import { doseLine } from "./model.js";
import { postHref } from "./move-detail.js";
import { dotted } from "./move-row.js";
import {
  attrWord, batchDay, batchFacts, canFit, DOSE_TYPES, DOSE_WORD, FITTING_LINE, formOf, pageRowsOf, patchOf, pendingLinksOf, rowActions,
  savesHref, tallyLine, writeError,
  type MoveForm, type OwnedRow, type PageRow,
} from "./saves-model.js";
import { useOneTap } from "./use-one-tap.js";

/** The most moves the "Same as…" list shows at once (the search narrows it). */
const PICK_LIMIT = 40;

/** A read that answered 404: the feature is off, or the batch isn't the account's. */
const isGone = (e: unknown): boolean => e instanceof ApiError && e.status === 404;
/** The app's few retries — never for a read that is gone or signed out. */
const retry = (n: number, e: unknown): boolean => !(e instanceof ApiError && (e.status === 404 || e.status === 401)) && n < 2;

function BackBar({ to, label }: { to: string; label: string }) {
  return (
    <div className="stu-build-bar">
      <Link className="btn stu-build-back" to={to}>
        <IconBack size={16} />
        {label}
      </Link>
    </div>
  );
}

/** A read's own states: loading, offline with nothing kept, gone, failed. Null once it has an answer. */
function ReadState({ q, gone, what }: { q: { isPending: boolean; isError: boolean; fetchStatus: string; error: unknown; data: unknown; refetch: () => unknown }; gone: string; what: string }) {
  const waiting = q.isPending && q.fetchStatus === "paused";
  if (q.data !== undefined) return null;
  if (q.isPending && !waiting) return <Spinner label={`Loading ${what}`} />;
  if (q.isError && isGone(q.error)) return <EmptyState title={gone} />;
  return (
    <EmptyState title={waiting ? `${what.charAt(0).toUpperCase()}${what.slice(1)} need a connection.` : `Couldn't load ${what}.`}>
      {waiting ? null : (
        <button type="button" className="btn" onClick={() => void q.refetch()}>
          Try again
        </button>
      )}
    </EmptyState>
  );
}

/** Each fact one unbroken piece, its dot kept with it: a line breaks only between them. */
function Facts({ facts }: { facts: readonly string[] }) {
  return (
    <span className="stu-tpl-facts">
      {facts.map((f, i) => (
        <span key={`${i}-${f}`}>
          {i > 0 ? " " : null}
          <span className="stu-tpl-fact">{i < facts.length - 1 ? `${f} ·` : f}</span>
        </span>
      ))}
    </span>
  );
}

// ── The batches ──────────────────────────────────────────────────────────────────────────────────────────────────────

export function SavesScreen() {
  const q = useQuery({ queryKey: SAVES_BATCHES_QUERY, queryFn: () => api.savesBatches(), retry });
  const coach = useCoach();
  const batches = q.data?.batches ?? [];
  return (
    <div className="stu-tpls stu-saves">
      <BackBar to="/studio" label="Studio" />
      <h1>From your saves</h1>
      {q.data === undefined ? (
        <ReadState q={q} gone="Nothing from your saves." what="your saves" />
      ) : batches.length === 0 ? (
        <EmptyState title="Nothing from your saves yet." />
      ) : (
        <ul className="stu-tpl-list">
          {batches.map((b) => (
            <li key={b.id} className="stu-tpl">
              <h2 className="stu-tpl-name">
                <Link className="stu-tpl-open" to={savesHref(b.id)}>
                  {batchDay(b) || "Batch"}
                </Link>
              </h2>
              <p className="stu-tpl-meta">
                <Facts facts={batchFacts(b)} />
              </p>
              {/* Put aside (spec §12.3): Fit them in brings it back — the coach's card's fit, the coach opened with it. */}
              {coach && b.dismissedAt && canFit(b) ? <FitAgain batchId={b.id} /> : null}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/** A batch put aside: Fit them in fits it with every new move on the coach's call and opens the coach with the fit. */
function FitAgain({ batchId }: { batchId: string }) {
  const coach = useCoach();
  const qc = useQueryClient();
  const { fit, pending, line } = useFitThemIn((id, request) => {
    void qc.invalidateQueries({ queryKey: SAVES_STATUS_QUERY });
    coach?.open({ fit: { batchId: id, request }, seeing: null });
  });
  return (
    <>
      <span className="stu-tpl-acts">
        <button type="button" className="btn" disabled={pending} onClick={() => fit(batchId)}>
          Fit them in
        </button>
      </span>
      {line ? (
        <p className="stu-save-again-line" role="status">
          {line}
        </p>
      ) : null}
    </>
  );
}

// ── One batch ────────────────────────────────────────────────────────────────────────────────────────────────────────

/**
 * A row's second line: what the move is for, then Check this when flagged, then the move it looks like — a button that
 * merges it into that move (`onLike`), else words. No creator, no dose.
 */
function RowTags({ page, onLike }: { page: PageRow; onLike?: () => void }) {
  const like = page.like ? `like ${page.like.name}` : null;
  const items = [
    page.purpose ? <span className="stu-save-purpose">{page.purpose}</span> : null,
    page.check ? <span className="pill pill-warn">Check this</span> : null,
    like && onLike ? (
      <button type="button" className="linklike stu-save-like" onClick={onLike}>
        {like}
      </button>
    ) : like ? (
      <span className="stu-save-liketext">{like}</span>
    ) : null,
  ].filter((x) => x !== null);
  if (items.length === 0) return null;
  // Each dot kept with what follows it: a line breaks only between whole pieces, never leaving a dot at its end.
  return (
    <p className="stu-tpl-meta stu-save-meta">
      {items.map((item, i) => (
        <span key={i} className="stu-save-bit">
          {i > 0 ? (
            <span className="stu-sep" aria-hidden="true">
              ·
            </span>
          ) : null}
          {item}
        </span>
      ))}
    </p>
  );
}

/** The sheet's labels: New, or Linked to {name}; and Check this. */
function MoveTags({ row }: { row: SaveBatchRowDto }) {
  return (
    <span className="stu-save-tags">
      {row.move.kind === "new" ? <span className="pill pill-ok">New</span> : <span className="stu-save-linked">{`Linked to ${row.move.linkedName ?? row.move.id}`}</span>}
      {row.move.check ? <span className="pill pill-warn">Check this</span> : null}
    </span>
  );
}

/** Skip | Coach | Include, in that order: Coach is no choice at all (null) — the coach's call. */
const CHOICES: ReadonlyArray<{ word: "Skip" | "Coach" | "Include"; value: FitChoice | null }> = [
  { word: "Skip", value: "skip" },
  { word: "Coach", value: null },
  { word: "Include", value: "include" },
];

/** A new move's say in the fit: three radios named by the move, one stop in the tab order, the arrows move the choice. */
function ChoiceControl({ name, value, onPick }: { name: string; value: FitChoice | null; onPick: (choice: FitChoice | null) => void }) {
  const refs = useRef<Array<HTMLButtonElement | null>>([]);
  const at = Math.max(0, CHOICES.findIndex((c) => c.value === value));
  const last = CHOICES.length - 1;
  const onKeyDown = (e: KeyboardEvent<HTMLButtonElement>, i: number) => {
    const to =
      e.key === "ArrowRight" || e.key === "ArrowDown"
        ? i === last ? 0 : i + 1
        : e.key === "ArrowLeft" || e.key === "ArrowUp"
          ? i === 0 ? last : i - 1
          : e.key === "Home"
            ? 0
            : e.key === "End"
              ? last
              : null;
    if (to === null) return;
    e.preventDefault();
    onPick(CHOICES[to]!.value);
    refs.current[to]?.focus();
  };
  return (
    <div className="stu-choice" role="radiogroup" aria-label={name}>
      {CHOICES.map((c, i) => (
        <button
          key={c.word}
          ref={(el) => {
            refs.current[i] = el;
          }}
          type="button"
          role="radio"
          aria-checked={i === at}
          tabIndex={i === at ? 0 : -1}
          className={`stu-choice-opt stu-choice-${c.word.toLowerCase()}`}
          onClick={() => onPick(c.value)}
          onKeyDown={(e) => onKeyDown(e, i)}
        >
          {c.word}
        </button>
      ))}
    </div>
  );
}

/** The moves the owner already has: one folded line; unfolded, their names — each opens its sheet, none has a control. */
function AlreadyYours({ owned, onOpen }: { owned: readonly OwnedRow[]; onOpen: (row: SaveBatchRowDto) => void }) {
  const [unfolded, setUnfolded] = useState(false);
  return (
    <div className="stu-save-owned">
      <button type="button" className="stu-save-fold" aria-expanded={unfolded} onClick={() => setUnfolded((u) => !u)}>
        <span aria-hidden="true">{unfolded ? "▾" : "▸"}</span> Already yours · {owned.length}
      </button>
      {unfolded ? (
        <ul className="stu-tpl-list">
          {owned.map((o) => (
            <li key={o.moveId} className="stu-tpl stu-save-owned-row">
              <span className="stu-tpl-name">
                <button type="button" className="stu-save-open" aria-haspopup="dialog" onClick={() => onOpen(o.row)}>
                  {o.name}
                </button>
              </span>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}

/** What the kept posts say about when, why or how often (spec §17): a line each, its creator beside it; nothing to press. */
function Notes({ insights }: { insights: readonly SaveBatchInsightDto[] }) {
  const id = useId();
  if (insights.length === 0) return null;
  return (
    <section className="stu-save-notes" aria-labelledby={id}>
      <h2 id={id} className="eyebrow">
        Notes
      </h2>
      <ul className="stu-save-notes-list">
        {insights.map((n, i) => (
          <li key={`${i}-${n.postId}`} className="stu-save-note">
            {dotted([<span key="text">{n.text}</span>, n.creator ? <span key="by" className="stu-save-by">{n.creator}</span> : null])}
          </li>
        ))}
      </ul>
    </section>
  );
}

type Open = { postMoveId: string; mode: "view" | "edit" | "pick" };

/** A like by its move and the move it names: one the server no longer knows stays words. */
const likeKey = (p: PageRow): string => `${p.moveId}\u0000${p.like?.id ?? ""}`;

export function SaveBatchScreen() {
  const { batchId = "" } = useParams();
  const qc = useQueryClient();
  const q = useQuery({ queryKey: savesBatchQuery(batchId), queryFn: () => api.savesBatch(batchId), retry });
  const account = useAccountLibrary();
  const coach = useCoach();
  const oneTap = useOneTap();
  const [open, setOpen] = useState<Open | null>(null);
  const [status, setStatus] = useState<string | null>(null);
  /** The owner's choices on this page, by move (null: back on the coach's call); a move not here keeps its stored one. */
  const [picks, setPicks] = useState<ReadonlyMap<string, FitChoice | null>>(() => new Map());
  /** Likes whose move has gone since the page was read (merged by another row's Same as…): words, not a button. */
  const [staleLikes, setStaleLikes] = useState<ReadonlySet<string>>(() => new Set());
  const title = useRef<HTMLHeadingElement>(null);
  const focusTitle = useRef(false);
  const { fit, pending, line } = useFitThemIn((id, request) => {
    // The batch saved: Settings → Saves' last import moved too. Seeing nothing: the fit is the batch's, not this page's.
    void qc.invalidateQueries({ queryKey: SAVES_STATUS_QUERY });
    coach?.open({ fit: { batchId: id, request }, seeing: null });
  });

  useEffect(() => {
    if (!focusTitle.current) return;
    focusTitle.current = false;
    title.current?.focus();
  });

  const data: SaveBatchDetailDto | undefined = q.data;
  const rows = useMemo(() => data?.rows ?? [], [data]);
  const { fresh, owned } = useMemo(() => pageRowsOf(rows), [rows]);
  const openRow = open ? (rows.find((r) => r.postMoveId === open.postMoveId) ?? null) : null;
  /** Choosing: a batch that can be fitted in, with the coach there to fit it. */
  const choosing = !!data && !!coach && canFit(data.batch);

  const choiceOf = (p: PageRow): FitChoice | null => (picks.has(p.moveId) ? (picks.get(p.moveId) ?? null) : p.row.move.choice);
  const moveIds = fresh.map((p) => p.moveId);
  const choices: Record<string, FitChoice | undefined> = Object.fromEntries(fresh.map((p) => [p.moveId, choiceOf(p) ?? undefined]));
  /** What Fit these in sends: the current new moves' choices only, a move on the coach's call left out. */
  const sent: Record<string, FitChoice> = Object.fromEntries(fresh.flatMap((p) => {
    const c = choiceOf(p);
    return c ? [[p.moveId, c] as const] : [];
  }));

  /**
   * Read the batch again (and the batches); `moves`: the owner's moves changed, so read the whole library again — their
   * moves (`["library", "personal"]`), the Studio's list and a move's own detail (`["library", "item", id]`) alike.
   */
  const refresh = (moves: boolean) => {
    void qc.invalidateQueries({ queryKey: savesBatchQuery(batchId) });
    void qc.invalidateQueries({ queryKey: SAVES_BATCHES_QUERY });
    if (moves) void qc.invalidateQueries({ queryKey: ["library"] });
  };

  /** A row's write done: the sheet closes, the page says what changed. */
  const done = (line: string, moves: boolean, gone = false) => {
    setOpen(null);
    setStatus(line);
    if (gone) focusTitle.current = true;
    refresh(moves);
  };

  /** `like {name}`: the move merged into the one it looks like — each post that shows it — in one tap. */
  const merge = (p: PageRow, like: { id: string; name: string }) =>
    oneTap(async () => {
      try {
        for (const id of pendingLinksOf(rows, p.moveId)) await api.savesRematch(id, like.id);
        setStatus(`Linked to ${like.name}.`);
        focusTitle.current = true;
      } catch (e) {
        // The move it looked like has gone (another row's Same as… merged it): no error — the like becomes words.
        if (isGone(e)) setStaleLikes((s) => new Set(s).add(likeKey(p)));
        else setStatus(writeError(e));
      } finally {
        refresh(true);
      }
    });

  const sheetOf = (row: SaveBatchRowDto) => setOpen({ postMoveId: row.postMoveId, mode: "view" });

  let body: ReactNode;
  if (!data) body = <ReadState q={q} gone="That batch isn't there." what="this batch" />;
  else if (fresh.length === 0 && owned.length === 0) body = <EmptyState title="Nothing left in this batch." />;
  else {
    body = (
      <>
        {fresh.length ? (
          <ul className="stu-tpl-list">
            {fresh.map((p) => {
              const like = p.like && rowActions(p.row).sameAs && !staleLikes.has(likeKey(p)) ? p.like : null;
              return (
                <li key={p.moveId} className="stu-tpl stu-save-row">
                  <div className="stu-save-what">
                    <h2 className="stu-tpl-name">
                      <button type="button" className="stu-save-open" aria-haspopup="dialog" onClick={() => sheetOf(p.row)}>
                        {p.name}
                      </button>
                    </h2>
                    <RowTags page={p} onLike={like ? () => merge(p, like) : undefined} />
                  </div>
                  {choosing ? (
                    <ChoiceControl name={p.name} value={choiceOf(p)} onPick={(c) => setPicks((m) => new Map(m).set(p.moveId, c))} />
                  ) : null}
                </li>
              );
            })}
          </ul>
        ) : null}
        {owned.length ? <AlreadyYours owned={owned} onOpen={sheetOf} /> : null}
      </>
    );
  }

  const n = fresh.length;
  return (
    <div className="stu-tpls stu-saves">
      <BackBar to={savesHref()} label="Saves" />
      <div className="stu-save-head">
        <h1 ref={title} tabIndex={-1}>
          {data ? `${n} new ${n === 1 ? "move" : "moves"}` : "From your saves"}
        </h1>
        {choosing && n > 0 ? (
          <p className="stu-save-line">
            On <b>Coach</b>, the coach decides. <b>Include</b> is in. <b>Skip</b> stays out.
          </p>
        ) : null}
      </div>
      {/* Empty, it is visually hidden — never display: none — so the region stays in the page and is heard when it speaks. */}
      <p className={status ? "stu-tpl-status" : "stu-tpl-status visually-hidden"} role="status">
        {status}
      </p>
      {body}
      {data ? <Notes insights={data.insights ?? []} /> : null}
      {choosing ? (
        <div className="stu-build-foot stu-save-foot">
          {n > 0 ? <p className="stu-save-tally">{tallyLine(choices, moveIds)}</p> : null}
          <button type="button" className="btn btn-primary" disabled={pending} onClick={() => fit(batchId, sent)}>
            Fit these in
          </button>
          {line ? (
            <p className="stu-save-foot-line" role="status">
              {line}
            </p>
          ) : null}
        </div>
      ) : data?.batch.fitting ? (
        <div className="stu-build-foot stu-save-foot">
          {coach ? (
            <button type="button" className="linklike tap-pad stu-save-fitting" onClick={() => coach.open()}>
              {FITTING_LINE}
            </button>
          ) : (
            <p className="stu-save-fitting">{FITTING_LINE}</p>
          )}
        </div>
      ) : null}
      {openRow && open ? (
        <MoveSheet
          key={openRow.postMoveId}
          row={openRow}
          links={pendingLinksOf(rows, openRow.move.id)}
          mode={open.mode}
          siblings={newMoves(rows)}
          offered={account.offered}
          find={account.find}
          ownStatus={account.mine.get(openRow.move.id)?.status}
          onMode={(mode) => setOpen({ postMoveId: openRow.postMoveId, mode })}
          onClose={() => setOpen(null)}
          onDone={done}
          onRead={() => refresh(true)}
        />
      ) : null}
    </div>
  );
}

// ── A move's sheet ───────────────────────────────────────────────────────────────────────────────────────────────────

/** The batch's new moves still pending (one each, by their record): "Same as…" may name one — two new moves the matcher missed. */
function newMoves(rows: readonly SaveBatchRowDto[]): ExerciseRecord[] {
  const out = new Map<string, ExerciseRecord>();
  for (const r of rows) if (r.status === "pending" && r.move.kind === "new" && r.record && !out.has(r.move.id)) out.set(r.move.id, r.record);
  return [...out.values()];
}

function MoveSheet({
  row,
  links,
  mode,
  siblings,
  offered,
  find,
  ownStatus,
  onMode,
  onClose,
  onDone,
  onRead,
}: {
  row: SaveBatchRowDto;
  /** The move's pending links — each post of the batch that shows it: Same as… and Remove write them all (a row is a move). */
  links: readonly string[];
  mode: Open["mode"];
  siblings: readonly ExerciseRecord[];
  offered: readonly ExerciseRecord[];
  find: (id: string) => ExerciseRecord | undefined;
  ownStatus?: "active" | "archived";
  onMode: (mode: Open["mode"]) => void;
  onClose: () => void;
  onDone: (line: string, moves: boolean, gone?: boolean) => void;
  /** A write refused part-way through the move's links: the batch read again, whatever went through. */
  onRead: () => void;
}) {
  const actions = rowActions(row, ownStatus);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // What the coach sees while the sheet is open (its "Seeing" hint from the nav's Coach).
  const focus = moveFocus({ id: row.move.id, name: row.move.name });
  useCoachSeeing(focus);

  const run = async (write: () => Promise<unknown>, line: string, moves: boolean, gone = false) => {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      await write();
      onDone(line, moves, gone);
    } catch (e) {
      setError(writeError(e));
      setBusy(false);
    }
  };
  /** Each of the move's pending links in turn (the row's own when it has none left to change); refused part-way, the
   * batch is read again — what went through stays. */
  const eachLink = (write: (postMoveId: string) => Promise<unknown>) => async () => {
    const ids = links.length ? links : [row.postMoveId];
    for (const [i, id] of ids.entries()) {
      try {
        await write(id);
      } catch (e) {
        if (i > 0) onRead();
        throw e;
      }
    }
  };

  const rec = row.record ?? find(row.move.id) ?? null;

  if (mode === "pick") {
    return (
      <Sheet open onClose={() => onMode("view")} title="Same as…">
        <SamePicker
          siblings={siblings}
          offered={offered}
          except={row.move.id}
          busy={busy}
          error={error}
          onPick={(target) => void run(eachLink((id) => api.savesRematch(id, target.id)), `Linked to ${target.name}.`, true)}
        />
      </Sheet>
    );
  }

  if (mode === "edit" && row.record) {
    return (
      <Sheet open onClose={() => onMode("view")} title={row.move.name}>
        <EditForm
          rec={row.record}
          busy={busy}
          error={error}
          onCancel={() => {
            setError(null);
            onMode("view");
          }}
          onSave={(form) => {
            const patch = patchOf(row.record!, form);
            if (patch === null) {
              onMode("view");
              return;
            }
            if ("error" in patch) {
              setError(patch.error);
              return;
            }
            void run(() => api.savesEditMove(row.move.id, patch), `Saved ${patch.name ?? row.move.name}.`, true);
          }}
        />
      </Sheet>
    );
  }

  const href = postHref(row.post.url);
  const saved = rec ? doseLine(rec) : null;
  const foot = (
    <div className="stu-save-actions">
      {actions.edit ? (
        <button type="button" className="btn" disabled={busy} onClick={() => onMode("edit")}>
          Edit
        </button>
      ) : null}
      {actions.notThis ? (
        <button type="button" className="btn" disabled={busy} onClick={() => void run(() => api.savesRematch(row.postMoveId, null), `${row.move.name} is a move of its own.`, true)}>
          Not this move
        </button>
      ) : null}
      {actions.sameAs ? (
        <button type="button" className="btn" disabled={busy} onClick={() => onMode("pick")}>
          Same as…
        </button>
      ) : null}
      {actions.remove ? (
        <button type="button" className="btn stu-tpl-del" disabled={busy} onClick={() => void run(eachLink((id) => api.savesRemove(id)), `Removed ${row.move.name}.`, false, true)}>
          Remove
        </button>
      ) : null}
      <AskCoach focus={focus} label="Ask the coach" />
    </div>
  );
  return (
    <Sheet open onClose={onClose} title={row.move.name} footer={foot}>
      <div className="stu-save-sheet">
        {row.move.summary ? <p className="stu-detail-sum">{row.move.summary}</p> : null}
        <p className="stu-meta stu-save-meta">
          <MoveTags row={row} />
        </p>
        {row.move.check && row.move.checkWhy?.length ? (
          <p className="stu-meta stu-save-meta stu-save-why">{dotted(row.move.checkWhy.map((w) => <span key={w}>{CHECK_WHY_WORDS[w]}</span>))}</p>
        ) : null}
        <p className="stu-meta stu-save-meta">
          {dotted([
            row.move.seenDose ? <span key="seen">{`In the post: ${row.move.seenDose}`}</span> : null,
            saved ? <span key="saved">{`Saved as: ${saved}`}</span> : null,
          ])}
        </p>
        {row.post.creator || href ? (
          <ul className="stu-saved">
            <li>
              {row.post.creator ? <span className="stu-saved-by">{row.post.creator}</span> : null}
              {href ? (
                <a className="stu-saved-link" href={href} target="_blank" rel="noopener noreferrer">
                  Open post
                  {row.post.creator ? <span className="visually-hidden">{` by ${row.post.creator}`}</span> : null}
                </a>
              ) : null}
            </li>
          </ul>
        ) : null}
        {row.record?.text.steps.length ? (
          <ol className="stu-detail-list">
            {row.record.text.steps.map((s, i) => (
              <li key={`${i}-${s}`}>{s}</li>
            ))}
          </ol>
        ) : null}
        {rec?.text.focus.length ? (
          <>
            <h3 className="eyebrow">Cues</h3>
            <ul className="stu-detail-list stu-save-cues">
              {rec.text.focus.map((c, i) => (
                <li key={`${i}-${c}`}>{c}</li>
              ))}
            </ul>
          </>
        ) : null}
        {rec ? <Ratings rec={rec} /> : null}
        {error ? (
          <p className="stu-detail-error" role="alert">
            {error}
          </p>
        ) : null}
      </div>
    </Sheet>
  );
}

/**
 * "Check this", why — each reason as a fact (verbatim audit gap 5). A near-duplicate's own move is named on the row
 * (`like {name}`); here it is only the reason — the move it looks like may be the owner's or another new one.
 */
const CHECK_WHY_WORDS: Readonly<Record<CheckWhy, string>> = {
  low_confidence: "Low confidence",
  inferred_name: "Name inferred",
  inferred_dose: "Dose inferred",
  near_duplicate: "Looks like another move",
};

/**
 * The move's ratings, per profile it rates — each attribute on its scale ("Clench 0 of 3", "Face down no"), the profile's
 * note under them — folded under "Ratings": a long sheet stays short until asked (verbatim audit gap 5). A model rated a
 * new move from the post; Edit changes them.
 */
function Ratings({ rec }: { rec: ExerciseRecord }) {
  const rated = Object.values(PROFILES).flatMap((p) => {
    const attrs = (rec.conditions as Record<string, Record<string, unknown> | undefined>)[p.id];
    if (!attrs) return [];
    const words = Object.entries(p.attributes).map(([k, spec]) => {
      const v = attrs[k];
      return spec.kind === "scale" ? `${attrWord(k)} ${typeof v === "number" ? v : "?"} of ${spec.max}` : `${attrWord(k)} ${v === true ? "yes" : v === false ? "no" : "?"}`;
    });
    return [{ id: p.id, line: `${p.label}: ${words.join(" · ")}`, note: rec.text.conditions?.[p.id]?.trim() || null }];
  });
  if (rated.length === 0) return null;
  return (
    <details className="stu-save-ratings">
      <summary>Ratings</summary>
      <ul className="stu-detail-list">
        {rated.map((r) => (
          <li key={r.id}>{r.line}</li>
        ))}
      </ul>
      {rated.map((r) => (r.note ? <p key={`${r.id}-note`} className="stu-detail-note">{r.note}</p> : null))}
    </details>
  );
}

/**
 * "Same as…": the batch's other new moves first (two new moves the matcher missed), then the moves the Studio offers
 * (the library, and the owner's own active moves) — each searched as the Studio searches.
 */
function SamePicker({
  siblings,
  offered,
  except,
  busy,
  error,
  onPick,
}: {
  siblings: readonly ExerciseRecord[];
  offered: readonly ExerciseRecord[];
  except: string;
  busy: boolean;
  error: string | null;
  onPick: (rec: ExerciseRecord) => void;
}) {
  const [q, setQ] = useState("");
  const listed = useMemo(() => {
    const first = (q.trim() ? searchLibrary(siblings, q) : siblings).filter((r) => r.id !== except);
    const firstIds = new Set(first.map((r) => r.id));
    const rest = searchLibrary(offered, q).filter((r) => r.id !== except && !firstIds.has(r.id));
    return [...first, ...rest].slice(0, PICK_LIMIT);
  }, [siblings, offered, q, except]);
  return (
    <div className="stu-picker">
      <SearchField value={q} onChange={setQ} label="Search moves" placeholder="Search moves" />
      {error ? (
        <p className="stu-detail-error" role="alert">
          {error}
        </p>
      ) : null}
      {listed.length ? (
        <ul className="stu-pick-list">
          {listed.map((r) => (
            <li key={r.id}>
              <button type="button" className="stu-pick" disabled={busy} onClick={() => onPick(r)}>
                <span className="stu-pick-name">{r.name}</span>
                <span className="stu-pick-sum">{r.text.summary}</span>
              </button>
            </li>
          ))}
        </ul>
      ) : (
        <p className="stu-meta">No moves match.</p>
      )}
    </div>
  );
}

// ── Edit ─────────────────────────────────────────────────────────────────────────────────────────────────────────────

function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <label className="stu-field-row stu-field-row--wide">
      <span>{label}</span>
      {children}
    </label>
  );
}

function EditForm({
  rec,
  busy,
  error,
  onCancel,
  onSave,
}: {
  rec: ExerciseRecord;
  busy: boolean;
  error: string | null;
  onCancel: () => void;
  onSave: (form: MoveForm) => void;
}) {
  const [form, setForm] = useState<MoveForm>(() => formOf(rec));
  const set = (patch: Partial<MoveForm>) => setForm((f) => ({ ...f, ...patch }));
  const first = useRef<HTMLInputElement>(null);
  const id = useId();
  useEffect(() => {
    first.current?.focus();
  }, []);
  const lines = (key: "steps" | "focus" | "mistakes", label: string) => (
    <Field label={label}>
      <textarea className="stu-field" rows={Math.max(2, form[key].split("\n").length)} value={form[key]} onChange={(e) => set({ [key]: e.target.value })} />
    </Field>
  );
  return (
    <form
      className="stu-save-form"
      onSubmit={(e) => {
        e.preventDefault();
        onSave(form);
      }}
    >
      <Field label="Name">
        <input ref={first} className="stu-field" value={form.name} maxLength={80} onChange={(e) => set({ name: e.target.value })} />
      </Field>
      <Field label="Summary">
        <textarea className="stu-field" rows={2} value={form.summary} maxLength={160} onChange={(e) => set({ summary: e.target.value })} />
      </Field>
      {lines("steps", "Steps")}
      {lines("focus", "Focus")}
      {lines("mistakes", "Common mistakes")}
      <fieldset className="stu-save-set">
        <legend className="eyebrow">Dose</legend>
        <div className="stu-part-fields">
          <label className="stu-field-row">
            <span>Type</span>
            <select className="stu-select" value={form.doseType} onChange={(e) => set({ doseType: e.target.value as MoveForm["doseType"] })}>
              {DOSE_TYPES.map((t) => (
                <option key={t} value={t}>
                  {DOSE_WORD[t]}
                </option>
              ))}
            </select>
          </label>
          <label className="stu-field-row">
            <span>From</span>
            <input className="stu-load-input" inputMode="decimal" value={form.low} onChange={(e) => set({ low: e.target.value })} />
          </label>
          <label className="stu-field-row">
            <span>To</span>
            <input className="stu-load-input" inputMode="decimal" value={form.high} onChange={(e) => set({ high: e.target.value })} />
          </label>
          <label className="stu-field-row">
            <span>Sets from</span>
            <input className="stu-load-input" inputMode="numeric" value={form.setsMin} onChange={(e) => set({ setsMin: e.target.value })} />
          </label>
          <label className="stu-field-row">
            <span>Sets to</span>
            <input className="stu-load-input" inputMode="numeric" value={form.setsMax} onChange={(e) => set({ setsMax: e.target.value })} />
          </label>
        </div>
      </fieldset>
      {Object.values(PROFILES).map((p) => (
        <fieldset key={p.id} className="stu-save-set">
          <legend className="eyebrow">{p.label}</legend>
          <div className="stu-part-fields">
            {Object.entries(p.attributes).map(([k, spec]) => {
              const value = form.ratings[p.id]?.[k];
              const rate = (v: number | boolean) => set({ ratings: { ...form.ratings, [p.id]: { ...form.ratings[p.id], [k]: v } } });
              return spec.kind === "scale" ? (
                <label key={k} className="stu-field-row">
                  <span>{attrWord(k)}</span>
                  <select className="stu-select" value={typeof value === "number" ? String(value) : ""} onChange={(e) => rate(Number(e.target.value))}>
                    {typeof value === "number" ? null : <option value="">—</option>}
                    {Array.from({ length: spec.max - spec.min + 1 }, (_, i) => spec.min + i).map((n) => (
                      <option key={n} value={n}>
                        {n}
                      </option>
                    ))}
                  </select>
                </label>
              ) : (
                <label key={k} className="stu-field-row stu-save-flag">
                  <span>{attrWord(k)}</span>
                  <input type="checkbox" checked={value === true} onChange={(e) => rate(e.target.checked)} />
                </label>
              );
            })}
          </div>
          <Field label="Note">
            <textarea
              className="stu-field"
              rows={2}
              maxLength={160}
              aria-describedby={`${id}-${p.id}`}
              value={form.notes[p.id] ?? ""}
              onChange={(e) => set({ notes: { ...form.notes, [p.id]: e.target.value } })}
            />
          </Field>
          <span id={`${id}-${p.id}`} className="visually-hidden">
            {p.label}
          </span>
        </fieldset>
      ))}
      {error ? (
        <p className="stu-detail-error" role="alert">
          {error}
        </p>
      ) : null}
      <div className="btn-row">
        <button type="submit" className="btn btn-primary" disabled={busy}>
          Save
        </button>
        <button type="button" className="btn" disabled={busy} onClick={onCancel}>
          Cancel
        </button>
      </div>
    </form>
  );
}
