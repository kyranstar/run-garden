/**
 * ONE MOVE IN THE LIST (Stage 2 spec §5) — four short lines, so 150 moves stay a list you can read down:
 *
 *   Goblet squat                                [＋]
 *   Squat holding one weight at your chest.
 *   Strength · Isotonic · Quads, Glute max · Kettlebell or Dumbbells
 *   2 × 7 · Last done 6 days ago · ✓ Fits today
 *
 * Line 3's purpose, contraction and muscles are terms: each a button that explains itself in one sentence from the
 * library's `GLOSSARY`, so the coach and the Studio explain a word alike. Line 4 is the dose Add puts in, the athlete's
 * history with the move, and today's fit — a colour that always sits beside its word, and whose reason is one tap down.
 *
 * Add and the detail (Task 5) are callbacks: a row draws them only when there is something for them to do, never
 * dead.
 */
import { Fragment, memo, type ReactNode } from "react";
import { EQUIPMENT, GLOSSARY, label, type ExerciseRecord, type Purpose } from "@rg/exercise-library";
import { Tooltip } from "../../components/tooltip.js";
import { IconAlert, IconCheck, IconClose, IconPlus } from "../../icons.js";
import { doseLine, historyLine, type Fit, type FitState, type MovePrefs } from "./model.js";

/** How many primary muscles a row names; the detail names them all. */
const MUSCLES_SHOWN = 2;

const FIT_ICON: Readonly<Record<FitState, ReactNode>> = {
  fits: <IconCheck />,
  care: <IconAlert />,
  not: <IconClose />,
};

/** Today's fit: icon, colour and word together, the reason one tap down. */
export function FitBadge({ fit }: { fit: Fit }) {
  return (
    <Tooltip term={fit.word} tip={fit.reason} className={`stu-fit stu-fit--${fit.state}`}>
      {FIT_ICON[fit.state]}
      {fit.word}
    </Tooltip>
  );
}

/** A vocabulary word, explained when the glossary has a sentence for it. */
function Term({ id }: { id: string }) {
  const tip = GLOSSARY[id];
  return tip ? <Tooltip term={label(id)} tip={tip} /> : <span>{label(id)}</span>;
}

const Sep = () => (
  <span className="stu-sep" aria-hidden="true">
    ·
  </span>
);

/** Items joined by a middle dot, empty ones dropped. */
function dotted(items: ReadonlyArray<ReactNode | null>): ReactNode[] {
  const kept = items.filter((x): x is ReactNode => x !== null && x !== false);
  return kept.map((x, i) => (
    <Fragment key={i}>
      {i > 0 ? <Sep /> : null}
      {x}
    </Fragment>
  ));
}

/** "Bench + Kettlebell or Dumbbells"; null for a move that needs nothing. */
export function gearLine(rec: ExerciseRecord): string | null {
  const parts = [...rec.equipment.all.map((g) => EQUIPMENT[g])];
  if (rec.equipment.oneOf.length) parts.push(rec.equipment.oneOf.map((g) => EQUIPMENT[g]).join(" or "));
  return parts.length ? parts.join(" + ") : null;
}

export const MoveRow = memo(function MoveRow({
  rec,
  fit,
  prefs,
  today,
  purpose: shownPurpose,
  onAdd,
  onOpen,
}: {
  rec: ExerciseRecord;
  /** Today's condition fit; null with no profile on. */
  fit: Fit | null;
  /** The athlete's say and history; null offline or before they load. */
  prefs: MovePrefs | null | undefined;
  /** The athlete's today, for "last done". */
  today: string;
  /** The part the list was browsed by: named instead of the move's first purpose when the move serves it. */
  purpose?: Purpose;
  onAdd?: (rec: ExerciseRecord) => void;
  onOpen?: (rec: ExerciseRecord) => void;
}) {
  const purpose = shownPurpose && rec.purposes.includes(shownPurpose) ? shownPurpose : rec.purposes[0];
  const muscles = rec.muscles.primary.slice(0, MUSCLES_SHOWN);
  const gear = gearLine(rec);
  return (
    <li className="stu-move">
      <h3 className="stu-move-name">
        {onOpen ? (
          <button type="button" className="stu-move-open" onClick={() => onOpen(rec)}>
            {rec.name}
          </button>
        ) : (
          rec.name
        )}
      </h3>
      {onAdd ? (
        <button type="button" className="btn btn-small stu-move-add" aria-label={`Add ${rec.name}`} onClick={() => onAdd(rec)}>
          <IconPlus />
        </button>
      ) : null}
      <p className="stu-move-sum">{rec.text.summary}</p>
      <p className="stu-meta">
        {dotted([
          purpose ? <Term id={purpose} /> : null,
          rec.contraction.length ? (
            <span className="stu-meta-g">
              {rec.contraction.map((c, i) => (
                <Fragment key={c}>
                  {i > 0 ? ", " : null}
                  <Term id={c} />
                </Fragment>
              ))}
            </span>
          ) : null,
          muscles.length ? (
            <span className="stu-meta-g">
              {muscles.map((m, i) => (
                <Fragment key={m}>
                  {i > 0 ? ", " : null}
                  <Term id={m} />
                </Fragment>
              ))}
            </span>
          ) : null,
          gear ? <span>{gear}</span> : null,
        ])}
      </p>
      <p className="stu-meta stu-meta--dose">
        {dotted([
          <span key="dose">{doseLine(rec)}</span>,
          ...historyLine(prefs, today).map((h) => <span key={h}>{h}</span>),
          fit ? <FitBadge fit={fit} /> : null,
        ])}
      </p>
    </li>
  );
});
