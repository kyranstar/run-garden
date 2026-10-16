/**
 * GOALS AND FOCUS (Stage 2 spec §8; principles §3.1): what the workout serves, and where its suggestions look. Each toggle
 * is one editor action; one the document can't take (a seventh goal, a thirteenth area) says why.
 */
import { useState } from "react";
import { GOAL_IDS, GOAL_LABELS, type WorkoutDoc } from "@rg/domain";
import { label, REGIONS } from "@rg/exercise-library";
import type { EditAction, Rejection } from "@rg/workout";
import { Sheet } from "../../components.js";
import { editRefusal } from "./build-model.js";

export function GoalsSheet({ doc, onEdit, onClose }: { doc: WorkoutDoc; onEdit: (a: EditAction) => Rejection | undefined; onClose: () => void }) {
  const [error, setError] = useState<string | null>(null);
  const toggle = (list: readonly string[], id: string): string[] => (list.includes(id) ? list.filter((x) => x !== id) : [...list, id]);
  const run = (a: EditAction) => {
    const r = onEdit(a);
    setError(r ? editRefusal(a, r, doc) : null);
  };
  return (
    <Sheet open onClose={onClose} title="Goals and focus">
      <div className="stu-item-body">
        <section className="stu-item-sec">
          <h3 className="eyebrow">Goals</h3>
          <div className="stu-chipset">
            {GOAL_IDS.map((g) => (
              <button
                key={g}
                type="button"
                className="chipbtn stu-toggle"
                aria-pressed={doc.intent.goals.includes(g)}
                onClick={() => run({ type: "setIntent", intent: { goals: toggle(doc.intent.goals, g) as WorkoutDoc["intent"]["goals"] } })}
              >
                {GOAL_LABELS[g]}
              </button>
            ))}
          </div>
        </section>
        <section className="stu-item-sec">
          <h3 className="eyebrow">Focus areas</h3>
          <div className="stu-chipset">
            {REGIONS.filter((r) => r !== "full-body").map((r) => (
              <button
                key={r}
                type="button"
                className="chipbtn stu-toggle"
                aria-pressed={doc.intent.focus.includes(r)}
                onClick={() => run({ type: "setIntent", intent: { focus: toggle(doc.intent.focus, r) } })}
              >
                {label(r)}
              </button>
            ))}
          </div>
        </section>
        {error ? (
          <p className="stu-build-error" role="alert">
            {error}
          </p>
        ) : null}
      </div>
    </Sheet>
  );
}
