/**
 * THE SET STEPPERS (Phase 2b; mocks §4 log card, §5 review): a typed field between − and +. The player's log card and
 * the review edit a set with the same ones. A weight is typed as "25", "25 lb" or "12kg" (`parseWeight` reads it
 * where it is used); its steppers move through the place's bells (or the weight grid).
 */
import { useId } from "react";

export function Stepper({
  label,
  value,
  onChange,
  onLess,
  onMore,
  lessLabel,
  moreLabel,
  inputMode,
}: {
  label: string;
  value: string;
  onChange: (text: string) => void;
  onLess: () => void;
  onMore: () => void;
  lessLabel: string;
  moreLabel: string;
  inputMode: "decimal" | "numeric";
}) {
  const id = useId();
  return (
    <div className="player-stepper">
      <label className="eyebrow" htmlFor={id}>
        {label}
      </label>
      <button type="button" aria-label={lessLabel} onClick={onLess}>
        −
      </button>
      <input
        id={id}
        aria-label={label}
        inputMode={inputMode}
        autoComplete="off"
        value={value}
        onChange={(e) => onChange(e.target.value)}
      />
      <button type="button" aria-label={moreLabel} onClick={onMore}>
        +
      </button>
    </div>
  );
}
