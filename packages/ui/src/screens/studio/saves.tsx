/**
 * "FROM YOUR SAVES" (saved-posts import, Task 15): where the owner first sees what the import brought, and says what of
 * it to keep. Two pages under the Studio:
 *
 *   /studio/saves                 ‹ Studio
 *                                 From your saves
 *                                 Fri 23 Oct                       2 new · 1 linked
 *                                 Thu 15 Oct                       3 new · Saved
 *
 *   /studio/saves/:batchId        ‹ Saves
 *                                 From your saves
 *                                 Fri 23 Oct · 2 new · 1 linked
 *                                 Zorbex quad shuffle      [New]
 *                                 coach_a · 3 x 10
 *                                 90/90 Hip Switch
 *                                 Linked to 90/90 hip switches · coach_a · 8 each side
 *                                 Zorbex neck nod          [New] [Check this]
 *                                 …
 *                                 NOTES
 *                                 Do it before a run, not after. · coach_a
 *                                 [ Save these ]
 *
 * A row opens the move's sheet: its words, the post (its creator, and a link that opens it apart), the dose as the post
 * gave it and as it would be saved, and — while the row is pending — Edit (a new move, or one of the owner's own),
 * Not this move (the post's move becomes a new move of its own, from the post's reading), Same as… (another new move of
 * the batch — two the matcher missed — or a library move or one of the owner's own, from what the Studio offers), Remove,
 * and Ask the coach (the coach, seeing the move). Save
 * these keeps what is left: the new moves become the owner's, their posts their links. Notes, under the rows, is what
 * the kept posts say about when, why or how often (spec §17) — one line each, with its creator, read-only: what the
 * coach keeps in memory on Save (each removable in Settings afterwards).
 *
 * A model wrote the names, summaries, notes and creators: drawn as text, never as markup; a post's address is a link
 * only when it is a web page's (`postHref`). Every write reads the batch again; one that changes the owner's moves
 * (save, edit, either re-match) reads the whole library again (`["library"]`: their moves, the Studio's list, a move's
 * own detail), so search, the builder and a move's detail see a saved or edited move at once.
 */
import { useEffect, useId, useMemo, useRef, useState, type ReactNode } from "react";
import { Link, useParams } from "react-router-dom";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { api, ApiError, SAVES_BATCHES_QUERY, SAVES_STATUS_QUERY, savesBatchQuery } from "@rg/api-client";
import { PROFILES, searchLibrary, type ExerciseRecord } from "@rg/exercise-library";
import type { SaveBatchDetailDto, SaveBatchInsightDto, SaveBatchRowDto } from "@rg/saves";
import { EmptyState, Sheet, Spinner } from "../../components.js";
import { SearchField } from "../../components/search-field.js";
import { IconBack } from "../../icons.js";
import { useAccountLibrary } from "../../library/account-library.js";
import { AskCoach, useCoachSeeing } from "./coach-ask.js";
import { moveFocus } from "./coach-focus.js";
import { doseLine } from "./model.js";
import { postHref } from "./move-detail.js";
import { dotted } from "./move-row.js";
import {
  attrWord, batchDay, batchFacts, canSave, DOSE_TYPES, DOSE_WORD, formOf, patchOf, rowActions, savesHref, shownRows, writeError,
  type MoveForm,
} from "./saves-model.js";

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
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

// ── One batch ────────────────────────────────────────────────────────────────────────────────────────────────────────

/** The row's labels: New, or Linked to {name}; and Check this. */
function RowTags({ row }: { row: SaveBatchRowDto }) {
  return (
    <span className="stu-save-tags">
      {row.move.kind === "new" ? <span className="pill pill-ok">New</span> : <span className="stu-save-linked">{`Linked to ${row.move.linkedName ?? row.move.id}`}</span>}
      {row.move.check ? <span className="pill pill-warn">Check this</span> : null}
    </span>
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

export function SaveBatchScreen() {
  const { batchId = "" } = useParams();
  const qc = useQueryClient();
  const q = useQuery({ queryKey: savesBatchQuery(batchId), queryFn: () => api.savesBatch(batchId), retry });
  const account = useAccountLibrary();
  const [open, setOpen] = useState<Open | null>(null);
  const [status, setStatus] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const title = useRef<HTMLHeadingElement>(null);
  const focusTitle = useRef(false);

  useEffect(() => {
    if (!focusTitle.current) return;
    focusTitle.current = false;
    title.current?.focus();
  });

  const data: SaveBatchDetailDto | undefined = q.data;
  const rows = data?.rows ?? [];
  const shown = shownRows(rows);
  const openRow = open ? (rows.find((r) => r.postMoveId === open.postMoveId) ?? null) : null;

  /**
   * Read the batch again (and the batches); `moves`: the owner's moves changed, so read the whole library again — their
   * moves (`["library", "personal"]`), the Studio's list and a move's own detail (`["library", "item", id]`) alike.
   */
  const refresh = (moves: boolean) => {
    void qc.invalidateQueries({ queryKey: savesBatchQuery(batchId) });
    void qc.invalidateQueries({ queryKey: SAVES_BATCHES_QUERY });
    if (moves) void qc.invalidateQueries({ queryKey: ["library"] });
  };

  const save = async () => {
    if (saving) return;
    setSaving(true);
    try {
      await api.savesSaveBatch(batchId);
      setStatus("Saved.");
      refresh(true);
      void qc.invalidateQueries({ queryKey: SAVES_STATUS_QUERY });
    } catch (e) {
      setStatus(writeError(e, "save"));
    } finally {
      setSaving(false);
    }
  };

  /** A row's write done: the sheet closes, the page says what changed. */
  const done = (line: string, moves: boolean, gone = false) => {
    setOpen(null);
    setStatus(line);
    if (gone) focusTitle.current = true;
    refresh(moves);
  };

  let body: ReactNode;
  if (!data) body = <ReadState q={q} gone="That batch isn't there." what="this batch" />;
  else if (shown.length === 0) body = <EmptyState title="Nothing left in this batch." />;
  else {
    body = (
      <ul className="stu-tpl-list">
        {shown.map((row) => (
          <li key={row.postMoveId} className="stu-tpl stu-save-row">
            <h2 className="stu-tpl-name">
              <button type="button" className="stu-save-open" aria-haspopup="dialog" onClick={() => setOpen({ postMoveId: row.postMoveId, mode: "view" })}>
                {row.move.name}
              </button>
            </h2>
            <p className="stu-tpl-meta stu-save-meta">
              {dotted([
                <RowTags key="tags" row={row} />,
                row.post.creator ? <span className="stu-save-by">{row.post.creator}</span> : null,
                row.move.seenDose ? <span>{row.move.seenDose}</span> : null,
              ])}
            </p>
          </li>
        ))}
      </ul>
    );
  }

  return (
    <div className="stu-tpls stu-saves">
      <BackBar to={savesHref()} label="Saves" />
      <h1 ref={title} tabIndex={-1}>
        From your saves
      </h1>
      {data ? (
        <p className="stu-tpl-meta">
          <Facts facts={[batchDay(data.batch), ...batchFacts(data.batch)].filter(Boolean)} />
        </p>
      ) : null}
      {/* Empty, it is visually hidden — never display: none — so the region stays in the page and is heard when it speaks. */}
      <p className={status ? "stu-tpl-status" : "stu-tpl-status visually-hidden"} role="status">
        {status}
      </p>
      {body}
      {data ? <Notes insights={data.insights ?? []} /> : null}
      {data && canSave(data.batch, rows) ? (
        <div className="stu-build-foot stu-save-foot">
          <button type="button" className="btn btn-primary" disabled={saving} onClick={() => void save()}>
            Save these
          </button>
        </div>
      ) : null}
      {openRow && open ? (
        <MoveSheet
          key={openRow.postMoveId}
          row={openRow}
          mode={open.mode}
          siblings={newMoves(rows)}
          offered={account.offered}
          find={account.find}
          ownStatus={account.mine.get(openRow.move.id)?.status}
          onMode={(mode) => setOpen({ postMoveId: openRow.postMoveId, mode })}
          onClose={() => setOpen(null)}
          onDone={done}
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
  mode,
  siblings,
  offered,
  find,
  ownStatus,
  onMode,
  onClose,
  onDone,
}: {
  row: SaveBatchRowDto;
  mode: Open["mode"];
  siblings: readonly ExerciseRecord[];
  offered: readonly ExerciseRecord[];
  find: (id: string) => ExerciseRecord | undefined;
  ownStatus?: "active" | "archived";
  onMode: (mode: Open["mode"]) => void;
  onClose: () => void;
  onDone: (line: string, moves: boolean, gone?: boolean) => void;
}) {
  const actions = rowActions(row, ownStatus);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // What the coach sees while the sheet is open (its "Seeing" hint from the nav's Coach).
  const focus = moveFocus({ id: row.move.id, name: row.move.name });
  useCoachSeeing(focus);

  const run = async (write: () => Promise<unknown>, what: "match" | "remove" | "edit", line: string, moves: boolean, gone = false) => {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      await write();
      onDone(line, moves, gone);
    } catch (e) {
      setError(writeError(e, what));
      setBusy(false);
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
          onPick={(target) => void run(() => api.savesRematch(row.postMoveId, target.id), "match", `Linked to ${target.name}.`, true)}
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
            void run(() => api.savesEditMove(row.move.id, patch), "edit", `Saved ${patch.name ?? row.move.name}.`, true);
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
        <button type="button" className="btn" disabled={busy} onClick={() => void run(() => api.savesRematch(row.postMoveId, null), "match", `${row.move.name} is a move of its own.`, true)}>
          Not this move
        </button>
      ) : null}
      {actions.sameAs ? (
        <button type="button" className="btn" disabled={busy} onClick={() => onMode("pick")}>
          Same as…
        </button>
      ) : null}
      {actions.remove ? (
        <button type="button" className="btn stu-tpl-del" disabled={busy} onClick={() => void run(() => api.savesRemove(row.postMoveId), "remove", `Removed ${row.move.name}.`, false, true)}>
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
          <RowTags row={row} />
        </p>
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
