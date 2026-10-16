import { test as base, expect, type BrowserContext, type Page } from "@playwright/test";

/**
 * The smoke suite's `test` (Audit 2 E2E I2): every test also fails on an
 * uncaught page error and on any 5xx from `/api/*` — an API that broke
 * somewhere the assertions do not look still fails the run.
 */
export const test = base.extend<{ failOnBrokenPage: void }>({
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
