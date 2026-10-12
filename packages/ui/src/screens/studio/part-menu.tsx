/**
 * A PART'S MENU (Stage 2 spec §8: "the header menu sets purpose, format, rounds, rest, and the part's one-line why").
 *
 *   Warm-up                                                   ✕
 *   Purpose   [Warm-up ▾]
 *   Format    [Straight ▾]        Rounds [−] 3 [+]     Rest between rounds [−] 60 [+]
 *   Why       [Open the hips before the hinge          ]
 *   [↑ Move up] [↓ Move down]
 *   ─────────────────────────────────────────────────────────
 *   [Remove part]                                     [Done]
 *
 * Each change is one editor action, made at once (the why when the field is left). Rounds belong to a format that
 * goes round (anything but straight sets), rest between rounds to more than one. A run's formats (intervals, steady)
 * are offered only to a part already in one: a run is not planned in the Studio yet. Removing a part is one action
 * and Undo brings it back.
 */
import { useId, useState } from "react";
import { PART_FORMATS, PART_PURPOSES, type WorkoutPart } from "@rg/domain";
import { label } from "@rg/exercise-library";
import type { EditAction, Rejection } from "@rg/workout";
import { Sheet } from "../../components.js";
import { IconArrowDown, IconArrowUp } from "../../icons.js";
import { rejectionText } from "./add-model.js";
import { CommitField, NumberStepper } from "./item-sheet.js";

type Format = WorkoutPart["format"];
type Purpose = WorkoutPart["purpose"];

/** The formats a part of exercises takes; a run's are offered only where they already are. */
const EXERCISE_FORMATS: readonly Format[] = ["straight", "superset", "circuit", "holds", "flow", "ladder"];
export const FORMAT_LABEL: Readonly<Record<Format, string>> = {
  straight: "Straight sets",
  superset: "Superset",
  circuit: "Circuit",
  holds: "Holds",
  flow: "Flow",
  ladder: "Ladder",
  intervals: "Intervals",
  steady: "Steady",
};
const MAX_ROUNDS = 50;
const MAX_REST = 900;
const REST_STEP = 15;

/** "Superset × 3", "Circuit", "" for straight sets: what a part's header says of its format. */
export function formatLine(part: WorkoutPart): string {
  if (part.format === "straight") return "";
  const rounds = part.rounds && part.rounds > 1 ? ` × ${part.rounds}` : "";
  return `${FORMAT_LABEL[part.format]}${rounds}`;
}

export function PartMenu({
  part,
  index,
  count,
  onEdit,
  onMoved,
  onRemove,
  onClose,
}: {
  part: WorkoutPart;
  index: number;
  /** How many parts the workout has. */
  count: number;
  onEdit: (action: EditAction) => Rejection | undefined;
  /** Moved: the part's new place. */
  onMoved: (to: number) => void;
  onRemove: () => void;
  onClose: () => void;
}) {
  const ids = useId();
  const [error, setError] = useState<string | null>(null);
  const run = (action: EditAction): boolean => {
    const r = onEdit(action);
    setError(r && r !== "unchanged" ? rejectionText(r) : null);
    return !r;
  };
  const patch = (p: Partial<Omit<WorkoutPart, "items">>) => run({ type: "setPart", part: index, patch: p });
  const purposes = PART_PURPOSES.filter((p) => p !== "run" || part.purpose === "run");
  const formats = PART_FORMATS.filter((f) => EXERCISE_FORMATS.includes(f) || f === part.format);
  const rounds = part.rounds ?? 1;
  const rest = part.restBetweenRoundsSec ?? 0;
  const move = (to: number) => {
    if (run({ type: "movePart", part: index, to })) onMoved(to);
  };
  return (
    <Sheet
      open
      onClose={onClose}
      title={label(part.purpose)}
      footer={
        <div className="btn-row stu-item-actions">
          <button type="button" className="btn btn-danger" onClick={onRemove}>
            Remove part
          </button>
          <button type="button" className="btn btn-primary" onClick={onClose}>
            Done
          </button>
        </div>
      }
    >
      <div className="stu-item-body">
        {error ? (
          <p className="stu-build-error" role="alert">
            {error}
          </p>
        ) : null}
        <div className="stu-part-fields">
          <label className="stu-field-row" htmlFor={`${ids}-p`}>
            <span>Purpose</span>
            <select id={`${ids}-p`} className="stu-select" value={part.purpose} onChange={(e) => patch({ purpose: e.target.value as Purpose })}>
              {purposes.map((p) => (
                <option key={p} value={p}>
                  {label(p)}
                </option>
              ))}
            </select>
          </label>
          <label className="stu-field-row" htmlFor={`${ids}-f`}>
            <span>Format</span>
            <select id={`${ids}-f`} className="stu-select" value={part.format} onChange={(e) => patch({ format: e.target.value as Format })}>
              {formats.map((f) => (
                <option key={f} value={f}>
                  {FORMAT_LABEL[f]}
                </option>
              ))}
            </select>
          </label>
          {part.format !== "straight" ? (
            <NumberStepper
              label="Rounds"
              value={String(rounds)}
              canLess={rounds > 1}
              canMore={rounds < MAX_ROUNDS}
              lessLabel="One round fewer"
              moreLabel="One round more"
              onStep={(dir) => patch({ rounds: Math.min(MAX_ROUNDS, Math.max(1, rounds + dir)) })}
              onType={(t) => {
                const n = Number(t.trim());
                return Number.isInteger(n) && n >= 1 && n <= MAX_ROUNDS ? patch({ rounds: n }) : false;
              }}
            />
          ) : null}
          {part.format !== "straight" && rounds > 1 ? (
            <NumberStepper
              label="Rest between rounds (s)"
              value={String(rest)}
              canLess={rest > 0}
              canMore={rest < MAX_REST}
              lessLabel="Less rest between rounds"
              moreLabel="More rest between rounds"
              onStep={(dir) => patch({ restBetweenRoundsSec: Math.min(MAX_REST, Math.max(0, rest + dir * REST_STEP)) })}
              onType={(t) => {
                const n = Number(t.trim());
                return Number.isInteger(n) && n >= 0 && n <= MAX_REST ? patch({ restBetweenRoundsSec: n }) : false;
              }}
            />
          ) : null}
          <label className="stu-field-row stu-field-row--wide">
            <span>Why</span>
            <CommitField
              label="Why"
              className="stu-field"
              multiline
              maxLength={160}
              value={part.why ?? ""}
              placeholder={`Why this ${label(part.purpose).toLowerCase()}`}
              onCommit={(text) => patch({ why: text.trim() ? text.trim() : undefined })}
            />
          </label>
        </div>
        <div className="btn-row stu-move-btns">
          <button type="button" className="btn" disabled={index === 0} onClick={() => move(index - 1)}>
            <IconArrowUp size={16} />
            Move up
          </button>
          <button type="button" className="btn" disabled={index >= count - 1} onClick={() => move(index + 1)}>
            <IconArrowDown size={16} />
            Move down
          </button>
        </div>
      </div>
    </Sheet>
  );
}
