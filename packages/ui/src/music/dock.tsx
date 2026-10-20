/**
 * The music dock (2026-10-17; one abstraction, 2026-10-19): a Spotify remote that rests as a small pill — a note, or
 * the track's short title while it plays — near the bottom edge (above the tab bar on a phone, in the rail's corner on
 * a desktop, smaller and up out of the way in the session player), and opens into a sheet: now playing, play/pause and
 * next, the athlete's playlists (one tap plays; each with what it suits), the volume where the device takes it, "Add a
 * playlist" (pick one of theirs, or paste a link), and the Spotify connection. In Edit, each playlist's name and tags.
 *
 * It plays only when asked: nothing starts on its own but a workout's music at its Start (the player's), and opening
 * it reads, never plays (music/controller.ts). Dark until the owner's Client ID arrives: `GET /api/music` answers 404
 * and the dock draws nothing at all.
 *
 * One controller per page (`useMusicDock`), shared by the shell's dock, the player's and the player's music line, so
 * what plays, the devices and the backoff carry from one screen to the next.
 *
 * The session's own cues are Web Audio in an "ambient" audio session (the sound pass), so they mix over Spotify; the
 * dock adds no audio element and no speech — on an iPhone either would stop Spotify.
 */
import { useEffect, useId, useRef, useState, useSyncExternalStore, type ReactNode } from "react";
import { useQuery, useQueryClient, type QueryClient } from "@tanstack/react-query";
import { ApiError, musicApi, SPOTIFY_LOGIN_PATH, type MusicDto } from "@rg/api-client";
import { MUSIC_GOOD_FOR, MUSIC_GOOD_FOR_LABELS, MUSIC_LABEL_MAX, type MusicGoodFor, type MusicShortcut } from "@rg/domain";
import { Sheet } from "../components.js";
import { readAutoPlay } from "./autoplay-setting.js";
import { makeBackoff, type Backoff } from "./backoff.js";
import { makeSpotify } from "./spotify.js";
import { makeDockController, SLOW_LINE, type Connection, type DockController, type DockState, type WorkoutTarget } from "./controller.js";
import { goodForWords, nowPlaying, pillTitle, volumeOf } from "./dock-model.js";

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

const musicQuery = { queryKey: MUSIC_QUERY, queryFn: readMusic, retry: false, staleTime: 5 * 60_000, networkMode: "online" as const };

/** The dock's read (the playlists, the connection, the athlete's choices per workout): undefined until it answers,
 * null while the dock is off. */
export function useMusicData(): MusicDto | null | undefined {
  return useQuery(musicQuery).data;
}

/** Is the dock on? The shell keeps room for it only then. */
export function useMusicOn(): boolean {
  return !!useMusicData();
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
      className={`music-pill tap-pad${title ? " music-pill--playing" : ""}`}
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
  startAdding: () => void;
  cancelAdding: () => void;
  addLink: (text: string) => void;
  nameAndSave: (label: string) => void;
  addPlaylist: (p: NonNullable<DockState["playlists"]>["items"][number]) => void;
  morePlaylists: () => void;
  remove: (id: string) => void;
  edit: (id: string, patch: { label: string; goodFor: MusicGoodFor[] }) => void;
  openEditor: (id: string | null) => void;
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
            {volumeOf(state.player, state.devices)?.supported === false ? <span className="music-now-volume">Volume · use the side buttons</span> : null}
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

/** The volume is sent this long after the slider stops moving. */
export const VOLUME_SETTLE_MS = 300;

/**
 * The volume, where the device takes it (a phone that doesn't says so under now playing). Sent as it changes once it
 * settles — every way of moving it fires `change`: a finger, a key, and a screen reader's steps, which release no
 * pointer and no key (review: committed only on pointer-up and key-up, VoiceOver could not set it).
 */
function VolumeRow({ state, actions }: { state: DockState; actions: PanelActions }) {
  const id = useId();
  const volume = volumeOf(state.player, state.devices);
  const [draft, setDraft] = useState<number | null>(null);
  const pending = useRef<{ timer: ReturnType<typeof setTimeout>; value: number } | null>(null);
  const send = useRef(actions.setVolume);
  send.current = actions.setVolume;
  // Leaving with a move not yet sent (the sheet closed): send it.
  useEffect(
    () => () => {
      if (pending.current) {
        clearTimeout(pending.current.timer);
        send.current(pending.current.value);
      }
    },
    [],
  );
  if (!volume?.supported) return null;
  const change = (value: number) => {
    setDraft(value);
    if (pending.current) clearTimeout(pending.current.timer);
    pending.current = {
      value,
      timer: setTimeout(() => {
        pending.current = null;
        send.current(value);
      }, VOLUME_SETTLE_MS),
    };
  };
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
        value={draft ?? volume.percent}
        onChange={(e) => change(Number(e.target.value))}
      />
    </div>
  );
}

/** A playlist's mark: its cover (Spotify's own image host only, kept when it was linked), else a note. */
function Cover({ image }: { image?: string | null }) {
  return (
    <span className="music-shortcut-mark" aria-hidden="true">
      {image ? <img className="music-cover" src={image} alt="" width={36} height={36} loading="lazy" referrerPolicy="no-referrer" /> : <NoteGlyph />}
    </span>
  );
}

function ShortcutRow({ shortcut, state, actions }: { shortcut: MusicShortcut; state: DockState; actions: PanelActions }) {
  const suits = goodForWords(shortcut);
  return (
    <li className="music-shortcut-row">
      <button type="button" className="music-shortcut" disabled={state.busy !== null} onClick={() => actions.tap(shortcut.id)}>
        <Cover image={shortcut.image} />
        <span className="music-shortcut-text">
          <span className="music-shortcut-label">{shortcut.label}</span>
          {suits ? <span className="music-shortcut-sub">{suits}</span> : null}
        </span>
      </button>
      {state.editing ? (
        <button type="button" className="btn btn-small" aria-label={`Edit ${shortcut.label}`} onClick={() => actions.openEditor(shortcut.id)}>
          Edit
        </button>
      ) : null}
    </li>
  );
}

/** One playlist's name and what it suits, as the athlete sets them; and Remove. */
function EditPanel({ shortcut, state, actions }: { shortcut: MusicShortcut; state: DockState; actions: PanelActions }) {
  const nameId = useId();
  const [label, setLabel] = useState(shortcut.label);
  const [goodFor, setGoodFor] = useState<MusicGoodFor[]>(shortcut.goodFor ?? []);
  const toggle = (t: MusicGoodFor) => setGoodFor((g) => (g.includes(t) ? g.filter((x) => x !== t) : MUSIC_GOOD_FOR.filter((x) => x === t || g.includes(x))));
  return (
    <section className="music-add" aria-label={`Edit ${shortcut.label}`}>
      <h3 className="music-subhead">{shortcut.name && shortcut.name !== shortcut.label ? shortcut.name : "Edit playlist"}</h3>
      <form
        className="music-add-form"
        onSubmit={(e) => {
          e.preventDefault();
          actions.edit(shortcut.id, { label, goodFor });
        }}
      >
        <label htmlFor={nameId}>Name</label>
        <div className="music-add-line">
          <input id={nameId} type="text" value={label} maxLength={MUSIC_LABEL_MAX} onChange={(e) => setLabel(e.target.value)} />
        </div>
        <span className="music-add-label" id={`${nameId}-tags`}>
          Good for
        </span>
        <div className="music-tags" role="group" aria-labelledby={`${nameId}-tags`}>
          {MUSIC_GOOD_FOR.map((t) => (
            <button key={t} type="button" className="music-tag" aria-pressed={goodFor.includes(t)} onClick={() => toggle(t)}>
              {goodFor.includes(t) ? "✓ " : ""}
              {MUSIC_GOOD_FOR_LABELS[t]}
            </button>
          ))}
        </div>
        <div className="music-foot">
          <button type="submit" className="btn btn-primary" disabled={state.busy !== null || !label.trim()}>
            Save
          </button>
          <button type="button" className="btn music-quiet" onClick={() => actions.openEditor(null)}>
            Cancel
          </button>
        </div>
      </form>
      <button type="button" className="btn btn-small music-remove" disabled={state.busy !== null} aria-label={`Remove ${shortcut.label}`} onClick={() => actions.remove(shortcut.id)}>
        Remove
      </button>
    </section>
  );
}

function AddPanel({ state, actions }: { state: DockState; actions: PanelActions }) {
  const linkId = useId();
  const nameId = useId();
  const [text, setText] = useState("");
  const [label, setLabel] = useState("");
  const adding = state.adding!;
  const linkedUris = new Set(state.music.shortcuts.map((s) => s.uri));
  return (
    <section className="music-add" aria-label="Add a playlist">
      <h3 className="music-subhead">Add a playlist</h3>
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
            <input id={nameId} type="text" value={label} maxLength={MUSIC_LABEL_MAX} onChange={(e) => setLabel(e.target.value)} />
            <button type="submit" className="btn btn-primary" disabled={state.busy !== null}>
              Save
            </button>
          </div>
        </form>
      ) : (
        <>
          <div className="music-playlists">
            <h4 className="music-subhead">Your playlists</h4>
            {state.playlists === null ? (
              state.connection === "connected" && !state.notice ? (
                <p className="music-notice">Loading your playlists…</p>
              ) : null
            ) : state.playlists.items.length === 0 ? (
              <p className="music-notice">No playlists yet</p>
            ) : (
              <ul className="music-list">
                {state.playlists.items.map((p) => (
                  <li key={p.id} className="music-shortcut-row">
                    <button
                      type="button"
                      className="music-shortcut"
                      disabled={state.busy !== null || linkedUris.has(p.uri)}
                      onClick={() => actions.addPlaylist(p)}
                    >
                      <Cover image={p.image} />
                      <span className="music-shortcut-text">
                        <span className="music-shortcut-label">{p.name}</span>
                        {linkedUris.has(p.uri) ? <span className="music-shortcut-sub">Added</span> : null}
                      </span>
                    </button>
                  </li>
                ))}
              </ul>
            )}
            {state.playlists?.next != null ? (
              <button type="button" className="btn btn-small" disabled={state.busy !== null} onClick={actions.morePlaylists}>
                More
              </button>
            ) : null}
          </div>
          <form
            className="music-add-form"
            onSubmit={(e) => {
              e.preventDefault();
              actions.addLink(text);
            }}
          >
            <label htmlFor={linkId}>Or paste a playlist or album link</label>
            <div className="music-add-line">
              <input id={linkId} type="url" inputMode="url" autoComplete="off" value={text} onChange={(e) => setText(e.target.value)} />
              <button type="submit" className="btn btn-primary" disabled={state.busy !== null || !text.trim()}>
                Add
              </button>
            </div>
          </form>
        </>
      )}
      {adding.error ? (
        <p className="music-add-error" role="status">
          {adding.error}
        </p>
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
        <a className="btn btn-primary music-connect" href={SPOTIFY_LOGIN_PATH} onClick={noteLoginStarted}>
          {state.connection === "reconnect" ? "Reconnect Spotify" : "Connect Spotify"}
        </a>
      </div>
    );
  }
  const editing = state.editing && state.editingId ? state.music.shortcuts.find((s) => s.id === state.editingId) : undefined;
  return (
    <div className="music-panel">
      <NowPlayingRow state={state} actions={actions} />
      {/* The volume belongs to what is playing: with nothing in the player there is nothing to turn up. */}
      {state.player ? <VolumeRow state={state} actions={actions} /> : null}
      {notice}
      {state.link ? (
        <a className="btn music-open" href={state.link} target="_blank" rel="noopener noreferrer">
          Open in Spotify
        </a>
      ) : null}
      {state.adding ? (
        <AddPanel state={state} actions={actions} />
      ) : editing ? (
        <EditPanel key={editing.id} shortcut={editing} state={state} actions={actions} />
      ) : (
        <section className="music-shortcuts" aria-label="Your playlists">
          {state.music.shortcuts.length ? (
            <ul className="music-list">
              {state.music.shortcuts.map((s) => (
                <ShortcutRow key={s.id} shortcut={s} state={state} actions={actions} />
              ))}
            </ul>
          ) : (
            <p className="music-notice">Add a playlist to play it from here — and with your workouts.</p>
          )}
          <div className="music-foot">
            <button type="button" className="btn music-quiet" onClick={actions.startAdding}>
              Add a playlist
            </button>
            {state.music.shortcuts.length ? (
              <button type="button" className="btn music-quiet" aria-pressed={state.editing} onClick={() => actions.setEditing(!state.editing)}>
                {state.editing ? "Done" : "Edit"}
              </button>
            ) : null}
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

const LOGIN_KEY = "rg-music-login-at";
/** How long after tapping Connect a return to the app looks for the connection again. */
export const LOGIN_RECHECK_MS = 10 * 60_000;

/** Connect was tapped here (kept across the navigation to the Worker's login; per tab). */
function noteLoginStarted(): void {
  try {
    sessionStorage.setItem(LOGIN_KEY, String(Date.now()));
  } catch {
    /* no storage: the dock reads the connection again on its next load */
  }
}

function loginStartedAt(): number | null {
  try {
    const at = Number(sessionStorage.getItem(LOGIN_KEY));
    return at > 0 ? at : null;
  } catch {
    return null;
  }
}

/**
 * Back in the app: read the connection again only shortly after Connect was tapped here — the login may have finished
 * in another browser (iOS opens a standalone app's login in Safari). Never on every return: the read's stale time
 * holds otherwise (review).
 */
export function recheckOnReturn(s: { connection: Connection; loginStartedAt: number | null; now: number }): boolean {
  return s.connection !== "connected" && s.loginStartedAt !== null && s.now - s.loginStartedAt <= LOGIN_RECHECK_MS;
}

/** The dock in the session player's top bar, among its tools — mounted only while the dock is on (dark: nothing). */
export function PlayerMusicTools() {
  return useMusicOn() ? <MusicDock variant="player" /> : null;
}

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

/** The page's one controller (per query client: a test's own client gets its own), and the backoff every call shares. */
const docks = new WeakMap<QueryClient, DockController>();
let pageBackoff: Backoff | null = null;

function dockFor(qc: QueryClient): DockController {
  const known = docks.get(qc);
  if (known) return known;
  pageBackoff ??= makeBackoff({ now: () => Date.now() });
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
    backoff: pageBackoff,
  });
  const controller = makeDockController({
    spotify,
    // The query keeps the stored playlists too: a save writes what the server answered there.
    saveMusic: async (music) => {
      const stored = (await musicApi.save(music)).music;
      qc.setQueryData<MusicDto | null>(MUSIC_QUERY, (d) => (d ? { ...d, music: stored } : d));
      return stored;
    },
    tag: async (playlists) => (await musicApi.tags(playlists)).tags,
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
  docks.set(qc, controller);
  return controller;
}

/** A controller of the caller's own for a query client (the tests' seam: a fake Spotify behind it). */
export function setDockFor(qc: QueryClient, dock: DockController): void {
  docks.set(qc, dock);
}

/** The page's dock controller and its state, kept in step with the Worker's read. Mount only while the dock is on. */
export function useMusicDock(): { dock: DockController; state: DockState; data: MusicDto | null | undefined } {
  const qc = useQueryClient();
  const data = useMusicData();
  const dock = dockFor(qc);
  useEffect(() => {
    if (data) dock.setServer(data);
  }, [dock, data]);
  const state = useSyncExternalStore(dock.subscribe, dock.get, dock.get);
  return { dock, state, data };
}

export function MusicDock({ variant }: { variant: "shell" | "player" }) {
  const { dock, state, data } = useMusicDock();
  const q = useQuery(musicQuery);
  const [clock, setClock] = useState(() => Date.now());
  const refetch = q.refetch;

  // Leaving the page (the shell for the player, or back): the sheet closes and its reading stops; the controller stays.
  useEffect(() => () => void dock.close(), [dock]);

  // Visibility: polling follows it, a play waiting for a device is retried, and — back from a Spotify login that
  // finished in another browser (iOS opens a standalone app's login in Safari) — the connection is read again.
  useEffect(() => {
    const onVisibility = () => {
      const visible = visibleNow();
      void dock.setVisible(visible);
      if (visible) {
        setClock(Date.now());
        if (recheckOnReturn({ connection: dock.get().connection, loginStartedAt: loginStartedAt(), now: Date.now() })) void refetch();
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
    // The login came back here: no later return needs to look for it.
    try {
      sessionStorage.removeItem(LOGIN_KEY);
    } catch {
      /* no storage */
    }
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

  if (!data) return null;
  const actions: PanelActions = {
    tap: (id) => void dock.tap(id),
    pause: () => void dock.pause(),
    resume: () => void dock.resume(),
    next: () => void dock.next(),
    setVolume: (p) => void dock.setVolume(p),
    startAdding: () => void dock.startAdding(),
    cancelAdding: () => dock.cancelAdding(),
    addLink: (text) => void dock.addLink(text),
    nameAndSave: (label) => void dock.nameAndSave(label),
    addPlaylist: (p) => void dock.addPlaylist(p),
    morePlaylists: () => void dock.morePlaylists(),
    remove: (id) => void dock.remove(id),
    edit: (id, patch) => void dock.edit(id, patch),
    openEditor: (id) => dock.openEditor(id),
    setEditing: (e) => dock.setEditing(e),
    disconnect: () => void dock.disconnect(),
  };
  return (
    <DockFrame
      variant={variant}
      pill={<MusicPill title={pillTitle(state, clock)} expanded={state.expanded} onOpen={() => void dock.open()} />}
      sheet={
        <Sheet open={state.expanded} onClose={() => void dock.close()} title="Music">
          <MusicPanel state={state} actions={actions} />
        </Sheet>
      }
    />
  );
}

/** The pill in its fixed corner, and the sheet BESIDE it, never inside: the pill's fixed box is a stacking context
 * below the tab bar's, and a sheet drawn inside it lay under the tab bar (its Connect button under "Plan"). */
export function DockFrame({ variant, pill, sheet }: { variant: "shell" | "player"; pill: ReactNode; sheet: ReactNode }) {
  return (
    <>
      <div className={`music-dock music-dock--${variant}`}>{pill}</div>
      {sheet}
    </>
  );
}

// ── A workout's music, at its Start (the session player) ─────────────────────

/** What the player hands over: the session was just started here (not resumed), and the music resolved at Start. */
export interface WorkoutMusicStart {
  fresh: boolean;
  target: WorkoutTarget | null;
}

/**
 * The player's music at Start: once, for a session just started here, the music its Start resolved plays on the
 * athlete's Spotify (connected, and "Play the workout's music when I start" on — this device's setting, on by default).
 * Nothing is said while it plays (the dock's pill shows it). No device open: one quiet line, "Open Spotify to play Spa",
 * with Play; Spotify asking to slow down: the dock's calm line. Dark, or no music: nothing at all, and no controller.
 */
export function WorkoutMusicLine(props: WorkoutMusicStart) {
  return useMusicOn() && props.target ? <WorkoutMusicLineOn {...props} target={props.target} /> : null;
}

function WorkoutMusicLineOn({ fresh, target }: { fresh: boolean; target: WorkoutTarget }) {
  const { dock, state, data } = useMusicDock();
  const asked = useRef(false);
  useEffect(() => {
    if (!fresh || asked.current || !data?.connected || !readAutoPlay()) return;
    asked.current = true;
    dock.setServer(data);
    void dock.autoPlay(target);
  }, [fresh, target, data, dock]);
  const w = state.workout;
  if (!w || w.target.uri !== target.uri) return null;
  if (w.status === "slow") {
    return (
      <p className="player-hint player-music" role="status">
        {SLOW_LINE}
      </p>
    );
  }
  return (
    <p className="player-hint player-music" role="status">
      Open Spotify to play {w.target.label}
      <button type="button" disabled={state.busy !== null} onClick={() => void dock.playWorkout(w.target)}>
        Play
      </button>
      {state.link ? (
        <a href={state.link} target="_blank" rel="noopener noreferrer">
          Open Spotify
        </a>
      ) : null}
    </p>
  );
}
