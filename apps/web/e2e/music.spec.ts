import type { APIRequestContext, Page } from "@playwright/test";
import { test, expect } from "./fixtures.js";

/**
 * The music dock (2026-10-17) against the fixture stack's stand-in Spotify (services/spotify-fixture.ts): the stack
 * must run with the dock on — `RG_E2E_SPOTIFY=1 bash apps/web/e2e/fixture-stack.sh` — else this file skips. Nothing
 * reaches Spotify: the fixture login connects a fixture account and the dock's calls go to the worker.
 *
 * The stand-in keeps one player for the whole stack, so run this file with `--workers=1`.
 *
 * RG_MUSIC_SHOTS=<dir> also writes the dock's screenshots (resting, playing, expanded, not connected, in the player;
 * light and dark) to <dir>, named <state>__<phone|desktop>__<light|dark>.png.
 */
test.skip(process.env.RG_E2E_SPOTIFY !== "1", "the music dock is off unless the stack runs with RG_E2E_SPOTIFY=1");
test.describe.configure({ mode: "serial" });

const FIXTURE_API = "/api/music/fixture/v1";
const BEARER = { authorization: "Bearer fixture-access-token" };
/** The stand-in's editorial playlist ("Spa Sounds"): playable and nameable, its items not readable. */
const SPA_ID = "fxplSpaEditorial000000";
/** The stand-in's Volume Beta (an album the athlete can read). */
const BETA_ID = "fxalbbeta0000000000000";

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

test.beforeEach(async ({ context, baseURL }) => {
  const req = context.request;
  expect((await req.post(`${baseURL}/api/dev/fixture-login`)).ok()).toBeTruthy();
  // From scratch: no Spotify, no shortcuts, the stand-in's player stopped and both its devices listed.
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

test("the pill rests, connects through the Worker, and plays only when asked", async ({ page, context, baseURL }, info) => {
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

  // Back in the app with the dock open, the parameter gone.
  await expect(sheet(page).getByRole("button", { name: /Minecraft, complete/ })).toBeVisible({ timeout: 30_000 });
  await expect(page).not.toHaveURL(/music=/);
  await expect(sheet(page).getByRole("button", { name: /Add your spa playlist/ })).toBeVisible();
  // Opening it played nothing.
  expect(await nowPlaying(req, baseURL!)).toBeNull();

  await sheet(page).getByRole("button", { name: /Minecraft, complete/ }).click();
  await expect(sheet(page).getByText("8 of 9 albums found")).toBeVisible({ timeout: 30_000 });
  await expect(sheet(page).locator(".music-now-title")).toBeVisible();
  const playing = await nowPlaying(req, baseURL!);
  expect(playing?.is_playing).toBe(true);
  expect(playing?.context.uri).toMatch(/^spotify:playlist:/);
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

test("shortcuts: the spa playlist by link, one of the athlete's playlists, an album by link (a track refused) — and one tap plays", async ({ page, context, baseURL }) => {
  const req = context.request;
  await connect(req, baseURL!);
  await page.goto("/");
  await pill(page).click();

  await sheet(page).getByRole("button", { name: /Add your spa playlist/ }).click();
  await sheet(page).getByLabel("Paste a playlist or album link").fill(`https://open.spotify.com/playlist/${SPA_ID}?si=abc`);
  await sheet(page).getByRole("button", { name: "Add", exact: true }).click();
  await expect(sheet(page).getByRole("button", { name: /^Spa$/ })).toBeVisible();

  await sheet(page).getByRole("button", { name: "Add a shortcut" }).click();
  await sheet(page).getByRole("button", { name: "Show your playlists" }).click();
  await sheet(page).getByRole("button", { name: /Easy run/ }).click();
  await expect(sheet(page).getByRole("button", { name: /Easy run/ })).toBeVisible();

  await sheet(page).getByRole("button", { name: "Add a shortcut" }).click();
  await sheet(page).getByLabel("Paste a playlist or album link").fill("https://open.spotify.com/track/0123456789abcdefABCDEF");
  await sheet(page).getByRole("button", { name: "Add", exact: true }).click();
  await expect(sheet(page).getByText("That isn't a Spotify playlist or album link.")).toBeVisible();
  // An album, named from Spotify.
  await sheet(page).getByLabel("Paste a playlist or album link").fill(`spotify:album:${BETA_ID}`);
  await sheet(page).getByRole("button", { name: "Add", exact: true }).click();
  await expect(sheet(page).getByRole("button", { name: /Minecraft - Volume Beta/ })).toBeVisible();

  // Kept in the preferences.
  const stored = ((await (await req.get(`${baseURL}/api/music`)).json()) as { music: { shortcuts: Array<{ label: string }> } }).music.shortcuts;
  expect(stored.map((s) => s.label)).toEqual(["Spa", "Easy run", "Minecraft - Volume Beta"]);

  await sheet(page).getByRole("button", { name: /^Spa$/ }).click();
  await expect.poll(async () => (await nowPlaying(req, baseURL!))?.context.uri).toBe(`spotify:playlist:${SPA_ID}`);
});

test("no Spotify device open: the link to open it, and the play goes through once the app is back", async ({ page, context, baseURL }) => {
  const req = context.request;
  await connect(req, baseURL!);
  expect((await req.put(`${baseURL}/api/music`, { data: { shortcuts: [{ id: "spa", label: "Spa", uri: `spotify:playlist:${SPA_ID}`, shuffle: true }] } })).ok()).toBeTruthy();
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
  await expect(sheet(page).getByRole("button", { name: /Minecraft, complete/ })).toBeVisible();
  await shot(page, "player-expanded", info.project.name);
  await sheet(page).getByRole("button", { name: "Close" }).click();
  // Nothing played on its own.
  expect(await nowPlaying(req, baseURL!)).toBeNull();
});
