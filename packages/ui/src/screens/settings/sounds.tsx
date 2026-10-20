/**
 * App Settings → Training → Sounds (the sound pass, 2026-10-17; its own card since the new shape): one row that says what is set ("Automatic · 70%", or
 * "Off") and opens the session's sound controls (`SoundSettings`), so the athlete can set them before a session. What
 * is set is kept on this device (`writeSound`), where the player reads it, and handed to the cue player at once, so a
 * preview plays at the volume set. Outside a session nothing is calm: Automatic plays soft keys.
 *
 * While the music dock is on, one more row: "Play the workout's music when I start" (2026-10-19; on by default, kept on
 * this device as the sounds are): a session's music starts on Spotify at its Start only while it is on.
 *
 * Self-contained: the screen places it with one line, beside the rows of other agents' work.
 */
import { useContext, useState } from "react";
import { QueryClientContext } from "@tanstack/react-query";
import { Card, Sheet } from "../../components.js";
import { SoundSettings, soundSummary } from "../../components/sound-settings.js";
import { cuePlayer, type CuePlayer } from "../../player/cue-player.js";
import { readSound, soundFor, writeSound, type StoredSound } from "../../player/sound-settings.js";
import { readAutoPlay, writeAutoPlay } from "../../music/autoplay-setting.js";
import { useMusicOn } from "../../music/dock.js";

/** "Play the workout's music when I start": while the music dock is on. */
function MusicAutoPlayRow() {
  const musicOn = useMusicOn();
  const [autoPlay, setAutoPlay] = useState(() => readAutoPlay());
  if (!musicOn) return null;
  return (
    <div className="setting-row">
      <span aria-hidden="true">Play the workout's music when I start</span>
      <button
        type="button"
        role="switch"
        aria-checked={autoPlay}
        aria-label="Play the workout's music when I start"
        className="program-switch"
        onClick={() => {
          writeAutoPlay(!autoPlay);
          setAutoPlay(!autoPlay);
        }}
      />
    </div>
  );
}

export function SoundsSection({ player = cuePlayer }: { player?: Pick<CuePlayer, "preview" | "configure"> } = {}) {
  const [sound, setSound] = useState<StoredSound>(() => readSound());
  const [open, setOpen] = useState(false);
  // The music row reads the dock's state: only where the app's query client is (the Settings screen's).
  const queries = useContext(QueryClientContext);
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
      {queries ? <MusicAutoPlayRow /> : null}
      {open ? (
        <Sheet open onClose={() => setOpen(false)} title="Sounds">
          <SoundSettings value={sound} onChange={change} player={player} />
        </Sheet>
      ) : null}
    </Card>
  );
}
