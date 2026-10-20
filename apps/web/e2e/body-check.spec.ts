import type { APIRequestContext, Page, TestInfo } from "@playwright/test";
import { test, expect } from "./fixtures.js";
import { seededAccount } from "./seeded-accounts.js";

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
 * Each project and each kind takes an account of its own (`fixture-login?account=body-<kind>-<project>`), seeded before
 * the run (the global setup, seeded-accounts.ts — never while other tests run): the two projects run at once on one
 * stack. The engine account moves today's runs a day on, so the programme session heads the card; the run account moves
 * a run of the plan to today, so the run does.
 *
 * Run: `RG_API_PORT=… RG_WEB_PORT=… bash apps/web/e2e/fixture-stack.sh`, then
 * `RG_BASE=http://localhost:<web> pnpm --filter @rg/web exec playwright test body-check`. `RG_E2E_SHOTS=<dir>` also
 * takes the card's screenshots (phone and desktop, light and dark) into that directory.
 */

type Kind = "engine" | "run";

const MODES = ["recovery", "consistent", "build"];

/** What the check reads of a session: its build's mode, the engine's proposal, its choices and its moves. */
interface SessionRead {
  build: {
    mode: string;
    params: { overrides: { mode?: string } };
    items: Array<{ exerciseId: string }>;
    exercises: Record<string, { regions: string[]; muscles: { primary: string[] } }>;
  };
  view: { proposedMode: string };
}

/** The library's muscles under each region these journeys ask about (the library's MUSCLE_REGION, for these). */
const HIP_MUSCLES = ["deep-hip-rotators", "hip-flexors", "adductors", "glute-min-tfl"];
// What a run works (the worker's `RUN_REGIONS`, body-exposure.ts — the e2e cannot import the worker; kept equal by hand).
const LEG_REGIONS = ["hips", "glutes", "quads", "hamstrings", "calves", "ankles", "feet"];
const LEG_MUSCLES = [...HIP_MUSCLES, "glute-max", "glute-med", "hamstrings", "quads", "gastrocnemius", "soleus", "tibialis", "peroneals", "feet-intrinsics"];

/** Does the build work any of these regions — a move's region, or a primary muscle under one? */
function works(s: SessionRead, regions: readonly string[], muscles: readonly string[]): boolean {
  return s.build.items.some((i) => {
    const ex = s.build.exercises[i.exerciseId];
    return !!ex && (ex.regions.some((r) => regions.includes(r)) || ex.muscles.primary.some((m) => muscles.includes(m)));
  });
}
const worksHips = (s: SessionRead): boolean => works(s, ["hips"], HIP_MUSCLES);
const worksLegs = (s: SessionRead): boolean => works(s, LEG_REGIONS, LEG_MUSCLES);
/** The sign-in's query: this project's account of the kind, seeded before the run. */
const accountOf = (kind: Kind, testInfo: TestInfo): string => `?account=${seededAccount(testInfo, `body-${kind}-${testInfo.project.name}`)}`;
const SHOTS = process.env.RG_E2E_SHOTS ?? "";

test.describe.configure({ mode: "serial" });

test.beforeAll(async ({ playwright }, testInfo) => {
  // Each account is seeded already (the global setup): here, only the day each journey needs.
  testInfo.setTimeout(60_000);
  for (const kind of ["engine", "run"] as const) {
    const req = await playwright.request.newContext({ baseURL: testInfo.project.use.baseURL });
    try {
      expect((await req.post(`/api/dev/fixture-login${accountOf(kind, testInfo)}`)).ok()).toBeTruthy();
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
    expect((await context.request.post(`${baseURL}/api/dev/fixture-login${accountOf("engine", testInfo)}`)).ok()).toBeTruthy();
  });

  test("Fresh, A bit heavy (one mode down) and Undo, Sore somewhere — on the card", async ({ page, context }, testInfo) => {
    const req = context.request;
    const session = await headed(req, "engine");
    expect(session.origin).toBe("program");
    const { card } = await openCheck(page);
    await shoot(page, "engine-asked", testInfo.project.name);

    await answer(page, "Fresh");
    await expect(card.locator(".body-check-line")).toBeEmpty();

    await answer(page, "A bit heavy");
    await expect(card.locator(".body-check-line")).toHaveText(/^Eased to a (consistent|recovery) session for (heavy legs|a heavy body)\s*Undo$/, { timeout: 30_000 });
    // One mode down from what the engine proposed for the day, chosen as the day's mode — and the card says that mode.
    const eased = (await (await req.get(`/api/sessions/${session.id}`)).json()) as SessionRead;
    expect(MODES.indexOf(eased.build.mode)).toBe(MODES.indexOf(eased.view.proposedMode) - 1);
    expect(eased.build.params.overrides.mode).toBe(eased.build.mode);
    await expect(card.locator(".body-check-line")).toContainText(`Eased to a ${eased.build.mode} session`);
    const easedLine = (await card.locator(".body-check-line").textContent()) ?? "";
    await shoot(page, "engine-eased", testInfo.project.name);

    await page.getByRole("button", { name: "Undo" }).click();
    await expect(card.locator(".body-check-line")).toHaveText("Kept as planned.", { timeout: 30_000 });
    // The focus moved to the line that says so.
    await expect(card.locator(".body-check-line")).toBeFocused();
    const back = (await (await req.get(`/api/sessions/${session.id}`)).json()) as SessionRead;
    expect(back.build.params.overrides.mode).toBeUndefined();
    expect(back.build.mode).toBe(back.view.proposedMode);
    // The day's own session again — the one A bit heavy was said of: heavy legs only if it works them.
    expect(easedLine).toContain(worksLegs(back) ? "for heavy legs" : "for a heavy body");

    await page.getByRole("button", { name: "Sore somewhere" }).click();
    await expect(page.getByRole("group", { name: "Where?" })).toBeVisible();
    await shoot(page, "engine-picker", testInfo.project.name);
    await page.getByRole("button", { name: "Hips", exact: true }).click();
    await page.getByRole("button", { name: "Done" }).click();
    // Eased when the day's session works the hips (a move's region, or a primary muscle under them), else noted.
    if (worksHips(back)) {
      await expect(card.locator(".body-check-line")).toHaveText(/^Eased to a (consistent|recovery) session for sore hips\s*Undo$/, { timeout: 30_000 });
      const sore = (await (await req.get(`/api/sessions/${session.id}`)).json()) as SessionRead;
      expect(MODES.indexOf(sore.build.mode)).toBe(MODES.indexOf(back.build.mode) - 1);
    } else {
      await expect(card.locator(".body-check-line")).toHaveText("Noted — today leaves your hips alone.", { timeout: 30_000 });
      const sore = (await (await req.get(`/api/sessions/${session.id}`)).json()) as SessionRead;
      expect(sore.build.mode).toBe(back.build.mode);
    }
    await expect(page.getByRole("button", { name: "Sore somewhere" })).toHaveAttribute("aria-pressed", "true");
  });
});

test.describe("a run of the plan", () => {
  test.beforeEach(async ({ context, baseURL }, testInfo) => {
    expect((await context.request.post(`${baseURL}/api/dev/fixture-login${accountOf("run", testInfo)}`)).ok()).toBeTruthy();
  });

  test("Fresh, A bit heavy (eased by the ease op) and Undo, Sore somewhere — on the card", async ({ page, context }, testInfo) => {
    const req = context.request;
    const run = await headed(req, "run");
    expect(run.origin).toBeNull();
    const before = ((await (await req.get(`/api/plan/workouts/${run.id}`)).json()) as { workout: { title: string; stageSummary: string | null; calendarSeconds: number; workoutSeconds: number | null } }).workout;
    const { card } = await openCheck(page);

    await answer(page, "Fresh");
    await expect(card.locator(".body-check-line")).toBeEmpty();

    await answer(page, "A bit heavy");
    await expect(card.locator(".body-check-line")).toHaveText(/^Eased to (\d+ h( \d+ min)?|\d+ min) for heavy legs\s*Undo$/, { timeout: 30_000 });
    // By time — the run is on the watch — 0.7 of the plan's, held easy; and the card names that time.
    const eased = ((await (await req.get(`/api/plan/workouts/${run.id}`)).json()) as { workout: { calendarSeconds: number; stageSummary: string | null } }).workout;
    const minutes = eased.calendarSeconds / 60;
    expect(Math.abs(minutes - (before.workoutSeconds ?? before.calendarSeconds) / 60 * 0.7)).toBeLessThanOrEqual(1);
    expect(eased.stageSummary).toMatch(/easy/i);
    const h = Math.floor(minutes / 60);
    const words = h === 0 ? `${minutes} min` : minutes % 60 === 0 ? `${h} h` : `${h} h ${minutes % 60} min`;
    await expect(card.locator(".body-check-line")).toContainText(`Eased to ${words} for heavy legs`);
    await shoot(page, "run-eased", testInfo.project.name);

    await page.getByRole("button", { name: "Undo" }).click();
    await expect(card.locator(".body-check-line")).toHaveText("Kept as planned.", { timeout: 30_000 });
    await expect(card.locator(".body-check-line")).toBeFocused();
    const back = ((await (await req.get(`/api/plan/workouts/${run.id}`)).json()) as { workout: { title: string; stageSummary: string | null; calendarSeconds: number } }).workout;
    expect([back.title, back.stageSummary, back.calendarSeconds]).toEqual([before.title, before.stageSummary, before.calendarSeconds]);

    await page.getByRole("button", { name: "Sore somewhere" }).click();
    await page.getByRole("button", { name: "Shoulders", exact: true }).click();
    await page.getByRole("button", { name: "Done" }).click();
    await expect(card.locator(".body-check-line")).toHaveText("Noted — today leaves your shoulders alone.", { timeout: 30_000 });
    await shoot(page, "run-noted", testInfo.project.name);
  });
});
