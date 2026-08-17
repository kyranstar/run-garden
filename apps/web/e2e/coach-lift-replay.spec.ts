import { test, expect } from "@playwright/test";

/**
 * END-TO-END REPLAY of the live 2026-08-16 failure.
 *
 * HOW TO RUN (three processes; see docs/TESTING.md for the base stack):
 *   node apps/web/e2e/coach-lift-replay-model.mjs                  # :8899
 *   cd apps/worker && npx wrangler dev --port 8840 \
 *     --var FIXTURE_MODE:1 --var APP_URL:http://localhost:5240 \
 *     --var AI_GATEWAY_BASE_URL:http://127.0.0.1:8899 --var AI_GATEWAY_API_KEY:stub
 *   RG_API_PORT=8840 RG_WEB_PORT=5240 pnpm --filter @rg/web dev     # :5240
 *   RG_BASE=http://localhost:5240 RG_MODEL_STUB=1 \
 *     pnpm --filter @rg/web exec playwright test e2e/coach-lift-replay.spec.ts
 *
 * Skipped without RG_MODEL_STUB: the coach reply has to come from the local
 * recorded-model server, and against a real gateway this would burn tokens
 * and assert on output nobody controls.
 *
 * The athlete's verbatim message goes in through the real HTTP surface
 * (`POST /api/coach/message` → `wake`), the coach's reply comes from a
 * recorded model response (no API key in this worktree — see
 * scratchpad/model-stub.mjs for how the bytes were reconstructed from the
 * failure's own `schemaIssues`), and everything after those bytes is the
 * real worker: zod → name→originId resolution → guardrails → persistence →
 * the DTO the app reads.
 *
 * Before this branch: 0 proposals, prose promising three leg sessions, and
 * a receipt saying only "couldn't be formatted".
 */

const MESSAGE =
  "Okay I missed some runs because I was camping. I did a bit of kayaking but mostly drinking, and I’m super stiff. " +
  "I want to replan this week to get me seriously into shape - this is going to by my number one priority before my " +
  "ski trip on the 26th. I want to add a daily lift component to augment my existing lift plan with things like " +
  "wallsits and anything else that will get me super prepared for skiing by the 26th.";

test.skip(!process.env.RG_MODEL_STUB, "needs the recorded-model server (see the header)");

test("the athlete's verbatim ski-prep message produces real proposals with real ops", async ({
  context,
  page,
  baseURL,
}) => {
  test.setTimeout(120_000);
  expect((await context.request.post(`${baseURL}/api/dev/fixture-login`)).ok()).toBeTruthy();
  expect((await context.request.post(`${baseURL}/api/dev/seed`)).ok()).toBeTruthy();

  const res = await context.request.post(`${baseURL}/api/coach/message`, {
    data: { body: MESSAGE },
    timeout: 90_000,
  });
  expect(res.ok()).toBeTruthy();

  // The wake outlives the request it was asked for (2026-08-17): the route
  // dispatches and answers "working", and `coachThinking` says when it's
  // done — the same signal the app itself polls.
  let state = await (await context.request.get(`${baseURL}/api/coach/state`)).json();
  for (let i = 0; i < 120 && state.coachThinking === true; i++) {
    await new Promise((r) => setTimeout(r, 1_000));
    state = await (await context.request.get(`${baseURL}/api/coach/state`)).json();
  }
  console.log("\n=== RECEIPTS / MESSAGES ===");
  for (const m of state.messages as Array<Record<string, unknown>>) {
    console.log(`  [${m.role}] ${String(m.body).slice(0, 220)}`);
  }
  // Only the proposal this message produced — the fixture seed ships two
  // unrelated pending proposals of its own.
  const pending = (state.pendingProposals as Array<Record<string, unknown>>).filter(
    (p) => String(p.title).includes("Ski-prep"),
  );

  // ── Evidence 1: N proposals out, with their ops ────────────────────────
  console.log("\n=== PROPOSALS ===");
  console.log(JSON.stringify(pending, null, 2));
  expect(pending.length).toBeGreaterThan(0);

  const ops = pending.flatMap((p) => p.ops as Array<Record<string, unknown>>);
  const sessions = ops.map((o) => o.session as Record<string, unknown>).filter(Boolean);
  expect(sessions.length).toBeGreaterThanOrEqual(5);

  // ── Evidence 2: a wall sit is a HOLD, not fake reps ────────────────────
  const allExercises = sessions.flatMap(
    (s) =>
      ((s.lift as { exercises?: Array<Record<string, unknown>> })?.exercises ??
        (s.mobility as { exercises?: Array<Record<string, unknown>> })?.exercises ??
        []) as Array<Record<string, unknown>>,
  );
  const wallSit = allExercises.find((e) => e.name === "Wall sit")!;
  console.log("\n=== WALL SIT AS STORED ===");
  console.log(JSON.stringify(wallSit, null, 2));
  expect(wallSit.holdSeconds).toBe(45);
  expect(wallSit.reps).toBeUndefined();
  expect(wallSit.weight).toEqual({ type: "bodyweight" });

  // The other two primitives the old vocabulary could not hold.
  expect(allExercises.some((e) => e.eccentricSeconds === 4)).toBe(true);
  expect(allExercises.some((e) => e.perSide === true)).toBe(true);
  // …and the circuit.
  expect(sessions.some((s) => (s.lift as { rounds?: number })?.rounds === 3)).toBe(true);
  // …and the third discipline body.
  expect(sessions.some((s) => s.mobility)).toBe(true);

  // ── Evidence 3: name → originId for every exercise, misses included ────
  console.log("\n=== NAME → originId RESOLUTION ===");
  for (const e of allExercises) {
    console.log(`  ${String(e.name).padEnd(28)} → ${e.originId ?? "(no catalog match — app-only)"}`);
  }
  const resolved = allExercises.filter((e) => e.originId);
  const missed = allExercises.filter((e) => !e.originId);
  expect(resolved.length).toBeGreaterThan(0);
  // The deliberate misses — neither is in COROS's library — survive as real
  // exercises rather than failing or vanishing from their sessions.
  expect(missed.map((e) => e.name).sort()).toEqual(["Couch stretch", "Skier hops"]);

  // ── Evidence 4: the proposal, rendered ────────────────────────────────
  await page.goto("/plan");
  const card = page.locator(`#proposal-${pending[0]!.id}`);
  await card.scrollIntoViewIfNeeded();
  await card.getByRole("button", { name: "Why?" }).click();
  await page.waitForTimeout(600); // let the sheet/disclosure animation settle
  await page.screenshot({ path: "../../screenshots/coach-ski-prep-proposal.png", fullPage: false });

  // ── Approve, and prove the sessions land with the right discipline ─────
  // Re-read first: opening /plan fires an "open" wake, and a fresh wake
  // supersedes the proposal it replaces, so the id captured above may
  // already be retired.
  const fresh = await (await context.request.get(`${baseURL}/api/coach/state`)).json();
  const toApprove = (fresh.pendingProposals as Array<Record<string, unknown>>).filter((p) =>
    String(p.title).includes("Ski-prep"),
  );
  expect(toApprove.length).toBeGreaterThan(0);
  for (const p of toApprove) {
    const ok = await context.request.post(`${baseURL}/api/coach/proposals/${p.id}/approve`);
    expect(ok.ok(), `approve ${p.id}: ${await ok.text()}`).toBeTruthy();
  }
  const plan = await (
    await context.request.get(`${baseURL}/api/plan/week?start=2026-08-17`)
  ).json();
  const created = (plan.days as Array<{ workouts: Array<Record<string, unknown>> }>)
    .flatMap((d) => d.workouts)
    .filter((w) => String(w.id).startsWith("cw-"));
  console.log("\n=== APPLIED SESSIONS ===");
  for (const w of created) {
    console.log(
      `  ${w.effectiveDate} ${String(w.title).padEnd(32)} sport=${w.sport} category=${w.category}`,
    );
    console.log(`      ${w.stageSummary}`);
    for (const e of (w.exercises as Array<{ line: string; onWatch: boolean }>) ?? []) {
      console.log(`      · ${e.line}${e.onWatch ? "" : "   [not on watch]"}`);
    }
  }
  // ── Evidence 5: the applied session, rendered ─────────────────────────
  // Step to the ski-prep week and open the wall-sit circuit.
  await page.goto("/plan");
  await page.getByRole("button", { name: "Next week" }).click();
  const filler = page.getByText("Wall-sit + core filler").first();
  await filler.waitFor({ state: "visible", timeout: 15_000 });
  await filler.click();
  await page.getByText("3 rounds of:").waitFor({ state: "visible", timeout: 10_000 });
  await page.waitForTimeout(800); // the sheet fades in — screenshot it settled
  await page.screenshot({ path: "../../screenshots/coach-ski-prep-session.png", fullPage: false });
  await page.getByRole("button", { name: "Close" }).click();

  // …and the graceful degradation: a mobility session whose "Couch stretch"
  // the athlete's COROS library has never heard of. The session is real, it
  // shows, and the one movement that can't reach the watch says so.
  const yoga = page.getByText("Hips and ankles").first();
  await yoga.click();
  await page.getByText("not on watch").first().waitFor({ state: "visible", timeout: 10_000 });
  await page.waitForTimeout(800);
  await page.screenshot({ path: "../../screenshots/coach-off-catalog-exercise.png", fullPage: false });

  // The mobility session is yoga, NOT a run — the old binary fallback's lie.
  const mobility = created.find((w) => w.category === "yoga");
  expect(mobility?.sport).toBe("yoga");
  // Every lift session is strength.
  expect(created.filter((w) => w.category === "strength").every((w) => w.sport === "strength")).toBe(true);
});
