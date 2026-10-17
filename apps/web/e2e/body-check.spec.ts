import type { APIRequestContext, Page } from "@playwright/test";
import { test, expect } from "./fixtures.js";

/**
 * THE BODY CHECK ON THE TODAY CARD (the new shape §4, stream E): "How's your body?" — Fresh · A bit heavy · Sore
 * somewhere — on an engine session (the fixture programme's session of today) and on a run of the plan, each answer
 * tapped on the card, what it did read from the card's line and from the server:
 *
 *   - Fresh: chosen, nothing changes, no line.
 *   - A bit heavy: the engine session is rebuilt one mode down ("Eased to a … session for heavy legs"); the run is eased
 *     by the ease op — by time, the run being on the watch ("Eased to 1 h 27 min …"). Undo puts it back ("Kept as
 *     planned.") and the server's copy is
 *     the plan's again.
 *   - Sore somewhere: the area picker, an area, Done — eased when the session works it, else noted.
 *
 * Each project and each kind takes an account of its own (`fixture-login?account=body-<kind>-<project>`), seeded at the
 * start: the two projects run at once on one stack. The engine account moves today's runs a day on, so the programme
 * session heads the card; the run account moves a run of the plan to today, so the run does.
 *
 * Run: `RG_API_PORT=… RG_WEB_PORT=… bash apps/web/e2e/fixture-stack.sh`, then
 * `RG_BASE=http://localhost:<web> pnpm --filter @rg/web exec playwright test body-check`. `RG_E2E_SHOTS=<dir>` also
 * takes the card's screenshots (phone and desktop, light and dark) into that directory.
 */

type Kind = "engine" | "run";
const accountOf = (kind: Kind, project: string): string => `?account=body-${kind}-${project}`;
const SHOTS = process.env.RG_E2E_SHOTS ?? "";

test.describe.configure({ mode: "serial" });

test.beforeAll(async ({ playwright }, testInfo) => {
  // Two seeds, each several seconds — longer while the other project seeds its own.
  testInfo.setTimeout(300_000);
  for (const kind of ["engine", "run"] as const) {
    const req = await playwright.request.newContext({ baseURL: testInfo.project.use.baseURL });
    try {
      expect((await req.post(`/api/dev/fixture-login${accountOf(kind, testInfo.project.name)}`)).ok()).toBeTruthy();
      const seeded = await req.post("/api/dev/seed", { timeout: 120_000 });
      expect(seeded.ok(), await seeded.text()).toBeTruthy();
      await arrange(req, kind);
    } finally {
      await req.dispose();
    }
  }
});

interface Row {
  id: string;
  origin: string | null;
  sport: string;
  category: string;
  effectiveDate: string;
  completionState: string;
  archived: boolean;
}

/** The day as each journey needs it: today's runs a day on (engine), or a run of the plan on today (run). */
async function arrange(req: APIRequestContext, kind: Kind): Promise<void> {
  const today = ((await (await req.get("/api/plan/today")).json()) as { today: string }).today;
  const all = ((await (await req.get("/api/plan/workouts")).json()) as { workouts: Row[] }).workouts;
  const planRun = (w: Row) => !w.origin && w.sport === "run" && w.category !== "rest" && w.category !== "race" && w.completionState === "scheduled" && !w.archived;
  const tomorrow = new Date(Date.parse(`${today}T12:00:00Z`) + 86_400_000).toISOString().slice(0, 10);
  if (kind === "engine") {
    for (const w of all.filter((x) => planRun(x) && x.effectiveDate === today)) {
      const moved = await req.post(`/api/plan/workouts/${w.id}/move`, { data: { toDate: tomorrow, toTime: "07:00" } });
      expect(moved.ok(), await moved.text()).toBeTruthy();
    }
    // The programme's session of today: its own, else the next one moved here (late, so its window is still ahead).
    const slot = (x: Row) => x.origin === "program" && x.completionState === "scheduled" && !x.archived;
    if (all.some((x) => slot(x) && x.effectiveDate === today)) return;
    const next = all.filter((x) => slot(x) && x.effectiveDate > today).sort((a, b) => a.effectiveDate.localeCompare(b.effectiveDate))[0];
    expect(next, "a programme session to move to today").toBeTruthy();
    const moved = await req.post(`/api/plan/workouts/${next!.id}/move`, { data: { toDate: today, toTime: "23:30" } });
    expect(moved.ok(), await moved.text()).toBeTruthy();
    return;
  }
  if (all.some((x) => planRun(x) && x.effectiveDate === today)) return;
  const next = all.filter((x) => planRun(x) && x.effectiveDate > today).sort((a, b) => a.effectiveDate.localeCompare(b.effectiveDate))[0];
  expect(next, "a run of the plan to move to today").toBeTruthy();
  const moved = await req.post(`/api/plan/workouts/${next!.id}/move`, { data: { toDate: today, toTime: "23:00" } });
  expect(moved.ok(), await moved.text()).toBeTruthy();
}

/** Today's card, and its body check. */
async function openCheck(page: Page) {
  await page.goto("/");
  const check = page.getByRole("group", { name: "How’s your body?" });
  await expect(check).toBeVisible({ timeout: 30_000 });
  return { check, card: page.locator(".body-check") };
}

/** The session the card heads: a run of the plan still to do today heads it; without one, the programme's session. */
async function headed(req: APIRequestContext, kind: Kind): Promise<{ id: string; origin: string | null }> {
  const today = (await (await req.get("/api/plan/today")).json()) as {
    today: string;
    todaySessions: Array<{ workout: { id: string; origin: string | null; sport: string; category: string; completionState: string } }>;
  };
  const scheduled = today.todaySessions.map((s) => s.workout).filter((w) => w.completionState === "scheduled" && w.category !== "rest");
  const found = scheduled.find((w) => (kind === "run" ? !w.origin && w.sport === "run" : w.origin === "program"));
  expect(found, `today's ${kind} session`).toBeTruthy();
  return found!;
}

async function answer(page: Page, name: string) {
  const chip = page.getByRole("button", { name, exact: true });
  await chip.click();
  await expect(chip).toHaveAttribute("aria-pressed", "true");
}

async function shoot(page: Page, name: string, project: string) {
  if (!SHOTS) return;
  for (const scheme of ["light", "dark"] as const) {
    await page.emulateMedia({ colorScheme: scheme });
    await page.locator(".body-check").scrollIntoViewIfNeeded();
    await page.screenshot({ path: `${SHOTS}/${project}-${name}-${scheme}.png` });
  }
  await page.emulateMedia({ colorScheme: "light" });
}

test.describe("an engine session", () => {
  test.beforeEach(async ({ context, baseURL }, testInfo) => {
    expect((await context.request.post(`${baseURL}/api/dev/fixture-login${accountOf("engine", testInfo.project.name)}`)).ok()).toBeTruthy();
  });

  test("Fresh, A bit heavy (one mode down) and Undo, Sore somewhere — on the card", async ({ page, context }, testInfo) => {
    const req = context.request;
    const session = await headed(req, "engine");
    expect(session.origin).toBe("program");
    const { card } = await openCheck(page);
    await shoot(page, "engine-asked", testInfo.project.name);

    await answer(page, "Fresh");
    await expect(card.locator(".body-check-line")).toHaveCount(0);

    await answer(page, "A bit heavy");
    await expect(card.locator(".body-check-line")).toHaveText(/^Eased to a (consistent|recovery) session for heavy legs\s*Undo$/, { timeout: 30_000 });
    const eased = (await (await req.get(`/api/sessions/${session.id}`)).json()) as { build: { mode: string; params: { overrides: { mode?: string } } } };
    expect(eased.build.params.overrides.mode).toBe(eased.build.mode);
    await shoot(page, "engine-eased", testInfo.project.name);

    await page.getByRole("button", { name: "Undo" }).click();
    await expect(card.locator(".body-check-line")).toHaveText("Kept as planned.");
    const back = (await (await req.get(`/api/sessions/${session.id}`)).json()) as { build: { params: { overrides: { mode?: string } } } };
    expect(back.build.params.overrides.mode).toBeUndefined();

    await page.getByRole("button", { name: "Sore somewhere" }).click();
    await expect(page.getByRole("group", { name: "Where?" })).toBeVisible();
    await shoot(page, "engine-picker", testInfo.project.name);
    await page.getByRole("button", { name: "Hips", exact: true }).click();
    await page.getByRole("button", { name: "Done" }).click();
    await expect(card.locator(".body-check-line")).toHaveText(
      /^(Eased to a (consistent|recovery) session for sore hips\s*Undo|Noted — today leaves your hips alone\.)$/,
      { timeout: 30_000 },
    );
    await expect(page.getByRole("button", { name: "Sore somewhere" })).toHaveAttribute("aria-pressed", "true");
  });
});

test.describe("a run of the plan", () => {
  test.beforeEach(async ({ context, baseURL }, testInfo) => {
    expect((await context.request.post(`${baseURL}/api/dev/fixture-login${accountOf("run", testInfo.project.name)}`)).ok()).toBeTruthy();
  });

  test("Fresh, A bit heavy (eased by the ease op) and Undo, Sore somewhere — on the card", async ({ page, context }, testInfo) => {
    const req = context.request;
    const run = await headed(req, "run");
    expect(run.origin).toBeNull();
    const before = ((await (await req.get(`/api/plan/workouts/${run.id}`)).json()) as { workout: { title: string; stageSummary: string | null; calendarSeconds: number } }).workout;
    const { card } = await openCheck(page);

    await answer(page, "Fresh");
    await expect(card.locator(".body-check-line")).toHaveCount(0);

    await answer(page, "A bit heavy");
    await expect(card.locator(".body-check-line")).toHaveText(/^Eased to (\d+ h( \d+ min)?|\d+ min) for heavy legs\s*Undo$/, { timeout: 30_000 });
    const eased = ((await (await req.get(`/api/plan/workouts/${run.id}`)).json()) as { workout: { calendarSeconds: number } }).workout;
    expect(eased.calendarSeconds).toBeLessThan(before.calendarSeconds);
    await shoot(page, "run-eased", testInfo.project.name);

    await page.getByRole("button", { name: "Undo" }).click();
    await expect(card.locator(".body-check-line")).toHaveText("Kept as planned.");
    const back = ((await (await req.get(`/api/plan/workouts/${run.id}`)).json()) as { workout: { title: string; stageSummary: string | null; calendarSeconds: number } }).workout;
    expect([back.title, back.stageSummary, back.calendarSeconds]).toEqual([before.title, before.stageSummary, before.calendarSeconds]);

    await page.getByRole("button", { name: "Sore somewhere" }).click();
    await page.getByRole("button", { name: "Shoulders", exact: true }).click();
    await page.getByRole("button", { name: "Done" }).click();
    await expect(card.locator(".body-check-line")).toHaveText("Noted — today leaves your shoulders alone.", { timeout: 30_000 });
    await shoot(page, "run-noted", testInfo.project.name);
  });
});
