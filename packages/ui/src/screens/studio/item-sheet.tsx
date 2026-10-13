/**
 * ONE MOVE IN THE WORKOUT (Stage 2 spec §8: "tap opens an item sheet — dose, cue, swap, move up / down, remove").
 *
 *   Romanian deadlift                                         ✕
 *   Wakes the glutes before Deadlift.            ← the item's why, when it has one
 *   ⚠ … [Swap in …]                              ← its notes, each with its Fix
 *   DOSE   Sets [−] 3 [+]   Reps [−] 8 [+]   Load [25 lb]   [Each side]
 *   CUE    [Something to remember          ]
 *   [Swap ›]  →  Planned alternates · Easier · Harder · Same purpose
 *   [↑ Up] [↓ Down]
 *   ─────────────────────────────────────────────────────────
 *   [Remove]                                          [Done]
 *
 * Every change is one editor action, made at once: a − or + is one step, a typed number or the cue lands on Enter or
 * when the field is left (never per keystroke, so a field cleared mid-typing is never sent). The load is typed as the
 * athlete says it, in their unit unless they name one ("25", "12 kg"), and kept as typed beside its kilograms. An edit
 * the editor refuses says why — an item already outside the rules ("Fix this item first.") changes only through Swap.
 * Up and Down move one place, across into the next part at a part's edge, so a move goes anywhere by buttons alone.
 *
 * Focus stays in the sheet: a Fix whose note goes with it hands focus to the sheet's first control, and a move that
 * reaches the end (its button now off) hands it to the other one.
 */
import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import type { WeightUnit, WorkoutDoc, WorkoutItem } from "@rg/domain";
import type { ExerciseRecord } from "@rg/exercise-library";
import type { EditAction, Rejection } from "@rg/workout";
import { Sheet } from "../../components.js";
import { IconArrowDown, IconArrowUp, IconCheck } from "../../icons.js";
import {
  amountKind,
  amountValue,
  editRefusal,
  loadFrom,
  moveTarget,
  sentence,
  stepAmount,
  stepSets,
  swapOptions,
  typedAmount,
  type AmountKind,
  type BuildCtx,
  type Note,
} from "./build-model.js";
import { fitOf, FIT_WORD, type StudioCtx } from "./model.js";
import { NoteRow } from "./summary-card.js";

/** − value + with a typed field between: a step lands at once, a typed value on Enter or when the field is left. */
export function NumberStepper({
  label,
  value,
  onStep,
  onType,
  canLess = true,
  canMore = true,
  lessLabel,
  moreLabel,
  inputMode = "numeric",
}: {
  label: string;
  value: string;
  onStep: (dir: 1 | -1) => void;
  /** A typed value; false puts the field back as it was. */
  onType: (text: string) => boolean;
  canLess?: boolean;
  canMore?: boolean;
  lessLabel: string;
  moreLabel: string;
  /** "text" where a value is more than digits: a rep range ("8-12"), a hold in minutes ("2m"). */
  inputMode?: "numeric" | "text";
}) {
  const id = useId();
  const [text, setText] = useState(value);
  const [typing, setTyping] = useState(false);
  useEffect(() => {
    if (!typing) setText(value);
  }, [value, typing]);
  const commit = () => {
    setTyping(false);
    if (text.trim() === value.trim() || !onType(text)) setText(value);
  };
  return (
    <div className="stu-stepper">
      <label htmlFor={id}>{label}</label>
      <button type="button" className="stu-step" aria-label={lessLabel} disabled={!canLess} onClick={() => onStep(-1)}>
        −
      </button>
      <input
        id={id}
        inputMode={inputMode}
        autoComplete="off"
        value={text}
        onFocus={() => setTyping(true)}
        onChange={(e) => setText(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === "Enter") (e.target as HTMLInputElement).blur();
        }}
      />
      <button type="button" className="stu-step" aria-label={moreLabel} disabled={!canMore} onClick={() => onStep(1)}>
        +
      </button>
    </div>
  );
}

/** A text field that lands on Enter or when it is left. */
export function CommitField({
  label,
  value,
  placeholder,
  onCommit,
  multiline = false,
  className,
  maxLength,
  readOnly = false,
}: {
  label: string;
  value: string;
  placeholder?: string;
  onCommit: (text: string) => void;
  multiline?: boolean;
  className?: string;
  maxLength?: number;
  /** Shown, not changed (a planned workout that can't change). */
  readOnly?: boolean;
}) {
  const [text, setText] = useState(value);
  const [typing, setTyping] = useState(false);
  useEffect(() => {
    if (!typing) setText(value);
  }, [value, typing]);
  const props = {
    "aria-label": label,
    className,
    value: text,
    placeholder,
    maxLength,
    readOnly,
    onFocus: () => setTyping(true),
    onChange: (e: { target: { value: string } }) => setText(e.target.value),
    onBlur: () => {
      setTyping(false);
      if (!readOnly && text !== value) onCommit(text);
    },
  };
  return multiline ? (
    <textarea {...props} rows={2} />
  ) : (
    <input
      {...props}
      autoComplete="off"
      onKeyDown={(e) => {
        if (e.key === "Enter") (e.target as HTMLInputElement).blur();
      }}
    />
  );
}

const AMOUNT_LABEL: Readonly<Record<AmountKind, string>> = { reps: "Reps", hold: "Seconds", breaths: "Breaths", distance: "Metres" };

/** A move's name as the builder shows it, library or not. */
export function itemName(item: WorkoutItem, rec: ExerciseRecord | undefined): string {
  if (item.kind === "exercise") return rec?.name ?? item.libraryId;
  if (item.kind === "free_exercise") return item.name;
  if (item.kind === "run") return "Run";
  return "Rest";
}

function SwapList({ title, recs, ctx, onPick }: { title: string; recs: readonly ExerciseRecord[]; ctx: StudioCtx; onPick: (rec: ExerciseRecord) => void }) {
  if (recs.length === 0) return null;
  return (
    <div className="stu-swap-group">
      <h4 className="eyebrow">{title}</h4>
      <ul className="stu-swap-list">
        {recs.map((r) => {
          const fit = fitOf(r, ctx);
          return (
            <li key={r.id}>
              <button type="button" className="stu-swap" onClick={() => onPick(r)}>
                <span className="stu-swap-name">{r.name}</span>
                {fit && fit.state !== "fits" ? <span className={`stu-swap-fit stu-fit--${fit.state}`}>{FIT_WORD[fit.state]}</span> : null}
              </button>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

export interface ItemSheetProps {
  doc: WorkoutDoc;
  part: number;
  item: number;
  rec: ExerciseRecord | undefined;
  /** The notes about this item. */
  notes: readonly Note[];
  unit: WeightUnit;
  bc: BuildCtx;
  ctx: StudioCtx;
  library: readonly ExerciseRecord[];
  /** One editor action; why it was refused, if it was. */
  onEdit: (action: EditAction) => Rejection | undefined;
  /** Moved: where the item now is. */
  onMoved: (to: [number, number]) => void;
  onRemove: () => void;
  onFix: (note: Note) => void;
  onCheck: (profileId: string) => void;
  checkLabel: (profileId: string) => string;
  onClose: () => void;
}

export function ItemSheet({ doc, part, item, rec, notes, unit, bc, ctx, library, onEdit, onMoved, onRemove, onFix, onCheck, checkLabel, onClose }: ItemSheetProps) {
  const it = doc.parts[part]?.items[item];
  const [error, setError] = useState<string | null>(null);
  const [swapping, setSwapping] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const swapId = useId();
  const body = useRef<HTMLDivElement>(null);
  const upBtn = useRef<HTMLButtonElement>(null);
  const downBtn = useRef<HTMLButtonElement>(null);
  /** Where focus goes once this render lands: the sheet's first control (after a Fix), or the other move button. */
  const refocus = useRef<"first" | "up" | "down" | null>(null);
  useEffect(() => {
    const want = refocus.current;
    if (!want) return;
    refocus.current = null;
    if (want === "first") {
      body.current?.querySelector<HTMLElement>("button:not(:disabled), input:not(:disabled), textarea")?.focus();
      return;
    }
    // The button pressed is off now (the move reached the end): the other one keeps focus in the sheet.
    const pressed = want === "up" ? upBtn.current : downBtn.current;
    if (pressed?.disabled) (want === "up" ? downBtn.current : upBtn.current)?.focus();
  });
  if (!it) return null;
  const run = (action: EditAction): boolean => {
    const r = onEdit(action);
    setError(r && r !== "unchanged" ? editRefusal(action, r, doc) : null);
    return !r;
  };
  const fix = (n: Note) => {
    onFix(n);
    refocus.current = "first";
  };
  const name = itemName(it, rec);
  const dosed = it.kind === "exercise" || it.kind === "free_exercise";
  const dose = dosed ? it.dose : null;
  const kind = dose ? amountKind(dose, rec) : null;
  const setDose = (d: NonNullable<typeof dose>) => run({ type: "setDose", part, item, dose: d });
  const up = moveTarget(doc, part, item, -1);
  const down = moveTarget(doc, part, item, 1);
  const move = (t: ReturnType<typeof moveTarget>, dir: "up" | "down") => {
    if (t && run({ type: "moveItem", from: t.from, to: t.to })) {
      onMoved(t.to);
      refocus.current = dir;
    }
  };
  const loaded = !!dose && (rec?.load === "external" || (dose.load !== undefined && dose.load !== "bodyweight"));
  const sided = !!dose && (rec ? rec.laterality !== "bilateral" : dose.perSide === true);
  const options = it.kind === "exercise" && rec ? swapOptions(it, rec, doc, library, bc) : null;
  const swap = (r: ExerciseRecord) => {
    if (run({ type: "swapItem", part, item, libraryId: r.id })) setSwapping(false);
  };
  const section = (title: string, body: ReactNode) => (
    <section className="stu-item-sec">
      <h3 className="eyebrow">{title}</h3>
      {body}
    </section>
  );

  return (
    <Sheet
      open
      onClose={onClose}
      title={name}
      footer={
        <div className="btn-row stu-item-actions">
          <button type="button" className="btn btn-danger" onClick={onRemove}>
            Remove
          </button>
          <button type="button" className="btn btn-primary" onClick={onClose}>
            Done
          </button>
        </div>
      }
    >
      <div ref={body} className="stu-item-body">
        {it.kind !== "rest" && it.why ? <p className="stu-item-why">{sentence(it.why)}</p> : null}
        {notes.length ? (
          <ul className="stu-notes">
            {notes.map((n, i) => (
              <NoteRow key={`${n.code}-${i}`} note={n} onFix={fix} onCheck={onCheck} checkLabel={checkLabel} />
            ))}
          </ul>
        ) : null}
        {error ? (
          <p className="stu-build-error" role="alert">
            {error}
          </p>
        ) : null}

        {dose && kind
          ? section(
              "Dose",
              <div className="stu-dose">
                <NumberStepper
                  label="Sets"
                  value={String(dose.sets ?? 1)}
                  canLess={(dose.sets ?? 1) > 1}
                  canMore={(dose.sets ?? 1) < 20}
                  lessLabel="One set fewer"
                  moreLabel="One set more"
                  onStep={(dir) => setDose(stepSets(dose, dir))}
                  onType={(t) => {
                    const n = Number(t.trim());
                    return Number.isInteger(n) && n >= 1 && n <= 20 ? setDose({ ...dose, sets: n }) : false;
                  }}
                />
                <NumberStepper
                  label={AMOUNT_LABEL[kind]}
                  value={amountValue(dose, kind)}
                  inputMode={kind === "breaths" ? "numeric" : "text"}
                  lessLabel={`Less: ${AMOUNT_LABEL[kind].toLowerCase()}`}
                  moreLabel={`More: ${AMOUNT_LABEL[kind].toLowerCase()}`}
                  onStep={(dir) => setDose(stepAmount(dose, kind, dir))}
                  onType={(t) => {
                    const next = typedAmount(dose, kind, t);
                    return next ? setDose(next) : false;
                  }}
                />
                {loaded ? (
                  <label className="stu-load">
                    <span>Load</span>
                    <CommitField
                      label="Load"
                      className="stu-load-input"
                      value={dose.load && dose.load !== "bodyweight" ? dose.load.typed : ""}
                      placeholder={unit}
                      maxLength={20}
                      onCommit={(text) => {
                        const load = loadFrom(text, unit);
                        if (load === "invalid") {
                          setLoadError(`Type a weight, like 25 or 12 ${unit === "lb" ? "kg" : "lb"}.`);
                          return;
                        }
                        setLoadError(null);
                        const { load: _old, ...rest } = dose;
                        setDose(load ? { ...rest, load } : rest);
                      }}
                    />
                  </label>
                ) : null}
                {loadError ? (
                  <p className="stu-build-error" role="alert">
                    {loadError}
                  </p>
                ) : null}
                {kind === "hold" ? (
                  // A hold to max (CUJ R17): the hold is a floor to go past, its best kept as a result.
                  <button
                    type="button"
                    className="chipbtn stu-sides"
                    aria-pressed={dose.max === true}
                    onClick={() => {
                      const { max: _m, ...rest } = dose;
                      setDose(dose.max ? rest : { ...rest, max: true });
                    }}
                  >
                    {dose.max ? <IconCheck /> : null}
                    To max
                  </button>
                ) : null}
                {sided ? (
                  <button
                    type="button"
                    className="chipbtn stu-sides"
                    aria-pressed={dose.perSide === true}
                    onClick={() => {
                      const { perSide: _p, ...rest } = dose;
                      setDose(dose.perSide ? rest : { ...rest, perSide: true });
                    }}
                  >
                    {dose.perSide ? <IconCheck /> : null}
                    Each side
                  </button>
                ) : null}
              </div>,
            )
          : null}

        {it.kind !== "rest"
          ? section(
              "Cue",
              <CommitField
                label="Cue"
                className="stu-field"
                value={it.cue ?? ""}
                placeholder="Something to remember"
                maxLength={160}
                onCommit={(text) => run({ type: "setCue", part, item, cue: text.trim() ? text : undefined })}
              />,
            )
          : null}

        {options ? (
          <section className="stu-item-sec">
            <button type="button" className="btn stu-swap-toggle" aria-expanded={swapping} aria-controls={swapId} onClick={() => setSwapping((v) => !v)}>
              Swap
            </button>
            <div id={swapId} className="stu-swaps" hidden={!swapping}>
              <SwapList title="Planned alternates" recs={options.alternates} ctx={ctx} onPick={swap} />
              <SwapList title="Easier" recs={options.easier} ctx={ctx} onPick={swap} />
              <SwapList title="Harder" recs={options.harder} ctx={ctx} onPick={swap} />
              <SwapList title="Same purpose" recs={options.same} ctx={ctx} onPick={swap} />
            </div>
          </section>
        ) : null}

        <div className="btn-row stu-move-btns">
          <button ref={upBtn} type="button" className="btn" disabled={!up} onClick={() => move(up, "up")}>
            <IconArrowUp size={16} />
            Move up
          </button>
          <button ref={downBtn} type="button" className="btn" disabled={!down} onClick={() => move(down, "down")}>
            <IconArrowDown size={16} />
            Move down
          </button>
        </div>
      </div>
    </Sheet>
  );
}
