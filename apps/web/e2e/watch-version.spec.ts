import type { APIRequestContext, Locator, Page } from "@playwright/test";
import { test, expect } from "./fixtures.js";

/**
 * THE WATCH'S EARLIER VERSION — END TO END (stream S; the owner, 2026-10-19: "It's always there and annoying and not
 * actionable or removable"). In an account of its own: three sessions whose watch holds an earlier version
 * (`POST /api/dev/watch-version`, fixture mode only) — one ahead a rewrite can reach, one ahead none can, one weeks past
 * and missed. The Plan's sync line counts the two still to run and opens to them, date · title; each opens its sheet,
 * which says it plainly and offers what that row can do. Send queues the rewrite (the fixture's COROS connection holds
 * no credentials, so it stays on its way: "Syncing"); Keep has the app take the watch's version at the next read (the
 * fixture never reads COROS, so the row keeps saying so: "Taking watch's version"). Each press says what it did in the
 * block's place, the focus on it, nothing below moving; the line counts down with each and is gone.
 *
 *   bash apps/web/e2e/fixture-stack.sh
 *   RG_BASE=http://localhost:5271 pnpm --filter @rg/web exec playwright test watch-version --workers=1
 *
 * `RG_WATCH_VERSION_SHOTS=<dir>` writes the screenshots (phone and desktop, light and dark).
 */

const SHOTS = process.env.RG_WATCH_VERSION_SHOTS ?? null;

/**
 * An account of its own, with nothing in it but what the lever puts there: the full fixture seed carries failed watch
 * writes, and "N changes couldn't sync" is the line's louder sentence.
 */
async function signIn(request: APIRequestContext, baseURL: string | undefined, project: string): Promise<void> {
  const account = `watchv-${Date.now().toString(36)}-${project}`.slice(0, 32);
  for (let attempt = 1; ; attempt++) {
    try {
      expect((await request.post(`${baseURL}/api/dev/fixture-login?account=${account}`)).ok()).toBeTruthy();
      return;
    } catch (e) {
      if (attempt >= 3 || !/ECONNRESET|socket hang up/.test(String(e))) throw e;
    }
  }
}

async function shot(page: Page, name: string, project: string): Promise<void> {
  if (!SHOTS) return;
  for (const scheme of ["light", "dark"] as const) {
    await page.emulateMedia({ colorScheme: scheme, reducedMotion: "reduce" });
    await page.waitForTimeout(250);
    await page.screenshot({ path: `${SHOTS}/${project}-${name}-${scheme}.png` });
  }
  await page.emulateMedia({ colorScheme: "light" });
}

async function tall(l: Locator): Promise<void> {
  // Rounded: WebKit lays a 44 px box out at 43.99997.
  expect(Math.round((await l.boundingBox())!.height), await l.textContent() ?? "").toBeGreaterThanOrEqual(44);
}

const line = (page: Page) => page.locator(".sync-stale > summary");

async function openLine(page: Page): Promise<void> {
  if (!(await page.locator(".sync-stale").evaluate((d) => (d as HTMLDetailsElement).open))) await line(page).click();
}

test("the watch's earlier version: the line names what is still to run, and each sheet sends this version or keeps the watch's", async ({ page, context, baseURL }, testInfo) => {
  test.setTimeout(180_000);
  const project = testInfo.project.name;
  await signIn(context.request, baseURL, project);
  const seeded = await context.request.post(`${baseURL}/api/dev/watch-version`);
  expect(seeded.ok()).toBeTruthy();
  const ids = (await seeded.json()) as { sendable: string; keepOnly: string };

  await page.goto("/plan");
  await expect(line(page)).toHaveText("Your watch has an earlier version of 2 sessions");
  await openLine(page);
  const links = page.locator(".sync-stale-list a");
  // Soonest first; the session weeks past and missed is not among them.
  await expect(links).toHaveText([/^\w{3} \w{3} \d{1,2} · Easy 30$/, /^\w{3} \w{3} \d{1,2} · Hills 6x1$/]);
  for (const l of await links.all()) await tall(l);
  await shot(page, "line", project);

  // The run a rewrite can reach: the sentence, and both choices.
  await links.filter({ hasText: "Easy 30" }).click();
  const easy = page.getByRole("dialog", { name: "Easy 30" });
  await expect(easy).toBeVisible();
  await expect(easy.locator(".watch-version-says")).toHaveText("Your watch has an earlier version of this session.");
  const send = easy.getByRole("button", { name: "Send this version to the watch" });
  const keep = easy.getByRole("button", { name: "Keep the watch's version" });
  await expect(send).toBeVisible();
  await expect(keep).toBeVisible();
  await tall(send);
  await tall(keep);
  await shot(page, "sheet-send", project);
  // What is below the block, measured from the block's own sentence: a click may scroll the sheet to reach its button,
  // and that is no move.
  const below = easy.locator(".hero-durations");
  const says = easy.locator(".watch-version-says");
  const gap = async () => (await below.boundingBox())!.y - (await says.boundingBox())!.y;
  const gapBefore = await gap();
  await send.click();
  // On its way: said where the buttons were, the focus there, the row's pill "Syncing", and nothing below moved.
  const sent = easy.locator(".watch-version-done");
  await expect(sent).toHaveText("Sending this version to your watch.");
  await expect(sent).toBeFocused();
  await expect(easy.locator(".pill", { hasText: "Syncing" })).toBeVisible();
  expect(Math.abs((await gap()) - gapBefore), "what is below the block stays where it was").toBeLessThanOrEqual(2);
  await shot(page, "sheet-sent", project);
  await page.keyboard.press("Escape");
  await expect(easy).toHaveCount(0);
  await expect(line(page)).toHaveText("Your watch has an earlier version of 1 session");

  // The run none can reach: why, in one line, and Keep alone.
  await openLine(page);
  await page.locator(".sync-stale-list a", { hasText: "Hills 6x1" }).click();
  const hills = page.getByRole("dialog", { name: "Hills 6x1" });
  await expect(hills.locator(".watch-version-says")).toHaveText(
    "Your watch has an earlier version of this session. Run Garden can't rewrite this one on your watch.",
  );
  await expect(hills.getByRole("button", { name: "Send this version to the watch" })).toHaveCount(0);
  await shot(page, "sheet-keep", project);
  await hills.getByRole("button", { name: "Keep the watch's version" }).click();
  const kept = hills.locator(".watch-version-done");
  await expect(kept).toHaveText("Run Garden will take the watch's version at the next sync.");
  await expect(kept).toBeFocused();
  await expect(hills.locator(".pill", { hasText: "Taking watch's version" })).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(hills).toHaveCount(0);
  // Nothing left to count.
  await expect(page.locator(".sync-stale")).toHaveCount(0);
  await expect(page.getByText(/earlier version of/)).toHaveCount(0);
  // Opened again: until the read brings it in, the row says the app is taking the watch's version — not "Synced",
  // not "Older on watch".
  await page.goto(`/plan?workout=${ids.keepOnly}`);
  const again = page.getByRole("dialog", { name: "Hills 6x1" });
  await expect(again.locator(".pill", { hasText: "Taking watch's version" })).toBeVisible();
  await expect(again.getByText("Run Garden will take the watch's version at the next sync.")).toBeVisible();
  await expect(again.getByText("Older on watch")).toHaveCount(0);
  await expect(again.locator(".watch-version")).toHaveCount(0);
  await shot(page, "sheet-taking", project);
});
