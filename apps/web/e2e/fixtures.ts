import { test as base, expect } from "@playwright/test";

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
