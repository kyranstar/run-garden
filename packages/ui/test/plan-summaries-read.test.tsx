// @vitest-environment jsdom
/**
 * THE PLANS READ, FAILING (`usePlanSummaries`, `GET /api/plans`): it's where a course's row comes from and any row's plan name, so
 * a failure has to read as "not read yet", never as "no plans". It tries again as every read of the app does, the rows meanwhile
 * keep the names they have of their own, and it comes back when something next reads it. It's never in the page's gate, so none of
 * this holds a paint. Synthetic data only.
 */
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { PlanSummaryDto, TrainingLineDto } from "@rg/api-client";
import { YourPlans } from "../src/screens/plan-cards.js";
import { usePlanSummaries } from "../src/screens/plan-sheet.js";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const today = "2026-08-11";
const noop = () => undefined;

const phases: TrainingLineDto["phases"] = [
  { id: "r1", discipline: "run", status: "active", name: "Base", startDate: "2026-08-03", endDate: "2026-08-23", planRaceDate: null, futureSessions: 0 },
  { id: "r2", discipline: "run", status: "active", name: "Race build", startDate: "2026-08-24", endDate: "2026-09-13", planRaceDate: null, futureSessions: 0 },
];
const line: TrainingLineDto = { key: "run:r1", discipline: "run", name: "Running", phases, currentPhaseId: "r1", startDate: "2026-08-03", endDate: "2026-09-13", goalRaceDate: null, ended: false };

const summary = (over: Partial<PlanSummaryDto> = {}): PlanSummaryDto => ({
  id: "c1",
  kind: "course",
  name: "Evening practice",
  purpose: "A made-up practice.",
  brief: "Keep the order.",
  onEnd: "continue",
  pausedUntil: null,
  objectiveIds: [],
  status: "active",
  lineKey: null,
  listedAs: "c1",
  course: { session: 2, of: 4 },
  prompt: null,
  ...over,
});
const THE_PLANS = [summary(), summary({ id: "plan-1", kind: "coach", name: "Autumn build", lineKey: line.key, listedAs: null, course: null })];

const json = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status, headers: { "Content-Type": "application/json" } });

let root: Root | null = null;
let host: HTMLDivElement | null = null;

afterEach(() => {
  act(() => root?.unmount());
  host?.remove();
  root = null;
  host = null;
  vi.unstubAllGlobals();
});

/** The app's own rule for a read (app.tsx: two retries), quickly. */
const appClient = () => new QueryClient({ defaultOptions: { queries: { retry: (count) => count < 2, retryDelay: 1, refetchOnWindowFocus: false, staleTime: 0, networkMode: "offlineFirst" } } });

/** `answers`: what each read gets, the last one for every read after it. */
function serve(answers: Array<() => Response>) {
  const calls: string[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) => {
      if (url !== "/api/plans") return json({ error: "not_found" }, 404);
      calls.push(url);
      return answers[Math.min(calls.length - 1, answers.length - 1)]!();
    }),
  );
  return calls;
}

const List = () => createElement(YourPlans, { plans: [], lines: [line], programs: undefined, today, onOpenPlan: noop, onOpenLine: noop, summaries: usePlanSummaries() });

function mount(qc: QueryClient) {
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  act(() => root!.render(createElement(QueryClientProvider, { client: qc }, createElement(MemoryRouter, null, createElement(List)))));
}

const rowNames = () => [...document.querySelectorAll(".plan-row-name")].map((n) => n.textContent);

async function until(check: () => boolean, what: string, passes = 200) {
  for (let i = 0; i < passes; i += 1) {
    if (check()) return;
    await act(async () => void (await new Promise((r) => setTimeout(r, 5))));
  }
  throw new Error(`timed out waiting for: ${what}\nreads so far, rows: ${rowNames().join(", ")}`);
}
const settle = async (ms = 60) => act(async () => void (await new Promise((r) => setTimeout(r, ms))));

const fails = () => json({ error: "internal" }, 500);
const answers = () => json({ plans: THE_PLANS });

describe("the plans read failing", () => {
  it("a read that fails once tries again, as every read does: the course's row and the plan's name land with nothing said", async () => {
    const calls = serve([fails, answers]);
    mount(appClient());
    await until(() => rowNames().includes("Evening practice"), "the course's row");
    expect(calls).toHaveLength(2);
    expect(rowNames()).toEqual(["Evening practice", "Autumn build"]);
  });

  it("while it hasn't answered, a row keeps the name it has of its own", async () => {
    serve([() => new Promise<Response>(() => undefined) as unknown as Response]);
    mount(appClient());
    await settle();
    expect(rowNames()).toEqual(["Running"]);
  });

  it("given up on after its tries, the list reads as before the answer: no more reads, its own names, the list and the foot still there", async () => {
    const calls = serve([fails]);
    mount(appClient());
    await until(() => calls.length === 3, "three tries");
    await settle();
    expect(calls).toHaveLength(3);
    expect(rowNames()).toEqual(["Running"]);
    expect(host!.textContent).toContain("Your plans");
    expect(host!.textContent).toContain("New program");
  });

  it("the next time the list is drawn it reads again, and what failed is all there", async () => {
    const calls = serve([fails, fails, fails, answers]);
    const qc = appClient();
    mount(qc);
    await until(() => calls.length === 3, "three tries");
    await settle();
    expect(rowNames()).toEqual(["Running"]);

    act(() => root!.unmount());
    host!.remove();
    mount(qc);
    await until(() => rowNames().includes("Evening practice"), "the course's row");
    expect(calls).toHaveLength(4);
    expect(rowNames()).toEqual(["Evening practice", "Autumn build"]);
  });

  it("a later read failing keeps what the last one said: a course never leaves the list for it", async () => {
    const calls = serve([answers, fails]);
    const qc = appClient();
    mount(qc);
    await until(() => rowNames().includes("Evening practice"), "the course's row");
    await act(async () => void (await qc.invalidateQueries({ queryKey: ["plans"] })));
    await until(() => calls.length === 4, "the read and its retries");
    await settle();
    expect(rowNames()).toEqual(["Evening practice", "Autumn build"]);
  });
});
