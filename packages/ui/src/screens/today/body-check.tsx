/**
 * "HOW'S YOUR BODY?" — THE BODY CHECK ON THE TODAY CARD (the new shape, 2026-10-17; design §4).
 *
 * Three chips — Fresh · A bit heavy · Sore somewhere — and, for Sore, a small picker of areas (the body's regions and
 * any condition switched on) with Done. Each answer is one request (`POST /api/today/body`); the server keeps it and
 * adapts the day as it asks, with no AI: an engine session one mode down, a watch-plan run eased — said in a line
 * ("Eased to 14 km for heavy legs") with Undo. A workout the coach or the Studio designed is never changed by itself:
 * the card offers "Ask the coach to adapt it" instead, which opens the coach with the words written. The chips show the
 * choice and can change until the session starts.
 *
 * `BodyCheck` is the connected piece the Today card places (`<BodyCheck workout={…} />`); `BodyCheckPanel` draws it from
 * a view, and `bodyLine` / `askRequest` are its words.
 */
import { useEffect, useId, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { bodyCheckApi, type BodyAreaDto, type BodyCheckDto, type BodyFeel, type WorkoutDto } from "@rg/api-client";
import { formatDistance, type Units } from "../../components.js";
import { IconCheck } from "../../icons.js";
import { useUnits } from "../../use-units.js";
import { ChipRow } from "../studio/chip-row.js";
import { useCoach } from "../studio/coach-ask.js";

const FEELS: ReadonlyArray<{ feel: BodyFeel; label: string }> = [
  { feel: "fresh", label: "Fresh" },
  { feel: "heavy", label: "A bit heavy" },
  { feel: "sore", label: "Sore somewhere" },
];

/** Areas in the athlete's words: "neck", "hips and calves", "neck, hips and calves". */
function areaWords(ids: readonly string[], areas: readonly BodyAreaDto[]): string {
  const words = ids.map((id) => (areas.find((a) => a.id === id)?.label ?? id).toLowerCase());
  return words.length <= 1 ? (words[0] ?? "") : `${words.slice(0, -1).join(", ")} and ${words.at(-1)}`;
}

/** Why the day changed: "heavy legs", "sore calves". */
function cause(answer: NonNullable<BodyCheckDto["answer"]>, areas: readonly BodyAreaDto[]): string {
  return answer.feel === "sore" ? `sore ${areaWords(answer.areas, areas)}` : "heavy legs";
}

/** What the session was eased to: "14 km", "35 min", "a recovery session". */
function easedTo(to: Extract<NonNullable<BodyCheckDto["change"]>, { kind: "eased" }>["to"], units: Units): string {
  if ("meters" in to) return formatDistance(to.meters, units);
  if ("minutes" in to) return `${to.minutes} min`;
  return `a ${to.mode} session`;
}

/** The line under the chips, or null (Fresh, no answer, or the coach is offered instead). */
export function bodyLine(view: BodyCheckDto, units: Units): string | null {
  const { answer, change } = view;
  if (!answer || !change) return null;
  switch (change.kind) {
    case "eased":
      return `Eased to ${easedTo(change.to, units)} for ${cause(answer, view.areas)}`;
    case "kept":
      if (change.why === "quiet") return `Noted — today leaves your ${areaWords(answer.areas, view.areas)} alone.`;
      if (change.why === "gentlest") return "Today is already as gentle as it goes.";
      if (change.why === "race") return "Race day — kept as planned.";
      return "Kept as planned.";
    case "ask":
      return null;
  }
}

/** What the coach is asked when a designed workout can't change by itself. */
export function askRequest(answer: NonNullable<BodyCheckDto["answer"]>, areas: readonly BodyAreaDto[]): string {
  return answer.feel === "sore" ? `Sore ${areaWords(answer.areas, areas)}; adapt today's session` : "Legs are heavy; adapt today's session";
}

export interface BodyCheckPanelProps {
  view: BodyCheckDto;
  units: Units;
  /** A save is on its way: the chips wait. */
  busy: boolean;
  error: string | null;
  onAnswer: (feel: BodyFeel, areas?: string[]) => void;
  onUndo: () => void;
  /** Opens the coach with these words; null without the coach in the app. */
  onAsk: ((request: string) => void) | null;
}

/** The check, drawn from its view. */
export function BodyCheckPanel({ view, units, busy, error, onAnswer, onUndo, onAsk }: BodyCheckPanelProps) {
  const questionId = useId();
  const pickerId = useId();
  const [picking, setPicking] = useState<string[] | null>(null);
  const chosen = view.answer?.feel ?? null;
  const locked = !view.open || busy;
  const line = bodyLine(view, units);
  const change = view.change;

  const tapFeel = (feel: BodyFeel) => {
    if (feel === "sore") {
      // The picker opens on the areas already kept (a second tap closes it).
      setPicking((p) => (p ? null : view.answer?.feel === "sore" ? [...view.answer.areas] : []));
      return;
    }
    setPicking(null);
    if (feel !== chosen) onAnswer(feel);
  };
  const toggleArea = (id: string) => setPicking((p) => (p ? (p.includes(id) ? p.filter((x) => x !== id) : [...p, id]) : p));
  // The picker closes back onto the chip that opened it, so the focus never falls to the page.
  const soreChip = useRef<HTMLButtonElement>(null);
  const close = () => {
    setPicking(null);
    soreChip.current?.focus();
  };
  const done = () => {
    if (!picking || picking.length === 0) return;
    const order = view.areas.map((a) => a.id);
    onAnswer("sore", order.filter((id) => picking.includes(id)));
    close();
  };

  return (
    <div className="body-check">
      <p className="body-check-q" id={questionId}>
        How&rsquo;s your body?
      </p>
      <div className="body-check-chips" role="group" aria-labelledby={questionId}>
        {FEELS.map(({ feel, label }) => {
          const on = chosen === feel;
          return (
            <button
              key={feel}
              type="button"
              className="chip"
              ref={feel === "sore" ? soreChip : undefined}
              aria-pressed={on}
              // Sore waits for the areas it offers (the read).
              disabled={locked || (feel === "sore" && view.areas.length === 0)}
              {...(feel === "sore" && view.open ? { "aria-expanded": picking !== null, "aria-controls": pickerId } : {})}
              onClick={() => tapFeel(feel)}
            >
              {on ? <IconCheck /> : null}
              {label}
            </button>
          );
        })}
      </div>
      {picking && view.open ? (
        <fieldset
          className="body-check-picker"
          id={pickerId}
          onKeyDown={(e) => {
            if (e.key === "Escape") {
              e.stopPropagation();
              close();
            }
          }}
        >
          <legend className="body-check-where">Where?</legend>
          <ChipRow
            toggle
            limit={8}
            more="More areas"
            less="Fewer areas"
            chips={view.areas.map((a) => ({ key: a.id, label: a.label, on: picking.includes(a.id), onClick: () => toggleArea(a.id) }))}
          />
          <div className="body-check-picker-actions">
            <button type="button" className="btn btn-small btn-primary" disabled={picking.length === 0 || busy} onClick={done}>
              Done
            </button>
            <button type="button" className="linklike tap-pad" onClick={close}>
              Cancel
            </button>
          </div>
        </fieldset>
      ) : null}
      <div className="body-check-result" aria-live="polite">
        {line ? (
          <p className="body-check-line">
            {line}
            {change?.kind === "eased" && view.open ? (
              <>
                {" "}
                <button type="button" className="linklike tap-pad body-check-undo" disabled={busy} onClick={onUndo}>
                  Undo
                </button>
              </>
            ) : null}
          </p>
        ) : null}
        {change?.kind === "ask" && view.answer && onAsk ? (
          <button type="button" className="btn btn-small body-check-ask" onClick={() => onAsk(askRequest(view.answer!, view.areas))}>
            Ask the coach to adapt it
          </button>
        ) : null}
        {error ? <p className="body-check-error">{error}</p> : null}
      </div>
    </div>
  );
}

const SAVE_FAILED = "Couldn't save — try again.";

/** The body check of one of today's sessions, as the Today card places it. */
export function BodyCheck({ workout }: { workout: Pick<WorkoutDto, "id"> }) {
  const qc = useQueryClient();
  const units = useUnits();
  const coach = useCoach();
  const key = ["body-check", workout.id] as const;
  const read = useQuery({ queryKey: key, queryFn: () => bodyCheckApi.read(workout.id), staleTime: 60_000 });
  const [error, setError] = useState<string | null>(null);

  /** The day's session may have changed: Today, the plan and the session's sheet read it again. */
  const settled = (next: BodyCheckDto, before: BodyCheckDto | undefined) => {
    qc.setQueryData(key, next);
    setError(null);
    if (next.change?.kind === "eased" || before?.change?.kind === "eased") {
      for (const k of [["today"], ["plan"], ["plan-week"], ["session", workout.id], ["workout", workout.id]]) void qc.invalidateQueries({ queryKey: k });
    }
  };
  const answer = useMutation({
    mutationFn: (a: { feel: BodyFeel; areas?: string[] }) => bodyCheckApi.answer(workout.id, a.feel, a.areas),
    onSuccess: (next) => settled(next, read.data),
    onError: () => setError(SAVE_FAILED),
  });
  const undo = useMutation({
    mutationFn: () => bodyCheckApi.undo(workout.id),
    onSuccess: (next) => settled(next, read.data),
    onError: () => setError(SAVE_FAILED),
  });

  // An ease left pending (a request cut off between its two halves) is finished by the card, once.
  const finished = useRef(false);
  const pendingAnswer = read.data?.pending ? read.data.answer : null;
  useEffect(() => {
    if (!pendingAnswer || finished.current) return;
    finished.current = true;
    answer.mutate({ feel: pendingAnswer.feel, ...(pendingAnswer.feel === "sore" ? { areas: pendingAnswer.areas } : {}) });
  }, [pendingAnswer, answer]);

  // Until the read lands (or offline), the question still stands: a tap is kept by the server all the same.
  const base: BodyCheckDto = read.data ?? { workoutId: workout.id, answer: null, change: null, open: true, areas: [] };
  // The choice shows as soon as it is tapped; the server's answer replaces it.
  const pending = answer.isPending && answer.variables ? { ...base, answer: { feel: answer.variables.feel, areas: answer.variables.areas ?? [] }, change: null } : base;
  return (
    <BodyCheckPanel
      view={pending}
      units={units}
      busy={answer.isPending || undo.isPending}
      error={error}
      onAnswer={(feel, areas) => answer.mutate({ feel, ...(areas ? { areas } : {}) })}
      onUndo={() => undo.mutate()}
      onAsk={coach ? (request) => coach.open({ request }) : null}
    />
  );
}
