/**
 * THE TEMPLATES (Stage 2 spec §9; `/studio/templates`): the athlete's saved workouts, pinned first.
 *
 *   ‹ Studio
 *   Templates
 *   ┌──────────────────────────────────────────────────┐
 *   │ Hips & posture                       [Start]  ⋯  │
 *   │ 📌 Pinned · 34 min · Strength · Used 3 days ago   │
 *   ├──────────────────────────────────────────────────┤
 *   │ Legs                                 [Start]  ⋯  │
 *   │ 20 min · Strength · Not used yet                  │
 *   └──────────────────────────────────────────────────┘
 *
 * The name opens the builder on the template (its Save writes it back; its way back is this list). Start opens the
 * builder and starts it at once — the builder's own Start, so a check the day waits on, a move the day swaps or a day
 * that refuses is said there, as for any workout; the tap itself unlocks the player's audio and asks for storage, as
 * every Start does. ⋯ holds the rest, one tap down: Schedule… (the builder's sheet), Rename…, Pin to quick starts (a
 * pinned template joins the home's quick starts, and comes first here), Delete… (asked first). A pin or a rename
 * changes the row in place; focus follows the row, or after a delete goes to its neighbour, never to the page. A
 * template deleted elsewhere (a write answered 404) is said to be gone, the list is read again, and focus goes to the
 * neighbour too.
 *
 * Reads and writes are the server's (`/api/templates`): with no connection the list says so (and fills in once the
 * connection is back) and a write says why.
 */
import { Fragment, useEffect, useId, useMemo, useRef, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { api, ApiError, type TemplateDto } from "@rg/api-client";
import { ConfirmDialog, EmptyState, localTodayGuess, Sheet, Spinner } from "../../components.js";
import { features } from "../../features.js";
import { IconBack, IconMore, IconPin } from "../../icons.js";
import { requestPersistentStorage } from "../../offline/live.js";
import { chimes } from "../../player/audio.js";
import { TEMPLATES_QUERY } from "./add-sheet.js";
import { BuildEntry } from "./build-entry.js";
import { sortTemplates, templateFacts, templateHref, type BuilderArrival } from "./templates-model.js";

type Templates = { templates: TemplateDto[] };
type Write = "rename" | "pin" | "delete";

/** Why a write did not happen, in plain words. */
export function templateWriteError(e: unknown, what: Write): string {
  if (e instanceof ApiError) {
    if (e.status === 404) return "That template is gone now.";
    if (e.status === 422 && what === "rename") return "That name can't be used.";
    return what === "delete" ? "Couldn't delete it. Try again." : "Couldn't save it. Try again.";
  }
  return what === "delete" ? "Deleting needs a connection." : what === "rename" ? "Renaming needs a connection." : "Pinning needs a connection.";
}

/** Where focus goes once the next render lands: a row's name or its ⋯, else the page's title. */
type FocusTo = { id: string; to: "open" | "more" } | { to: "title" };

export function TemplatesScreen() {
  const qc = useQueryClient();
  const navigate = useNavigate();
  const q = useQuery({ queryKey: TEMPLATES_QUERY, queryFn: api.templates, staleTime: 30_000 });
  const todayQ = useQuery({ queryKey: ["today"], queryFn: api.today });
  const today = todayQ.data?.today ?? localTodayGuess();
  const list = useMemo(() => sortTemplates(q.data?.templates ?? []), [q.data]);
  const [menuId, setMenuId] = useState<string | null>(null);
  const [renaming, setRenaming] = useState<TemplateDto | null>(null);
  const [deleting, setDeleting] = useState<{ t: TemplateDto; busy: boolean; error: string | null } | null>(null);
  const [status, setStatus] = useState<string | null>(null);
  const root = useRef<HTMLDivElement>(null);
  const title = useRef<HTMLHeadingElement>(null);
  const focusNext = useRef<FocusTo | null>(null);

  useEffect(() => {
    const want = focusNext.current;
    const r = root.current;
    if (!want || !r) return;
    focusNext.current = null;
    const row = want.to === "title" ? null : ([...r.querySelectorAll<HTMLElement>(".stu-tpl")].find((el) => el.dataset.id === want.id) ?? null);
    const target =
      want.to === "more" ? row?.querySelector<HTMLElement>(".stu-tpl-more") : (row?.querySelector<HTMLElement>("a.stu-tpl-open") ?? row?.querySelector<HTMLElement>(".stu-tpl-more"));
    (target ?? title.current)?.focus();
  });

  /** A template as the server now has it, in its place in the list. */
  const put = (t: TemplateDto) =>
    qc.setQueryData<Templates>(TEMPLATES_QUERY, (old) => (old ? { templates: old.templates.map((x) => (x.id === t.id ? t : x)) } : old));

  /** Where focus goes when a row leaves the list: the next row's name (else the one before), else the page's title. */
  const neighbourOf = (id: string): FocusTo => {
    const at = list.findIndex((x) => x.id === id);
    const near = at < 0 ? undefined : (list[at + 1] ?? list[at - 1]);
    return near ? { id: near.id, to: "open" } : { to: "title" };
  };
  /**
   * A template the server no longer has (deleted elsewhere): the list is read again, and its row goes. Its ⋯ goes with
   * it, so focus can't go back there — a sheet or question still open sends it to the neighbour when it closes.
   */
  const gone = useRef<{ id: string; focus: FocusTo } | null>(null);
  const lost = (e: unknown, t: TemplateDto): boolean => {
    if (!(e instanceof ApiError && e.status === 404)) return false;
    gone.current = { id: t.id, focus: neighbourOf(t.id) };
    void qc.invalidateQueries({ queryKey: TEMPLATES_QUERY });
    return true;
  };
  /** A sheet or question about `t` closed: focus to the neighbour if its row went while it was open. */
  const closedOn = (t: TemplateDto) => {
    if (gone.current?.id !== t.id) return;
    focusNext.current = gone.current.focus;
    gone.current = null;
  };

  const start = (t: TemplateDto) => {
    // Inside the tap: audio unlocks only in a gesture, and storage is asked to persist (as every Start does).
    chimes.unlock();
    void requestPersistentStorage();
    navigate(templateHref(t.id), { state: { from: "templates", then: "start" } satisfies BuilderArrival });
  };
  const schedule = (t: TemplateDto) => {
    setMenuId(null);
    navigate(templateHref(t.id), { state: { from: "templates", then: "schedule" } satisfies BuilderArrival });
  };
  const pin = async (t: TemplateDto) => {
    setMenuId(null);
    try {
      const res = await api.updateTemplate(t.id, { pinned: !t.pinned });
      put(res.template);
      focusNext.current = { id: t.id, to: "more" };
      setStatus(res.template.pinned ? `Pinned “${t.name}” to quick starts.` : `Unpinned “${t.name}”.`);
    } catch (e) {
      // The menu has closed already: focus goes to the neighbour now, before the row goes.
      if (lost(e, t)) closedOn(t);
      setStatus(templateWriteError(e, "pin"));
    }
  };
  const rename = async (t: TemplateDto, name: string): Promise<string | null> => {
    try {
      const res = await api.updateTemplate(t.id, { name: name.trim() });
      put(res.template);
      setRenaming(null);
      focusNext.current = { id: t.id, to: "more" };
      setStatus(`Renamed “${res.template.name}”.`);
      return null;
    } catch (e) {
      lost(e, t);
      return templateWriteError(e, "rename");
    }
  };
  const remove = async () => {
    const d = deleting;
    if (!d || d.busy) return;
    setDeleting({ ...d, busy: true, error: null });
    try {
      await api.deleteTemplate(d.t.id);
    } catch (e) {
      lost(e, d.t);
      setDeleting({ ...d, busy: false, error: templateWriteError(e, "delete") });
      return;
    }
    focusNext.current = neighbourOf(d.t.id);
    qc.setQueryData<Templates>(TEMPLATES_QUERY, (old) => (old ? { templates: old.templates.filter((x) => x.id !== d.t.id) } : old));
    void qc.invalidateQueries({ queryKey: TEMPLATES_QUERY });
    setDeleting(null);
    setStatus(`Deleted “${d.t.name}”.`);
  };

  const menuT = menuId ? (list.find((t) => t.id === menuId) ?? null) : null;

  // Offline with nothing kept, the read waits (paused) rather than failing: it says so, and goes on by itself once the
  // connection is back — never a wait that does not end.
  const waiting = q.isPending && q.fetchStatus === "paused";
  let body;
  if (q.isPending && !waiting) body = <Spinner label="Loading your templates" />;
  else if (!q.data && (waiting || q.isError)) {
    body = (
      <EmptyState title={waiting ? "Your templates need a connection." : "Couldn't load your templates."}>
        <button type="button" className="btn" onClick={() => void q.refetch()}>
          Try again
        </button>
      </EmptyState>
    );
  } else if (list.length === 0) {
    body = (
      <>
        <EmptyState title="No templates yet." />
        <BuildEntry />
      </>
    );
  } else {
    body = (
      <ul className="stu-tpl-list">
        {list.map((t) => {
          const facts = [...(t.pinned ? ["Pinned"] : []), ...templateFacts(t, today)];
          return (
            <li key={t.id} className="stu-tpl" data-id={t.id}>
              <h2 className="stu-tpl-name">
                {t.doc ? (
                  <Link className="stu-tpl-open" to={templateHref(t.id)} state={{ from: "templates" } satisfies BuilderArrival}>
                    {t.name}
                  </Link>
                ) : (
                  <span className="stu-tpl-open">{t.name}</span>
                )}
              </h2>
              <p className="stu-tpl-meta">
                {t.pinned ? <IconPin size={14} /> : null}
                {/* Each fact one unbroken piece, its dot kept with it: a line breaks only between them. */}
                <span className="stu-tpl-facts">
                  {facts.map((f, i) => (
                    <Fragment key={f}>
                      {i > 0 ? " " : null}
                      <span className="stu-tpl-fact">{i < facts.length - 1 ? `${f} ·` : f}</span>
                    </Fragment>
                  ))}
                </span>
              </p>
              <span className="stu-tpl-acts">
                {t.doc && features.player ? (
                  <button type="button" className="btn stu-tpl-start" onClick={() => start(t)}>
                    Start<span className="visually-hidden">: {t.name}</span>
                  </button>
                ) : null}
                <button type="button" className="btn stu-icon-btn stu-tpl-more" aria-label={`${t.name}: more`} aria-haspopup="dialog" onClick={() => setMenuId(t.id)}>
                  <IconMore size={18} />
                </button>
              </span>
            </li>
          );
        })}
      </ul>
    );
  }

  return (
    <div ref={root} className="stu-tpls">
      <div className="stu-build-bar">
        <Link className="btn stu-build-back" to="/studio">
          <IconBack size={16} />
          Studio
        </Link>
      </div>
      <h1 ref={title} tabIndex={-1}>
        Templates
      </h1>
      {/* Empty, it is visually hidden — never display: none — so the region stays in the page and is heard when it speaks. */}
      <p className={status ? "stu-tpl-status" : "stu-tpl-status visually-hidden"} role="status">
        {status}
      </p>
      {body}

      {menuT ? (
        <Sheet open onClose={() => setMenuId(null)} title={menuT.name}>
          <div className="stu-tpl-menu">
            {menuT.doc ? (
              <button type="button" className="btn" onClick={() => schedule(menuT)}>
                Schedule…
              </button>
            ) : null}
            <button
              type="button"
              className="btn"
              onClick={() => {
                setMenuId(null);
                setRenaming(menuT);
              }}
            >
              Rename…
            </button>
            {menuT.doc || menuT.pinned ? (
              <button type="button" className="btn" onClick={() => void pin(menuT)}>
                <IconPin size={16} />
                {menuT.pinned ? "Unpin from quick starts" : "Pin to quick starts"}
              </button>
            ) : null}
            <button
              type="button"
              className="btn stu-tpl-del"
              onClick={() => {
                setMenuId(null);
                setDeleting({ t: menuT, busy: false, error: null });
              }}
            >
              Delete…
            </button>
          </div>
        </Sheet>
      ) : null}
      {renaming ? (
        <RenameSheet
          key={renaming.id}
          initial={renaming.name}
          onSave={(name) => rename(renaming, name)}
          onClose={() => {
            closedOn(renaming);
            setRenaming(null);
          }}
        />
      ) : null}
      <ConfirmDialog
        open={!!deleting}
        onClose={() => {
          if (deleting) closedOn(deleting.t);
          setDeleting(null);
        }}
        title="Delete this template?"
        confirmLabel="Delete"
        onConfirm={() => void remove()}
        busy={deleting?.busy}
        error={deleting?.error}
      >
        {deleting ? `“${deleting.t.name}” will be deleted. Workouts already planned from it stay.` : ""}
      </ConfirmDialog>
    </div>
  );
}

function RenameSheet({ initial, onSave, onClose }: { initial: string; onSave: (name: string) => Promise<string | null>; onClose: () => void }) {
  const [name, setName] = useState(initial);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const id = useId();
  const can = name.trim() !== "" && name.trim() !== initial && !busy;
  const go = async () => {
    if (!can) return;
    setBusy(true);
    setError(null);
    const why = await onSave(name);
    setBusy(false);
    if (why) setError(why);
  };
  return (
    <Sheet
      open
      onClose={onClose}
      title="Rename"
      footer={
        <div className="btn-row stu-sched-actions">
          <button type="button" className="btn btn-primary" disabled={!can} onClick={() => void go()}>
            {busy ? "Saving…" : "Save"}
          </button>
        </div>
      }
    >
      <label className="stu-field-row stu-field-row--wide" htmlFor={id}>
        <span>Name</span>
        <input
          id={id}
          className="stu-field"
          value={name}
          maxLength={80}
          autoComplete="off"
          onChange={(e) => setName(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") void go();
          }}
        />
      </label>
      {error ? (
        <p className="stu-build-error" role="alert">
          {error}
        </p>
      ) : null}
    </Sheet>
  );
}
