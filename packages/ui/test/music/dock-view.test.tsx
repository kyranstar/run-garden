/**
 * The music dock, drawn (2026-10-17; packages/ui/src/music/dock.tsx). renderToStaticMarkup, node env.
 *
 *  - Hidden altogether while the server says the dock is off (no Client ID: a 404), or hasn't answered.
 *  - Resting: a small pill — a note, or the track's short title while it plays — in the shell and, smaller, in the
 *    session player.
 *  - Expanded: now playing, play/pause and next, the shortcuts (one tap = play), the volume where the device takes it
 *    ("Use the side buttons" where it doesn't), "Add a shortcut", and Connect / Reconnect.
 *  - Adding: a pasted link, the athlete's playlists, a name when Spotify won't say one.
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
import { MUSIC_QUERY, MusicDock, MusicPanel, MusicPill, type PanelActions } from "../../src/music/dock.js";
import { pillTitle } from "../../src/music/dock-model.js";
import type { DockState } from "../../src/music/controller.js";
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
  build: null,
  adding: null,
  playlists: null,
  editing: false,
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
      expect(html).toMatch(/<button[^>]*class="music-pill"[^>]*aria-label="Music"/);
      expect(html).toContain('aria-haspopup="dialog"');
      expect(html).not.toContain('role="dialog"');
      expect(html).not.toContain("Connect Spotify");
    }
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
    expect(html).not.toContain("Minecraft");
    expect(html).not.toContain("Add a shortcut");
  });

  it("a consent to renew: Reconnect Spotify, saying why in plain words", () => {
    const html = panel({ connection: "reconnect" });
    expect(html).toContain("Spotify needs you to sign in again.");
    expect(html).toMatch(/<a[^>]*href="\/api\/music\/spotify\/login"[^>]*>Reconnect Spotify<\/a>/);
  });

  it("connected: now playing (title · artist), pause and next, the shortcuts, and Add a shortcut", () => {
    const html = panel({
      player: playing(phone),
      devices: [phone],
      music: { shortcuts: [{ id: "s1", label: "Easy run", uri: `spotify:playlist:${ID}`, shuffle: true }] },
    });
    expect(html).toContain("Subwoofer Lullaby");
    expect(html).toContain("C418");
    expect(html).toContain('aria-label="Pause"');
    expect(html).toContain('aria-label="Next"');
    expect(html).toContain("Minecraft, complete");
    expect(html).toContain("Add your spa playlist");
    expect(html).toContain("Easy run");
    expect(html).toContain("Add a shortcut");
    // Each shortcut one tap, and a fingertip.
    expect(html).toMatch(/<button[^>]*class="music-shortcut"[^>]*>/);
  });

  it("paused, the button says Play", () => {
    const html = panel({ player: { ...playing(phone), is_playing: false }, devices: [phone] });
    expect(html).toContain('aria-label="Play"');
    expect(html).not.toContain('aria-label="Pause"');
  });

  it("the volume: a slider where the device takes it, 'Use the side buttons' where it doesn't, nothing with no device", () => {
    const desktop = panel({ player: playing(desk), devices: [desk] });
    expect(desktop).toMatch(/<input[^>]*type="range"[^>]*aria-label="Volume"[^>]*value="40"/);
    const handset = panel({ player: playing(phone), devices: [phone] });
    expect(handset).not.toContain('type="range"');
    expect(handset).toContain("Use the side buttons");
    const none = panel({ devices: [] });
    expect(none).not.toContain('type="range"');
    expect(none).not.toContain("Use the side buttons");
  });

  it("a notice and the open-in-Spotify link while a play waits for a device", () => {
    const html = panel({ notice: { text: "No Spotify device is open.", tone: "warn" }, link: `https://open.spotify.com/playlist/${ID}` });
    expect(html).toMatch(/role="status"[^>]*>[^<]*No Spotify device is open\./);
    expect(html).toMatch(new RegExp(`<a[^>]*href="https://open.spotify.com/playlist/${ID}"[^>]*target="_blank"[^>]*>Open in Spotify</a>`));
  });

  it("the build's count", () => {
    expect(panel({ notice: { text: "8 of 9 albums found", tone: "info" }, build: { found: 8, of: 9, missing: ["Minecraft: Chaos Cubed"] } })).toContain(
      "8 of 9 albums found",
    );
  });

  it("editing: remove a shortcut, rebuild Minecraft, disconnect", () => {
    const html = panel({
      editing: true,
      music: { shortcuts: [{ id: "s1", label: "Easy run", uri: `spotify:playlist:${ID}`, shuffle: true }], minecraftPlaylistId: ID },
    });
    expect(html).toContain('aria-label="Remove Easy run"');
    expect(html).toContain("Rebuild");
    expect(html).toContain("Disconnect Spotify");
    expect(panel({}).includes("Disconnect Spotify")).toBe(false);
  });
});

describe("adding a shortcut", () => {
  it("paste a link, or pick one of your playlists", () => {
    const html = panel({ adding: { target: "custom" }, playlists: [{ id: ID, name: "Easy run", uri: `spotify:playlist:${ID}`, total: 30 }] });
    expect(html).toMatch(/<label[^>]*for="[^"]+"[^>]*>Paste a playlist or album link<\/label>/);
    expect(html).toContain("Your playlists");
    expect(html).toMatch(/<button[^>]*class="music-shortcut"[^>]*>.*?Easy run<\/span><\/button>/);
    expect(html).toContain("Cancel");
  });

  it("the spa slot says so", () => {
    expect(panel({ adding: { target: "spa" } })).toContain("Your spa playlist");
  });

  it("a link Spotify won't name asks for a name; a refused one says why", () => {
    expect(panel({ adding: { target: "custom", needsLabel: { uri: `spotify:playlist:${ID}` } } })).toMatch(/<label[^>]*>Name it<\/label>/);
    expect(panel({ adding: { target: "custom", error: "That isn't a Spotify playlist or album link." } })).toContain(
      "That isn&#x27;t a Spotify playlist or album link.",
    );
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

describe("the stylesheet", () => {
  const css = readFileSync(fileURLToPath(new URL("../../src/styles.css", import.meta.url)), "utf8");
  const rule = (selector: string) => {
    const at = css.indexOf(`\n${selector} {`);
    expect(at, selector).toBeGreaterThan(-1);
    return css.slice(at, css.indexOf("}", at));
  };

  it("the pill is a fingertip, sits above the nav and the home indicator on phones, and in the rail's corner on desktop", () => {
    expect(rule(".music-pill")).toContain("min-height: var(--tap)");
    expect(rule(".music-pill")).toContain("min-width: var(--tap)");
    const shell = rule(".music-dock--shell");
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

  it("in the player it stays clear of the top bar and the safe area", () => {
    const player = rule(".music-dock--player");
    expect(player).toContain("env(safe-area-inset-top");
  });
});
