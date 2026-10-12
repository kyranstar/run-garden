/**
 * THE BUILDER'S SUMMARY (Stage 2 spec §8; principles §2.4, §2.7–§2.8): one card, computed live from the draft —
 *
 *   34 min · Strength · Home                          1 to fix  ⌄
 *   ⚠ Half-kneeling press isn't allowed with today's …  [Swap in Floor press]
 *   ── (open) ──
 *   Holds          ▮▮▮▯▯  90 s
 *   Through range  ▮▮▮▮▮  40 reps
 *   …
 *   Works hips, glutes, upper back
 *   ⓘ You set Goblet squat aside as not for you.
 *
 * The line and the count are the toggle; the errors stay in view whatever it is set to, because they are what stops
 * Start — each with its Fix where the validator has one, or the check that could answer it. The balance, the areas
 * and the warnings (costs, never blocks) fold away. Every level has its number beside it, and every note its shape
 * (a triangle to fix, a circle for a cost) and a word for a screen reader: status is never colour alone. A workout
 * that can't change (done, under way, its day passed) still says what it would be judged by, but offers nothing to do:
 * no Fix, no check.
 */
import { useId } from "react";
import { GLOSSARY } from "@rg/exercise-library";
import { CATEGORY_LABELS } from "../../components.js";
import { Tooltip } from "../../components/tooltip.js";
import { IconAlert, IconChevron, IconInfo } from "../../icons.js";
import { areasWorked, BALANCE_LEVELS, balanceRows, type Judged, type Note } from "./build-model.js";

export function NoteRow({
  note,
  onFix,
  onCheck,
  checkLabel,
  readOnly = false,
}: {
  note: Note;
  onFix: (note: Note) => void;
  onCheck: (profileId: string) => void;
  /** The words of a profile's check ("Jaw check"). */
  checkLabel: (profileId: string) => string;
  /** The workout can't change: the note is said, with nothing to do about it here. */
  readOnly?: boolean;
}) {
  const error = note.severity === "error";
  return (
    <li className={`stu-note stu-note--${note.severity}`}>
      <span className="stu-note-icon">{error ? <IconAlert /> : <IconInfo />}</span>
      <span className="stu-note-text">
        <span className="visually-hidden">{error ? "To fix: " : "Note: "}</span>
        {note.message}
      </span>
      {!readOnly && (note.check || note.fix) ? (
        <span className="stu-note-actions">
          {note.check ? (
            <button type="button" className="btn btn-small" onClick={() => onCheck(note.check!)}>
              {checkLabel(note.check)}
            </button>
          ) : null}
          {note.fix ? (
            <button type="button" className="btn btn-small stu-note-fix" onClick={() => onFix(note)}>
              {note.fix.label}
            </button>
          ) : null}
        </span>
      ) : null}
    </li>
  );
}

export function SummaryCard({
  judged,
  place,
  open,
  onToggle,
  onFix,
  onCheck,
  checkLabel,
  readOnly = false,
}: {
  judged: Judged;
  /** The place the gear is judged at, by name; null until known. */
  place: string | null;
  open: boolean;
  onToggle: () => void;
  onFix: (note: Note) => void;
  onCheck: (profileId: string) => void;
  checkLabel: (profileId: string) => string;
  /** The workout can't change: its notes offer no Fix and no check. */
  readOnly?: boolean;
}) {
  const id = useId();
  const d = judged.derived;
  const errors = judged.notes.filter((n) => n.severity === "error");
  const warnings = judged.notes.filter((n) => n.severity === "warning");
  const line = [d ? `${d.estimatedMinutes} min` : "No moves yet", d ? (CATEGORY_LABELS[d.category] ?? null) : null, place].filter(Boolean).join(" · ");
  const count = errors.length ? `${errors.length} to fix` : warnings.length ? `${warnings.length} ${warnings.length === 1 ? "note" : "notes"}` : "";
  const areas = d ? areasWorked(d) : [];
  const row = (n: Note, i: number) => <NoteRow key={`${n.code}-${i}`} note={n} onFix={onFix} onCheck={onCheck} checkLabel={checkLabel} readOnly={readOnly} />;
  return (
    <section className="stu-sum" aria-labelledby={`${id}-h`}>
      <h2 id={`${id}-h`} className="visually-hidden">
        Summary
      </h2>
      <button type="button" className="stu-sum-head" aria-expanded={open} aria-controls={`${id}-b`} onClick={onToggle}>
        <span className="stu-sum-line">{line}</span>
        {count ? <span className={`stu-sum-count${errors.length ? " stu-sum-count--error" : ""}`}>{count}</span> : null}
        <span className="stu-sum-chev" aria-hidden="true">
          <IconChevron />
        </span>
      </button>
      {/* What is left to fix, said when it changes — and nothing, said plainly: a Fix that clears the last error is heard
          as well as seen. (Costs aren't counted here: they change nothing Start or Schedule can do.) */}
      <span className="visually-hidden" role="status">
        {errors.length ? `${errors.length} to fix` : "Nothing to fix."}
      </span>
      {errors.length ? <ul className="stu-notes">{errors.map(row)}</ul> : null}
      <div id={`${id}-b`} className="stu-sum-body" hidden={!open}>
        {d ? (
          <dl className="stu-bal">
            {balanceRows(d.balance).map((r) => (
              <div key={r.key} className="stu-bal-row">
                <dt>{r.term && GLOSSARY[r.term] ? <Tooltip term={r.label} tip={GLOSSARY[r.term]!} /> : r.label}</dt>
                <dd>
                  <span className="stu-meter" aria-hidden="true">
                    {Array.from({ length: BALANCE_LEVELS }, (_, i) => (
                      <span key={i} className={i < r.level ? "stu-meter-on" : undefined} />
                    ))}
                  </span>
                  <span className="stu-bal-v">{r.text}</span>
                </dd>
              </div>
            ))}
          </dl>
        ) : null}
        {areas.length ? <p className="stu-sum-areas">{`Works ${areas.join(", ")}`}</p> : null}
        {warnings.length ? <ul className="stu-notes">{warnings.map(row)}</ul> : null}
      </div>
    </section>
  );
}
