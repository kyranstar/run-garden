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
import { Link, useLocation } from "react-router-dom";
import { useQuery, useQueryClient, type QueryClient } from "@tanstack/react-query";
import { api, ApiError, type DocIssueDto, type TemplateDto } from "@rg/api-client";
import { addDays, type WorkoutDoc } from "@rg/domain";
import { EXERCISES, type ExerciseRecord } from "@rg/exercise-library";
import { toProposable, type DraftDoc } from "@rg/workout";
import { Sheet } from "../../components.js";
import { IconCheck, IconClose, IconPin } from "../../icons.js";
import { useStudioDraft, type DraftStore, type StudioDraft } from "../../studio-drafts.js";
import { useAccountLibrary } from "../../library/account-library.js";
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
import type { BuilderArrival } from "./templates-model.js";
import { useMoveSay } from "./prefs.js";

/** How far ahead the sheet looks for planned workouts to add to. */
export const PLANNED_DAYS = 28;

/**
 * How long ✕ and Escape wait for a write under way before they may close the sheet anyway (the page then keeps the
 * answer, "Still saving…" until it lands). An object so a test can shorten it.
 */
export const SAVE_PATIENCE = { ms: 8000 };

export const TEMPLATES_QUERY = ["templates"] as const;
const plannedQuery = (today: string) => ["plan", "studio-targets", today] as const;

/** What an Add did, and how to take it back. */
export interface AddDone {
  /** "Added to Main in “Hips & posture”." */
  text: string;
  /** Open: the builder on what the move went into. */
  href: string;
  /** Take it back; what the server says of the undone workout (its watch copy) comes back with it. */
  undo: () => Promise<UndoDone | void>;
  /** What the server notes about the result as costs (its warnings), in its words. Never blocks. */
  notes: string[];
  /** A planned workout whose copy on the watch is now the older version: offer to send the new one. */
  watch?: { workoutId: string; minutes: number };
}

/** What an Undo leaves to say: the watch still holds the copy with the move in it. */
export interface UndoDone {
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
  /** What the target's moves resolve in: the account's `all` (the sheet's). The bundled library when absent. */
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
          const back = await api.reviseWorkoutDoc(target.id, original, done.saved.rev ?? 0);
          refresh();
          // The watch may hold the copy with the move (sent after the Add): the line says so, with Send.
          return back.watchHasOlder ? { watch: { workoutId: target.id, minutes: back.workout.minutes } } : {};
        },
      };
    }
    case "template": {
      // The read can be a copy (the service worker answers from its cache when the network is slow): every write names
      // the copy it was built on (`baseUpdatedAt`), so one the template has moved past is refused, never written over it.
      const fresh = async () => (await deps.qc.fetchQuery({ queryKey: TEMPLATES_QUERY, queryFn: api.templates, staleTime: 0 })).templates;
      const read = async () => {
        const t = (await fresh()).find((x) => x.id === target.id);
        if (!t?.doc) throw new Refused("That template can't be read.");
        return t as TemplateDto & { doc: WorkoutDoc };
      };
      const write = async (t: TemplateDto & { doc: WorkoutDoc }) => {
        const r = into(t.doc);
        const doc = toProposable(r.doc);
        if (!doc) throw new Refused("That template can't be changed here.");
        return { r, saved: await api.updateTemplate(t.id, { doc, baseUpdatedAt: t.updatedAt }) };
      };
      let t = await read();
      let done: Awaited<ReturnType<typeof write>>;
      try {
        done = await write(t);
      } catch (e) {
        // Changed between the read and the write: add to what is there now, once.
        if (!isStale(e)) throw e;
        t = await read();
        try {
          done = await write(t);
        } catch (again) {
          if (isStale(again)) throw new Refused("That template changed elsewhere. Try again.");
          throw again;
        }
      }
      const original = t.doc;
      const { r, saved } = done;
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
          await api.updateTemplate(t.id, { doc: original, baseUpdatedAt: saved.template.updatedAt });
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
  /** The athlete closed the sheet while a write was still under way (past `SAVE_PATIENCE`): its answer, for the page. */
  onLeaveWhileSaving?: (writing: Promise<AddDone>) => void;
}

/** The templates the sheet offers: those whose document reads, pinned first. */
const usableTemplates = (ts: readonly TemplateDto[]): TemplateDto[] =>
  ts.filter((t) => t.doc !== null).sort((a, b) => Number(b.pinned) - Number(a.pinned));

/** A read that waits for the connection (paused offline) with nothing kept: said so, never a wait that does not end. */
const waiting = (q: { fetchStatus: string; data: unknown }): string | null => (q.fetchStatus === "paused" && q.data === undefined ? "Needs a connection" : null);

export function AddSheet({ rec, ctx, today, onClose, onAdded, drafts, onLeaveWhileSaving }: AddSheetProps) {
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
  // What the target already holds resolves in the account's whole library (an archived move of the athlete's own too).
  const { all } = useAccountLibrary();

  // The draft the sheet offers: the FIRST read's answer, for the sheet's lifetime, so the row never comes or goes once
  // the list is drawn (what Add writes reads the device again at that moment).
  const firstRead = useRef<{ draft: StudioDraft | null } | null>(null);
  if (loaded && !firstRead.current) firstRead.current = { draft };
  const offeredDraft = firstRead.current?.draft ?? null;

  // The athlete's choice; until they make one, the workout being built if there is one, else a new workout.
  const [chosen, setChosen] = useState<AddTargetKind | null>(null);
  const [workoutId, setWorkoutId] = useState<string | null>(null);
  const [templateId, setTemplateId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const busyNow = useRef(false);
  /** The write under way, handed to the page if the athlete leaves before it answers. */
  const inFlight = useRef<Promise<AddDone> | null>(null);
  /** The write has run past `SAVE_PATIENCE.ms`: the sheet may close, the page keeps the answer. */
  const [stuck, setStuck] = useState(false);
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

  const kind: AddTargetKind = chosen ?? (offeredDraft ? "draft" : "new");
  const wid = workoutId && workouts.some((w) => w.id === workoutId) ? workoutId : (workouts[0]?.id ?? null);
  const tid = templateId && tpls.some((t) => t.id === templateId) ? templateId : (tpls[0]?.id ?? null);
  // Nothing to add to until the draft has been read: the default (and so what Add would write) depends on it.
  const target: AddTarget | null = !loaded
    ? null
    : kind === "draft"
      ? offeredDraft
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
    setStuck(false);
    setError(null);
    const patience = setTimeout(() => {
      if (live.current) setStuck(true);
    }, SAVE_PATIENCE.ms);
    const writing = addTo(target, rec, { drafts: { load, save, clear }, qc, library: all });
    inFlight.current = writing;
    try {
      const done = await writing;
      // Gone already (closed while saving): the page took the write over and shows its answer.
      if (live.current) onAdded(done);
    } catch (e) {
      if (live.current) setError(writeErrorText(e));
    } finally {
      clearTimeout(patience);
      busyNow.current = false;
      inFlight.current = null;
      if (live.current) {
        setBusy(false);
        setStuck(false);
      }
    }
  };

  /** ✕ and Escape: wait while a write is under way — but not past `SAVE_PATIENCE.ms`; then close, the page keeping it. */
  const close = () => {
    if (!busyNow.current) return onClose();
    if (!stuckNow.current || !inFlight.current) return;
    onLeaveWhileSaving?.(inFlight.current);
    onClose();
  };
  const stuckNow = useRef(false);
  stuckNow.current = stuck;

  const pick = (k: AddTargetKind) => {
    setChosen(k);
    setError(null);
  };
  // A plain function, not a component: a component made in render would be a new type each time, and every radio
  // would be remounted (and lose focus) on each change.
  const option = (k: AddTargetKind, label: string, extra?: ReactNode, offered = true) => (
    <div key={k} className={`stu-add-opt${kind === k ? " stu-add-opt--on" : ""}`}>
      <label className="stu-choice">
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
      // While a write is under way the sheet waits for its answer — for a while (`close`).
      onClose={close}
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
            {offeredDraft ? option("draft", "To the workout I'm building", held(`“${offeredDraft.doc.title}”`)) : null}
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
                held(waiting(planned) ?? (planned.isPending ? "…" : "None coming up"))
              ),
              workouts.length > 0,
            )}
            {option("new", "To a new workout", offeredDraft ? held(`Replaces “${offeredDraft.doc.title}”`) : undefined)}
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
                held(waiting(templates) ?? (templates.isPending ? "…" : "None yet"))
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
      {/* Past the wait: say it is still going, and that the sheet can go (the page keeps the answer). */}
      <p className="stu-add-wait" role="status">
        {stuck ? "Still saving… You can close this." : ""}
      </p>
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
  /**
   * saving — the sheet was closed while the write was still under way; failed — that write did not happen;
   * done / undoing / undone — as they say.
   */
  phase: "saving" | "failed" | "done" | "undoing" | "undone";
  /** The version on offer to the watch, once its Send was taken. */
  sent?: boolean;
  /**
   * After Undo: the Add's own version was sent to the watch before it was undone, so the watch holds the copy with the
   * move. Only then does the line say so — the server's `watchHasOlder` compares revisions, not what is in them.
   */
  addSent?: boolean;
  error?: string;
}

/** The words of the line, by phase — and, when the watch holds another copy, what it holds. */
function lineWords(a: Added): string {
  if (a.phase === "saving") return "Still saving…";
  if (a.phase === "failed") return "";
  if (a.phase === "undone") {
    if (!a.watch) return "Undone.";
    if (a.sent) return "Undone. Sending this version to your watch.";
    // Only what the line knows: the Add's version went to the watch — else just that the watch's copy is another one.
    return a.addSent ? `Undone. Your watch has the copy with ${a.rec.name}.` : "Undone. Your watch has an older version.";
  }
  if (!a.watch) return a.text;
  return `${a.text} ${a.sent ? "Sending the new version to your watch." : "Your watch has the older version."}`;
}

/**
 * The quiet confirmation line: where the move went, with Open and Undo — and, when the watch holds another copy of the
 * workout, a Send (the session's own: its preview, then the push). Its words and the server's costs are one status
 * region, always mounted where the line can show (the page, the detail's foot), so they are announced as they change;
 * empty, it takes no room. A failure is an alert. After Undo, or once the new version is on its way, the button that
 * was pressed is gone and focus rests on the line's words (only when it had nowhere else to be).
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
  /** Open the watch preview for the workout, to send the version it now holds in the app. */
  onSendWatch?: (workoutId: string) => void;
}) {
  const said = useRef<HTMLDivElement>(null);
  const phase = added?.phase;
  const sent = added?.sent;
  // Open hands the builder its way back: the search, or the move, the Add was made from.
  const here = useLocation();
  const backTo: BuilderArrival = { from: { href: `${here.pathname}${here.search}` } };
  useEffect(() => {
    // The pressed button went (Undo, Send): focus rests on the line rather than falling to the page — and only then;
    // focus the athlete moved elsewhere stays where they put it.
    const a = document.activeElement;
    if ((phase === "undone" || sent) && (!a || a === document.body)) said.current?.focus({ preventScroll: true });
  }, [phase, sent]);
  const acting = added && (added.phase === "done" || added.phase === "undoing");
  const sendable = added && added.watch && !added.sent && (added.phase === "done" || added.phase === "undone") && onSendWatch;
  return (
    <div className={`stu-added${added ? " stu-added--on" : ""}`}>
      <div ref={said} className="stu-added-said" role="status" tabIndex={-1}>
        <p className="stu-added-text">{added ? lineWords(added) : ""}</p>
        {acting && added.notes.length ? (
          <ul className="stu-added-notes">
            {added.notes.map((n, i) => (
              <li key={`${i}-${n}`}>{n}</li>
            ))}
          </ul>
        ) : null}
      </div>
      {acting ? (
        <span className="stu-added-actions">
          <Link className="linklike tap-pad" to={added.href} state={backTo}>
            Open
          </Link>
          {/* Not `disabled` while it runs: a disabled button drops the focus it holds. */}
          <button type="button" className="linklike tap-pad" aria-disabled={added.phase === "undoing"} onClick={onUndo}>
            Undo
          </button>
        </span>
      ) : null}
      {added && added.phase !== "saving" ? (
        <button type="button" className="stu-added-x tap-pad" aria-label="Dismiss" onClick={onDismiss}>
          <IconClose />
        </button>
      ) : null}
      {sendable ? (
        <button type="button" className="btn btn-small stu-added-send" onClick={() => onSendWatch(added.watch!.workoutId)}>
          {added.phase === "undone" ? "Send this version" : "Send the new version"}
        </button>
      ) : null}
      {added?.error ? (
        <span className="stu-added-error" role="alert">
          {added.error}
        </span>
      ) : null}
    </div>
  );
}
