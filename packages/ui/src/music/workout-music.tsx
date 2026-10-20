/**
 * A WORKOUT'S MUSIC (2026-10-19): which of the athlete's playlists a session plays, said on its sheet, and handed to the
 * player at Start.
 *
 * The rule is the domain's (`resolveWorkoutMusic`): the athlete's choice for this workout (`musicChoices`, set here with
 * Change), else the workout's own (its document's `music` — a designed workout may name one), else the first saved
 * playlist good for its kind (`workoutMusicKind`: from its category — a row's, or the one its document derives — and
 * whether the session is calm), else none. The sheet says it — "Music · Spa (default)" — and Change offers the saved
 * playlists, "No music" and "Use the default". At Start, what resolves goes with the session to the player (its
 * extras: `musicAtStart`), which plays it once (music/dock.tsx `WorkoutMusicLine`).
 *
 * Shown only while the dock is on and the athlete has a playlist; dark, nothing at all.
 */
import { useState } from "react";
import { useMutation, useQueryClient, type QueryClient } from "@tanstack/react-query";
import { musicApi, type MusicDto } from "@rg/api-client";
import {
  pickOf,
  resolveWorkoutMusic,
  workoutMusicKind,
  type MusicChoice,
  type MusicShortcut,
  type ResolvedMusic,
  type WorkoutMusic,
} from "@rg/domain";
import { Sheet } from "../components.js";
import type { WorkoutTarget } from "./controller.js";
import { MUSIC_QUERY, useMusicData } from "./dock.js";

/** What a session's music is read from, beside the athlete's playlists and choices. */
export interface SessionMusicInput {
  /** The planned workout's id (its choice's key); null before there is a row (a quick start in the Studio). */
  workoutId: string | null;
  /** Its category: the row's, or the one its document derives (`deriveDoc(doc).category`). */
  category: string | null | undefined;
  /** Built in recovery mode, or its document's effort is "recover". */
  calm: boolean;
  /** The workout's own music (its document's). */
  docMusic?: WorkoutMusic | null;
  /** A choice made before there is a row to keep it under (the Studio's pre-start). */
  localPick?: MusicChoice | null;
}

/** The session's music, from the dock's read: null while the dock is off or the athlete has no playlist. */
export function sessionMusic(data: MusicDto | null | undefined, input: SessionMusicInput): ResolvedMusic | null {
  if (!data || data.music.shortcuts.length === 0) return null;
  const choice = input.localPick ?? (input.workoutId ? data.choices?.[input.workoutId] : null) ?? null;
  return resolveWorkoutMusic({
    shortcuts: data.music.shortcuts,
    kind: workoutMusicKind({ category: input.category, calm: input.calm }),
    athlete: pickOf(choice),
    workout: input.docMusic ?? null,
  });
}

export const targetOf = (s: MusicShortcut): WorkoutTarget => ({ id: s.id, label: s.label, uri: s.uri });

/** What Start hands the player: the playlist that resolves now (the dock's read as cached), or none. */
export function musicAtStart(qc: QueryClient, input: SessionMusicInput): WorkoutTarget | null {
  const resolved = sessionMusic(qc.getQueryData<MusicDto | null>(MUSIC_QUERY), input);
  return resolved?.shortcut ? targetOf(resolved.shortcut) : null;
}

/** Whose choice it is, in a word after the playlist's name. */
export function musicWords(r: ResolvedMusic): { name: string; whose: string | null } {
  if (!r.shortcut) return { name: "No music", whose: null };
  return { name: r.shortcut.label, whose: r.source === "default" ? "default" : r.source === "workout" ? "the coach's pick" : null };
}

export function WorkoutMusicRow(props: SessionMusicInput & { date: string; onPick?: (c: MusicChoice) => void }) {
  const data = useMusicData();
  const resolved = sessionMusic(data, props);
  return data && resolved ? <MusicRowOn {...props} data={data} resolved={resolved} /> : null;
}

function MusicRowOn({
  data,
  resolved,
  workoutId,
  date,
  onPick,
  ...input
}: SessionMusicInput & { date: string; onPick?: (c: MusicChoice) => void; data: MusicDto; resolved: ResolvedMusic }) {
  const qc = useQueryClient();
  const [open, setOpen] = useState(false);
  const save = useMutation({
    mutationFn: (choice: MusicChoice) => musicApi.choose(workoutId!, choice),
    onSuccess: ({ choices }) => {
      qc.setQueryData<MusicDto | null>(MUSIC_QUERY, (d) => (d ? { ...d, choices } : d));
      setOpen(false);
    },
  });
  const words = musicWords(resolved);
  const asDefault = sessionMusic(data, { ...input, workoutId, localPick: { date, use: "default" } });
  const pick = (choice: MusicChoice) => {
    if (onPick || !workoutId) {
      onPick?.(choice);
      setOpen(false);
      return;
    }
    save.mutate(choice);
  };
  const on = (id: string | "none" | "default") =>
    id === "none" ? !resolved.shortcut : id === "default" ? resolved.source === "default" && !!resolved.shortcut : resolved.shortcut?.id === id && resolved.source !== "default";
  return (
    <div className="session-music">
      <span className="session-music-text">
        <span className="session-music-label">Music</span>{" "}
        <b>{words.name}</b>
        {words.whose ? <small> ({words.whose})</small> : null}
      </span>
      <button type="button" className="btn btn-small" aria-haspopup="dialog" aria-label={`Change the music: ${words.name}`} onClick={() => setOpen(true)}>
        Change
      </button>
      {open ? (
        <Sheet open onClose={() => setOpen(false)} title="Music for this workout" centered>
          <div className="choice-list">
            {data.music.shortcuts.map((s) => (
              <button key={s.id} type="button" aria-pressed={on(s.id)} disabled={save.isPending} onClick={() => pick({ date, use: "playlist", playlist: s.id })}>
                {s.label}
              </button>
            ))}
            <button type="button" aria-pressed={on("none")} disabled={save.isPending} onClick={() => pick({ date, use: "none" })}>
              No music
            </button>
            <button type="button" aria-pressed={on("default")} disabled={save.isPending} onClick={() => pick({ date, use: "default" })}>
              {asDefault?.shortcut ? `Use the default · ${asDefault.shortcut.label}` : "Use the default"}
            </button>
          </div>
          {save.isError ? (
            <p className="session-refused" role="alert">
              Couldn't change it — try again.
            </p>
          ) : null}
        </Sheet>
      ) : null}
    </div>
  );
}
