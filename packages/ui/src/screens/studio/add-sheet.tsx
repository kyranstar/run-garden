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
 * The workout being built is offered when there is a draft on this device. The planned workouts are those the Studio
 * may change (`editableWorkouts`: document workouts still to be done — a programme's own sessions are the engine's, so
 * for those the sheet's answer is Pin, which the engine prefers); the templates, those whose document reads; a new
 * workout is always there. The rows never move under a finger: the list is drawn once the draft has been read (until
 * then nothing in it can be tapped, and Add waits too), and the planned-workout and template rows hold their place
 * while their reads answer — saying "None coming up" / "None yet" when there are none.
 *
 * The move lands in the part its purpose belongs to (`addMove`), and only an edit the editor accepts is made: a full
 * part, or a document the move would break, says why in the sheet and changes nothing. After Add the sheet closes and
 * a quiet line says where the move went, with Open and Undo (`AddedLine`) — and, for a planned workout the watch holds
 * an older copy of, "Send the new version".
 *
 * Planned workouts and templates are the server's: adding to one reads it fresh, writes a new revision (a planned
 * workout, `PUT /api/workouts/:id/doc` with the revision it read — a write that lands in between is retried once on
 * the newer revision) or the template, and Undo writes back what was there — refused, plainly, when the template
 * changed since. They need a connection and say so. The draft and a new workout are this device's and work offline;
 * what Undo puts back is the draft as the device held it at the moment of the Add, read then, not as a render saw it.
 * While a write is under way the sheet stays: ✕ and Escape wait for the answer.
 */
import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import { Link } from "react-router-dom";
import { useQuery, useQueryClient, type QueryClient } from "@tanstack/react-query";
import { api, ApiError, type DocIssueDto, type TemplateDto } from "@rg/api-client";
import { addDays, type WorkoutDoc } from "@rg/domain";
import { EXERCISES, type ExerciseRecord } from "@rg/exercise-library";
import { toProposable, type DraftDoc } from "@rg/workout";
import { Sheet } from "../../components.js";
import { IconCheck, IconClose, IconPin } from "../../icons.js";
import { useStudioDraft, type DraftStore, type StudioDraft } from "../../studio-drafts.js";
import {
  addedText,
  addMove,
  addTargetHref,
  editableWorkouts,
  freshDoc,
  plannedLabel,
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
  /** What the server notes about the result as costs (its warnings), in its words. Never blocks. */
  notes: string[];
  /** A planned workout whose copy on the watch is now the older version: offer to send the new one. */
  watch?: { workoutId: string; minutes: number };
}

/** An Add (or an Undo) refused, or failed on this device, before anything reached the server; its message is what the athlete reads. */
class Refused extends Error {}

const CANT_CHANGE = "This workout can't be changed here.";
const LOCAL_SAVE = "Couldn't keep it on this device.";
const LOCAL_UNDO = "Couldn't undo it on this device.";

/** Why an Add or an Undo did not happen, in plain words. */
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

const costs = (issues: readonly DocIssueDto[] | undefined): string[] => (issues ?? []).filter((i) => i.severity === "warning").map((i) => i.message);

export interface AddDeps {
  /** This device's draft. Read when the Add is made — never what a render last saw. */
  drafts: Pick<DraftStore, "load"> & { save: (doc: DraftDoc) => Promise<unknown>; clear: () => Promise<void> };
  qc: QueryClient;
  library?: readonly ExerciseRecord[];
}

/** A step on this device that failed: said as this device's, not as a connection's. */
async function onDevice<T>(step: () => Promise<T>, text: string): Promise<T> {
  try {
    return await step();
  } catch {
    throw new Refused(text);
  }
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
      // What Undo puts back: the draft as the device holds it now, read now.
      const before: StudioDraft | null = await onDevice(() => deps.drafts.load(), LOCAL_SAVE);
      if (target.kind === "draft" && !before) throw new Refused("The workout you were building isn't here any more.");
      const r = into(target.kind === "draft" ? before!.doc : freshDoc());
      await onDevice(() => deps.drafts.save(r.doc), LOCAL_SAVE);
      return {
        text: addedText(r.part, r.doc.title),
        href,
        notes: [],
        undo: () => onDevice(async () => (before ? void (await deps.drafts.save(before.doc)) : deps.drafts.clear()), LOCAL_UNDO),
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
        void deps.qc.invalidateQueries({ queryKey: ["session", target.id] });
      };
      refresh();
      return {
        text: addedText(done.r.part, done.saved.workout.title),
        href,
        notes: costs(done.saved.warnings),
        ...(done.saved.watchHasOlder ? { watch: { workoutId: target.id, minutes: done.saved.workout.minutes } } : {}),
        undo: async () => {
          await api.reviseWorkoutDoc(target.id, original, done.saved.rev ?? 0);
          refresh();
        },
      };
    }
    case "template": {
      const fresh = async () => (await deps.qc.fetchQuery({ queryKey: TEMPLATES_QUERY, queryFn: api.templates, staleTime: 0 })).templates;
      const t = (await fresh()).find((x) => x.id === target.id);
      if (!t?.doc) throw new Refused("That template can't be read.");
      const original = t.doc;
      const r = into(original);
      const doc = toProposable(r.doc);
      if (!doc) throw new Refused("That template can't be changed here.");
      const saved = await api.updateTemplate(t.id, { doc });
      void deps.qc.invalidateQueries({ queryKey: TEMPLATES_QUERY });
      return {
        text: addedText(r.part, t.name),
        href,
        notes: costs(saved.warnings),
        undo: async () => {
          // Only the template as this Add left it: an edit made since is not undone from here.
          const now = (await fresh()).find((x) => x.id === t.id);
          if (!now) throw new Refused("That template is gone.");
          if (now.updatedAt !== saved.template.updatedAt) throw new Refused("That template changed since, so it can't be undone here.");
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
  /** The device's draft store (a test passes its own). */
  drafts?: DraftStore;
}

/** The templates the sheet offers: those whose document reads, pinned first. */
const usableTemplates = (ts: readonly TemplateDto[]): TemplateDto[] =>
  ts.filter((t) => t.doc !== null).sort((a, b) => Number(b.pinned) - Number(a.pinned));

export function AddSheet({ rec, ctx, today, onClose, onAdded, drafts }: AddSheetProps) {
  const qc = useQueryClient();
  const name = useId();
  const { draft, loaded, save, clear, load } = useStudioDraft(drafts);
  const planned = useQuery({
    queryKey: plannedQuery(today),
    queryFn: () => api.workouts(today, addDays(today, PLANNED_DAYS)),
    staleTime: 30_000,
  });
  const templates = useQuery({ queryKey: TEMPLATES_QUERY, queryFn: api.templates, staleTime: 30_000 });
  const workouts = editableWorkouts(planned.data?.workouts ?? [], today);
  const tpls = usableTemplates(templates.data?.templates ?? []);
  const { say, set: setSay, error: sayError } = useMoveSay(rec.id, ctx);

  // The athlete's choice; until they make one, the workout being built if there is one, else a new workout — decided
  // only once the draft has been read.
  const [chosen, setChosen] = useState<AddTargetKind | null>(null);
  const [workoutId, setWorkoutId] = useState<string | null>(null);
  const [templateId, setTemplateId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const busyNow = useRef(false);
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
  // Nothing to add to until the draft has been read: the default (and so what Add would write) depends on it.
  const target: AddTarget | null = !loaded
    ? null
    : kind === "draft"
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
    if (!target || busyNow.current) return;
    busyNow.current = true;
    setBusy(true);
    setError(null);
    try {
      const done = await addTo(target, rec, { drafts: { load, save, clear }, qc });
      if (live.current) onAdded(done);
    } catch (e) {
      if (live.current) setError(writeErrorText(e));
    } finally {
      busyNow.current = false;
      if (live.current) setBusy(false);
    }
  };

  const pick = (k: AddTargetKind) => {
    setChosen(k);
    setError(null);
  };
  // A plain function, not a component: a component made in render would be a new type each time, and every radio
  // would be remounted (and lose focus) on each change.
  const option = (k: AddTargetKind, label: string, extra?: ReactNode, offered = true) => (
    <div key={k} className={`stu-add-opt${kind === k ? " stu-add-opt--on" : ""}`}>
      <label className="stu-add-choice">
        <input type="radio" name={name} value={k} checked={kind === k} disabled={!offered} onChange={() => pick(k)} />
        <span>{label}</span>
      </label>
      {extra}
    </div>
  );
  /** The note a held row shows while its read answers, or when it has nothing to offer. */
  const held = (text: string) => <span className="stu-add-what">{text}</span>;

  return (
    <Sheet
      open
      // While a write is under way the sheet waits for its answer: ✕ and Escape do nothing until then.
      onClose={() => {
        if (!busyNow.current) onClose();
      }}
      title={`Add ${rec.name}`}
      footer={
        <div className="btn-row stu-add-actions">
          {/* One name; the pressed state is `aria-pressed`, shown by the check in the pin's place. */}
          <button type="button" className="btn stu-add-pin" aria-pressed={say.pinned} onClick={() => setSay({ pinned: !say.pinned })}>
            {say.pinned ? <IconCheck /> : <IconPin />}
            Pin — keep it in my rotation
          </button>
          <button type="button" className="btn btn-primary stu-add-go" disabled={!target || busy} onClick={() => void add()}>
            {busy ? "Adding…" : "Add"}
          </button>
        </div>
      }
    >
      <fieldset className="stu-add-targets" aria-busy={!loaded}>
        <legend className="visually-hidden">Add it to</legend>
        {loaded ? (
          <>
            {draft ? option("draft", "To the workout I'm building", held(`“${draft.doc.title}”`)) : null}
            {option(
              "workout",
              "To a planned workout",
              workouts.length ? (
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
                      {plannedLabel(w, workouts)}
                    </option>
                  ))}
                </select>
              ) : (
                held(planned.isPending ? "…" : "None coming up")
              ),
              workouts.length > 0,
            )}
            {option("new", "To a new workout", draft ? held(`Replaces “${draft.doc.title}”`) : undefined)}
            {option(
              "template",
              "To a template",
              tpls.length ? (
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
                </select>
              ) : (
                held(templates.isPending ? "…" : "None yet")
              ),
              tpls.length > 0,
            )}
          </>
        ) : null}
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
  /** The new version, once its Send was taken. */
  sent?: boolean;
  error?: string;
}

/**
 * The quiet confirmation line: where the move went, with Open and Undo — and, when the watch holds the workout's older
 * version, "Send the new version" (the session's own Send: its preview, then the push). Always mounted where it can show
 * (the page, the detail's foot) so its words are announced as they change; empty, it takes no room. A failed Undo is
 * an alert. After Undo it says so, and focus — whose button just went — rests on the line.
 */
export function AddedLine({
  added,
  onUndo,
  onDismiss,
  onSendWatch,
}: {
  added: Added | null;
  onUndo: () => void;
  onDismiss: () => void;
  /** Open the watch preview for the workout, to send its new version. */
  onSendWatch?: (workoutId: string) => void;
}) {
  const text = useRef<HTMLParagraphElement>(null);
  const phase = added?.phase;
  useEffect(() => {
    // Undo's button went with the undo: focus rests on the line rather than falling to the page — and only then; focus
    // the athlete moved elsewhere stays where they put it.
    const a = document.activeElement;
    if (phase === "undone" && (!a || a === document.body)) text.current?.focus({ preventScroll: true });
  }, [phase]);
  const live = added && added.phase !== "undone";
  const watch = live && added.watch ? added.watch : null;
  return (
    <div className={`stu-added${added ? " stu-added--on" : ""}`}>
      <p ref={text} className="stu-added-text" role="status" tabIndex={-1}>
        {added
          ? added.phase === "undone"
            ? "Undone."
            : [added.text, watch ? (added.sent ? "Sending the new version to your watch." : "Your watch has the older version.") : null]
                .filter(Boolean)
                .join(" ")
          : ""}
      </p>
      {live ? (
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
      {added ? (
        <button type="button" className="stu-added-x tap-pad" aria-label="Dismiss" onClick={onDismiss}>
          <IconClose />
        </button>
      ) : null}
      {watch && !added?.sent && onSendWatch ? (
        <button type="button" className="btn btn-small stu-added-send" onClick={() => onSendWatch(watch.workoutId)}>
          Send the new version
        </button>
      ) : null}
      {live && added.notes.length ? (
        <ul className="stu-added-notes">
          {added.notes.map((n, i) => (
            <li key={`${i}-${n}`}>{n}</li>
          ))}
        </ul>
      ) : null}
      {added?.error ? (
        <span className="stu-added-error" role="alert">
          {added.error}
        </span>
      ) : null}
    </div>
  );
}
