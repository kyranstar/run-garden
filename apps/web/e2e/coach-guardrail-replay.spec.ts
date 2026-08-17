import { test, expect, type APIRequestContext } from "@playwright/test";

/**
 * THE GUARDRAILS, DRIVEN END TO END through the real HTTP surface.
 *
 * Unit tests prove `validateOps` classifies these shapes. This proves the whole
 * pipeline does: dossier → recorded model reply → zod → guardrails → the rows
 * the panel reads. The four cases are the four things the 2026-08-16 ski-prep
 * failure did that nothing stopped — a lift block from a standing start, a week
 * with no rest day, the heaviest session two days before the trip, and an op
 * aimed at the second of two same-category rows on one day.
 *
 * WHAT THIS FILE USED TO ASSERT, and why it changed (2026-08-17). Every case
 * below used to end in a receipt: the proposal was rejected, nothing was
 * applied, and the athlete was told about a plan they never saw. All four are
 * judgements about load, not broken plans, so all four are ADVISORY now — the
 * proposal reaches the athlete as a pending card carrying the cost as a
 * trade-off line, and they decide. The findings themselves are unchanged and
 * the strings are still checked here, because "the athlete is told" is only
 * worth anything if what they are told is right.
 *
 * The recorded model returns the SAME bytes for any repair round-trip, which is
 * what makes the last case honest: an advisory must not provoke one.
 *
 * HOW TO RUN (three processes):
 *   node apps/web/e2e/coach-guardrail-replay-model.mjs                # :8898
 *   cd apps/worker && npx wrangler dev --port 8844 \
 *     --var FIXTURE_MODE:1 --var APP_URL:http://localhost:5244 \
 *     --var AI_GATEWAY_BASE_URL:http://127.0.0.1:8898 --var AI_GATEWAY_API_KEY:stub
 *   RG_API_PORT=8844 RG_WEB_PORT=5244 pnpm --filter @rg/web dev        # :5244
 *   RG_BASE=http://localhost:5244 RG_MODEL_STUB=1 \
 *     pnpm --filter @rg/web exec playwright test e2e/coach-guardrail-replay.spec.ts
 */

const STUB = "http://127.0.0.1:8898";

test.skip(!process.env.RG_MODEL_STUB, "needs the recorded-model server (see the header)");

interface Pending {
  id: string;
  title: string;
  flags: string[];
  status: string;
}

/** Point the recorded model at one scenario, with the dates this run needs. */
async function arm(
  request: APIRequestContext,
  scenario: string,
  dates: Record<string, string | string[]>,
): Promise<void> {
  const res = await request.post(`${STUB}/scenario`, { data: { scenario, dates } });
  expect(res.ok()).toBeTruthy();
}

/**
 * One athlete message → one wake → the thread and the tray it produced. The
 * wake is awaited inside the POST (2026-08-17), so the response means "done".
 */
async function ask(
  request: APIRequestContext,
  baseURL: string,
  body: string,
): Promise<{ receipts: string[]; pending: Pending[] }> {
  const res = await request.post(`${baseURL}/api/coach/message`, { data: { body }, timeout: 90_000 });
  expect(res.ok(), await res.text()).toBeTruthy();
  const state = await (await request.get(`${baseURL}/api/coach/state`)).json();
  return {
    receipts: (state.messages as Array<{ role: string; body: string }>)
      .filter((m) => m.role === "receipt")
      .map((m) => m.body),
    pending: state.pendingProposals as Pending[],
  };
}

/** The proposal this scenario minted, and its trade-off lines as one string. */
function tradeOffs(pending: Pending[], marker: string): string {
  const p = pending.find((x) => x.title.includes(marker));
  expect(p, `the ${marker} proposal must reach the athlete as an approvable card`).toBeTruthy();
  expect(p!.status).toBe("pending");
  return p!.flags.join(" | ");
}

async function weekRunMinutes(
  request: APIRequestContext,
  baseURL: string,
  start: string,
): Promise<{ total: number; byId: Map<string, number> }> {
  const week = await (await request.get(`${baseURL}/api/plan/week?start=${start}`)).json();
  const byId = new Map<string, number>();
  let total = 0;
  for (const day of week.days as Array<{ workouts: Array<Record<string, unknown>> }>) {
    for (const w of day.workouts) {
      const minutes = Math.round((w.calendarSeconds as number) / 60);
      byId.set(w.id as string, minutes);
      if (w.category !== "rest" && w.sport === "run") total += minutes;
    }
  }
  return { total, byId };
}

test("the four guardrails the ski-prep failure walked straight through", async ({
  context,
  baseURL,
}) => {
  test.setTimeout(240_000);
  const request = context.request;
  expect((await request.post(`${baseURL}/api/dev/fixture-login`)).ok()).toBeTruthy();
  expect((await request.post(`${baseURL}/api/dev/seed`)).ok()).toBeTruthy();

  const today = (await (await request.get(`${baseURL}/api/plan/today`)).json()).today as string;
  const iso = (offset: number) => {
    const d = new Date(`${today}T12:00:00Z`);
    d.setUTCDate(d.getUTCDate() + offset);
    return d.toISOString().slice(0, 10);
  };
  // The Monday of next week, and the seven days that follow it.
  const sunFirst = new Date(`${today}T12:00:00Z`).getUTCDay();
  const monday = iso(8 - (sunFirst === 0 ? 7 : sunFirst));
  const week = Array.from({ length: 7 }, (_, i) => {
    const d = new Date(`${monday}T12:00:00Z`);
    d.setUTCDate(d.getUTCDate() + i);
    return d.toISOString().slice(0, 10);
  });
  console.log(`\ntoday=${today}  next week starts ${monday}`);

  // ── 1 · COLD START ─────────────────────────────────────────────────────
  // Three 50-minute leg sessions on consecutive days for someone whose
  // trailing strength volume is zero. The ramp check is multiplicative, so
  // before this branch it computed a cap of zero, hit `avg > 0` and said
  // nothing at all — silent for exactly the athlete it protects.
  await arm(context.request, "cold-start", { d1: week[1]!, d3: week[2]!, d5: week[3]! });
  let out = await ask(request, baseURL!, "Give me a lift session every day before my ski trip.");
  const cold = tradeOffs(out.pending, "GUARD-cold-start");
  console.log(`\n[cold start] ${cold}`);
  expect(cold).toContain("no strength work in the last four weeks");
  expect(cold).toContain("150 minutes");
  // …and the 30-minute hard-lift threshold: three 50-minute lifts in a row
  // were not "hard" at the old 60-minute bar, so nothing objected to those
  // either.
  expect(cold, "50-minute lifts on consecutive days are back-to-back hard days").toContain(
    "back to back",
  );
  // The whole point of the rework: it is a card with an approve button, not a
  // sentence about something invisible.
  expect(out.receipts.filter((r) => r.startsWith("Not applied"))).toHaveLength(0);

  // ── 2 · NO REST DAY ────────────────────────────────────────────────────
  // Fill the two free days of next week and the athlete has seven on, seven.
  await arm(context.request, "no-rest-day", { d1: week[0]!, restOfWeek: [week[0]!, week[4]!] });
  out = await ask(request, baseURL!, "I want to run every single day next week.");
  const rest = tradeOffs(out.pending, "GUARD-no-rest");
  console.log(`\n[no rest day] ${rest}`);
  expect(rest).toContain("no rest day at all");

  // ── 3 · A DATED EVENT THE ATHLETE TOLD THE COACH ABOUT ─────────────────
  // Round trip: the coach writes the trip to memory in one wake, and the
  // guardrail reads it back in the next. Nothing else in this app remembers
  // a ski trip — which is why the coach cheerfully scheduled its heaviest
  // unaccustomed leg session two days before one.
  const trip = iso(10);
  await arm(context.request, "trip-record", {
    d1: week[1]!,
    trip,
    tripEnd: iso(14),
    tripEve: iso(9),
  });
  const before3 = (await (await request.get(`${baseURL}/api/coach/state`)).json()).memoryCount as number;
  await ask(request, baseURL!, `I'm going skiing on the ${trip.slice(-2)}th — get me ready.`);
  const after3 = (await (await request.get(`${baseURL}/api/coach/state`)).json()).memoryCount as number;
  expect(after3, "the coach must record the trip in memory — nothing else remembers it").toBeGreaterThan(
    before3,
  );

  await arm(context.request, "trip-violate", { trip, tripEnd: iso(14), tripEve: iso(9) });
  out = await ask(request, baseURL!, "Anything else I should do this week?");
  const eve = tradeOffs(out.pending, "GUARD-trip-eve");
  console.log(`\n[event taper] ${eve}`);
  expect(eve).toContain("Ski trip");
  expect(eve).toContain("last two days before");

  // ── 4 · TWO SAME-CATEGORY SESSIONS ON ONE DAY ──────────────────────────
  // `entryFor` matched on date+category, so both rows resolved to whichever
  // came first and the guardrail reasoned about a calendar that would never
  // exist. Set the collision up with a move, then aim an ease at the SECOND
  // row and check which duration the ramp trade-off quotes.
  const before = await weekRunMinutes(request, baseURL!, monday);
  const collisionDate = week[1]!;
  const dayTwo = (
    await (await request.get(`${baseURL}/api/plan/week?start=${monday}`)).json()
  ).days.find((d: { date: string }) => d.date === week[3]!);
  const moveId = (dayTwo.workouts as Array<{ id: string; category: string }>).find(
    (w) => w.category === "quality",
  )!.id;
  const movedMinutes = before.byId.get(moveId)!;

  await arm(context.request, "double-setup", {
    moveId,
    collisionDate,
    setupExpiry: collisionDate,
  });
  out = await ask(request, baseURL!, "Move Thursday's session onto Tuesday, I'm away Thursday.");
  const setup = out.pending.find((p) => p.title.includes("GUARD-double-setup"));
  expect(setup, "the setup move must survive the guardrails").toBeTruthy();
  expect((await request.post(`${baseURL}/api/coach/proposals/${setup!.id}/approve`)).ok()).toBeTruthy();

  const collided = (
    await (await request.get(`${baseURL}/api/plan/week?start=${monday}`)).json()
  ).days.find((d: { date: string }) => d.date === collisionDate);
  const quality = (collided.workouts as Array<{ id: string; category: string }>).filter(
    (w) => w.category === "quality",
  );
  console.log(`\n[two on a day] ${collisionDate} now holds ${quality.length} quality rows`);
  expect(quality.length, "two same-category rows on one day — reachable today").toBe(2);

  // Blow the second row up to 300 minutes. The week the athlete would
  // actually have is (unchanged total − that row's minutes + 300); easing
  // the wrong row would quote a different number.
  await arm(context.request, "double", { secondRowId: moveId, setupExpiry: collisionDate });
  out = await ask(request, baseURL!, "Make Tuesday's second session a long easy one.");
  const doubled = tradeOffs(out.pending, "GUARD-double");
  const expected = before.total - movedMinutes + 300;
  console.log(
    `\n[two on a day] week was ${before.total} min, moved row is ${movedMinutes} min → expect ${expected}\n${doubled}`,
  );
  expect(doubled, "the ramp must quote the calendar this ease actually produces").toContain(
    `${expected} minutes`,
  );
});
