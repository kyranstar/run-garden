import type { APIRequestContext } from "@playwright/test";
import { test, expect } from "./fixtures.js";

/**
 * THE COACH DESIGNER, END TO END (Stage 3 Task 9; Batch 3B's gate): the Studio's composer → a run on the scripted model
 * → the suggestion → Approve → the workout on the Plan. Everything but the model is the real app and the real worker:
 * the step loop, the opening context, the tools, the independent reviewer, the proposal, the approve.
 *
 * Needs the fixture stack on the scripted model, and skips itself otherwise:
 *
 *   RG_E2E_DESIGN_MODEL=scripted:now bash apps/web/e2e/fixture-stack.sh
 *   RG_E2E_DESIGN_MODEL=scripted:now RG_BASE=http://localhost:5271 pnpm --filter @rg/web exec playwright test coach-designer --workers=1
 *
 * One live run per athlete, and the projects share the fixture account: each journey first cancels a run left live and
 * declines a suggestion left open, so it starts from the empty composer.
 */

test.skip(process.env.RG_E2E_DESIGN_MODEL !== "scripted:now", "needs the fixture stack on the scripted model (RG_E2E_DESIGN_MODEL=scripted:now)");

/** Sign in (no Origin header: the /api/dev/* guard allows it), once more on a reset socket. */
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
  for (let i = 0; i < 5; i++) {
    const current = (await (await request.get(`${baseURL}/api/coach/runs/current`)).json()) as {
      run: { id: string; status: string } | null;
      proposal?: { id: string; status?: string } | null;
    };
    if (!current.run) return;
    if (["active", "stepping", "waiting_athlete", "waiting_review", "waiting_set"].includes(current.run.status)) {
      await request.post(`${baseURL}/api/coach/runs/${current.run.id}/cancel`, { data: {} });
    } else if (current.proposal && ["pending", "partially_approved"].includes(current.proposal.status ?? "")) {
      // (A suggestion decided in the last 10 minutes still comes back with its run: no one's to clear.)
      await request.post(`${baseURL}/api/coach/proposals/${current.proposal.id}/decline`, { data: {} });
    } else return;
  }
}

test("the composer → a scripted run → the suggestion → Approve → the workout is on the Plan", async ({ page, context, baseURL }) => {
  test.setTimeout(120_000);
  await signIn(context.request, baseURL);
  await clearTheCoach(context.request, baseURL);

  await page.goto("/studio");
  const field = page.getByPlaceholder("What would help today?");
  await expect(field).toBeVisible();
  await field.fill("a short, gentle hips session");
  await page.getByRole("button", { name: "Now", exact: true }).click();

  // The run view stands in the composer's place while the coach works; its lines are the events'.
  await expect(page.getByRole("heading", { name: /^Coach · / })).toBeVisible();
  await expect(page.getByText("“a short, gentle hips session”")).toBeVisible();

  // The run finishes on its own (the client steps it) and its suggestion opens under the composer. The card's heading
  // says what became of it once decided (fix wave 3B, M3), so the card is found by its own box.
  await expect(page.getByRole("region", { name: "The coach suggests" })).toBeVisible({ timeout: 60_000 });
  const card = page.locator("section.coach-pc");
  await expect(page.getByRole("heading", { name: "Coach · done" })).toBeVisible();
  // Once over, the trail folds to one line; the card's Approve sits high (B-I7).
  await expect(page.getByRole("button", { name: "How the coach made this" })).toHaveAttribute("aria-expanded", "false");
  await expect(card.getByRole("button", { name: "Hips and back, gently" })).toBeVisible();
  await expect(card).toContainText("Reviewed");

  // A tip from the review is on the card; the review's scores, one tap down, in plain words (M1, M2).
  await expect(card.getByText("Hold the last bridge for a slow count of three.")).toBeVisible();
  await expect(card.getByText("Clear purpose")).toBeHidden();
  await card.getByRole("button", { name: "See the review" }).click();
  await expect(card.getByText("Clear purpose")).toBeVisible();

  await card.getByRole("button", { name: "Approve", exact: true }).click();
  const placed = card.getByRole("link", { name: /^On your plan for / });
  await expect(placed).toBeVisible({ timeout: 30_000 });
  await expect(card.getByRole("heading", { name: "Added to your plan" })).toBeVisible();

  // That day on the Plan, the workout's sheet open.
  await placed.click();
  await expect(page).toHaveURL(/\/plan\?week=\d{4}-\d{2}-\d{2}&workout=/);
  await expect(page.getByRole("dialog").getByText("Hips and back, gently").first()).toBeVisible({ timeout: 15_000 });
});
