/**
 * A ROW OF CHIPS THAT KEEPS ITS LENGTH ONE TAP DOWN (principles §7: depth one tap down). It shows its first `limit`
 * chips — and any chosen one, wherever it sits, so a choice never hides — and folds the rest behind a disclosure that
 * names what it opens ("More tags"). The folded chips stay in the DOM, so `aria-controls` always resolves; they join
 * the row in place when opened (`display: contents`), and the button stays last, reading "Fewer tags".
 *
 * `toggle` chips are filter choices (`aria-pressed`, a check when chosen, so the choice never rests on colour); plain
 * chips are actions (open a list).
 */
import { useId, useState } from "react";
import { IconCheck } from "../../icons.js";

export interface ChipSpec {
  key: string;
  label: string;
  /** Chosen (toggle chips). */
  on?: boolean;
  onClick: () => void;
}

export function ChipRow({
  chips,
  limit = Infinity,
  more = "More",
  less = "Fewer",
  toggle = false,
}: {
  chips: readonly ChipSpec[];
  /** How many show before the fold. */
  limit?: number;
  more?: string;
  less?: string;
  toggle?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const id = useId();
  const shown = (c: ChipSpec, i: number) => i < limit || (toggle && c.on === true);
  const first = chips.filter(shown);
  const rest = chips.filter((c, i) => !shown(c, i));
  const chip = (c: ChipSpec) =>
    toggle ? (
      <button key={c.key} type="button" className="chip" aria-pressed={c.on === true} onClick={c.onClick}>
        {c.on ? <IconCheck /> : null}
        {c.label}
      </button>
    ) : (
      <button key={c.key} type="button" className="chip" onClick={c.onClick}>
        {c.label}
      </button>
    );
  return (
    <div className="stu-chipset">
      {first.map(chip)}
      {rest.length > 0 ? (
        <>
          <span id={id} className="stu-more" hidden={!open}>
            {rest.map(chip)}
          </span>
          <button
            type="button"
            className="linklike stu-more-btn tap-pad"
            aria-expanded={open}
            aria-controls={id}
            onClick={() => setOpen((o) => !o)}
          >
            {open ? less : more}
          </button>
        </>
      ) : null}
    </div>
  );
}
