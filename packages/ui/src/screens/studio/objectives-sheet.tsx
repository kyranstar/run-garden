/**
 * ADD OR EDIT AN OBJECTIVE (Stage 3 Task 11; spec §11) — one sheet in the Studio's pattern (a Sheet, its fields as the
 * builder's sheets lay them, Save pinned in its foot), with two views:
 *
 *   New objective                              ✕        Key result                                 ✕
 *   Title  [                     ]                      Name     [                    ]
 *   Why    [                     ]                      Measure  [Longest hold        ▾]
 *   GOALS  Ski · Posture · …  (toggles)                 Moves    (Wall sit ✕)  [⌕ Find a move ]
 *   KEY RESULTS                                         Over the last [90 days ▾]
 *   Wall sit hold · Longest hold · Wall sit  Edit Remove  Target (s) [120]   Start (s) [60]
 *   [＋ Add a key result]                               By [date]
 *                                    [ Save ]                                         [Back] [Done]
 *
 * The key results are the whole list (`PUT`'s rule): one removed is left out of what is sent. Values are typed in the
 * key result's unit — the athlete's, from their settings, for a new one; the one it was kept in for one that exists, while
 * its measure still fits it — a race time or a pace as a clock. A check-in or test key result (not measured until a
 * later stage) is kept as it is. What can't be sent is said in plain words before anything is sent; the server's
 * refusal is said the same way, and the sheet stays open.
 */
import { useEffect, useId, useMemo, useRef, useState } from "react";
import { GOAL_IDS, MAX_KEY_RESULTS } from "@rg/domain";
import { EXERCISES, label, searchLibrary } from "@rg/exercise-library";
import { Sheet } from "../../components.js";
import { SearchField } from "../../components/search-field.js";
import { IconClose, IconPlus } from "../../icons.js";
import {
  defaultWindow,
  draftMeasure,
  draftUnit,
  emptyKr,
  krInputOf,
  MEASURE_KINDS,
  MEASURE_LABELS,
  measureOf,
  measureWords,
  METRIC_LABELS,
  moveName,
  objectiveInputOf,
  unitHint,
  WINDOW_CHOICES,
  type BoardUnits,
  type KrDraft,
  type MeasureKind,
  type Metric,
  type ObjectiveDraft,
} from "./objectives-model.js";

/** The moves a search offers at once. */
const PICKS_SHOWN = 6;

/** What can't be sent, in plain words: below the fold on a phone, so each time it is said it is scrolled to. */
function Errors({ errors }: { errors: string[] }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (errors.length) ref.current?.scrollIntoView?.({ block: "nearest" });
  }, [errors]);
  if (!errors.length) return null;
  return (
    <div ref={ref} className="stu-build-error obj-sheet-errors" role="alert">
      {errors.map((e) => (
        <p key={e}>{e}</p>
      ))}
    </div>
  );
}

type View = { kind: "objective" } | { kind: "kr"; index: number | null; draft: KrDraft; errors: string[] };

export function ObjectiveSheet({
  initial,
  editing,
  units,
  onSave,
  onClose,
}: {
  initial: ObjectiveDraft;
  editing: boolean;
  units: BoardUnits;
  /** Sends it; answers what went wrong, in plain words, or null when it was saved. */
  onSave: (draft: ObjectiveDraft, body: Exclude<ReturnType<typeof objectiveInputOf>, { errors: string[] }>["body"]) => Promise<string[] | null>;
  onClose: () => void;
}) {
  const [draft, setDraft] = useState(initial);
  const [view, setView] = useState<View>({ kind: "objective" });
  const [errors, setErrors] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const titleId = useId();
  const whyId = useId();
  const addRef = useRef<HTMLButtonElement>(null);
  const backTo = useRef<"add" | null>(null);

  useEffect(() => {
    if (view.kind === "objective" && backTo.current === "add") {
      backTo.current = null;
      addRef.current?.focus();
    }
  }, [view.kind]);

  const save = async () => {
    if (busy) return;
    const r = objectiveInputOf(draft, units);
    if ("errors" in r) {
      setErrors(r.errors);
      return;
    }
    setBusy(true);
    setErrors([]);
    const why = await onSave(draft, r.body);
    setBusy(false);
    if (why) setErrors(why);
  };

  const toggleGoal = (g: string) =>
    setDraft((d) => ({ ...d, goalIds: d.goalIds.includes(g) ? d.goalIds.filter((x) => x !== g) : [...d.goalIds, g] }));

  if (view.kind === "kr") {
    const done = () => {
      const r = krInputOf(view.draft, units);
      if ("errors" in r) {
        setView({ ...view, errors: r.errors });
        return;
      }
      setDraft((d) => ({
        ...d,
        krs: view.index === null ? [...d.krs, view.draft] : d.krs.map((k, i) => (i === view.index ? view.draft : k)),
      }));
      setErrors([]);
      backTo.current = "add";
      setView({ kind: "objective" });
    };
    const back = () => {
      backTo.current = "add";
      setView({ kind: "objective" });
    };
    return (
      <Sheet
        open
        onClose={back}
        title="Key result"
        footer={
          <div className="btn-row stu-sched-actions">
            <button type="button" className="btn" onClick={back}>
              Back
            </button>
            <button type="button" className="btn btn-primary" onClick={done}>
              Done
            </button>
          </div>
        }
      >
        <KeyResultForm draft={view.draft} units={units} errors={view.errors} onChange={(next) => setView({ ...view, draft: next })} />
      </Sheet>
    );
  }

  return (
    <Sheet
      open
      onClose={onClose}
      title={editing ? "Edit objective" : "New objective"}
      footer={
        <div className="btn-row stu-sched-actions">
          <button type="button" className="btn btn-primary" disabled={busy} onClick={() => void save()}>
            {busy ? "Saving…" : "Save"}
          </button>
        </div>
      }
    >
      <div className="obj-sheet">
        <label className="stu-field-row stu-field-row--wide" htmlFor={titleId}>
          <span>Title</span>
          <input
            id={titleId}
            className="stu-field"
            value={draft.title}
            maxLength={120}
            autoComplete="off"
            onChange={(e) => setDraft({ ...draft, title: e.target.value })}
          />
        </label>
        <label className="stu-field-row stu-field-row--wide" htmlFor={whyId}>
          <span>Why</span>
          <textarea id={whyId} className="stu-field" rows={2} maxLength={500} value={draft.why} onChange={(e) => setDraft({ ...draft, why: e.target.value })} />
        </label>
        <section className="obj-sheet-sec">
          <h3 className="eyebrow">Goals</h3>
          <div className="stu-chipset">
            {GOAL_IDS.map((g) => (
              <button key={g} type="button" className="chipbtn stu-toggle" aria-pressed={draft.goalIds.includes(g)} onClick={() => toggleGoal(g)}>
                {label(g)}
              </button>
            ))}
          </div>
        </section>
        <section className="obj-sheet-sec">
          <h3 className="eyebrow">Key results</h3>
          {draft.krs.length ? (
            <ul className="obj-sheet-krs">
              {draft.krs.map((k, i) => {
                const m = measureOf(k, units);
                const name = k.label.trim() || "A key result";
                return (
                  <li key={k.id ?? `new-${i}`} className="obj-sheet-kr">
                    <span className="obj-sheet-kr-name">{name}</span>
                    <span className="obj-sheet-kr-what">{"measure" in m ? measureWords(m.measure, units) : ""}</span>
                    <span className="obj-sheet-kr-acts">
                      <button
                        type="button"
                        className="btn btn-small"
                        aria-label={`Edit ${name}`}
                        onClick={() => setView({ kind: "kr", index: i, draft: k, errors: [] })}
                      >
                        Edit
                      </button>
                      <button
                        type="button"
                        className="btn btn-small"
                        aria-label={`Remove ${name}`}
                        onClick={() => setDraft({ ...draft, krs: draft.krs.filter((_, j) => j !== i) })}
                      >
                        Remove
                      </button>
                    </span>
                  </li>
                );
              })}
            </ul>
          ) : null}
          <button
            ref={addRef}
            type="button"
            className="btn obj-sheet-add"
            disabled={draft.krs.length >= MAX_KEY_RESULTS}
            onClick={() => setView({ kind: "kr", index: null, draft: emptyKr(), errors: [] })}
          >
            <IconPlus size={16} />
            Add a key result
          </button>
        </section>
        <Errors errors={errors} />
      </div>
    </Sheet>
  );
}

/** One key result's fields. */
function KeyResultForm({ draft, units, errors, onChange }: { draft: KrDraft; units: BoardUnits; errors: string[]; onChange: (d: KrDraft) => void }) {
  const ids = {
    name: useId(),
    kind: useId(),
    metric: useId(),
    reps: useId(),
    load: useId(),
    distance: useId(),
    hrLow: useId(),
    hrHigh: useId(),
    window: useId(),
    target: useId(),
    baseline: useId(),
    due: useId(),
  };
  const nameRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    nameRef.current?.focus({ preventScroll: true });
  }, []);
  const set = (patch: Partial<KrDraft>) => onChange({ ...draft, ...patch });
  const measure = draftMeasure(draft, units);
  const unit = draftUnit(draft, measure, units);
  const hint = unitHint(unit, measure);
  const kind = draft.kind;
  const withHint = (word: string) => (hint ? `${word} (${hint})` : word);
  const windows = WINDOW_CHOICES.includes(draft.windowDays as (typeof WINDOW_CHOICES)[number]) ? [...WINDOW_CHOICES] : [...WINDOW_CHOICES, draft.windowDays].sort((a, b) => a - b);

  const choose = (k: string) => {
    if (k === "kept" || k === "") {
      set({ kind: k as KrDraft["kind"] });
      return;
    }
    const next = k as MeasureKind;
    const before = draftMeasure(draft, units);
    const after = draftMeasure({ ...draft, kind: next }, units);
    // A measure of another kind of number: what was typed for the old one means nothing now.
    const sameUnit = before !== null && after !== null && draftUnit(draft, before, units) === draftUnit({ ...draft, kind: next }, after, units);
    set({ kind: next, windowDays: defaultWindow(next), ...(sameUnit ? {} : { target: "", baseline: "" }) });
  };

  return (
    <div className="obj-sheet">
      <label className="stu-field-row stu-field-row--wide" htmlFor={ids.name}>
        <span>Name</span>
        <input ref={nameRef} id={ids.name} className="stu-field" value={draft.label} maxLength={120} autoComplete="off" onChange={(e) => set({ label: e.target.value })} />
      </label>
      <label className="stu-field-row stu-field-row--wide" htmlFor={ids.kind}>
        <span>Measure</span>
        <select id={ids.kind} className="stu-select" value={kind} onChange={(e) => choose(e.target.value)}>
          <option value="">Choose…</option>
          {MEASURE_KINDS.map((k) => (
            <option key={k} value={k}>
              {MEASURE_LABELS[k]}
            </option>
          ))}
          {draft.kept ? <option value="kept">{`${measureWords(draft.kept.measure, units)} (kept as it is)`}</option> : null}
        </select>
      </label>
      {kind === "hold_max" || kind === "best_set" ? <MovesField moves={draft.moves} onChange={(moves) => set({ moves })} /> : null}
      {kind === "best_set" ? (
        <div className="obj-sheet-row">
          <label className="stu-field-row" htmlFor={ids.metric}>
            <span>Which best</span>
            <select id={ids.metric} className="stu-select" value={draft.metric} onChange={(e) => set({ metric: e.target.value as Metric })}>
              {(Object.keys(METRIC_LABELS) as Metric[]).map((m) => (
                <option key={m} value={m}>
                  {METRIC_LABELS[m]}
                </option>
              ))}
            </select>
          </label>
          {draft.metric === "load_at_reps" ? (
            <label className="stu-field-row" htmlFor={ids.reps}>
              <span>Reps</span>
              <input id={ids.reps} className="stu-field" inputMode="numeric" value={draft.reps} onChange={(e) => set({ reps: e.target.value })} />
            </label>
          ) : null}
          {draft.metric === "reps_at_load" ? (
            <label className="stu-field-row" htmlFor={ids.load}>
              <span>{`Load (${units.weightUnit})`}</span>
              <input id={ids.load} className="stu-field" inputMode="decimal" value={draft.load} onChange={(e) => set({ load: e.target.value })} />
            </label>
          ) : null}
        </div>
      ) : null}
      {kind === "run_best" || kind === "predicted_time" ? (
        <label className="stu-field-row" htmlFor={ids.distance}>
          <span>{`Distance (${units.units})`}</span>
          <input id={ids.distance} className="stu-field" inputMode="decimal" value={draft.distance} onChange={(e) => set({ distance: e.target.value })} />
        </label>
      ) : null}
      {kind === "pace_at_hr" ? (
        <div className="obj-sheet-row">
          <label className="stu-field-row" htmlFor={ids.hrLow}>
            <span>Heart rate from</span>
            <input id={ids.hrLow} className="stu-field" inputMode="numeric" value={draft.hrLow} onChange={(e) => set({ hrLow: e.target.value })} />
          </label>
          <label className="stu-field-row" htmlFor={ids.hrHigh}>
            <span>to</span>
            <input id={ids.hrHigh} className="stu-field" inputMode="numeric" value={draft.hrHigh} onChange={(e) => set({ hrHigh: e.target.value })} />
          </label>
        </div>
      ) : null}
      {kind !== "" && kind !== "kept" ? (
        <label className="stu-field-row" htmlFor={ids.window}>
          <span>Over the last</span>
          <select id={ids.window} className="stu-select" value={draft.windowDays} onChange={(e) => set({ windowDays: Number(e.target.value) })}>
            {windows.map((w) => (
              <option key={w} value={w}>
                {`${w} days`}
              </option>
            ))}
          </select>
        </label>
      ) : null}
      <div className="obj-sheet-row">
        <label className="stu-field-row" htmlFor={ids.target}>
          <span>{withHint("Target")}</span>
          <input id={ids.target} className="stu-field" inputMode="decimal" autoComplete="off" value={draft.target} onChange={(e) => set({ target: e.target.value })} />
        </label>
        <label className="stu-field-row" htmlFor={ids.baseline}>
          <span>{withHint("Start")}</span>
          <input id={ids.baseline} className="stu-field" inputMode="decimal" autoComplete="off" value={draft.baseline} onChange={(e) => set({ baseline: e.target.value })} />
        </label>
      </div>
      <label className="stu-field-row" htmlFor={ids.due}>
        <span>By (optional)</span>
        <input id={ids.due} type="date" className="stu-field" value={draft.dueDate} onChange={(e) => set({ dueDate: e.target.value })} />
      </label>
      <Errors errors={errors} />
    </div>
  );
}

/** The moves a hold or a set is read from: each chosen one a removable chip, more found by name. */
function MovesField({ moves, onChange }: { moves: string[]; onChange: (moves: string[]) => void }) {
  const [q, setQ] = useState("");
  const found = useMemo(
    () => (q.trim() ? searchLibrary(EXERCISES, q).filter((r) => !moves.includes(r.id)).slice(0, PICKS_SHOWN) : []),
    [q, moves],
  );
  return (
    <div className="stu-field-row stu-field-row--wide obj-moves">
      <span>Moves</span>
      {moves.length ? (
        <div className="stu-chipset">
          {moves.map((id) => (
            <button key={id} type="button" className="chip stu-chip-x" aria-label={`Remove ${moveName(id)}`} onClick={() => onChange(moves.filter((m) => m !== id))}>
              {moveName(id)}
              <IconClose />
            </button>
          ))}
        </div>
      ) : null}
      {moves.length < 10 ? <SearchField value={q} onChange={setQ} label="Find a move" placeholder="Find a move" /> : null}
      {found.length ? (
        <ul className="stu-pick-list obj-picks">
          {found.map((r) => (
            <li key={r.id}>
              <button
                type="button"
                className="stu-pick obj-pick"
                onClick={() => {
                  onChange([...moves, r.id]);
                  setQ("");
                }}
              >
                <span className="stu-pick-name">{r.name}</span>
              </button>
            </li>
          ))}
        </ul>
      ) : q.trim() ? (
        <p className="muted">No moves match.</p>
      ) : null}
    </div>
  );
}
