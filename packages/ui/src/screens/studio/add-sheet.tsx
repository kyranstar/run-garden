/**
 * ADD — ONE SMALL SHEET (Stage 2 spec §7; principles §7: "Add opens one small sheet: into a specific workout (it lands
 * in the right part) or keep in a program's rotation / pin it").
 *
 *   Add Goblet squat                                   ✕
 *   ◉ To the workout I'm building        “Hips & posture”
 *   ○ To a planned workout               [Thu Oct 16 · Strength ▾]
 *   ○ To a new workout
 *   ○ To a template                      [Desk reset ▾]
 *   ─────────────────────────────────────────────────────
 *   [📌 Pin — keep it in my rotation]              [ Add ]
 *
 * A choice is offered only where there is one: the workout being built when there is a draft on this device; the
 * planned workouts the Studio may change (`editableWorkouts`: document workouts still to be done — a programme's own
 * sessions are the engine's, so for those the sheet's answer is Pin, which the engine prefers); the templates that
 * read. A new workout is always there.
 *
 * The move lands in the part its purpose belongs to (`addMove`), and only an edit the editor accepts is made: a full
 * part, or a document the move would break, says why in the sheet and changes nothing. After Add the sheet closes and
 * a quiet line says where the move went, with Open and Undo (`AddedLine`).
 *
 * Planned workouts and templates are the server's: adding to one reads it fresh, writes a new revision (a planned
 * workout, `PUT /api/workouts/:id/doc` with the revision it read — a write that lands in between is retried once on
 * the newer revision) or the template, and Undo writes back what was there. They need a connection and say so. The
 * draft and a new workout are this device's and work offline.
 */
import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import { Link } from "react-router-dom";
import { useQuery, useQueryClient, type QueryClient } from "@tanstack/react-query";
import { api, ApiError, type DocIssueDto, type TemplateDto } from "@rg/api-client";
import { addDays, type WorkoutDoc } from "@rg/domain";
import { EXERCISES, type ExerciseRecord } from "@rg/exercise-library";
import { toProposable, type DraftDoc } from "@rg/workout";
import { Sheet, formatDayShort } from "../../components.js";
import { IconCheck, IconClose, IconPin } from "../../icons.js";
import { useStudioDraft, type StudioDraft } from "../../studio-drafts.js";
import {
  addedText,
  addMove,
  addTargetHref,
  editableWorkouts,
  freshDoc,
  rejectionText,
  type AddTarget,
  type AddTargetKind,
} from "./add-model.js";
import type { StudioCtx } from "./model.js";
import { useMoveSay } from "./prefs.js";

/** How far ahead the sheet looks for planned workouts to add to. */
export const PLANNED_DAYS = 28;

export const TEMPLATES_QUERY = ["templates"] as const;
const plannedQuery = (today: string) => ["plan", "studio-targets", today] as const;

/** What an Add did, and how to take it back. */
export interface AddDone {
  /** "Added to Main in “Hips & posture”." */
  text: string;
  /** Open: the builder on what the move went into. */
  href: string;
  undo: () => Promise<void>;
}

/** An Add refused before anything was written; its message is what the athlete reads. */
class Refused extends Error {}

const CANT_CHANGE = "This workout can't be changed here.";

/** Why an Add or an Undo that reached the server did not happen, in plain words. */
export function writeErrorText(e: unknown, undoing = false): string {
  if (e instanceof Refused) return e.message;
  if (e instanceof ApiError) {
    const body = (e.body ?? {}) as { error?: string; issues?: DocIssueDto[] };
    if (e.status === 409 && body.error === "stale_revision") return undoing ? "It changed since, so it can't be undone here." : "This workout changed elsewhere. Try again.";
    if (e.status === 409) return "This workout can't be changed now.";
    if (e.status === 422 && body.error === "invalid_doc") {
      return body.issues?.find((i) => i.severity === "error")?.message ?? "That move can't go in this workout.";
    }
    if (e.status === 404) return "That's gone now.";
    return undoing ? "Couldn't undo it. Try again." : "Couldn't add it. Try again.";
  }
  return undoing ? "Undo needs a connection." : "That needs a connection.";
}

const isStale = (e: unknown): boolean =>
  e instanceof ApiError && e.status === 409 && (e.body as { error?: string } | null)?.error === "stale_revision";

export interface AddDeps {
  draft: StudioDraft | null;
  saveDraft: (doc: DraftDoc) => Promise<unknown>;
  clearDraft: () => Promise<void>;
  qc: QueryClient;
  library?: readonly ExerciseRecord[];
}

/** Put the move into the target. Throws (`writeErrorText` says why) when nothing was added. */
export async function addTo(target: AddTarget, rec: ExerciseRecord, deps: AddDeps): Promise<AddDone> {
  const library = deps.library ?? EXERCISES;
  const href = addTargetHref(target);
  const into = (doc: WorkoutDoc) => {
    const r = addMove(doc, rec, library);
    if ("rejected" in r) throw new Refused(rejectionText(r.rejected));
    return r;
  };
  switch (target.kind) {
    case "draft":
    case "new": {
      const before = deps.draft;
      if (target.kind === "draft" && !before) throw new Refused("There's no workout being built.");
      const r = into(target.kind === "draft" ? before!.doc : freshDoc());
      await deps.saveDraft(r.doc);
      return {
        text: addedText(r.part, r.doc.title),
        href,
        undo: async () => {
          if (before) await deps.saveDraft(before.doc);
          else await deps.clearDraft();
        },
      };
    }
    case "workout": {
      const read = async () => {
        const res = await api.workoutDoc(target.id);
        if (!res.doc) throw new Refused(CANT_CHANGE);
        return res;
      };
      const write = async (res: { doc: WorkoutDoc; rev: number | null }) => {
        const r = into(res.doc);
        const doc = toProposable(r.doc);
        if (!doc) throw new Refused(CANT_CHANGE);
        return { r, saved: await api.reviseWorkoutDoc(target.id, doc, res.rev ?? 0) };
      };
      let res = await read();
      let done: Awaited<ReturnType<typeof write>>;
      try {
        done = await write(res);
      } catch (e) {
        // Changed between the read and the write: add to what is there now, once.
        if (!isStale(e)) throw e;
        res = await read();
        done = await write(res);
      }
      const original = res.doc;
      const refresh = () => {
        void deps.qc.invalidateQueries({ queryKey: ["plan"] });
        void deps.qc.invalidateQueries({ queryKey: ["today"] });
      };
      refresh();
      return {
        text: addedText(done.r.part, done.saved.workout.title),
        href,
        undo: async () => {
          await api.reviseWorkoutDoc(target.id, original, done.saved.rev ?? 0);
          refresh();
        },
      };
    }
    case "template": {
      const { templates } = await deps.qc.fetchQuery({ queryKey: TEMPLATES_QUERY, queryFn: api.templates, staleTime: 0 });
      const t = templates.find((x) => x.id === target.id);
      if (!t?.doc) throw new Refused("That template can't be read.");
      const original = t.doc;
      const r = into(original);
      const doc = toProposable(r.doc);
      if (!doc) throw new Refused("That template can't be changed here.");
      await api.updateTemplate(t.id, { doc });
      void deps.qc.invalidateQueries({ queryKey: TEMPLATES_QUERY });
      return {
        text: addedText(r.part, t.name),
        href,
        undo: async () => {
          await api.updateTemplate(t.id, { doc: original });
          void deps.qc.invalidateQueries({ queryKey: TEMPLATES_QUERY });
        },
      };
    }
  }
}

export interface AddSheetProps {
  rec: ExerciseRecord;
  ctx: StudioCtx;
  /** The athlete's today. */
  today: string;
  onClose: () => void;
  /** The move went in; the sheet closes. */
  onAdded: (done: AddDone) => void;
}

/** The templates the sheet offers: those whose document reads, pinned first. */
const usableTemplates = (ts: readonly TemplateDto[]): TemplateDto[] =>
  ts.filter((t) => t.doc !== null).sort((a, b) => Number(b.pinned) - Number(a.pinned));

export function AddSheet({ rec, ctx, today, onClose, onAdded }: AddSheetProps) {
  const qc = useQueryClient();
  const name = useId();
  const { draft, save, clear } = useStudioDraft();
  const planned = useQuery({
    queryKey: plannedQuery(today),
    queryFn: () => api.workouts(today, addDays(today, PLANNED_DAYS)),
    staleTime: 30_000,
  });
  const templates = useQuery({ queryKey: TEMPLATES_QUERY, queryFn: api.templates, staleTime: 30_000 });
  const workouts = editableWorkouts(planned.data?.workouts ?? [], today);
  const tpls = usableTemplates(templates.data?.templates ?? []);
  const { say, set: setSay, error: sayError } = useMoveSay(rec.id, ctx);

  // The athlete's choice; until they make one, the workout being built if there is one, else a new workout.
  const [chosen, setChosen] = useState<AddTargetKind | null>(null);
  const [workoutId, setWorkoutId] = useState<string | null>(null);
  const [templateId, setTemplateId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Mounted: an answer that lands after the sheet is gone is dropped. Set in the effect itself, not only cleared by its
  // cleanup — StrictMode mounts, unmounts and mounts again, and a ref only ever cleared would read "gone" for good.
  const live = useRef(false);
  useEffect(() => {
    live.current = true;
    return () => {
      live.current = false;
    };
  }, []);

  const kind: AddTargetKind = chosen ?? (draft ? "draft" : "new");
  const wid = workoutId && workouts.some((w) => w.id === workoutId) ? workoutId : (workouts[0]?.id ?? null);
  const tid = templateId && tpls.some((t) => t.id === templateId) ? templateId : (tpls[0]?.id ?? null);
  const target: AddTarget | null =
    kind === "draft"
      ? draft
        ? { kind: "draft" }
        : null
      : kind === "workout"
        ? wid
          ? { kind: "workout", id: wid }
          : null
        : kind === "template"
          ? tid
            ? { kind: "template", id: tid }
            : null
          : { kind: "new" };

  const add = async () => {
    if (!target || busy) return;
    setBusy(true);
    setError(null);
    try {
      const done = await addTo(target, rec, { draft, saveDraft: save, clearDraft: clear, qc });
      if (live.current) onAdded(done);
    } catch (e) {
      if (live.current) setError(writeErrorText(e));
    } finally {
      if (live.current) setBusy(false);
    }
  };

  const pick = (k: AddTargetKind) => {
    setChosen(k);
    setError(null);
  };
  // A plain function, not a component: a component made in render would be a new type each time, and every radio
  // would be remounted (and lose focus) on each change.
  const option = (k: AddTargetKind, label: string, extra?: ReactNode) => (
    <div key={k} className={`stu-add-opt${kind === k ? " stu-add-opt--on" : ""}`}>
      <label className="stu-add-choice">
        <input type="radio" name={name} value={k} checked={kind === k} onChange={() => pick(k)} />
        <span>{label}</span>
      </label>
      {extra}
    </div>
  );

  return (
    <Sheet
      open
      onClose={onClose}
      title={`Add ${rec.name}`}
      footer={
        <div className="btn-row stu-add-actions">
          <button type="button" className="btn stu-add-pin" aria-pressed={say.pinned} onClick={() => setSay({ pinned: !say.pinned })}>
            {say.pinned ? <IconCheck /> : <IconPin />}
            {say.pinned ? "Pinned" : "Pin — keep it in my rotation"}
          </button>
          <button type="button" className="btn btn-primary stu-add-go" disabled={!target || busy} onClick={() => void add()}>
            {busy ? "Adding…" : "Add"}
          </button>
        </div>
      }
    >
      <fieldset className="stu-add-targets">
        <legend className="visually-hidden">Add it to</legend>
        {draft ? option("draft", "To the workout I'm building", <span className="stu-add-what">{`“${draft.doc.title}”`}</span>) : null}
        {workouts.length
          ? option(
              "workout",
              "To a planned workout",
              <select
                className="stu-add-select"
                aria-label="Planned workout"
                value={wid ?? ""}
                onChange={(e) => {
                  setWorkoutId(e.target.value);
                  pick("workout");
                }}
              >
                {workouts.map((w) => (
                  <option key={w.id} value={w.id}>
                    {`${formatDayShort(w.effectiveDate)} · ${w.title}`}
                  </option>
                ))}
              </select>,
            )
          : null}
        {option("new", "To a new workout", draft ? <span className="stu-add-what">{`Replaces “${draft.doc.title}”`}</span> : undefined)}
        {tpls.length
          ? option(
              "template",
              "To a template",
              <select
                className="stu-add-select"
                aria-label="Template"
                value={tid ?? ""}
                onChange={(e) => {
                  setTemplateId(e.target.value);
                  pick("template");
                }}
              >
                {tpls.map((t) => (
                  <option key={t.id} value={t.id}>
                    {t.name}
                  </option>
                ))}
              </select>,
            )
          : null}
      </fieldset>
      {error || sayError ? (
        <p className="stu-add-error" role="alert">
          {error ?? sayError}
        </p>
      ) : null}
    </Sheet>
  );
}

/** The athlete's Add, as the confirmation line shows it. */
export interface Added extends AddDone {
  /** Which Add (a new one replaces the line). */
  n: number;
  rec: ExerciseRecord;
  /** Where it was started: the move's detail, or a row of the list. */
  from: "detail" | "list";
  phase: "done" | "undoing" | "undone";
  error?: string;
}

/**
 * The quiet confirmation line: where the move went, with Open and Undo. Always mounted where it can show (the page,
 * the detail's foot) so its words are announced as they change; empty, it takes no room. After Undo it says so, and
 * focus — whose button just went — rests on the line.
 */
export function AddedLine({ added, onUndo, onDismiss }: { added: Added | null; onUndo: () => void; onDismiss: () => void }) {
  const text = useRef<HTMLParagraphElement>(null);
  const phase = added?.phase;
  useEffect(() => {
    // Undo's button went with the undo (or was disabled under the finger while it ran): focus rests on the line rather
    // than falling to the page — and only then; focus the athlete moved elsewhere stays where they put it.
    const a = document.activeElement;
    if (phase === "undone" && (!a || a === document.body)) text.current?.focus({ preventScroll: true });
  }, [phase]);
  return (
    <div className={`stu-added${added ? " stu-added--on" : ""}`}>
      <p ref={text} className="stu-added-text" role="status" tabIndex={-1}>
        {added ? (added.phase === "undone" ? "Undone." : added.text) : ""}
      </p>
      {added && added.phase !== "undone" ? (
        <span className="stu-added-actions">
          <Link className="linklike tap-pad" to={added.href}>
            Open
          </Link>
          {/* Not `disabled` while it runs: a disabled button drops the focus it holds. */}
          <button type="button" className="linklike tap-pad" aria-disabled={added.phase === "undoing"} onClick={onUndo}>
            Undo
          </button>
        </span>
      ) : null}
      {added?.error ? <span className="stu-added-error">{added.error}</span> : null}
      {added ? (
        <button type="button" className="stu-added-x tap-pad" aria-label="Dismiss" onClick={onDismiss}>
          <IconClose />
        </button>
      ) : null}
    </div>
  );
}
