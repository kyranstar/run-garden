/**
 * The music dock, drawn (2026-10-17; packages/ui/src/music/dock.tsx). renderToStaticMarkup, node env.
 *
 *  - Hidden altogether while the server says the dock is off (no Client ID: a 404), or hasn't answered.
 *  - Resting: a small pill — a note, or the track's short title while it plays — in the shell and, smaller, in the
 *    session player.
 *  - Expanded: now playing, play/pause and next, the athlete's playlists (one tap = play; each with its cover and what
 *    it suits), the volume where the device takes it ("Use the side buttons" where it doesn't), "Add a playlist", and
 *    Connect / Reconnect. Nothing the app would build, no spa slot.
 *  - Adding: the athlete's playlists (a page, then More), a pasted link, a name when Spotify won't say one.
 *  - Editing: a playlist's name and what it suits (toggles that say ✓ as well as their colour), Remove; Disconnect.
 *  - Asked to slow down: one calm line.
 *  - The player's line for a workout's music that couldn't start: "Open Spotify to play …" with Play.
 *  - No <audio> element and no speech anywhere in it (either would stop Spotify on an iPhone).
 */
import { createElement, type ReactElement } from "react";
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { describe, expect, it } from "vitest";
import type { MusicDto } from "@rg/api-client";
import { DockFrame, MUSIC_QUERY, MusicDock, MusicPanel, MusicPill, PlayerMusicTools, recheckOnReturn, WorkoutMusicLine, type PanelActions } from "../../src/music/dock.js";
import { pillTitle } from "../../src/music/dock-model.js";
import { SLOW_LINE, type DockState } from "../../src/music/controller.js";
import { AppShell } from "../../src/shell.js";

const ID = "0123456789abcdefABCDEF";
const noop = () => undefined;
const actions: PanelActions = new Proxy({} as PanelActions, { get: () => noop });

function render(el: ReactElement, music?: MusicDto | null): string {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } });
  if (music !== undefined) qc.setQueryData(MUSIC_QUERY, music);
  return renderToStaticMarkup(createElement(QueryClientProvider, { client: qc }, createElement(MemoryRouter, null, el)));
}

const base: DockState = {
  connection: "connected",
  music: { shortcuts: [] },
  expanded: true,
  player: null,
  readAt: null,
  devices: null,
  busy: null,
  notice: null,
  link: null,
  adding: null,
  playlists: null,
  editing: false,
  editingId: null,
  workout: null,
};
const phone = { id: "phone-1", name: "Phone", type: "Smartphone", supports_volume: false, is_active: true };
const desk = { id: "desk-1", name: "Desktop", type: "Computer", supports_volume: true, volume_percent: 40, is_active: true };
const playing = (device: typeof phone | typeof desk) => ({
  is_playing: true,
  device,
  progress_ms: 1000,
  item: { name: "Subwoofer Lullaby", artists: [{ name: "C418" }], duration_ms: 208_000 },
});
const panel = (state: Partial<DockState>) => render(createElement(MusicPanel, { state: { ...base, ...state }, actions }));

describe("visibility", () => {
  it("draws nothing while the server says the dock is off, or hasn't answered", () => {
    expect(render(createElement(MusicDock, { variant: "shell" }), null)).toBe("");
    expect(render(createElement(MusicDock, { variant: "shell" }))).toBe("");
    expect(render(createElement(MusicDock, { variant: "player" }), null)).toBe("");
  });

  it("on, the resting pill shows — connected or not — and nothing else (no sheet until it is opened)", () => {
    for (const dto of [{ connected: true, music: { shortcuts: [] } }, { connected: false, music: { shortcuts: [] } }]) {
      const html = render(createElement(MusicDock, { variant: "shell" }), dto);
      expect(html).toContain('class="music-dock music-dock--shell"');
      expect(html).toMatch(/<button[^>]*class="music-pill tap-pad"[^>]*aria-label="Music"/);
      expect(html).toContain('aria-haspopup="dialog"');
      expect(html).not.toContain('role="dialog"');
      expect(html).not.toContain("Connect Spotify");
    }
  });

  it("the sheet is drawn beside the pill's fixed box, never inside it (inside, the tab bar covered it)", () => {
    const html = render(
      createElement(DockFrame, { variant: "shell", pill: createElement("button", null, "pill"), sheet: createElement("div", { role: "dialog" }, "sheet") }),
    );
    expect(html).toBe('<div class="music-dock music-dock--shell"><button>pill</button></div><div role="dialog">sheet</div>');
  });

  it("in the session player it is mounted only while the dock is on — dark, nothing at all", () => {
    expect(render(createElement(PlayerMusicTools), null)).toBe("");
    expect(render(createElement(PlayerMusicTools))).toBe("");
    expect(render(createElement(PlayerMusicTools), { connected: true, music: { shortcuts: [] } })).toContain("music-dock--player");
  });

  it("in the session player it is the smaller form", () => {
    const html = render(createElement(MusicDock, { variant: "player" }), { connected: true, music: { shortcuts: [] } });
    expect(html).toContain('class="music-dock music-dock--player"');
  });

  it("the shell carries it on every screen", () => {
    const html = render(createElement(AppShell, null, createElement("p", null, "page")), { connected: true, music: { shortcuts: [] } });
    expect(html).toContain("music-dock--shell");
    expect(html).toContain("shell--music");
    expect(html).toContain('class="music-dock-room"');
    // Off, the shell has no room kept for it.
    const off = render(createElement(AppShell, null, createElement("p", null, "page")), null);
    expect(off).not.toContain("music-dock");
    expect(off).not.toContain("shell--music");
  });
});

describe("the resting pill", () => {
  it("a note alone at rest; the track's short title while it plays", () => {
    const rest = render(createElement(MusicPill, { title: null, expanded: false, onOpen: noop }));
    expect(rest).toContain('aria-label="Music"');
    expect(rest).not.toContain("music-pill-title");
    const html = render(createElement(MusicPill, { title: "Subwoofer Lullaby", expanded: false, onOpen: noop }));
    expect(html).toContain('aria-label="Music: Subwoofer Lullaby"');
    expect(html).toContain('<span class="music-pill-title">Subwoofer Lullaby</span>');
    expect(html).toContain("music-pill--playing");
  });

  it("names the track only while it plays and until it should have ended", () => {
    const state = { ...base, player: playing(phone), readAt: 10_000 };
    expect(pillTitle(state, 10_000)).toBe("Subwoofer Lullaby");
    expect(pillTitle(state, 10_000 + 206_000)).toBe("Subwoofer Lullaby");
    expect(pillTitle(state, 10_000 + 208_000)).toBeNull();
    expect(pillTitle({ ...state, player: { ...playing(phone), is_playing: false } }, 10_000)).toBeNull();
    expect(pillTitle(base, 10_000)).toBeNull();
  });
});

describe("the expanded sheet", () => {
  it("not connected: Connect Spotify, which goes to the Worker's login — and nothing else", () => {
    const html = panel({ connection: "not_connected" });
    expect(html).toMatch(/<a[^>]*href="\/api\/music\/spotify\/login"[^>]*>Connect Spotify<\/a>/);
    expect(html).not.toContain("Add a playlist");
  });

  it("a consent to renew: Reconnect Spotify, saying why in plain words", () => {
    const html = panel({ connection: "reconnect" });
    expect(html).toContain("Spotify needs you to sign in again.");
    expect(html).toMatch(/<a[^>]*href="\/api\/music\/spotify\/login"[^>]*>Reconnect Spotify<\/a>/);
  });

  it("connected: now playing (title · artist), pause and next, the athlete's playlists — each with what it suits — and Add a playlist; nothing the app builds", () => {
    const html = panel({
      player: playing(phone),
      devices: [phone],
      music: {
        shortcuts: [
          { id: "s1", label: "Easy run", uri: `spotify:playlist:${ID}`, shuffle: true, goodFor: ["run"] },
          { id: "spa", label: "Spa Sounds", uri: `spotify:album:${ID}`, shuffle: true, image: "https://i.scdn.co/image/abc", goodFor: ["mobility", "wind-down"] },
        ],
        minecraftPlaylistId: ID,
      },
    });
    expect(html).toContain("Subwoofer Lullaby");
    expect(html).toContain("C418");
    expect(html).toContain('aria-label="Pause"');
    expect(html).toContain('aria-label="Next"');
    expect(html).not.toContain("Minecraft");
    expect(html).not.toContain("spa playlist");
    expect(html).toMatch(/Easy run<\/span><span class="music-shortcut-sub">Runs<\/span>/);
    expect(html).toMatch(/Spa Sounds<\/span><span class="music-shortcut-sub">Mobility · Winding down<\/span>/);
    // Its cover, from Spotify's own host, decorative (the label names it).
    expect(html).toMatch(/<img class="music-cover" src="https:\/\/i.scdn.co\/image\/abc" alt=""/);
    expect(html).toContain("Add a playlist");
    // Each playlist one tap, and a fingertip.
    expect(html).toMatch(/<button[^>]*class="music-shortcut"[^>]*>/);
  });

  it("with no playlist yet: one plain line and Add a playlist (no Edit)", () => {
    const html = panel({});
    expect(html).toContain("Add a playlist to play it from here — and with your workouts.");
    expect(html).not.toContain(">Edit<");
  });

  it("asked to slow down: the one calm line", () => {
    expect(panel({ notice: { text: SLOW_LINE, tone: "info" } })).toMatch(/role="status">Spotify asked us to slow down — back in a few minutes</);
  });

  it("paused, the button says Play", () => {
    const html = panel({ player: { ...playing(phone), is_playing: false }, devices: [phone] });
    expect(html).toContain('aria-label="Play"');
    expect(html).not.toContain('aria-label="Pause"');
  });

  it("the volume: a slider where the device takes it, 'Use the side buttons' where it doesn't, nothing with no device", () => {
    const desktop = panel({ player: playing(desk), devices: [desk] });
    expect(desktop).toMatch(/<input[^>]*type="range"[^>]*aria-label="Volume"[^>]*value="40"/);
    // A phone that refuses remote volume: one small line under now playing, not a line of its own.
    const handset = panel({ player: playing(phone), devices: [phone] });
    expect(handset).not.toContain('type="range"');
    expect(handset).toMatch(/<section class="music-now"[^>]*>.*Volume · use the side buttons.*<\/section>/);
    expect(handset).not.toContain("music-volume-note");
    const none = panel({ devices: [] });
    expect(none).not.toContain('type="range"');
    expect(none).not.toContain("side buttons");
    // Nothing in the player: no volume to set, whatever the devices.
    const idle = panel({ devices: [desk] });
    expect(idle).toContain("Nothing playing");
    expect(idle).not.toContain('type="range"');
  });

  it("a notice and the open-in-Spotify link while a play waits for a device", () => {
    const html = panel({ notice: { text: "No Spotify device is open.", tone: "warn" }, link: `https://open.spotify.com/playlist/${ID}` });
    expect(html).toMatch(/role="status"[^>]*>[^<]*No Spotify device is open\./);
    expect(html).toMatch(new RegExp(`<a[^>]*href="https://open.spotify.com/playlist/${ID}"[^>]*target="_blank"[^>]*>Open in Spotify</a>`));
  });

  it("editing: each playlist's Edit, and Disconnect; its editor — the name, what it suits (each toggle says ✓ when on), Save, Remove", () => {
    const music = { shortcuts: [{ id: "s1", label: "Easy run", uri: `spotify:playlist:${ID}`, shuffle: true, name: "Easy run mix", goodFor: ["run" as const] }] };
    const html = panel({ editing: true, music });
    expect(html).toContain('aria-label="Edit Easy run"');
    expect(html).toContain("Disconnect Spotify");
    expect(html).not.toContain("Rebuild");
    expect(panel({ music }).includes("Disconnect Spotify")).toBe(false);
    const editor = panel({ editing: true, editingId: "s1", music });
    expect(editor).toMatch(/<label[^>]*>Name<\/label>/);
    expect(editor).toMatch(/<input[^>]*type="text"[^>]*value="Easy run"/);
    // Spotify's own name above, when the label differs.
    expect(editor).toContain("Easy run mix");
    expect(editor).toMatch(/role="group" aria-labelledby="[^"]+"/);
    expect(editor).toMatch(/<button[^>]*class="music-tag"[^>]*aria-pressed="true"[^>]*>✓ Runs<\/button>/);
    expect(editor).toMatch(/<button[^>]*class="music-tag"[^>]*aria-pressed="false"[^>]*>Mobility<\/button>/);
    expect(editor).toContain("Winding down");
    expect(editor).toContain("Strength");
    expect(editor).toContain('aria-label="Remove Easy run"');
    expect(editor).toMatch(/<button type="submit"[^>]*>Save<\/button>/);
  });
});

describe("adding a playlist", () => {
  const item = (n: number, extra = {}) => ({ id: `${ID.slice(0, 20)}${n}x`, name: `List ${n}`, uri: `spotify:playlist:${ID.slice(0, 20)}${n}x`, total: n, description: "", image: null, ...extra });

  it("pick one of your playlists (More for the next page), or paste a link", () => {
    const html = panel({ adding: {}, playlists: { items: [item(1)], next: 20 } });
    expect(html).toContain("Your playlists");
    expect(html).toMatch(/<button[^>]*class="music-shortcut"[^>]*>.*?List 1<\/span><\/span><\/button>/);
    expect(html).toMatch(/<button[^>]*>More<\/button>/);
    expect(html).toMatch(/<label[^>]*for="[^"]+"[^>]*>Or paste a playlist or album link<\/label>/);
    expect(html).toContain("Cancel");
    expect(panel({ adding: {}, playlists: { items: [item(1)], next: null } })).not.toMatch(/>More</);
    // While the first page is read.
    expect(panel({ adding: {}, playlists: null })).toContain("Loading your playlists…");
    expect(panel({ adding: {}, playlists: { items: [], next: null } })).toContain("No playlists yet");
  });

  it("one linked already is shown as added, not offered again", () => {
    const html = panel({ adding: {}, playlists: { items: [item(1)], next: null }, music: { shortcuts: [{ id: "s1", label: "List 1", uri: item(1).uri, shuffle: true }] } });
    expect(html).toMatch(/<button[^>]*class="music-shortcut"[^>]*disabled=""[^>]*>.*?List 1<\/span><span class="music-shortcut-sub">Added<\/span>/);
  });

  it("a link Spotify won't name asks for a name; a refused one says why", () => {
    expect(panel({ adding: { needsLabel: { uri: `spotify:playlist:${ID}` } } })).toMatch(/<label[^>]*>Name it<\/label>/);
    expect(panel({ adding: { error: "That isn't a Spotify playlist or album link." } })).toContain("That isn&#x27;t a Spotify playlist or album link.");
  });
});

describe("a workout's music in the player", () => {
  const target = { id: "spa", label: "Spa", uri: `spotify:playlist:${ID}` };
  it("dark, or no music for the session: nothing at all", () => {
    expect(render(createElement(WorkoutMusicLine, { session: "p1", fresh: true, target }), null)).toBe("");
    expect(render(createElement(WorkoutMusicLine, { session: "p1", fresh: true, target: null }), { connected: true, music: { shortcuts: [] } })).toBe("");
    // Nothing to say until the play has been tried.
    expect(render(createElement(WorkoutMusicLine, { session: "p1", fresh: false, target }), { connected: true, music: { shortcuts: [] } })).toBe("");
  });
});

describe("it never stops Spotify", () => {
  it("no <audio> element, no Audio(), no speech, anywhere in the dock", () => {
    const dir = fileURLToPath(new URL("../../src/music/", import.meta.url));
    for (const f of readdirSync(dir)) {
      const src = readFileSync(`${dir}${f}`, "utf8");
      expect(src, f).not.toMatch(/<audio|new Audio\(|speechSynthesis|SpeechSynthesisUtterance|HTMLAudioElement/);
    }
  });
});

describe("a login finished in another browser", () => {
  it("is looked for when the app is back only shortly after Connect was tapped here — never on every return", () => {
    const at = 1_000_000;
    expect(recheckOnReturn({ connection: "not_connected", loginStartedAt: at, now: at + 60_000 })).toBe(true);
    expect(recheckOnReturn({ connection: "reconnect", loginStartedAt: at, now: at + 9 * 60_000 })).toBe(true);
    expect(recheckOnReturn({ connection: "not_connected", loginStartedAt: at, now: at + 11 * 60_000 })).toBe(false);
    expect(recheckOnReturn({ connection: "not_connected", loginStartedAt: null, now: at })).toBe(false);
    expect(recheckOnReturn({ connection: "connected", loginStartedAt: at, now: at + 1000 })).toBe(false);
  });
});

describe("the stylesheet", () => {
  const css = readFileSync(fileURLToPath(new URL("../../src/styles.css", import.meta.url)), "utf8");
  const rule = (selector: string) => {
    const at = css.indexOf(`\n${selector} {`);
    expect(at, selector).toBeGreaterThan(-1);
    return css.slice(at, css.indexOf("}", at));
  };

  it("the pill is compact — 36 px, the small type, a translucent ground — and still a fingertip (its pad); it sits above the nav and the home indicator on phones, at most 45% of the width, and in the rail's corner on desktop", () => {
    const pill = rule(".music-pill");
    expect(pill).toContain("min-height: calc(var(--tap) - var(--space-4))");
    expect(pill).toContain("min-width: calc(var(--tap) - var(--space-4))");
    expect(pill).toContain("var(--text-sm)");
    expect(pill).toMatch(/background: color-mix\(in srgb, var\(--bg-raised\) \d+%, transparent\)/);
    expect(pill).toContain("backdrop-filter");
    // The 44px floor is the shared pad's.
    expect(render(createElement(MusicPill, { title: null, expanded: false, onOpen: noop }))).toMatch(/class="music-pill tap-pad"/);
    const shell = rule(".music-dock--shell");
    expect(shell).toContain("max-width: 45vw");
    expect(shell).toContain("position: fixed");
    expect(shell).toContain("var(--nav-height)");
    expect(shell).toContain("env(safe-area-inset-bottom");
    expect(css).toMatch(/@media \(min-width: 1024px\) \{\s*\.music-dock--shell \{[^}]*bottom: var\(--space-6\)/);
  });

  it("the page keeps room under its last control for the pill below lg; at lg the rail's foot does", () => {
    expect(rule(".music-dock-room")).toContain("var(--tap)");
    expect(css).toMatch(/@media \(min-width: 1024px\) \{[^@]*\.music-dock-room \{\s*display: none;/);
    expect(css).toMatch(/\.shell--music \.side-nav \.nav-footer \{[^}]*padding-bottom: calc\(var\(--tap\)/);
  });

  it("below lg it steps aside where a page pins its own action row above the tab bar (it covered Start now); at lg it stays", () => {
    const hide = /\.shell:has\(\.stu-build-foot\) \.music-dock--shell,\s*\.shell:has\(\.stu > \.stu-added--on\) \.music-dock--shell \{\s*display: none;/;
    expect(css).toMatch(hide);
    // At lg it comes back: four classes, after the rules that hide it.
    const back = css.search(/\.shell\.shell--music \.music-dock\.music-dock--shell \{\s*display: flex;/);
    expect(back).toBeGreaterThan(css.search(hide));
    // The rows it steps aside for are still the ones pinned there.
    expect(rule(".stu-build-foot")).toContain("position: sticky");
    expect(rule(".stu > .stu-added--on")).toContain("position: sticky");
  });

  it("in the player it is one of the top bar's tools: in its row, never floating over the player's lines", () => {
    const player = rule(".music-dock--player");
    expect(player).not.toContain("position: fixed");
    // The size and edge of the player's own tools.
    const pill = rule(".music-dock--player .music-pill");
    expect(pill).toContain("width: var(--tap)");
    expect(pill).toContain("height: var(--tap)");
    expect(pill).toContain("border-radius: var(--radius-md)");
  });
});
