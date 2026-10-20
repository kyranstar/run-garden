import type { APIRequestContext, Page } from "@playwright/test";
import { test, expect } from "./fixtures.js";

/**
 * The music dock (2026-10-17; one list of the athlete's own playlists, 2026-10-19) against the fixture stack's
 * stand-in Spotify (services/spotify-fixture.ts): the stack must run with the dock on — `RG_E2E_SPOTIFY=1 bash
 * apps/web/e2e/fixture-stack.sh` — else this file skips. Nothing reaches Spotify: the fixture login connects a fixture
 * account and the dock's calls go to the worker. No model either: on the fixture stack the playlists are tagged by
 * their words.
 *
 * The stand-in keeps one player for the whole stack, so run this file with `--workers=1`.
 *
 * RG_MUSIC_SHOTS=<dir> also writes the screenshots (resting, the add flow, a playlist's editor, playing, expanded, not
 * connected, a session's Music row and its Change, the player's line, the slow-down line, in the player; light and
 * dark) to <dir>, named <state>__<phone|desktop>__<light|dark>.png.
 */
test.skip(process.env.RG_E2E_SPOTIFY !== "1", "the music dock is off unless the stack runs with RG_E2E_SPOTIFY=1");
test.describe.configure({ mode: "serial" });

const FIXTURE_API = "/api/music/fixture/v1";
const BEARER = { authorization: "Bearer fixture-access-token" };
/** The stand-in's editorial playlist ("Spa Sounds"): playable, its name and description readable, its items not. */
const SPA_ID = "fxplSpaEditorial000000";
/** The athlete's own "Stretch" playlist in the stand-in. */
const STRETCH_ID = "fxplStretch00000000000";
/** The stand-in's "Rain Studies" (an album the athlete can read). */
const ALBUM_ID = "fxalbrain0000000000000";

async function fixtureSpotify(req: APIRequestContext, baseURL: string, method: "GET" | "PUT" | "DELETE", path: string, data?: unknown) {
  return req.fetch(`${baseURL}${FIXTURE_API}${path}`, { method, headers: BEARER, ...(data === undefined ? {} : { data }) });
}

async function nowPlaying(req: APIRequestContext, baseURL: string): Promise<{ is_playing: boolean; device: { id: string }; context: { uri: string } } | null> {
  const res = await fixtureSpotify(req, baseURL, "GET", "/me/player");
  return res.status() === 204 ? null : ((await res.json()) as never);
}

/** Connected, as a finished login leaves it (the fixture login stores a fixture account and redirects). */
async function connect(req: APIRequestContext, baseURL: string) {
  const res = await req.get(`${baseURL}/api/music/spotify/login`, { maxRedirects: 0 });
  expect(res.status()).toBe(302);
}

type Stored = { label: string; name?: string; description?: string; goodFor?: string[] };
const stored = async (req: APIRequestContext, baseURL: string): Promise<Stored[]> =>
  ((await (await req.get(`${baseURL}/api/music`)).json()) as { music: { shortcuts: Stored[] } }).music.shortcuts;

/** A mobility workout today, made as the Studio makes one: its sheet's address. */
async function mobilityToday(req: APIRequestContext, baseURL: string, title: string): Promise<string> {
  const today = ((await (await req.get(`${baseURL}/api/plan/today`)).json()) as { today: string }).today;
  const doc = {
    version: 1,
    title,
    intent: { summary: "Open the hips and the upper back.", goals: ["mobility"], focus: [], effort: "maintain" },
    parts: [
      {
        purpose: "main",
        format: "flow",
        items: [
          { kind: "exercise", libraryId: "catCow", dose: { sets: 1, holdSec: 40 } },
          { kind: "exercise", libraryId: "threadNeedle", dose: { sets: 1, holdSec: 40, perSide: true } },
        ],
      },
    ],
    source: { kind: "studio" },
  };
  const res = await req.post(`${baseURL}/api/workouts`, { data: { date: today, time: "23:30", doc, clientId: `music-e2e-${Date.now()}-${Math.random().toString(36).slice(2, 8)}` } });
  expect(res.ok(), await res.text()).toBeTruthy();
  return ((await res.json()) as { workout: { id: string } }).workout.id;
}

/** Open a workout's sheet, answering today's check if it asks first: its Start in sight. */
async function openSheet(page: Page, id: string) {
  await page.goto(`/plan?workout=${encodeURIComponent(id)}`);
  const radio = page.locator(".session-precheck [role=radio]").first();
  const start = page.getByRole("button", { name: /^Start · \d+ min$/ });
  await expect(radio.or(start)).toBeVisible({ timeout: 30_000 });
  if (await radio.isVisible()) {
    await radio.click();
    await page.getByRole("button", { name: "Build", exact: true }).click();
  }
  await expect(start).toBeVisible({ timeout: 30_000 });
}

test.beforeEach(async ({ context, baseURL }) => {
  const req = context.request;
  expect((await req.post(`${baseURL}/api/dev/fixture-login`)).ok()).toBeTruthy();
  // From scratch: no Spotify, no playlists, the stand-in's player stopped and both its devices listed.
  expect((await req.delete(`${baseURL}/api/music/spotify`)).ok()).toBeTruthy();
  expect((await req.put(`${baseURL}/api/music`, { data: { shortcuts: [] } })).ok()).toBeTruthy();
  expect((await fixtureSpotify(req, baseURL!, "DELETE", "/state")).status()).toBe(204);
});

const pill = (page: Page) => page.locator(".music-dock button.music-pill");
const sheet = (page: Page) => page.getByRole("dialog", { name: "Music" });

async function shot(page: Page, name: string, projectName: string) {
  const dir = process.env.RG_MUSIC_SHOTS;
  if (!dir) return;
  const device = projectName === "iphone" ? "phone" : "desktop";
  for (const scheme of ["light", "dark"] as const) {
    await page.emulateMedia({ colorScheme: scheme });
    await page.waitForTimeout(150);
    await page.screenshot({ path: `${dir}/${name}__${device}__${scheme}.png` });
  }
  await page.emulateMedia({ colorScheme: "light" });
}

test("the pill rests and connects; a playlist picked from the athlete's own is named and tagged, and one tap plays it", async ({ page, context, baseURL }, info) => {
  const req = context.request;
  await page.goto("/");
  await expect(pill(page)).toBeVisible({ timeout: 30_000 });
  await expect(pill(page)).toHaveAttribute("aria-label", "Music");
  await expect(sheet(page)).toHaveCount(0);
  await shot(page, "resting", info.project.name);

  await pill(page).click();
  await expect(sheet(page).getByRole("link", { name: "Connect Spotify" })).toBeVisible();
  await shot(page, "not-connected", info.project.name);
  await sheet(page).getByRole("link", { name: "Connect Spotify" }).click();

  // Back in the app with the dock open, the parameter gone; nothing the app would build is offered.
  await expect(sheet(page).getByText("Add a playlist to play it from here — and with your workouts.")).toBeVisible({ timeout: 30_000 });
  await expect(page).not.toHaveURL(/music=/);
  await expect(sheet(page).getByText(/Minecraft|spa playlist/)).toHaveCount(0);
  expect(await nowPlaying(req, baseURL!)).toBeNull();

  // The add flow lists the athlete's own playlists.
  await sheet(page).getByRole("button", { name: "Add a playlist" }).click();
  await expect(sheet(page).getByRole("button", { name: "Stretch" })).toBeVisible();
  await expect(sheet(page).getByRole("button", { name: "Easy run" })).toBeVisible();
  await shot(page, "add-flow", info.project.name);
  await sheet(page).getByRole("button", { name: "Stretch" }).click();
  // Named from Spotify, with what it suits (its description: "Slow stretches & long holds").
  const row = sheet(page).locator(".music-shortcut", { hasText: "Stretch" });
  await expect(row).toContainText("Mobility");
  expect(await stored(req, baseURL!)).toEqual([
    expect.objectContaining({ label: "Stretch", name: "Stretch", description: "Slow stretches & long holds", goodFor: ["mobility"] }),
  ]);

  await row.click();
  await expect(sheet(page).locator(".music-now-title")).toBeVisible({ timeout: 15_000 });
  const playing = await nowPlaying(req, baseURL!);
  expect(playing?.is_playing).toBe(true);
  expect(playing?.context.uri).toBe(`spotify:playlist:${STRETCH_ID}`);
  // The phone plays on its Spotify app (the kind it runs on), which takes no remote volume; the desktop on its own.
  if (info.project.name === "iphone") {
    expect(playing?.device.id).toBe("fixture-phone");
    await expect(sheet(page).getByText("Use the side buttons")).toBeVisible();
  } else {
    expect(playing?.device.id).toBe("fixture-desktop");
    await expect(sheet(page).getByRole("slider", { name: "Volume" })).toBeVisible();
  }
  await shot(page, "expanded", info.project.name);

  await sheet(page).getByRole("button", { name: "Close" }).click();
  await expect(pill(page)).toHaveClass(/music-pill--playing/);
  await expect(pill(page).locator(".music-pill-title")).not.toBeEmpty();
  await shot(page, "playing", info.project.name);
});

test("pasted: an editorial playlist named and described from Spotify, an album, a track refused; Edit renames and retags", async ({ page, context, baseURL }, info) => {
  const req = context.request;
  await connect(req, baseURL!);
  await page.goto("/");
  await pill(page).click();

  await sheet(page).getByRole("button", { name: "Add a playlist" }).click();
  await sheet(page).getByLabel("Or paste a playlist or album link").fill(`https://open.spotify.com/playlist/${SPA_ID}?si=abc`);
  await sheet(page).getByRole("button", { name: "Add", exact: true }).click();
  await expect(sheet(page).locator(".music-shortcut", { hasText: "Spa Sounds" })).toContainText("Mobility · Winding down");

  await sheet(page).getByRole("button", { name: "Add a playlist" }).click();
  await sheet(page).getByLabel("Or paste a playlist or album link").fill("https://open.spotify.com/track/0123456789abcdefABCDEF");
  await sheet(page).getByRole("button", { name: "Add", exact: true }).click();
  await expect(sheet(page).getByText("That isn't a Spotify playlist or album link.")).toBeVisible();
  await sheet(page).getByLabel("Or paste a playlist or album link").fill(`spotify:album:${ALBUM_ID}`);
  await sheet(page).getByRole("button", { name: "Add", exact: true }).click();
  await expect(sheet(page).getByRole("button", { name: /Rain Studies/ })).toBeVisible();
  expect((await stored(req, baseURL!)).map((s) => s.label)).toEqual(["Spa Sounds", "Rain Studies"]);
  // Spotify's escaped description, kept plain — its link's markup gone.
  expect((await stored(req, baseURL!))[0]!.description).toBe("Calm music for yoga, massage & rest. More");

  await sheet(page).getByRole("button", { name: "Edit", exact: true }).click();
  await sheet(page).getByRole("button", { name: "Edit Spa Sounds" }).click();
  await sheet(page).getByLabel("Name").fill("Spa");
  await sheet(page).getByRole("button", { name: "✓ Mobility" }).click();
  await expect(sheet(page).getByRole("button", { name: "Mobility", exact: true })).toHaveAttribute("aria-pressed", "false");
  await shot(page, "editor", info.project.name);
  await sheet(page).getByRole("button", { name: "Save", exact: true }).click();
  await expect(sheet(page).locator(".music-shortcut", { hasText: "Spa" }).first()).toContainText("Winding down");
  expect((await stored(req, baseURL!))[0]).toEqual(expect.objectContaining({ label: "Spa", name: "Spa Sounds", goodFor: ["wind-down"] }));

  await sheet(page).getByRole("button", { name: "Done", exact: true }).click();
  await sheet(page).locator(".music-shortcut", { hasText: "Spa" }).first().click();
  await expect.poll(async () => (await nowPlaying(req, baseURL!))?.context.uri).toBe(`spotify:playlist:${SPA_ID}`);
});

test("no Spotify device open: the link to open it, and the play goes through once the app is back", async ({ page, context, baseURL }) => {
  const req = context.request;
  await connect(req, baseURL!);
  expect((await req.put(`${baseURL}/api/music`, { data: { shortcuts: [{ id: "spa", label: "Spa", uri: `spotify:playlist:${SPA_ID}`, shuffle: true, goodFor: [] }] } })).ok()).toBeTruthy();
  expect((await fixtureSpotify(req, baseURL!, "PUT", "/state/devices", { none: true })).status()).toBe(204);
  // The browser refuses to open a window unasked (as it may once the tap has been awaited): the dock offers the link.
  await page.addInitScript(() => {
    window.open = () => null;
  });
  await page.goto("/");
  await pill(page).click();
  await sheet(page).getByRole("button", { name: /^Spa$/ }).click();
  await expect(sheet(page).getByText("No Spotify device is open.")).toBeVisible();
  await expect(sheet(page).getByRole("link", { name: "Open in Spotify" })).toHaveAttribute("href", `https://open.spotify.com/playlist/${SPA_ID}`);

  // The athlete opens Spotify (its device is listed again) and comes back to the app.
  expect((await fixtureSpotify(req, baseURL!, "PUT", "/state/devices", { none: false })).status()).toBe(204);
  await page.evaluate(() => {
    for (const state of ["hidden", "visible"]) {
      Object.defineProperty(document, "visibilityState", { value: state, configurable: true });
      document.dispatchEvent(new Event("visibilitychange"));
    }
  });
  await expect.poll(async () => (await nowPlaying(req, baseURL!))?.context.uri, { timeout: 15_000 }).toBe(`spotify:playlist:${SPA_ID}`);
  await expect(sheet(page).getByRole("link", { name: "Open in Spotify" })).toHaveCount(0);
});

test("a spa playlist linked before names and tags is read and tagged on the first open; a mobility workout's sheet says it, Change changes it, and Start plays it", async ({ page, context, baseURL }, info) => {
  const req = context.request;
  await connect(req, baseURL!);
  // As an earlier version left it: the spa slot, no name, no tags.
  expect((await req.put(`${baseURL}/api/music`, { data: { shortcuts: [{ id: "spa", label: "Spa", uri: `spotify:playlist:${SPA_ID}`, shuffle: true }] } })).ok()).toBeTruthy();
  await page.goto("/");
  await pill(page).click();
  await expect(sheet(page).locator(".music-shortcut", { hasText: "Spa Sounds" })).toContainText("Mobility · Winding down", { timeout: 15_000 });
  expect(await stored(req, baseURL!)).toEqual([expect.objectContaining({ label: "Spa Sounds", name: "Spa Sounds", goodFor: ["mobility", "wind-down"] })]);
  await sheet(page).getByRole("button", { name: "Close" }).click();

  const id = await mobilityToday(req, baseURL!, "Evening hips");
  await openSheet(page, id);
  const music = page.locator(".session-music");
  await expect(music).toHaveText("Music Spa Sounds (default)Change");
  await shot(page, "sheet-music", info.project.name);

  await music.getByRole("button", { name: /Change the music/ }).click();
  const change = page.getByRole("dialog", { name: "Music for this workout" });
  await expect(change.getByRole("button", { name: "Use the default · Spa Sounds" })).toHaveAttribute("aria-pressed", "true");
  // Each a fingertip (to the pixel: a dialog still settling measures 43.99997).
  for (const b of await change.getByRole("button").all()) {
    const box = (await b.boundingBox())!;
    expect(Math.round(box.height), await b.innerText()).toBeGreaterThanOrEqual(44);
  }
  await shot(page, "sheet-music-change", info.project.name);
  await change.getByRole("button", { name: "No music" }).click();
  await expect(music).toHaveText("Music No musicChange");
  await music.getByRole("button", { name: /Change the music/ }).click();
  await page.getByRole("dialog", { name: "Music for this workout" }).getByRole("button", { name: "Use the default · Spa Sounds" }).click();
  await expect(music).toHaveText("Music Spa Sounds (default)Change");

  expect(await nowPlaying(req, baseURL!)).toBeNull();
  await page.getByRole("button", { name: /^Start · \d+ min$/ }).click();
  await expect(page).toHaveURL(new RegExp(`/session/${id}`), { timeout: 15_000 });
  await expect(page.locator(".player-count")).toContainText("1 of ");
  // At Start, the workout's music plays on the device Spotify would use; the player says nothing about it.
  await expect.poll(async () => (await nowPlaying(req, baseURL!))?.context.uri, { timeout: 15_000 }).toBe(`spotify:playlist:${SPA_ID}`);
  // Its line's room is kept from Start (nothing moves when a line comes), and says nothing while the music plays.
  await expect(page.locator(".player-music")).toHaveText("");
  await expect(page.locator(".player-top .music-dock--player .music-pill")).toHaveClass(/music-pill--playing/, { timeout: 15_000 });
});

test("no device at Start: one quiet line in the player, whose Play opens Spotify, and the music plays once the app is back", async ({ page, context, baseURL }, info) => {
  const req = context.request;
  await connect(req, baseURL!);
  expect(
    (await req.put(`${baseURL}/api/music`, {
      data: { shortcuts: [{ id: "spa", label: "Spa", uri: `spotify:playlist:${SPA_ID}`, shuffle: true, name: "Spa Sounds", goodFor: ["mobility", "wind-down"] }] },
    })).ok(),
  ).toBeTruthy();
  expect((await fixtureSpotify(req, baseURL!, "PUT", "/state/devices", { none: true })).status()).toBe(204);
  await page.addInitScript(() => {
    window.open = () => null;
  });
  const id = await mobilityToday(req, baseURL!, "Morning reset");
  await openSheet(page, id);
  await expect(page.locator(".session-music")).toHaveText("Music Spa (default)Change");
  await page.getByRole("button", { name: /^Start · \d+ min$/ }).click();
  await expect(page.locator(".player-count")).toContainText("1 of ", { timeout: 15_000 });
  const line = page.locator(".player-music");
  // The line's room is kept from the first draw: the stage is where it will stay (review-M M8).
  const stage = page.locator(".player-main");
  const before = (await stage.boundingBox())!.y;
  await expect(line).toContainText("Open Spotify to play Spa", { timeout: 15_000 });
  expect((await stage.boundingBox())!.y).toBe(before);
  await shot(page, "player-line", info.project.name);
  await line.getByRole("button", { name: "Play" }).click();
  // The browser wouldn't open Spotify unasked: the link is there to tap.
  await expect(line.getByRole("link", { name: "Open Spotify" })).toHaveAttribute("href", `https://open.spotify.com/playlist/${SPA_ID}`);
  expect((await fixtureSpotify(req, baseURL!, "PUT", "/state/devices", { none: false })).status()).toBe(204);
  await page.evaluate(() => {
    for (const state of ["hidden", "visible"]) {
      Object.defineProperty(document, "visibilityState", { value: state, configurable: true });
      document.dispatchEvent(new Event("visibilitychange"));
    }
  });
  await expect.poll(async () => (await nowPlaying(req, baseURL!))?.context.uri, { timeout: 15_000 }).toBe(`spotify:playlist:${SPA_ID}`);
  await expect(line).toHaveText("");
});

test("Spotify says slow down: one calm line, and a tap says how long — nothing sent", async ({ page, context, baseURL }, info) => {
  const req = context.request;
  await connect(req, baseURL!);
  expect((await req.put(`${baseURL}/api/music`, { data: { shortcuts: [{ id: "spa", label: "Spa", uri: `spotify:playlist:${SPA_ID}`, shuffle: true, goodFor: [] }] } })).ok()).toBeTruthy();
  expect((await fixtureSpotify(req, baseURL!, "PUT", "/state/limit", { count: 1 })).status()).toBe(204);
  await page.goto("/");
  await pill(page).click();
  await expect(sheet(page).getByText("Spotify asked us to slow down — back in a few minutes")).toBeVisible({ timeout: 15_000 });
  await shot(page, "slow-down", info.project.name);
  await sheet(page).getByRole("button", { name: /^Spa$/ }).click();
  await expect(sheet(page).getByText("Spotify asked us to slow down — back in about a minute.")).toBeVisible();
  expect(await nowPlaying(req, baseURL!)).toBeNull();
});

test("a mobility quick start's Start now plays the playlist good for mobility", async ({ page, context, baseURL }) => {
  const req = context.request;
  await connect(req, baseURL!);
  expect(
    (await req.put(`${baseURL}/api/music`, {
      data: {
        shortcuts: [
          { id: "s1", label: "Easy run", uri: "spotify:playlist:fxplEasyRun00000000000", shuffle: true, goodFor: ["run"] },
          { id: "spa", label: "Spa", uri: `spotify:playlist:${SPA_ID}`, shuffle: true, goodFor: ["mobility", "wind-down"] },
        ],
      },
    })).ok(),
  ).toBeTruthy();
  await page.goto("/studio/build/quick/hip_opener");
  await expect(page.getByRole("button", { name: "Start now" })).toBeVisible({ timeout: 30_000 });
  await page.getByRole("button", { name: "Start now" }).click();
  // Today's check may ask first; one this quick start left today (an earlier run's, discarded below) is offered again.
  const check = page.getByRole("dialog").getByRole("radiogroup");
  const again = page.getByRole("button", { name: "Continue it" });
  await expect(check.or(again).or(page.locator(".player-count"))).toBeVisible({ timeout: 15_000 });
  if (await again.isVisible()) await again.click();
  else if (await check.isVisible()) {
    await check.getByRole("radio").nth(2).click();
    await page.getByRole("dialog").getByRole("button", { name: "Save", exact: true }).click();
  }
  await expect(page).toHaveURL(/\/session\//, { timeout: 15_000 });
  await expect(page.locator(".player-count")).toContainText("1 of ");
  await expect.poll(async () => (await nowPlaying(req, baseURL!))?.context.uri, { timeout: 15_000 }).toBe(`spotify:playlist:${SPA_ID}`);
  // Left un-started for the next run: ended, and discarded.
  await page.getByRole("button", { name: "Leave the session" }).click();
  await page.getByRole("button", { name: "End and review" }).click();
  await page.getByRole("button", { name: "Discard", exact: true }).click();
  await page.getByRole("button", { name: "Discard session" }).click();
  await expect(page).not.toHaveURL(/\/session\//, { timeout: 15_000 });
});

test("in the session player the dock is one of the top bar's tools, over none of the player's lines or controls — at 375 px with the warning and the hints showing", async ({ page, context, baseURL }, info) => {
  const req = context.request;
  await connect(req, baseURL!);
  // The narrowest common phone.
  if (info.project.name === "iphone") await page.setViewportSize({ width: 375, height: 812 });
  await page.goto("/studio/build/quick/desk_reset");
  await expect(page.getByRole("button", { name: "Start now" })).toBeVisible({ timeout: 30_000 });
  // The builder pins its actions above the tab bar: below lg the pill steps aside there; at lg it stays in the rail.
  if (info.project.name === "iphone") await expect(pill(page)).toBeHidden();
  else await expect(pill(page)).toBeVisible();
  await page.getByRole("button", { name: "Start now" }).click();
  // Today's check may ask first; a session of this one started earlier today is continued.
  const check = page.getByRole("dialog").getByRole("radiogroup");
  const again = page.getByRole("button", { name: "Continue it" });
  await expect(check.or(again).or(page.locator(".player-count"))).toBeVisible({ timeout: 15_000 });
  if (await again.isVisible()) await again.click();
  else if (await check.isVisible()) {
    await check.getByRole("radio").nth(2).click();
    await page.getByRole("dialog").getByRole("button", { name: "Save", exact: true }).click();
  }
  await expect(page).toHaveURL(/\/session\//, { timeout: 15_000 });
  await expect(page.locator(".player-count")).toContainText("1 of ");

  // The player's own lines at their fullest: this device can't keep the session (its storage refused — the warning),
  // audio not yet unlocked ("Tap for sound"), and a phone with a ring/silent switch, told once (the hint).
  await page.addInitScript(() => {
    const define = (target: object, key: string, value: unknown) => {
      try {
        Object.defineProperty(target, key, { value, configurable: true });
      } catch {
        /* the browser's own, kept */
      }
    };
    define(window, "indexedDB", { open: () => { throw new Error("refused"); } });
    if (!("audioSession" in navigator)) define(navigator, "audioSession", { type: "auto" });
    if (/iPhone/.test(navigator.userAgent)) define(Navigator.prototype, "maxTouchPoints", 5);
  });
  await page.reload();
  await expect(page.locator(".player-count")).toContainText("1 of ", { timeout: 15_000 });
  await expect(page.locator(".player-warn")).toBeVisible();
  if (info.project.name === "iphone") await expect(page.getByText("Cues follow your ring/silent switch.")).toBeVisible();

  const dock = page.locator(".player-top .player-tools .music-dock--player button.music-pill");
  await expect(dock).toBeVisible();
  const box = (await dock.boundingBox())!;
  // Over none of the player's own: its top bar's other controls and count, the warning and the hints (and the hint's
  // OK), and its actions at the foot.
  const theirs = page.locator(
    ".player-top > button, .player-top .player-tools > button, .player-count, .player-warn, .player-hint, .player-hint button, .player-actions button",
  );
  expect(await theirs.count()).toBeGreaterThan(4);
  for (const el of await theirs.all()) {
    if (!(await el.isVisible())) continue;
    const c = (await el.boundingBox())!;
    const overlaps = box.x < c.x + c.width && c.x < box.x + box.width && box.y < c.y + c.height && c.y < box.y + box.height;
    expect(overlaps, `the dock over "${(await el.getAttribute("aria-label")) ?? (await el.textContent())}"`).toBe(false);
  }
  await shot(page, "player", info.project.name);
  await dock.click();
  await expect(sheet(page).getByRole("button", { name: "Add a playlist" })).toBeVisible();
  await shot(page, "player-expanded", info.project.name);
  await sheet(page).getByRole("button", { name: "Close" }).click();
  // Nothing played on its own (no playlist, so no workout's music either).
  expect(await nowPlaying(req, baseURL!)).toBeNull();
});
