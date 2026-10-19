import { test as base, expect, type BrowserContext, type Page, type Request } from "@playwright/test";

/** The longest a navigation waits for the page's reads before it goes anyway. */
const READS_PATIENCE_MS = 10_000;
/** How long the page must stay without a read in flight to count as settled: a read the last one's answer starts. */
const READS_QUIET_MS = 150;

/**
 * The page's own reads (`fetch`/XHR to `/api/*`), followed in flight, so that a navigation never cuts them: WebKit
 * reports each fetch a navigation cuts as a page error ("Fetch API cannot load … due to access control checks"), which
 * the guard below rightly fails on — and a journey that loads its next address while the last page is still reading
 * fails whenever the runner is slow (CI 9614fd8: `/insights` → `/garden` with Growth's five reads out, 2026-10-19).
 * A journey that MEANS to cut reads (a reload mid-step) uses the bare test and its own guard (coach-robustness).
 */
function followReads(page: Page): () => Promise<void> {
  const inFlight = new Map<Request, number>();
  let navigatedAt = 0;
  page.on("request", (r) => {
    if (r.frame() !== page.mainFrame()) return;
    if (r.isNavigationRequest()) navigatedAt = Date.now();
    else if ((r.resourceType() === "fetch" || r.resourceType() === "xhr") && new URL(r.url()).pathname.startsWith("/api/")) inFlight.set(r, Date.now());
  });
  const done = (r: Request) => void inFlight.delete(r);
  page.on("requestfinished", done);
  page.on("requestfailed", done);
  // A read of a document that has gone is not waited for: WebKit does not always say it failed.
  page.on("domcontentloaded", () => {
    for (const [r, at] of inFlight) if (at < navigatedAt) inFlight.delete(r);
  });
  return async () => {
    if (page.url() === "about:blank") return;
    const until = Date.now() + READS_PATIENCE_MS;
    let quietSince = inFlight.size === 0 ? Date.now() : 0;
    while (Date.now() < until) {
      if (inFlight.size > 0) quietSince = 0;
      else if (!quietSince) quietSince = Date.now();
      else if (Date.now() - quietSince >= READS_QUIET_MS) break;
      await new Promise((r) => setTimeout(r, 25));
    }
    inFlight.clear();
  };
}

/**
 * The smoke suite's `test` (Audit 2 E2E I2): every test also fails on an
 * uncaught page error and on any 5xx from `/api/*` — an API that broke
 * somewhere the assertions do not look still fails the run.
 *
 * And its `page` lets the page's reads answer before it leaves: `goto` and
 * `reload` wait until no read is in flight (`followReads`), as a reader who
 * waited for the page would — the guard then never sees a read the journey
 * itself cut.
 */
export const test = base.extend<{ failOnBrokenPage: void }>({
  page: async ({ page }, use) => {
    const settled = followReads(page);
    const goto = page.goto.bind(page);
    const reload = page.reload.bind(page);
    page.goto = async (url, options) => {
      await settled();
      return goto(url, options);
    };
    page.reload = async (options) => {
      await settled();
      return reload(options);
    };
    await use(page);
  },
  failOnBrokenPage: [
    async ({ page }, use) => {
      const problems: string[] = [];
      page.on("pageerror", (e) => problems.push(`pageerror: ${e.name}: ${e.message}`));
      page.on("response", (r) => {
        const { pathname } = new URL(r.url());
        if (pathname.startsWith("/api/") && r.status() >= 500) {
          problems.push(`${r.status()} ${r.request().method()} ${pathname}`);
        }
      });
      await use();
      expect(problems, "uncaught page errors and 5xx /api responses").toEqual([]);
    },
    { auto: true },
  ],
});

export { expect };

/**
 * The page's clock at mid-morning of the ACCOUNT's own day, in the account's own zone: the date the server keeps
 * (`GET /api/plan/today`) and the zone it keeps it in (the settings). Pinned from the runner's own date, as it once
 * was, the page ran ahead of the server by a day whenever the runner's zone had passed midnight and the account's had
 * not (CI in UTC, the fixture account in Los Angeles) — whatever zone the runner or the browser is in, the two agree.
 */
export async function pinAccountMorning(page: Page, context: BrowserContext, baseURL: string | undefined): Promise<void> {
  const today = ((await (await context.request.get(`${baseURL}/api/plan/today`)).json()) as { today: string }).today;
  const zone = ((await (await context.request.get(`${baseURL}/api/settings`)).json()) as { prefs: { timezone: string } }).prefs.timezone;
  await page.clock.install({ time: zonedTime(today, 10, zone) });
}

/** The instant that is `hour`:00 on `date` in `timeZone`. */
export function zonedTime(date: string, hour: number, timeZone: string): Date {
  const [y, m, d] = date.split("-").map(Number);
  const guess = Date.UTC(y!, m! - 1, d!, hour);
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-US", { timeZone, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" })
      .formatToParts(new Date(guess))
      .map((p) => [p.type, p.value]),
  );
  const shown = Date.UTC(Number(parts.year), Number(parts.month) - 1, Number(parts.day), Number(parts.hour), Number(parts.minute));
  return new Date(guess - (shown - guess));
}
