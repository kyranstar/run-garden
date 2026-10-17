/**
 * THE SESSION'S SOUND, SET (the sound pass, 2026-10-17): sound on/off (a real switch), the volume (a slider that applies
 * as it moves) and the sounds — Automatic (soft keys; bowls for a calm session), Soft keys, Bowls or Kalimba — each
 * with a ▶ that plays the countdown into go. Shared by the player's Settings sheet and app Settings; the parent keeps
 * the value (on the device, `writeSound`) and hands it to the cue player.
 *
 * A preview plays inside its own tap (`cuePlayer.preview` unlocks audio there), at the volume the cue player was last
 * given.
 */
import { useId } from "react";
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
        {CHOICES.map((c) => (
          <div key={c} className="sound-choice">
            <button type="button" role="radio" aria-checked={value.choice === c} onClick={() => onChange({ ...value, choice: c })}>
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
