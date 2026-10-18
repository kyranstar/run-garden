import { execFileSync } from "node:child_process";
import type { APIRequestContext, Locator, Page } from "@playwright/test";
import { test as bare } from "@playwright/test";
import { test, expect } from "./fixtures.js";

/**
 * THE COACH'S ROBUSTNESS, END TO END (the owner's request, 2026-10-16: "make sure the coach is robust, and doesn't
 * crash if I navigate away mid response etc."). On the fixture stack, the real app and worker with the scripted model
 * (its stand-in made slow on cue — `POST /delay/<ms>` — so a step is mid-response when the athlete moves):
 *
 * The stack runs the coach's steps in its run stepper's alarm (COACH_STEP_ALARM, as production does): a step request
 * only arms the run, and no client connection carries a step.
 *
 *   1. leaving the coach mid-step (and during a question): the run goes on stepping on the Plan — the app's run keeper —
 *      and the nav's Coach ● says so; back in the coach, the suggestion is there;
 *   2. the tab closed mid-step: the run goes on with no client at all, to its end (Task 13, §2.12: a run the athlete
 *      started keeps going unwatched, within its lease's window); opened again, its suggestion is there;
 *  2c. the worker killed mid-step: the run's object takes the step back once no call could still be running (the model's
 *      deadline — 30 s on this stack, FIXTURE_MODEL_TIMEOUT_MS — and a minute), never sooner and never after a
 *      15-minute stale wait; the dead call counts at an estimate, so the run isn't stopped by its limit: it finishes;
 *  1b, 2b. the same between an answer over 16 KB and the next step, which runs its queued calls (the `big` script):
 *      left for the Plan, the calls run there; the tab closed, the run goes on to its end with no client — no model
 *      asked again;
 *   3. a reload mid-step, during Approve and during Decline: the run finishes; the decision lands once, never twice;
 *      after the reload the card says what came of it;
 *   4. offline mid-step, then back: the run picks up by itself;
 *   9. Send, an answer, Approve, Decline and Cancel tapped twice or three times: one request each;
 *  12. a render error inside the coach (injected): the coach says so in place, and the conversation and the app go on.
 *
 * Needs the fixture stack on the scripted model, and skips itself otherwise:
 *
 *   RG_E2E_DESIGN_MODEL=scripted:now bash apps/web/e2e/fixture-stack.sh
 *   RG_E2E_DESIGN_MODEL=scripted:now RG_BASE=http://localhost:5271 pnpm --filter @rg/web exec playwright test coach-robustness --workers=1
 *
 * (RG_DESIGN_MODEL_PORT names the stand-in's port when it isn't the default.) One live run per athlete, and the
 * projects share the fixture account: each journey starts a new conversation (the new shape §5: the coach's sheet,
 * opened from the nav). A full run records about $3–4 of
 * the fixture account's weekly AI budget ($20, each call's worst case held back before it): start a fresh stack every
 * few runs, or the coach stops for the week's budget.
 */

test.skip(process.env.RG_E2E_DESIGN_MODEL !== "scripted:now", "needs the fixture stack on the scripted model (RG_E2E_DESIGN_MODEL=scripted:now)");
bare.skip(process.env.RG_E2E_DESIGN_MODEL !== "scripted:now", "needs the fixture stack on the scripted model (RG_E2E_DESIGN_MODEL=scripted:now)");

const MODEL = `http://127.0.0.1:${process.env.RG_DESIGN_MODEL_PORT ?? "8897"}`;
const LIVE = ["active", "stepping", "waiting_athlete", "waiting_review", "waiting_set"];
const TITLE = "Hips and back, gently";

/** The stand-in model: its script, its delay, the calls it has seen. */
async function model(path: string): Promise<{ begun: number; answered: number; hungUp: number }> {
  const res = await fetch(`${MODEL}${path}`, { method: path === "/calls" ? "GET" : "POST" });
  return (await res.json()) as { begun: number; answered: number; hungUp: number };
}

/** Until the stand-in has begun `n` calls: the step is mid-response. */
async function modelBegun(n: number): Promise<void> {
  await expect.poll(async () => (await model("/calls")).begun, { timeout: 30_000 }).toBeGreaterThanOrEqual(n);
}

async function signIn(request: APIRequestContext, baseURL: string | undefined) {
  for (let attempt = 1; ; attempt++) {
    try {
      expect((await request.post(`${baseURL}/api/dev/fixture-login`)).ok()).toBeTruthy();
      return;
    } catch (e) {
      if (attempt >= 3 || !/ECONNRESET|socket hang up/.test(String(e))) throw e;
    }
  }
}

interface Current {
  run: { id: string; status: string; costUsd: number; steps: number; error: string | null } | null;
  proposal?: { id: string; status: string } | null;
}
const current = async (request: APIRequestContext, baseURL: string | undefined): Promise<Current> =>
  (await (await request.get(`${baseURL}/api/coach/runs/current`)).json()) as Current;

/** A suggestion's statuses the athlete still decides in: the current read's other proposals were decided already. */
const OPEN = ["pending", "partially_approved"];

/**
 * Nothing of an earlier journey's left — no live run, no open suggestion — and the stand-in back to its script. (A
 * suggestion decided in the last 10 minutes still comes back with its run, for a reload to show what came of it: no one's
 * to clear. A new run takes its place on screen: `start`.)
 */
async function fresh(request: APIRequestContext, baseURL: string | undefined) {
  await signIn(request, baseURL);
  const declined = new Set<string>();
  for (let i = 0; i < 6; i++) {
    const c = await current(request, baseURL);
    if (!c.run) break;
    if (LIVE.includes(c.run.status)) await request.post(`${baseURL}/api/coach/runs/${c.run.id}/cancel`, { data: {} });
    else if (c.proposal && OPEN.includes(c.proposal.status) && !declined.has(c.proposal.id)) {
      declined.add(c.proposal.id);
      await request.post(`${baseURL}/api/coach/proposals/${c.proposal.id}/decline`, { data: {} });
    } else break;
  }
  await model("/use/");
  await model("/delay/");
  await model("/calls/reset");
}

/** The PIDs `lsof` names for `args` (none: lsof answers 1). */
function pidsOf(...args: string[]): number[] {
  try {
    return execFileSync("lsof", ["-t", ...args], { encoding: "utf8" }).split("\n").filter(Boolean).map(Number);
  } catch {
    return [];
  }
}

const psField = (field: string, pid: number): string => execFileSync("ps", ["-o", `${field}=`, "-p", String(pid)], { encoding: "utf8" }).trim();

/**
 * Take the worker down mid-step, at once, as a deploy or a crash does: the workerd holding a connection to the stand-in
 * model (the runtime whose step waits on its call), its `wrangler dev`, and everything under that — SIGKILL. (Killing a
 * workerd alone leaves wrangler 4.118 up but serving nothing.) The stack's supervisor starts `wrangler dev` again on the
 * same state (fixture-stack.sh).
 */
function killTheWorker(): void {
  const port = new URL(MODEL).port;
  const model = new Set(pidsOf("-i", `TCP:${port}`, "-sTCP:LISTEN"));
  const callers = [...new Set(pidsOf("-i", `TCP:${port}`, "-sTCP:ESTABLISHED"))].filter((pid) => !model.has(pid));
  const runtime = callers.find((pid) => /workerd/.test(psField("comm", pid)));
  expect(runtime, "a workerd waiting on the stand-in model").toBeDefined();
  const wrangler = Number(psField("ppid", runtime!));
  expect(psField("command", wrangler), "the runtime's parent is its wrangler").toMatch(/wrangler/);
  const under = (pid: number): number[] => {
    let children: number[] = [];
    try {
      children = execFileSync("pgrep", ["-P", String(pid)], { encoding: "utf8" }).split("\n").filter(Boolean).map(Number);
    } catch {
      // none
    }
    return children.flatMap((c) => [c, ...under(c)]);
  };
  for (const pid of [wrangler, ...under(wrangler)]) {
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      // gone already
    }
  }
}

/** Until the worker answers again (its health route, through the web server). */
async function workerBack(request: APIRequestContext, baseURL: string | undefined): Promise<void> {
  await expect
    .poll(async () => (await request.get(`${baseURL}/api/health`).catch(() => null))?.status() ?? 0, { timeout: 90_000, intervals: [1_000] })
    .toBe(200);
}

/** The main navigation as this viewport shows it (the bottom bar on a phone, the rail on a desktop). */
const nav = (page: Page): Locator => page.locator('nav[aria-label="Main"]:visible');

/** The coach's sheet, and its box. */
const sheetOf = (page: Page): Locator => page.getByRole("dialog", { name: "Coach" });
const boxOf = (page: Page): Locator => sheetOf(page).locator(".coach-box textarea");

/** The nav's Coach (the phone's bar, or the rail): its ● says what the coach is doing. */
const coachButton = (page: Page): Locator => nav(page).locator("button.nav-coach");

/** Open the coach's sheet from the nav. */
async function openCoach(page: Page) {
  await coachButton(page).click();
  await expect(boxOf(page)).toBeVisible({ timeout: 20_000 });
  await expect(sheetOf(page).locator(".coach-opening, .coach-turns").first()).toBeVisible({ timeout: 20_000 });
}

/** A new conversation: the opening screen, whatever an earlier journey left. */
async function newConversation(page: Page) {
  if (await sheetOf(page).locator(".coach-opening").isVisible()) return;
  await sheetOf(page).getByRole("button", { name: "More" }).click();
  await sheetOf(page).getByRole("menuitem", { name: "New conversation" }).click();
  await expect(sheetOf(page).locator(".coach-opening")).toBeVisible();
}

/** Close the coach's sheet and go to a place in the nav. */
async function leaveFor(page: Page, name: RegExp) {
  await page.keyboard.press("Escape");
  await expect(sheetOf(page)).toHaveCount(0);
  await nav(page).getByRole("link", { name }).click();
}

async function start(page: Page, words: string) {
  await page.goto("/");
  await openCoach(page);
  await newConversation(page);
  await boxOf(page).fill(words);
  const created = page.waitForResponse((r) => r.request().method() === "POST" && new URL(r.url()).pathname === "/api/coach/runs");
  await sheetOf(page).getByRole("button", { name: "Send" }).click();
  await created;
  await expect(page.locator("section.coach-pc")).toHaveCount(0);
  await expect(sheetOf(page).getByRole("heading", { name: /^Coach · / })).toBeVisible();
}

const card = (page: Page) => page.locator("section.coach-pc");

/** How many of today's sessions are the scripted workout (an approve that landed twice would add two). */
async function todayCopies(request: APIRequestContext, baseURL: string | undefined): Promise<number> {
  const today = (await (await request.get(`${baseURL}/api/plan/today`)).json()) as { todaySessions: Array<{ workout: { title: string } }> };
  return today.todaySessions.filter((s) => s.workout.title === TITLE).length;
}

/** Every coach request the page sends, by method and route (ids folded). */
function coachRequests(page: Page): Record<string, number> {
  const seen: Record<string, number> = {};
  page.on("request", (r) => {
    const path = new URL(r.url()).pathname;
    if (!path.startsWith("/api/coach")) return;
    const key = `${r.method()} ${path.replace(/\/(runs|proposals)\/[^/]+/, "/$1/:id")}`;
    seen[key] = (seen[key] ?? 0) + 1;
  });
  return seen;
}

// The journeys share the fixture account (one live run at a time): run them with --workers=1.

test("1. leaving the coach mid-step, the coach goes on — on the Plan, and through a question", async ({ page, context, baseURL }) => {
  test.setTimeout(150_000);
  await fresh(context.request, baseURL);
  await model("/delay/12000");
  await start(page, "a short, gentle hips session");
  await modelBegun(1);
  await model("/delay/");

  // Mid-response, to the Plan: the nav's Coach says the coach is at work, and the run goes on to the end there.
  await leaveFor(page, /^Plan/);
  await expect(page).toHaveURL(/\/plan/);
  await expect(coachButton(page)).toContainText("the coach is working");
  await expect.poll(async () => (await current(context.request, baseURL)).run?.status, { timeout: 60_000 }).toBe("finished");
  await expect(coachButton(page)).not.toContainText("the coach is working");

  // Back in the coach: the suggestion is there.
  await openCoach(page);
  await expect(card(page).getByRole("button", { name: TITLE })).toBeVisible({ timeout: 20_000 });

  // A question: the athlete leaves and comes back; it waits for them, and their answer goes on to the end.
  await fresh(context.request, baseURL);
  await model("/use/ask");
  await start(page, "hips, after a question");
  await expect(page.getByText("How do your hips feel today?", { exact: true })).toBeVisible({ timeout: 30_000 });
  await leaveFor(page, /^Plan/);
  await expect(coachButton(page)).toContainText("the coach is waiting for you");
  await openCoach(page);
  await expect(page.getByText("How do your hips feel today?", { exact: true })).toBeVisible();
  // One tap answers it.
  await page.getByRole("button", { name: "Tight" }).click();
  await expect(card(page).getByRole("button", { name: TITLE })).toBeVisible({ timeout: 60_000 });
});

test("2. the tab closed mid-step: the coach goes on with no client at all, to its end; opened again, its suggestion is there", async ({ context, baseURL }) => {
  test.setTimeout(180_000);
  await fresh(context.request, baseURL);
  await model("/delay/20000");
  let page = await context.newPage();
  await start(page, "a short, gentle hips session");
  await modelBegun(1);
  await model("/delay/");
  await page.close();

  // No client at all (Task 13, §2.12: a run the athlete started keeps going unwatched until it ends or waits for them,
  // within its lease's window): the run over, every call of the script made — read through /current, which keeps no
  // lease. (Read until it ends: the step at work holds its 20 s call first, quiet all that time.)
  await expect.poll(async () => (await current(context.request, baseURL)).run?.status, { timeout: 120_000, intervals: [1_000] }).toBe("finished");
  expect((await model("/calls")).begun).toBe(4);

  // Opened again: its suggestion is there, and no model asked again.
  page = await context.newPage();
  await page.goto("/");
  await openCoach(page);
  await expect(card(page).getByRole("button", { name: TITLE })).toBeVisible({ timeout: 30_000 });
  expect((await model("/calls")).begun).toBe(4);
});

/**
 * The guard of a journey that kills the worker: a 5xx from /api/* while it is down (the web server's proxy answering for
 * it) is expected; any other — and any page error — fails it.
 */
function guardAcrossKill(page: Page): { down: () => void; up: () => void; check: () => void } {
  const problems: string[] = [];
  let downAt: number | null = null;
  let upAt: number | null = null;
  page.on("pageerror", (e) => problems.push(`pageerror: ${e.name}: ${e.message}`));
  page.on("response", (r) => {
    const { pathname } = new URL(r.url());
    if (!pathname.startsWith("/api/") || r.status() < 500) return;
    const now = Date.now();
    const whileDown = downAt !== null && now >= downAt && (upAt === null || now <= upAt + 5_000);
    if (!whileDown) problems.push(`${r.status()} ${r.request().method()} ${pathname}`);
  });
  return {
    down: () => (downAt = Date.now()),
    up: () => (upAt = Date.now()),
    check: () => expect(problems, "page errors, and 5xx /api responses while the worker was up").toEqual([]),
  };
}

bare("2c. the worker killed mid-step: the step taken back once no call could still be running, the dead call counted at an estimate — the run finishes", async ({ page, context, baseURL }) => {
  bare.setTimeout(300_000);
  const guard = guardAcrossKill(page);
  await fresh(context.request, baseURL);
  await model("/delay/20000");
  await start(page, "a short, gentle hips session");
  await modelBegun(1);
  await model("/delay/");
  const killedAt = Date.now();
  guard.down();
  killTheWorker();
  // The call dies with it: the stand-in sees its caller hang up.
  await expect.poll(async () => (await model("/calls")).hungUp, { timeout: 30_000 }).toBeGreaterThanOrEqual(1);
  await workerBack(context.request, baseURL);
  guard.up();
  // Restarted, the object can't know the step it recorded is dead (a deploy lets one run on in the old instance): no
  // second call before the claim, the model's deadline and a minute — though the page reads on all the while.
  await new Promise((r) => setTimeout(r, 10_000));
  expect((await model("/calls")).begun).toBe(1);
  // Then the step is taken back, and the run finishes: within minutes, never behind a 15-minute stale claim. The dead
  // call counts against the run at an estimate (its worst case, at the stand-in's unknown price, is past the run's
  // $1.50 limit by itself), so its limit doesn't stop it.
  await expect(card(page).getByRole("button", { name: TITLE })).toBeVisible({ timeout: 200_000 });
  expect(Date.now() - killedAt).toBeLessThan(4 * 60_000);
  const done = (await current(context.request, baseURL)).run!;
  expect(done).toMatchObject({ status: "finished", error: null });
  expect(done.costUsd).toBeLessThan(1.5);
  guard.check();
});

/**
 * An answer over 16 KB (the `big` script) runs its calls in the NEXT step, which calls no model (coach-runs.ts
 * DOCUMENT_ANSWER_BYTES). The server steps the run (its alarm): `readSeen` turns true once a read of the page's has
 * brought the big answer's line — the step that read it is done, the one that runs its calls next.
 */
function bigStepSeen(page: Page): () => boolean {
  let seen = false;
  page.on("response", async (r) => {
    if (seen || !/\/api\/coach\/runs\/[^/]+(\/step)?\?afterSeq=/.test(r.url())) return;
    const body = await r.text().catch(() => "");
    if (body.includes("Weighing the hips")) seen = true;
  });
  return () => seen;
}

test("1b. between a big answer's two steps: the athlete leaves for the Plan — the queued calls run there, no model asked again", async ({ page, context, baseURL }) => {
  test.setTimeout(150_000);
  await fresh(context.request, baseURL);
  await model("/use/big");
  const seen = bigStepSeen(page);
  await start(page, "a short, gentle hips session");
  await expect.poll(seen, { timeout: 60_000 }).toBe(true);
  // The step that read the answer is done; the one that runs its calls is next: to the Plan.
  await leaveFor(page, /^Plan/);
  await expect(page).toHaveURL(/\/plan/);
  await expect.poll(async () => (await current(context.request, baseURL)).run?.status, { timeout: 60_000 }).toBe("finished");
  // Two main turns before the finish, the reviewer, the finish: the queued calls asked no model.
  expect((await model("/calls")).begun).toBe(4);
  await openCoach(page);
  await expect(card(page).getByRole("button", { name: TITLE })).toBeVisible({ timeout: 20_000 });
});

test("2b. between a big answer's two steps: the tab is closed — the run goes on to its end with no client", async ({ context, baseURL }) => {
  test.setTimeout(180_000);
  await fresh(context.request, baseURL);
  await model("/use/big");
  let page = await context.newPage();
  const seen = bigStepSeen(page);
  await start(page, "a short, gentle hips session");
  await expect.poll(seen, { timeout: 60_000 }).toBe(true);
  await page.close();
  // With nobody watching, the queued calls run and the run goes on to its end (Task 13, §2.12) — no model asked again.
  await expect.poll(async () => (await current(context.request, baseURL)).run?.status, { timeout: 120_000, intervals: [1_000] }).toBe("finished");
  expect((await model("/calls")).begun).toBe(4);
  page = await context.newPage();
  await page.goto("/");
  await openCoach(page);
  await expect(card(page).getByRole("button", { name: TITLE })).toBeVisible({ timeout: 30_000 });
  expect((await model("/calls")).begun).toBe(4);
});

/**
 * The suite's guard, but for a journey that reloads with requests in flight: WebKit reports each fetch its own reload
 * cut ("Fetch API cannot load … due to access control checks") as a page error of the page going away — those, and only
 * those, are expected. Any other page error, or a 5xx, fails the journey.
 */
function guardAcrossReloads(page: Page): () => void {
  const problems: string[] = [];
  page.on("pageerror", (e) => {
    // WebKit's words arrive split at their first colon ("Fetch API cannot load http" / "//localhost…"): read them whole.
    const said = `${e.name}: ${e.message}`;
    if (!/^Fetch API cannot load .* due to access control checks\.?$/.test(said)) problems.push(`pageerror: ${said}`);
  });
  page.on("response", (r) => {
    const { pathname } = new URL(r.url());
    if (pathname.startsWith("/api/") && r.status() >= 500) problems.push(`${r.status()} ${r.request().method()} ${pathname}`);
  });
  return () => expect(problems, "uncaught page errors and 5xx /api responses").toEqual([]);
}

bare("3. a reload mid-step, during Approve and during Decline: the run finishes, and each decision lands once", async ({ page, context, baseURL }) => {
  bare.setTimeout(180_000);
  const checkGuard = guardAcrossReloads(page);
  await fresh(context.request, baseURL);
  await model("/delay/10000");
  await start(page, "a short, gentle hips session");
  await modelBegun(1);
  await model("/delay/");
  await page.reload();
  await openCoach(page);
  await expect(card(page).getByRole("button", { name: TITLE })).toBeVisible({ timeout: 90_000 });

  // Approve, then reload before its answer is drawn: it lands once.
  const before = await todayCopies(context.request, baseURL);
  const proposalId = (await current(context.request, baseURL)).proposal!.id;
  await card(page).getByRole("button", { name: "Approve", exact: true }).click();
  await page.reload();
  await openCoach(page);
  await expect
    .poll(async () => ((await (await context.request.get(`${baseURL}/api/coach/proposals/${proposalId}`)).json()) as { status: string }).status, { timeout: 20_000 })
    .toBe("approved");
  expect(await todayCopies(context.request, baseURL)).toBe(before + 1);
  // After the reload the card says what came of it (the current read answers a suggestion decided in the last 10
  // minutes) — a reload that read before the approve landed reads again once it shows; nothing offers a second approve.
  await expect(async () => {
    await page.reload();
    await openCoach(page);
    await expect(card(page).getByRole("heading", { name: "Added to your plan" })).toBeVisible({ timeout: 5_000 });
  }).toPass({ timeout: 30_000 });
  await expect(page.getByRole("button", { name: "Approve", exact: true })).toHaveCount(0);

  // Decline, then reload before its answer is drawn: declined, and nothing added.
  await fresh(context.request, baseURL);
  await start(page, "something calm");
  await expect(card(page).getByRole("button", { name: TITLE })).toBeVisible({ timeout: 60_000 });
  const declineId = (await current(context.request, baseURL)).proposal!.id;
  await card(page).getByRole("button", { name: "Decline" }).click();
  await card(page).locator(".coach-pc-decline").getByRole("button", { name: "Decline" }).click();
  await page.reload();
  await openCoach(page);
  await expect
    .poll(async () => ((await (await context.request.get(`${baseURL}/api/coach/proposals/${declineId}`)).json()) as { status: string }).status, { timeout: 20_000 })
    .toBe("declined");
  expect(await todayCopies(context.request, baseURL)).toBe(before + 1);
  await expect(async () => {
    await page.reload();
    await openCoach(page);
    await expect(card(page).getByRole("heading", { name: "Not added" })).toBeVisible({ timeout: 5_000 });
  }).toPass({ timeout: 30_000 });
  checkGuard();
});

test("4. offline mid-step, then back: the run picks up by itself", async ({ page, context, baseURL }) => {
  test.setTimeout(150_000);
  await fresh(context.request, baseURL);
  await model("/delay/8000");
  await start(page, "a short, gentle hips session");
  await modelBegun(1);
  await model("/delay/");
  await context.setOffline(true);
  // Offline past the step's answer: the next steps can't go; it says so, and keeps trying.
  await expect(page.getByText("Can't reach the coach right now. It keeps trying.")).toBeVisible({ timeout: 45_000 });
  await context.setOffline(false);
  await expect(card(page).getByRole("button", { name: TITLE })).toBeVisible({ timeout: 90_000 });
  await expect(page.getByText("Can't reach the coach right now. It keeps trying.")).toHaveCount(0);
});

test("9. Send, an answer, Approve, Decline and Cancel tapped twice or three times: one request each", async ({ page, context, baseURL }) => {
  test.setTimeout(180_000);
  await fresh(context.request, baseURL);
  await model("/use/ask");
  const seen = coachRequests(page);
  await page.goto("/");
  await openCoach(page);
  await newConversation(page);
  await boxOf(page).fill("tapped three times");
  await sheetOf(page).getByRole("button", { name: "Send" }).click({ clickCount: 3 });
  await expect(page.getByText("How do your hips feel today?", { exact: true })).toBeVisible({ timeout: 30_000 });
  expect(seen["POST /api/coach/runs"]).toBe(1);

  await page.getByRole("button", { name: "Tight" }).click({ clickCount: 3 });
  await expect(card(page).getByRole("button", { name: TITLE })).toBeVisible({ timeout: 60_000 });
  expect(seen["POST /api/coach/runs/:id/answer"]).toBe(1);

  await card(page).getByRole("button", { name: "Approve", exact: true }).dblclick();
  await expect(card(page).getByRole("link", { name: /^On your plan for / })).toBeVisible({ timeout: 30_000 });
  expect(seen["POST /api/coach/proposals/:id/approve"]).toBe(1);

  await fresh(context.request, baseURL);
  await start(page, "declined twice");
  await expect(card(page).getByRole("button", { name: TITLE })).toBeVisible({ timeout: 60_000 });
  await card(page).getByRole("button", { name: "Decline" }).click();
  await card(page).locator(".coach-pc-decline").getByRole("button", { name: "Decline" }).dblclick();
  await expect(card(page).getByRole("heading", { name: "Not added" })).toBeVisible({ timeout: 20_000 });
  expect(seen["POST /api/coach/proposals/:id/decline"]).toBe(1);
  await expect(card(page).getByText("isn't open any more")).toHaveCount(0);

  await fresh(context.request, baseURL);
  await model("/delay/8000");
  await start(page, "cancelled twice");
  await modelBegun(1);
  await page.getByRole("button", { name: "Cancel" }).dblclick();
  await expect(sheetOf(page).locator(".coach-msg--coach", { hasText: /cancel/i })).toBeVisible({ timeout: 20_000 });
  expect(seen["POST /api/coach/runs/:id/cancel"]).toBe(1);
  await model("/delay/");
});

// A render error is what this journey injects: the page's own error report for it is expected, so it runs without the
// suite's "no page error" guard — and asserts instead that the app stood.
bare("12. a render error inside the coach stays in the coach: said in place, the conversation and the app go on", async ({ page, context, baseURL }) => {
  bare.setTimeout(120_000);
  await fresh(context.request, baseURL);
  // Dev-only, test-side: a change line whose reason, as the card reads it, throws (no app code knows of this).
  await page.addInitScript(() => {
    const trim = String.prototype.trim;
    String.prototype.trim = function (this: string) {
      if (String(this) === "render-error-sentinel") throw new Error("an injected render error");
      return trim.call(this);
    };
  });
  await page.route("**/api/coach/proposals/*", async (route) => {
    if (route.request().method() !== "GET") return route.continue();
    const res = await route.fetch();
    const body = (await res.json()) as { changes?: unknown[] };
    body.changes = [
      { opId: "op-injected", kind: "skip", workoutId: "w-x", date: null, time: null, summary: "A change", was: null, effect: null, why: "render-error-sentinel", issues: [], outcome: null },
    ];
    await route.fulfill({ response: res, json: body });
  });
  await start(page, "a short, gentle hips session");
  // The run finishes; its suggestion's card throws as it draws.
  await expect(page.getByText("Something went wrong showing the coach — reload")).toBeVisible({ timeout: 90_000 });
  // The turn stands — the athlete's words, the coach's line — and the box; the app's navigation works.
  await expect(sheetOf(page).locator(".coach-msg--athlete", { hasText: "a short, gentle hips session" })).toBeVisible();
  await expect(sheetOf(page).locator(".coach-turn-reply .coach-msg--coach")).toBeVisible();
  await expect(boxOf(page)).toBeVisible();
  await leaveFor(page, /^Plan/);
  await expect(page).toHaveURL(/\/plan/);
  await expect(page.locator("#root")).not.toBeEmpty();
  await page.unroute("**/api/coach/proposals/*");
});
