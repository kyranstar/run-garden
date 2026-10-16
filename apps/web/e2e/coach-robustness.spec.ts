import type { APIRequestContext, Locator, Page } from "@playwright/test";
import { test as bare } from "@playwright/test";
import { test, expect } from "./fixtures.js";

/**
 * THE COACH'S ROBUSTNESS, END TO END (the owner's request, 2026-10-16: "make sure the coach is robust, and doesn't
 * crash if I navigate away mid response etc."). On the fixture stack, the real app and worker with the scripted model
 * (its stand-in made slow on cue — `POST /delay/<ms>` — so a step is mid-response when the athlete moves):
 *
 *   1. leaving the Studio mid-step (and during a question): the run goes on stepping on the Plan — the app's run keeper —
 *      and the Studio tab's ● says so; back, the suggestion is there;
 *   2. the tab closed mid-step and opened again: the step the server still holds is said ("still working"), and the run
 *      finishes by itself;
 *  1b, 2b. the same between an answer over 16 KB and the next step, which runs its queued calls (the `big` script):
 *      left for the Plan, the calls run there; the tab closed, they wait and run once it's opened — no model asked again;
 *   3. a reload mid-step, during Approve and during Decline: the run finishes; the decision lands once, never twice;
 *   4. offline mid-step, then back: the run picks up by itself;
 *   9. Now, Send, Approve, Decline and Cancel tapped twice or three times: one request each;
 *  12. a render error inside the coach (injected): the coach says so in place, and the Studio and the app go on.
 *
 * Needs the fixture stack on the scripted model, and skips itself otherwise:
 *
 *   RG_E2E_DESIGN_MODEL=scripted:now bash apps/web/e2e/fixture-stack.sh
 *   RG_E2E_DESIGN_MODEL=scripted:now RG_BASE=http://localhost:5271 pnpm --filter @rg/web exec playwright test coach-robustness --workers=1
 *
 * (RG_DESIGN_MODEL_PORT names the stand-in's port when it isn't the default.) One live run per athlete, and the
 * projects share the fixture account: each journey starts from the empty composer. A full run records about $3–4 of
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
  run: { id: string; status: string; costUsd: number } | null;
  proposal?: { id: string; status: string } | null;
}
const current = async (request: APIRequestContext, baseURL: string | undefined): Promise<Current> =>
  (await (await request.get(`${baseURL}/api/coach/runs/current`)).json()) as Current;

/** Nothing of an earlier journey's left — no live run, no open suggestion — and the stand-in back to its script. */
async function fresh(request: APIRequestContext, baseURL: string | undefined) {
  await signIn(request, baseURL);
  for (let i = 0; i < 6; i++) {
    const c = await current(request, baseURL);
    if (!c.run) break;
    if (LIVE.includes(c.run.status)) await request.post(`${baseURL}/api/coach/runs/${c.run.id}/cancel`, { data: {} });
    else if (c.proposal) await request.post(`${baseURL}/api/coach/proposals/${c.proposal.id}/decline`, { data: {} });
    else break;
  }
  await model("/use/");
  await model("/delay/");
  await model("/calls/reset");
}

/** The main navigation as this viewport shows it (the bottom bar on a phone, the rail on a desktop). */
const nav = (page: Page): Locator => page.locator('nav[aria-label="Main"]:visible');

async function start(page: Page, words: string) {
  await page.goto("/studio");
  const field = page.getByPlaceholder("What would help today?");
  await expect(field).toBeVisible({ timeout: 20_000 });
  await field.fill(words);
  await page.getByRole("button", { name: "Now", exact: true }).click();
  await expect(page.getByRole("heading", { name: /^Coach · / })).toBeVisible();
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

test("1. leaving the Studio mid-step, the coach goes on — on the Plan, and through a question", async ({ page, context, baseURL }) => {
  test.setTimeout(150_000);
  await fresh(context.request, baseURL);
  await model("/delay/12000");
  await start(page, "a short, gentle hips session");
  await modelBegun(1);
  await model("/delay/");

  // Mid-response, to the Plan: the Studio tab says the coach is at work, and the run goes on to the end there.
  await nav(page).getByRole("link", { name: /^Plan/ }).click();
  await expect(page).toHaveURL(/\/plan/);
  await expect(nav(page).getByRole("link", { name: /^Studio/ })).toContainText("the coach is working");
  await expect.poll(async () => (await current(context.request, baseURL)).run?.status, { timeout: 60_000 }).toBe("finished");
  await expect(nav(page).getByRole("link", { name: /^Studio/ })).not.toContainText("the coach is working");

  // Back: the suggestion is there.
  await nav(page).getByRole("link", { name: /^Studio/ }).click();
  await expect(card(page).getByRole("button", { name: TITLE })).toBeVisible({ timeout: 20_000 });

  // A question: the athlete leaves and comes back; it waits for them, and their answer goes on to the end.
  await fresh(context.request, baseURL);
  await model("/use/ask");
  await start(page, "hips, after a question");
  await expect(page.getByText("How do your hips feel today?", { exact: true })).toBeVisible({ timeout: 30_000 });
  await nav(page).getByRole("link", { name: /^Plan/ }).click();
  await expect(nav(page).getByRole("link", { name: /^Studio/ })).toContainText("the coach is waiting for you");
  await nav(page).getByRole("link", { name: /^Studio/ }).click();
  await expect(page.getByText("How do your hips feel today?", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Tight" }).click();
  await page.getByRole("button", { name: "Send" }).click();
  await expect(card(page).getByRole("button", { name: TITLE })).toBeVisible({ timeout: 60_000 });
});

test("2. the tab closed mid-step: opened again, the step the server holds is said, and the run finishes by itself", async ({ context, baseURL }) => {
  test.setTimeout(150_000);
  await fresh(context.request, baseURL);
  await model("/delay/20000");
  let page = await context.newPage();
  await start(page, "a short, gentle hips session");
  await modelBegun(1);
  await model("/delay/");
  await page.close();

  // Opened again while the server still holds that step: said, with its ● — never a bare header.
  page = await context.newPage();
  await page.goto("/studio");
  await expect(page.locator(".coach-line--now")).toContainText("The coach is still working on this…", { timeout: 15_000 });
  await expect(card(page).getByRole("button", { name: TITLE })).toBeVisible({ timeout: 90_000 });
});

/**
 * An answer over 16 KB (the `big` script) runs its calls in the NEXT step, which calls no model (coach-runs.ts
 * DOCUMENT_ANSWER_BYTES). Between the two: `hold` keeps the next step from leaving this page until `release`, or
 * drops every later step (`drop`: the tab is as good as closed).
 */
async function betweenBigSteps(page: Page): Promise<{ readSeen: () => boolean; release: () => void; drop: () => void }> {
  let seen = false;
  let mode: "hold" | "drop" | "go" = "hold";
  let release!: () => void;
  const released = new Promise<void>((r) => (release = r));
  await page.route("**/api/coach/runs/*/step", async (route) => {
    if (seen && mode === "hold") await released;
    if (seen && mode === "drop") return route.abort();
    const res = await route.fetch();
    const body = await res.text();
    if (body.includes("Weighing the hips")) seen = true;
    await route.fulfill({ response: res, body });
  });
  return {
    readSeen: () => seen,
    release: () => {
      mode = "go";
      release();
    },
    drop: () => {
      mode = "drop";
      release();
    },
  };
}

test("1b. between a big answer's two steps: the athlete leaves for the Plan — the queued calls run there, no model asked again", async ({ page, context, baseURL }) => {
  test.setTimeout(150_000);
  await fresh(context.request, baseURL);
  await model("/use/big");
  const gate = await betweenBigSteps(page);
  await start(page, "a short, gentle hips session");
  await expect.poll(gate.readSeen, { timeout: 60_000 }).toBe(true);
  // The step that read the answer is back; the one that runs its calls is held: to the Plan, then let it go.
  await nav(page).getByRole("link", { name: /^Plan/ }).click();
  await expect(page).toHaveURL(/\/plan/);
  gate.release();
  await expect.poll(async () => (await current(context.request, baseURL)).run?.status, { timeout: 60_000 }).toBe("finished");
  // Two main turns before the finish, the reviewer, the finish: the queued calls asked no model.
  expect((await model("/calls")).begun).toBe(4);
  await nav(page).getByRole("link", { name: /^Studio/ }).click();
  await expect(card(page).getByRole("button", { name: TITLE })).toBeVisible({ timeout: 20_000 });
});

test("2b. between a big answer's two steps: the tab is closed — the calls wait, queued, and run once it's opened again", async ({ context, baseURL }) => {
  test.setTimeout(150_000);
  await fresh(context.request, baseURL);
  await model("/use/big");
  let page = await context.newPage();
  const gate = await betweenBigSteps(page);
  await start(page, "a short, gentle hips session");
  await expect.poll(gate.readSeen, { timeout: 60_000 }).toBe(true);
  gate.drop();
  await page.close();
  // Nobody steps it: the run waits, live, its calls queued.
  const waiting = await current(context.request, baseURL);
  expect(waiting.run?.status).toBe("active");
  page = await context.newPage();
  await page.goto("/studio");
  await expect(card(page).getByRole("button", { name: TITLE })).toBeVisible({ timeout: 90_000 });
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
  await expect(page.getByRole("heading", { name: /^Coach · / })).toBeVisible();
  await expect(card(page).getByRole("button", { name: TITLE })).toBeVisible({ timeout: 90_000 });

  // Approve, then reload before its answer is drawn: it lands once.
  const before = await todayCopies(context.request, baseURL);
  const proposalId = (await current(context.request, baseURL)).proposal!.id;
  await card(page).getByRole("button", { name: "Approve", exact: true }).click();
  await page.reload();
  await expect(page.getByPlaceholder("What would help today?")).toBeVisible({ timeout: 20_000 });
  await expect
    .poll(async () => ((await (await context.request.get(`${baseURL}/api/coach/proposals/${proposalId}`)).json()) as { status: string }).status, { timeout: 20_000 })
    .toBe("approved");
  expect(await todayCopies(context.request, baseURL)).toBe(before + 1);
  // Nothing offers a second approve.
  await expect(page.getByRole("button", { name: "Approve", exact: true })).toHaveCount(0);

  // Decline, then reload before its answer is drawn: declined, and nothing added.
  await fresh(context.request, baseURL);
  await start(page, "something calm");
  await expect(card(page).getByRole("button", { name: TITLE })).toBeVisible({ timeout: 60_000 });
  const declineId = (await current(context.request, baseURL)).proposal!.id;
  await card(page).getByRole("button", { name: "Decline" }).click();
  await card(page).locator(".coach-pc-decline").getByRole("button", { name: "Decline" }).click();
  await page.reload();
  await expect(page.getByPlaceholder("What would help today?")).toBeVisible({ timeout: 20_000 });
  await expect
    .poll(async () => ((await (await context.request.get(`${baseURL}/api/coach/proposals/${declineId}`)).json()) as { status: string }).status, { timeout: 20_000 })
    .toBe("declined");
  expect(await todayCopies(context.request, baseURL)).toBe(before + 1);
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

test("9. Now, Send, Approve, Decline and Cancel tapped twice or three times: one request each", async ({ page, context, baseURL }) => {
  test.setTimeout(180_000);
  await fresh(context.request, baseURL);
  await model("/use/ask");
  const seen = coachRequests(page);
  await page.goto("/studio");
  await page.getByPlaceholder("What would help today?").fill("tapped three times");
  await page.getByRole("button", { name: "Now", exact: true }).click({ clickCount: 3 });
  await expect(page.getByText("How do your hips feel today?", { exact: true })).toBeVisible({ timeout: 30_000 });
  expect(seen["POST /api/coach/runs"]).toBe(1);
  await expect(page.getByText("Copy my words back")).toHaveCount(0);

  await page.getByRole("button", { name: "Tight" }).click();
  await page.getByRole("button", { name: "Send" }).click({ clickCount: 3 });
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
  await expect(page.getByRole("heading", { name: "Coach · cancelled" })).toBeVisible({ timeout: 20_000 });
  expect(seen["POST /api/coach/runs/:id/cancel"]).toBe(1);
  await model("/delay/");
});

// A render error is what this journey injects: the page's own error report for it is expected, so it runs without the
// suite's "no page error" guard — and asserts instead that the app stood.
bare("12. a render error inside the coach stays in the coach: said in place, the Studio and the app go on", async ({ page, context, baseURL }) => {
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
  await expect(page.getByRole("heading", { name: "Coach · done" })).toBeVisible({ timeout: 90_000 });
  await expect(page.getByText("Something went wrong showing the coach — reload")).toBeVisible({ timeout: 30_000 });
  // The run view and the composer beside it stand; the Studio's own sections too; the app's navigation works.
  await expect(page.getByRole("heading", { name: "Coach · done" })).toBeVisible();
  await expect(page.getByPlaceholder("What would help today?")).toBeVisible();
  await expect(page.getByRole("heading", { name: "Quick starts" })).toBeVisible();
  await nav(page).getByRole("link", { name: /^Plan/ }).click();
  await expect(page).toHaveURL(/\/plan/);
  await expect(page.locator("#root")).not.toBeEmpty();
  await page.unroute("**/api/coach/proposals/*");
});
