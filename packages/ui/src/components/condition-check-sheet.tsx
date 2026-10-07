/**
 * THE CONDITION CHECK (Phase 2a Task 6; mocks §1). A chip beside readiness on the Today card — "<word> check"
 * before today's check, "<word> 2" after — opens a sheet with the profile's own scale, Feeling off, and Save.
 *
 * Every word here comes from the profile (`check.label`, whose first word names the chip); the UI holds none of
 * its own. The reading is the same one the session pre-check asks for: either answers the other.
 */
import { useRef, useState, type KeyboardEvent } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { api, type ConditionViewDto } from "@rg/api-client";
import { Banner, Sheet } from "../components.js";

export interface TodayReading {
  value: number | null;
  feelingOff: boolean;
}

/** The chip's word: the check label's first word ("Knee / hip" → "Knee"). */
export function checkWord(label: string): string {
  return label.trim().split(/[\s/]+/)[0] || label;
}

/** "Knee check" before today's check; "Knee 2", "Knee 2 · off", "Knee · off" after. */
export function conditionChipLabel(c: ConditionViewDto & { today: TodayReading | null }): string {
  const word = checkWord(c.check.label);
  if (!c.today || (c.today.value === null && !c.today.feelingOff)) return `${word} check`;
  return `${word}${c.today.value !== null ? ` ${c.today.value}` : ""}${c.today.feelingOff ? " · off" : ""}`;
}

/** One chip per switched-on profile; nothing at all without one (an account with no program gets none). */
export function ConditionChips({
  conditions,
  onOpen,
}: {
  conditions: ReadonlyArray<ConditionViewDto & { today: TodayReading | null }>;
  onOpen: (profileId: string) => void;
}) {
  if (conditions.length === 0) return null;
  return (
    <>
      {conditions.map((c) => (
        <button
          key={c.profileId}
          type="button"
          className="ready-chip condition-chip"
          onClick={() => onOpen(c.profileId)}
        >
          {conditionChipLabel(c)} ›
        </button>
      ))}
    </>
  );
}

/**
 * The 0–10 grid (two rows), shared by the check sheet and the session pre-check. One choice, so a radiogroup
 * (audit 2a-UI M3): one tab stop — the chosen number, else the first — and the arrow keys, Home and End move the
 * choice. Tapping the chosen number clears it (null), which leaves "Feeling off" alone as an answer; Space on it keeps
 * it, as a radio does.
 */
export function CheckScale({
  label,
  min,
  max,
  value,
  onPick,
  disabled,
}: {
  label: string;
  min: number;
  max: number;
  value: number | null;
  onPick: (n: number | null) => void;
  disabled?: boolean;
}) {
  const steps = Array.from({ length: max - min + 1 }, (_, i) => min + i);
  const refs = useRef<Array<HTMLButtonElement | null>>([]);
  const stop = value !== null && steps.includes(value) ? steps.indexOf(value) : 0;
  const onKeyDown = (e: KeyboardEvent<HTMLButtonElement>, i: number) => {
    const last = steps.length - 1;
    const to =
      e.key === "ArrowRight" || e.key === "ArrowDown"
        ? i === last ? 0 : i + 1
        : e.key === "ArrowLeft" || e.key === "ArrowUp"
          ? i === 0 ? last : i - 1
          : e.key === "Home"
            ? 0
            : e.key === "End"
              ? last
              : null;
    if (to === null) return;
    e.preventDefault();
    onPick(steps[to]!);
    refs.current[to]?.focus();
  };
  return (
    <div className="check-scale" role="radiogroup" aria-label={label}>
      {steps.map((n, i) => (
        <button
          key={n}
          ref={(el) => {
            refs.current[i] = el;
          }}
          type="button"
          role="radio"
          aria-checked={value === n}
          tabIndex={i === stop ? 0 : -1}
          disabled={disabled}
          // A tap on the chosen number clears it; a key press (Space/Enter: a click with no pointer detail) never
          // unchecks a radio (2a UI re-review U7).
          onClick={(e) => onPick(value === n && e.detail > 0 ? null : n)}
          onKeyDown={(e) => onKeyDown(e, i)}
        >
          {n}
        </button>
      ))}
    </div>
  );
}

/** "Feeling off" — a toggle, beside the scale. With two profiles asked at once, each is named by its own word. */
export function FeelingOffToggle({ on, onToggle, disabled, word }: { on: boolean; onToggle: () => void; disabled?: boolean; word?: string }) {
  return (
    <button
      type="button"
      className="chipbtn check-off"
      aria-pressed={on}
      aria-label={word ? `Feeling off · ${word}` : undefined}
      disabled={disabled}
      onClick={onToggle}
    >
      Feeling off
    </button>
  );
}

export function ConditionCheckSheet({
  condition,
  onClose,
}: {
  condition: ConditionViewDto & { today: TodayReading | null };
  onClose: () => void;
}) {
  const qc = useQueryClient();
  const [value, setValue] = useState<number | null>(condition.today?.value ?? null);
  const [off, setOff] = useState(condition.today?.feelingOff ?? false);
  const save = useMutation({
    mutationFn: () => api.recordCheck({ profileId: condition.profileId, value, feelingOff: off }),
    onSuccess: (res) => {
      // `{check: null}`: a restore is replacing the account and nothing was recorded — not saved (audit 2a-UI M7).
      if (!res.check) return;
      // The chip reads it from Today; a session built today reads it as its pre-check.
      void qc.invalidateQueries({ queryKey: ["today"] });
      void qc.invalidateQueries({ queryKey: ["session"] });
      onClose();
    },
  });
  const unrecorded = save.isSuccess && !save.data.check;
  return (
    <Sheet
      open
      onClose={onClose}
      title={condition.check.label}
      footer={
        <button
          type="button"
          className="btn btn-primary"
          disabled={(value === null && !off) || save.isPending}
          onClick={() => save.mutate()}
        >
          Save
        </button>
      }
    >
      <div className="stack check-sheet">
        <CheckScale
          label={condition.check.label}
          min={condition.check.min}
          max={condition.check.max}
          value={value}
          onPick={setValue}
        />
        <div className="row">
          <FeelingOffToggle on={off} onToggle={() => setOff((v) => !v)} />
        </div>
        {save.isError ? <Banner kind="warn">Couldn't save that — try again.</Banner> : null}
        {unrecorded ? <Banner kind="warn">Not saved — a restore is running. Try again once it finishes.</Banner> : null}
      </div>
    </Sheet>
  );
}
