/**
 * THE SESSION'S SOUND, SET (the sound pass, 2026-10-17): sound on/off (a real switch), the volume (a slider that applies
 * as it moves) and the sounds — Automatic (soft keys; bowls for a calm session), Soft keys, Bowls or Kalimba — each
 * with a ▶ that plays the countdown into go. Shared by the player's Settings sheet and app Settings; the parent keeps
 * the value (on the device, `writeSound`) and hands it to the cue player.
 *
 * A preview plays inside its own tap (`cuePlayer.preview` unlocks audio there), at the volume the cue player was last
 * given. The sounds are one radio group by the keys: one tab stop (the choice), arrows move the choice and the focus,
 * wrapping, and Home and End go to the first and the last.
 */
import { useId, useRef, type KeyboardEvent } from "react";
import { cuePlayer, type CuePlayer } from "../player/cue-player.js";
import { PALETTE_NAMES } from "../player/sound-palettes.js";
import { resolvePalette, type SoundChoice, type StoredSound } from "../player/sound-settings.js";

/** Automatic, then each palette: the default (soft keys), the calm one (bowls), kalimba. */
const CHOICES: readonly SoundChoice[] = ["auto", "keys", "bowl", "kalimba"];

/** A choice's name: Automatic, or the palette's own. */
export const choiceName = (c: SoundChoice): string => (c === "auto" ? "Automatic" : PALETTE_NAMES[c]);

/** What is set, in a few words: "Automatic · 70%", or "Off". */
export const soundSummary = (s: StoredSound): string => (s.on ? `${choiceName(s.choice)} · ${Math.round(s.volume * 100)}%` : "Off");

export function SoundSettings({
  value,
  onChange,
  calm = false,
  player = cuePlayer,
}: {
  value: StoredSound;
  onChange: (next: StoredSound) => void;
  /** The session is calm: Automatic's preview is bowls. Outside a session, soft keys. */
  calm?: boolean;
  player?: Pick<CuePlayer, "preview">;
}) {
  const id = useId();
  const radios = useRef<Array<HTMLButtonElement | null>>([]);
  const onKey = (e: KeyboardEvent, i: number) => {
    const last = CHOICES.length - 1;
    const to =
      e.key === "ArrowDown" || e.key === "ArrowRight"
        ? (i + 1) % CHOICES.length
        : e.key === "ArrowUp" || e.key === "ArrowLeft"
          ? (i + last) % CHOICES.length
          : e.key === "Home"
            ? 0
            : e.key === "End"
              ? last
              : null;
    if (to === null) return;
    e.preventDefault();
    onChange({ ...value, choice: CHOICES[to]! });
    radios.current[to]?.focus();
  };
  return (
    <div className="sound-settings">
      <div className="setting-row">
        <span aria-hidden="true">Sound</span>
        <button
          type="button"
          role="switch"
          aria-checked={value.on}
          aria-label="Sound"
          className="program-switch"
          onClick={() => onChange({ ...value, on: !value.on })}
        />
      </div>
      <div className="setting-row sound-volume">
        <label htmlFor={`${id}-volume`}>Volume</label>
        <input
          id={`${id}-volume`}
          type="range"
          aria-label="Volume"
          min={0}
          max={100}
          step={5}
          value={Math.round(value.volume * 100)}
          onChange={(e) => onChange({ ...value, volume: Number(e.target.value) / 100 })}
        />
      </div>
      <h3 className="settings-subhead" aria-hidden="true">
        Sounds
      </h3>
      <div role="radiogroup" aria-label="Sounds" className="sound-choices">
        {CHOICES.map((c, i) => (
          <div key={c} className="sound-choice">
            <button
              ref={(el) => {
                radios.current[i] = el;
              }}
              type="button"
              role="radio"
              aria-checked={value.choice === c}
              tabIndex={value.choice === c ? 0 : -1}
              onClick={() => onChange({ ...value, choice: c })}
              onKeyDown={(e) => onKey(e, i)}
            >
              <span>{choiceName(c)}</span>
              {c === "auto" ? (
                <>
                  {" "}
                  <small>Soft keys; bowls for calm sessions</small>
                </>
              ) : null}
            </button>
            <button type="button" className="sound-play" aria-label={`Play ${choiceName(c)}`} onClick={() => player.preview("count", resolvePalette(c, calm))}>
              <svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true">
                <path d="M8 5.5v13l11-6.5z" fill="currentColor" />
              </svg>
            </button>
          </div>
        ))}
      </div>
    </div>
  );
}
