/**
 * App Settings → Training → Sounds (the sound pass, 2026-10-17; its own card since the new shape): one row that says what is set ("Automatic · 70%", or
 * "Off") and opens the session's sound controls (`SoundSettings`), so the athlete can set them before a session. What
 * is set is kept on this device (`writeSound`), where the player reads it, and handed to the cue player at once, so a
 * preview plays at the volume set. Outside a session nothing is calm: Automatic plays soft keys.
 *
 * Self-contained: the screen places it with one line, beside the rows of other agents' work.
 */
import { useState } from "react";
import { Card, Sheet } from "../../components.js";
import { SoundSettings, soundSummary } from "../../components/sound-settings.js";
import { cuePlayer, type CuePlayer } from "../../player/cue-player.js";
import { readSound, soundFor, writeSound, type StoredSound } from "../../player/sound-settings.js";

export function SoundsSection({ player = cuePlayer }: { player?: Pick<CuePlayer, "preview" | "configure"> } = {}) {
  const [sound, setSound] = useState<StoredSound>(() => readSound());
  const [open, setOpen] = useState(false);
  const change = (next: StoredSound) => {
    writeSound(next);
    setSound(next);
    player.configure(soundFor(next, false));
  };
  return (
    <Card title="Sounds">
      <button
        type="button"
        className="place-row"
        aria-haspopup="dialog"
        onClick={() => {
          // The cue player has what is stored, so a preview plays at the stored volume from the first tap.
          player.configure(soundFor(sound, false));
          setOpen(true);
        }}
      >
        <span className="place-row-main">
          <b>Sounds</b>
          <small>{soundSummary(sound)}</small>
        </span>
        <span className="faint" aria-hidden>
          ›
        </span>
      </button>
      {open ? (
        <Sheet open onClose={() => setOpen(false)} title="Sounds">
          <SoundSettings value={sound} onChange={change} player={player} />
        </Sheet>
      ) : null}
    </Card>
  );
}
