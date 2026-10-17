import type { APIRequestContext, Page } from "@playwright/test";
import { test, expect } from "./fixtures.js";

/**
 * COACH EVERYWHERE, END TO END (phase A): a planned workout's sheet → "Ask" → the app's coach sheet over the Plan, the
 * workout as its chip → Now → the run on the scripted model → the suggestion, in the sheet → "Change something…" → the
 * follow-up's run → its suggestion in the old one's place, the old one superseded with the athlete's words. Everything
 * but the model is the real app and the real worker: the focus checked and read into the opening context, the step
 * loop, the reviewer, the proposal, the supersede.
 *
 * Needs the fixture stack on the scripted model, and skips itself otherwise:
 *
 *   RG_E2E_DESIGN_MODEL=scripted:now bash apps/web/e2e/fixture-stack.sh
 *   RG_E2E_DESIGN_MODEL=scripted:now RG_BASE=http://localhost:5271 pnpm --filter @rg/web exec playwright test coach-everywhere --workers=1
 *
 * The stand-in model is switched to the `followup` script for the journey (`POST /use/followup`: as `now`, but a run
 * asked from a suggestion proposes it shorter) and back after it. One live run per athlete, and the projects share the
 * fixture account: the journey first cancels a run left live and declines a suggestion left open.
 */

test.skip(process.env.RG_E2E_DESIGN_MODEL !== "scripted:now", "needs the fixture stack on the scripted model (RG_E2E_DESIGN_MODEL=scripted:now)");

const MODEL = `http://127.0.0.1:${process.env.RG_DESIGN_MODEL_PORT ?? "8897"}`;
const LIVE = ["active", "stepping", "waiting_athlete", "waiting_review", "waiting_set"];

async function model(path: string): Promise<void> {
  await fetch(`${MODEL}${path}`, { method: "POST" });
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

/** Nothing of an earlier journey's left: no live run, no open suggestion. */
async function clearTheCoach(request: APIRequestContext, baseURL: string | undefined) {
  for (let i = 0; i < 6; i++) {
    const current = (await (await request.get(`${baseURL}/api/coach/runs/current`)).json()) as {
      run: { id: string; status: string } | null;
      proposal?: { id: string; status?: string } | null;
      alsoOpen?: Array<{ proposalId: string }>;
    };
    for (const a of current.alsoOpen ?? []) await request.post(`${baseURL}/api/coach/proposals/${a.proposalId}/decline`, { data: {} });
    if (!current.run) return;
    if (LIVE.includes(current.run.status)) {
      await request.post(`${baseURL}/api/coach/runs/${current.run.id}/cancel`, { data: {} });
    } else if (current.proposal && ["pending", "partially_approved"].includes(current.proposal.status ?? "")) {
      await request.post(`${baseURL}/api/coach/proposals/${current.proposal.id}/decline`, { data: {} });
    } else return;
  }
}

/** A planned workout to ask from: today's, else the next one the plan holds. */
async function aPlannedWorkout(request: APIRequestContext, baseURL: string | undefined): Promise<{ id: string; title: string }> {
  const today = (await (await request.get(`${baseURL}/api/plan/today`)).json()) as {
    nextWorkout: { id: string; title: string; category: string } | null;
    upcoming?: Array<{ id: string; title: string; category: string }>;
  };
  const w = [today.nextWorkout, ...(today.upcoming ?? [])].find((x) => x && x.category !== "rest");
  if (!w) throw new Error("the fixture plan holds no workout to ask from");
  return w;
}

const coachSheet = (page: Page) => page.getByRole("dialog", { name: "Coach" });

test("a planned workout's sheet → Ask → the coach's sheet with its chip → a suggestion → 'Change something…' → the new one replaces it", async ({ page, context, baseURL }) => {
  test.setTimeout(150_000);
  await signIn(context.request, baseURL);
  await clearTheCoach(context.request, baseURL);
  await model("/use/followup");
  try {
    const w = await aPlannedWorkout(context.request, baseURL);
    await page.goto(`/plan?workout=${encodeURIComponent(w.id)}`);
    const workoutSheet = page.getByRole("dialog").first();
    await expect(workoutSheet).toBeVisible({ timeout: 15_000 });

    // Ask, from the workout's own sheet: the coach's sheet opens over it, in place — the chip says what it is about.
    await workoutSheet.getByRole("button", { name: /^Ask the coach about / }).click();
    const sheet = coachSheet(page);
    await expect(sheet).toBeVisible();
    await expect(page).toHaveURL(/\/plan\?workout=/);
    await expect(sheet.locator(".coach-about")).toContainText(`About: `);
    await expect(sheet.locator(".coach-about")).toContainText(w.title);
    await expect(sheet.getByPlaceholder("What would help today?")).toBeFocused();
    await sheet.getByPlaceholder("What would help today?").fill("something gentle for the hips instead");
    await sheet.getByRole("button", { name: "Now", exact: true }).click();

    // The run works in the sheet; its suggestion opens there.
    await expect(sheet.getByRole("heading", { name: /^Coach · / })).toBeVisible();
    const card = sheet.locator("section.coach-pc");
    await expect(card.getByRole("button", { name: "Hips and back, gently" })).toBeVisible({ timeout: 60_000 });
    // The run was asked from the workout: its read says so.
    const first = (await (await context.request.get(`${baseURL}/api/coach/runs/current`)).json()) as {
      run: { id: string; focus?: { kind: string; id: string } };
      proposal: { id: string };
    };
    expect(first.run.focus).toEqual({ kind: "workout", id: w.id });
    const firstProposal = first.proposal.id;

    // The follow-up: one line under the suggestion.
    const follow = card.getByPlaceholder("Change something…");
    await expect(follow).toBeVisible();
    await follow.fill("Make it shorter");
    await card.getByRole("button", { name: "Send", exact: true }).click();

    // The follow-up's trail takes the card's place; then its suggestion stands where the old one was.
    await expect(sheet.getByRole("button", { name: "Hips and back, shorter" })).toBeVisible({ timeout: 60_000 });
    await expect(sheet.getByRole("button", { name: "Hips and back, gently" })).toHaveCount(0);
    await expect(sheet.locator("section.coach-pc")).toHaveCount(1);

    // The old suggestion: superseded by the new one, with the athlete's words.
    const old = (await (await context.request.get(`${baseURL}/api/coach/proposals/${firstProposal}`)).json()) as {
      status: string;
      lines: Array<{ outcome: { status: string; reason?: string } | null }>;
    };
    expect(old.status).toBe("superseded");
    expect(old.lines[0]!.outcome).toMatchObject({ status: "superseded", reason: "Changed: Make it shorter" });
    const next = (await (await context.request.get(`${baseURL}/api/coach/runs/current`)).json()) as {
      run: { focus?: { kind: string; id: string } };
      proposal: { id: string };
      alsoOpen?: unknown[];
    };
    expect(next.run.focus).toEqual({ kind: "proposal", id: firstProposal });
    expect(next.proposal.id).not.toBe(firstProposal);
    // One current suggestion: nothing else waiting.
    expect(next.alsoOpen ?? []).toEqual([]);

    // Escape closes the coach's sheet; the workout's sheet is still there under it.
    await page.keyboard.press("Escape");
    await expect(sheet).toHaveCount(0);
    await expect(workoutSheet).toBeVisible();
  } finally {
    await model("/use/");
  }
});
