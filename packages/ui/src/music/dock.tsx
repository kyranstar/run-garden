/**
 * The music dock (2026-10-17): a Spotify remote that rests as a small pill — a note, or the track's short title while
 * it plays — near the bottom edge (above the tab bar on a phone, in the rail's corner on a desktop, smaller and up out
 * of the way in the session player), and opens into a sheet: now playing, play/pause and next, the shortcuts (one tap
 * plays), the volume where the device takes it, "Add a shortcut", and the Spotify connection.
 *
 * It plays only when asked: nothing starts on its own, and opening it reads, never plays (music/controller.ts). Dark
 * until the owner's Client ID arrives: `GET /api/music` answers 404 and the dock draws nothing at all.
 *
 * The session's own cues are Web Audio in an "ambient" audio session (the sound pass), so they mix over Spotify; the
 * dock adds no audio element and no speech — on an iPhone either would stop Spotify.
 */
import { useEffect, useId, useState, useSyncExternalStore } from "react";
import { useQuery, useQueryClient, type QueryClient } from "@tanstack/react-query";
import { ApiError, musicApi, SPOTIFY_LOGIN_PATH, type MusicDto } from "@rg/api-client";
import { Sheet } from "../components.js";
import { makeSpotify } from "./spotify.js";
import { makeDockController, type DockController, type DockState } from "./controller.js";
import { dockShortcuts, nowPlaying, pillTitle, volumeOf, type DockShortcut } from "./dock-model.js";

export const MUSIC_QUERY = ["music"] as const;

/** The dock's read: null when the dock is off (the server's 404). */
async function readMusic(): Promise<MusicDto | null> {
  try {
    return await musicApi.read();
  } catch (e) {
    if (e instanceof ApiError && e.status === 404) return null;
    throw e;
  }
}

/** Is the dock on? The shell keeps room for it only then. */
export function useMusicOn(): boolean {
  const q = useQuery({ queryKey: MUSIC_QUERY, queryFn: readMusic, retry: false, staleTime: 5 * 60_000, networkMode: "online" });
  return !!q.data;
}

// ── Glyphs (stroke icons, as icons.tsx draws them) ────────────────────────────

const glyph = { width: 18, height: 18, viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeWidth: 1.8, strokeLinecap: "round" as const, strokeLinejoin: "round" as const, "aria-hidden": true };
const NoteGlyph = () => (
  <svg {...glyph}>
    <path d="M9 18V5.5l10-2V16" />
    <circle cx="6.5" cy="18" r="2.5" />
    <circle cx="16.5" cy="16" r="2.5" />
  </svg>
);
const PlayGlyph = () => (
  <svg {...glyph}>
    <path d="M8 5.5v13l10.5-6.5L8 5.5Z" fill="currentColor" />
  </svg>
);
const PauseGlyph = () => (
  <svg {...glyph}>
    <path d="M8.5 5.5v13M15.5 5.5v13" strokeWidth={3} />
  </svg>
);
const NextGlyph = () => (
  <svg {...glyph}>
    <path d="M6 5.5v13l9-6.5-9-6.5Z" fill="currentColor" />
    <path d="M18.5 5.5v13" strokeWidth={2.4} />
  </svg>
);

// ── The pill ─────────────────────────────────────────────────────────────────

export function MusicPill({ title, expanded, onOpen }: { title: string | null; expanded: boolean; onOpen: () => void }) {
  return (
    <button
      type="button"
      className={`music-pill${title ? " music-pill--playing" : ""}`}
      aria-label={title ? `Music: ${title}` : "Music"}
      aria-haspopup="dialog"
      aria-expanded={expanded}
      onClick={onOpen}
    >
      <NoteGlyph />
      {title ? <span className="music-pill-title">{title}</span> : null}
    </button>
  );
}

// ── The sheet's body ─────────────────────────────────────────────────────────

export interface PanelActions {
  tap: (id: string) => void;
  pause: () => void;
  resume: () => void;
  next: () => void;
  setVolume: (percent: number) => void;
  startAdding: (target: "spa" | "custom") => void;
  cancelAdding: () => void;
  addLink: (text: string) => void;
  nameAndSave: (label: string) => void;
  addPlaylist: (p: NonNullable<DockState["playlists"]>[number]) => void;
  loadPlaylists: () => void;
  remove: (id: string) => void;
  rebuildMinecraft: () => void;
  setEditing: (editing: boolean) => void;
  disconnect: () => void;
}

function NowPlayingRow({ state, actions }: { state: DockState; actions: PanelActions }) {
  const now = nowPlaying(state.player);
  return (
    <section className="music-now" aria-label="Now playing">
      <div className="music-now-text">
        {now ? (
          <>
            <b className="music-now-title">{now.title}</b>
            <span className="music-now-meta">
              {[now.artist, now.device ? `on ${now.device}` : null].filter(Boolean).join(" · ")}
            </span>
          </>
        ) : (
          <span className="music-now-meta">Nothing playing</span>
        )}
      </div>
      {now ? (
        <div className="music-now-controls">
          {now.playing ? (
            <button type="button" className="music-control" aria-label="Pause" onClick={actions.pause}>
              <PauseGlyph />
            </button>
          ) : (
            <button type="button" className="music-control" aria-label="Play" onClick={actions.resume}>
              <PlayGlyph />
            </button>
          )}
          <button type="button" className="music-control" aria-label="Next" onClick={actions.next}>
            <NextGlyph />
          </button>
        </div>
      ) : null}
    </section>
  );
}

function VolumeRow({ state, actions }: { state: DockState; actions: PanelActions }) {
  const id = useId();
  const volume = volumeOf(state.player, state.devices);
  const [draft, setDraft] = useState<number | null>(null);
  if (!volume) return null;
  if (!volume.supported) return <p className="music-volume-note">Use the side buttons</p>;
  const value = draft ?? volume.percent;
  return (
    <div className="music-volume">
      <label htmlFor={id}>Volume</label>
      <input
        id={id}
        type="range"
        aria-label="Volume"
        min={0}
        max={100}
        step={5}
        value={value}
        onChange={(e) => setDraft(Number(e.target.value))}
        onPointerUp={() => {
          if (draft !== null) actions.setVolume(draft);
          setDraft(null);
        }}
        onKeyUp={() => {
          if (draft !== null) actions.setVolume(draft);
          setDraft(null);
        }}
      />
    </div>
  );
}

function ShortcutRow({ shortcut, state, actions }: { shortcut: DockShortcut; state: DockState; actions: PanelActions }) {
  const busyHere = state.busy === "building" && shortcut.kind === "minecraft";
  const adding = shortcut.kind === "spa" && !shortcut.uri;
  const removable = state.editing && shortcut.kind !== "minecraft" && !!shortcut.uri;
  const rebuildable = state.editing && shortcut.kind === "minecraft" && !!shortcut.uri;
  return (
    <li className="music-shortcut-row">
      <button
        type="button"
        className="music-shortcut"
        disabled={state.busy !== null}
        aria-busy={busyHere || undefined}
        onClick={() => actions.tap(shortcut.id)}
      >
        <span className="music-shortcut-mark" aria-hidden="true">
          {adding ? "+" : <NoteGlyph />}
        </span>
        <span className="music-shortcut-label">{busyHere ? "Building the Minecraft playlist…" : shortcut.label}</span>
      </button>
      {removable ? (
        <button type="button" className="btn btn-small" aria-label={`Remove ${shortcut.label}`} onClick={() => actions.remove(shortcut.id)}>
          Remove
        </button>
      ) : null}
      {rebuildable ? (
        <button type="button" className="btn btn-small" disabled={state.busy !== null} onClick={actions.rebuildMinecraft}>
          Rebuild
        </button>
      ) : null}
    </li>
  );
}

function AddPanel({ state, actions }: { state: DockState; actions: PanelActions }) {
  const linkId = useId();
  const nameId = useId();
  const [text, setText] = useState("");
  const [label, setLabel] = useState("");
  const adding = state.adding!;
  return (
    <section className="music-add" aria-label={adding.target === "spa" ? "Your spa playlist" : "Add a shortcut"}>
      <h3 className="music-subhead">{adding.target === "spa" ? "Your spa playlist" : "Add a shortcut"}</h3>
      {adding.needsLabel ? (
        <form
          className="music-add-form"
          onSubmit={(e) => {
            e.preventDefault();
            actions.nameAndSave(label);
          }}
        >
          <label htmlFor={nameId}>Name it</label>
          <div className="music-add-line">
            <input id={nameId} type="text" value={label} maxLength={60} onChange={(e) => setLabel(e.target.value)} />
            <button type="submit" className="btn btn-primary" disabled={state.busy !== null}>
              Save
            </button>
          </div>
        </form>
      ) : (
        <form
          className="music-add-form"
          onSubmit={(e) => {
            e.preventDefault();
            actions.addLink(text);
          }}
        >
          <label htmlFor={linkId}>Paste a playlist or album link</label>
          <div className="music-add-line">
            <input id={linkId} type="url" inputMode="url" autoComplete="off" value={text} onChange={(e) => setText(e.target.value)} />
            <button type="submit" className="btn btn-primary" disabled={state.busy !== null || !text.trim()}>
              Add
            </button>
          </div>
        </form>
      )}
      {adding.error ? (
        <p className="music-add-error" role="status">
          {adding.error}
        </p>
      ) : null}
      {!adding.needsLabel ? (
        <div className="music-playlists">
          <h4 className="music-subhead">Your playlists</h4>
          {state.playlists === null ? (
            <button type="button" className="btn btn-small" onClick={actions.loadPlaylists}>
              Show your playlists
            </button>
          ) : state.playlists.length === 0 ? (
            <p className="music-volume-note">No playlists yet</p>
          ) : (
            <ul className="music-list">
              {state.playlists.map((p) => (
                <li key={p.id}>
                  <button type="button" className="music-shortcut" disabled={state.busy !== null} onClick={() => actions.addPlaylist(p)}>
                    <span className="music-shortcut-mark" aria-hidden="true">
                      +
                    </span>
                    <span className="music-shortcut-label">{p.name}</span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      ) : null}
      <button type="button" className="btn music-quiet" onClick={actions.cancelAdding}>
        Cancel
      </button>
    </section>
  );
}

export function MusicPanel({ state, actions }: { state: DockState; actions: PanelActions }) {
  const notice = state.notice ? (
    <p className={`music-notice${state.notice.tone === "warn" ? " music-notice--warn" : ""}`} role="status">
      {state.notice.text}
    </p>
  ) : null;
  if (state.connection !== "connected") {
    return (
      <div className="music-panel">
        {state.connection === "reconnect" ? <p className="music-notice music-notice--warn">Spotify needs you to sign in again.</p> : null}
        <a className="btn btn-primary music-connect" href={SPOTIFY_LOGIN_PATH}>
          {state.connection === "reconnect" ? "Reconnect Spotify" : "Connect Spotify"}
        </a>
      </div>
    );
  }
  return (
    <div className="music-panel">
      <NowPlayingRow state={state} actions={actions} />
      <VolumeRow state={state} actions={actions} />
      {notice}
      {state.link ? (
        <a className="btn music-open" href={state.link} target="_blank" rel="noopener noreferrer">
          Open in Spotify
        </a>
      ) : null}
      {state.adding ? (
        <AddPanel state={state} actions={actions} />
      ) : (
        <section className="music-shortcuts" aria-label="Shortcuts">
          <ul className="music-list">
            {dockShortcuts(state.music).map((s) => (
              <ShortcutRow key={s.id} shortcut={s} state={state} actions={actions} />
            ))}
          </ul>
          <div className="music-foot">
            <button type="button" className="btn music-quiet" onClick={() => actions.startAdding("custom")}>
              Add a shortcut
            </button>
            <button type="button" className="btn music-quiet" aria-pressed={state.editing} onClick={() => actions.setEditing(!state.editing)}>
              {state.editing ? "Done" : "Edit"}
            </button>
          </div>
          {state.editing ? (
            <button type="button" className="btn btn-danger music-disconnect" onClick={actions.disconnect}>
              Disconnect Spotify
            </button>
          ) : null}
        </section>
      )}
    </div>
  );
}

// ── The dock ─────────────────────────────────────────────────────────────────

const visibleNow = (): boolean => typeof document === "undefined" || document.visibilityState !== "hidden";

function openLink(url: string): boolean {
  if (typeof window === "undefined") return false;
  const w = window.open(url, "_blank");
  if (!w) return false;
  try {
    w.opener = null;
  } catch {
    /* cross-origin already */
  }
  return true;
}

function useDock(data: MusicDto | null | undefined, qc: QueryClient): DockController {
  const [dock] = useState(() => {
    const spotify = makeSpotify({
      token: async (fresh) => {
        try {
          return await musicApi.token(fresh);
        } catch (e) {
          if (e instanceof ApiError && e.status === 404) return { connected: false, reason: "not_connected" };
          throw e;
        }
      },
      fetch: (input, init) => fetch(input, init),
      now: () => Date.now(),
      sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
    });
    const controller = makeDockController({
      spotify,
      // The query keeps the stored shortcuts too: a save writes what the server answered there.
      saveMusic: async (music) => {
        const stored = (await musicApi.save(music)).music;
        qc.setQueryData<MusicDto | null>(MUSIC_QUERY, (d) => (d ? { ...d, music: stored } : d));
        return stored;
      },
      disconnect: async () => {
        await musicApi.disconnect();
        qc.setQueryData<MusicDto | null>(MUSIC_QUERY, (d) => (d ? { ...d, connected: false } : d));
      },
      prefer: () => (typeof window !== "undefined" && window.matchMedia?.("(pointer: coarse)").matches ? "Smartphone" : "Computer"),
      random: () => Math.random(),
      openLink,
      now: () => Date.now(),
      sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
      schedule: (fn, ms) => {
        const id = setTimeout(fn, ms);
        return () => clearTimeout(id);
      },
      isVisible: visibleNow,
      newId: () => `s${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`,
    });
    if (data) controller.setServer(data);
    return controller;
  });
  useEffect(() => {
    if (data) dock.setServer(data);
  }, [dock, data]);
  useEffect(() => () => dock.dispose(), [dock]);
  return dock;
}

export function MusicDock({ variant }: { variant: "shell" | "player" }) {
  const qc = useQueryClient();
  const q = useQuery({ queryKey: MUSIC_QUERY, queryFn: readMusic, retry: false, staleTime: 5 * 60_000, networkMode: "online" });
  const dock = useDock(q.data, qc);
  const state = useSyncExternalStore(dock.subscribe, dock.get, dock.get);
  const [clock, setClock] = useState(() => Date.now());
  const refetch = q.refetch;

  // Visibility: polling follows it, a play waiting for a device is retried, and — back from a Spotify login that
  // finished in another browser (iOS opens a standalone app's login in Safari) — the connection is read again.
  useEffect(() => {
    const onVisibility = () => {
      const visible = visibleNow();
      void dock.setVisible(visible);
      if (visible) {
        setClock(Date.now());
        if (dock.get().connection !== "connected") void refetch();
      }
    };
    document.addEventListener("visibilitychange", onVisibility);
    return () => document.removeEventListener("visibilitychange", onVisibility);
  }, [dock, refetch]);

  // Back from Spotify's login in this browser (`/?music=connected|error`): open the dock and say how it went.
  useEffect(() => {
    if (variant !== "shell" || typeof window === "undefined") return;
    const params = new URLSearchParams(window.location.search);
    const outcome = params.get("music");
    if (outcome !== "connected" && outcome !== "error") return;
    params.delete("music");
    const rest = params.toString();
    window.history.replaceState(window.history.state, "", `${window.location.pathname}${rest ? `?${rest}` : ""}${window.location.hash}`);
    void refetch().then(async () => {
      await dock.open();
      if (outcome === "error") dock.say("Spotify didn't connect. Try again.", "warn");
    });
  }, [variant, dock, refetch]);

  // The pill's title expires when the track should have ended: look again then (no read — the clock only).
  useEffect(() => {
    const t = pillTitle(state, clock) ? setTimeout(() => setClock(Date.now()), 15_000) : null;
    return () => {
      if (t) clearTimeout(t);
    };
  }, [state, clock]);

  if (!q.data) return null;
  const actions: PanelActions = {
    tap: (id) => void dock.tap(id),
    pause: () => void dock.pause(),
    resume: () => void dock.resume(),
    next: () => void dock.next(),
    setVolume: (p) => void dock.setVolume(p),
    startAdding: (t) => dock.startAdding(t),
    cancelAdding: () => dock.cancelAdding(),
    addLink: (text) => void dock.addLink(text),
    nameAndSave: (label) => void dock.nameAndSave(label),
    addPlaylist: (p) => void dock.addPlaylist(p),
    loadPlaylists: () => void dock.loadPlaylists(),
    remove: (id) => void dock.remove(id),
    rebuildMinecraft: () => void dock.rebuildMinecraft(),
    setEditing: (e) => dock.setEditing(e),
    disconnect: () => void dock.disconnect(),
  };
  return (
    <div className={`music-dock music-dock--${variant}`}>
      <MusicPill title={pillTitle(state, clock)} expanded={state.expanded} onOpen={() => void dock.open()} />
      <Sheet open={state.expanded} onClose={() => void dock.close()} title="Music">
        <MusicPanel state={state} actions={actions} />
      </Sheet>
    </div>
  );
}
