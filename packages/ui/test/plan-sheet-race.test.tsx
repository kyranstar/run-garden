// @vitest-environment jsdom
/**
 * A coach plan's race day, changed from its sheet (stream G, 2026-10-19): a race was cancelled and the plan still named
 * it. The sheet says the plan's own race ("Race · Fri 23 Oct") with a Change beside it — a day field, Save, No race and
 * Cancel; saving asks `POST /api/coach/plans/:id/race` and reads again the plan, the week, the race strip and the coach's
 * chips. A refusal is said in its words. No race line when the plan names none (Settings' race day is changed in
 * Settings), and the old "race Oct 23" chip in the header is gone.
 */
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, describe, expect, it, vi } from "vitest";
import { api, ApiError, type CoachPlanDto, type PlanDetailResponse } from "@rg/api-client";
import { PlanSheet } from "../src/screens/plan-sheet.js";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;
let host: HTMLDivElement | null = null;

afterEach(() => {
  act(() => root?.unmount());
  host?.remove();
  root = null;
  host = null;
  vi.restoreAllMocks();
});

const plan = (over: Partial<CoachPlanDto> = {}): CoachPlanDto => ({
  id: "cp1",
  discipline: "run",
  name: "Autumn 10K",
  status: "active",
  startDate: "2026-10-05",
  endDate: "2026-11-01",
  raceDate: "2026-10-23",
  planRaceDate: "2026-10-23",
  source: "coach",
  kind: "block",
  ...over,
});

function mount(p: CoachPlanDto, onClose: () => void = () => undefined): QueryClient {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } });
  const detail: PlanDetailResponse = { plan: p, weeks: [], progressions: [], sessions: { planned: 12, done: 3 }, adherencePct: null };
  qc.setQueryData(["plan-detail", p.id], detail);
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  act(() =>
    root!.render(
      createElement(
        QueryClientProvider,
        { client: qc },
        createElement(
          MemoryRouter,
          null,
          createElement(PlanSheet, { planId: p.id, plans: [p], onClose, onRetire: async () => null, onRename: () => undefined }),
        ),
      ),
    ),
  );
  return qc;
}

const button = (name: string): HTMLButtonElement => {
  const found = [...document.querySelectorAll("button")].find((b) => b.textContent?.trim() === name);
  if (!found) throw new Error(`no button "${name}"`);
  return found;
};
const hasButton = (name: string) => [...document.querySelectorAll("button")].some((b) => b.textContent?.trim() === name);
const dayField = () => document.querySelector<HTMLInputElement>('input[type="date"][aria-label="Race day"]');

/** Types a day into the field the way a person does (React reads the native setter's value). */
function pick(day: string) {
  const field = dayField()!;
  act(() => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(field, day);
    field.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

describe("the plan's race, in its sheet", () => {
  it("says the plan's own race with a Change beside it, and the header's race chip is gone", () => {
    mount(plan());
    expect(document.body.textContent).toContain("Race · Fri 23 Oct");
    expect(button("Change").getAttribute("aria-expanded")).toBe("false");
    expect(document.querySelector(".studio-modal-meta")?.textContent).not.toMatch(/race/i);
    expect(dayField()).toBeNull();
  });

  it("no race line when the plan names none, even with a race day in Settings", () => {
    mount(plan({ raceDate: "2026-10-30", planRaceDate: null }));
    expect(document.body.textContent).not.toContain("Race ·");
    expect(hasButton("Change")).toBe(false);
  });

  it("a plan the coach didn't write, and a bucket of one-offs, offer no Change", () => {
    mount(plan({ id: "sp1", source: "studio", planRaceDate: undefined }));
    expect(hasButton("Change")).toBe(false);
    act(() => root?.unmount());
    host?.remove();
    mount(plan({ id: "adhoc-run-1", kind: "loose" }));
    expect(hasButton("Change")).toBe(false);
  });

  it("Change opens a day field from the plan's first day, on the race; Cancel closes it and hands focus back", () => {
    mount(plan());
    act(() => button("Change").click());
    expect(button("Change").getAttribute("aria-expanded")).toBe("true");
    expect(dayField()?.value).toBe("2026-10-23");
    expect(dayField()?.min).toBe("2026-10-05");
    expect(document.activeElement).toBe(dayField());
    for (const name of ["Save", "No race", "Cancel"]) expect(hasButton(name), name).toBe(true);
    act(() => button("Cancel").click());
    expect(dayField()).toBeNull();
    expect(document.activeElement).toBe(button("Change"));
  });

  it("Save moves the race and reads again the plan, the week, the race strip and the coach's chips", async () => {
    const asked = vi.spyOn(api, "coachPlanRace").mockResolvedValue({ ok: true, raceDate: "2026-10-30", demoted: 1 });
    const qc = mount(plan());
    const reread = vi.spyOn(qc, "invalidateQueries");
    act(() => button("Change").click());
    pick("2026-10-30");
    await act(async () => button("Save").click());
    expect(asked.mock.calls).toEqual([["cp1", "2026-10-30"]]);
    const keys = reread.mock.calls.map(([f]) => JSON.stringify(f?.queryKey));
    for (const key of [["plan-detail", "cp1"], ["coach-plans"], ["plan-week"], ["plan"], ["race-hub"], ["coach-nudges"]]) {
      expect(keys, JSON.stringify(key)).toContain(JSON.stringify(key));
    }
    expect(dayField()).toBeNull();
  });

  it("No race clears it", async () => {
    const asked = vi.spyOn(api, "coachPlanRace").mockResolvedValue({ ok: true, raceDate: null, demoted: 1 });
    mount(plan());
    act(() => button("Change").click());
    await act(async () => button("No race").click());
    expect(asked.mock.calls).toEqual([["cp1", null]]);
    expect(dayField()).toBeNull();
  });

  it("a refusal is said in its words and the field stays open; anything else in plain words", async () => {
    const why = "Race day can't be before the plan starts, Mon 5 Oct.";
    const asked = vi.spyOn(api, "coachPlanRace").mockRejectedValueOnce(new ApiError(400, { error: "bad_date", why }));
    mount(plan());
    act(() => button("Change").click());
    pick("2026-10-01");
    await act(async () => button("Save").click());
    expect(document.querySelector('[role="alert"]')?.textContent).toBe(why);
    expect(dayField()).not.toBeNull();

    asked.mockRejectedValueOnce(new TypeError("Failed to fetch"));
    await act(async () => button("No race").click());
    expect(document.querySelector('[role="alert"]')?.textContent).toBe("Couldn't change the race day. Try again.");
    // Closed and opened again, it starts fresh.
    act(() => button("Cancel").click());
    act(() => button("Change").click());
    expect(document.querySelector('[role="alert"]')).toBeNull();
  });

  it("Escape closes the field, never the sheet; a second Escape closes the sheet", () => {
    const onClose = vi.fn();
    mount(plan(), onClose);
    act(() => button("Change").click());
    act(() => void document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })));
    expect(dayField()).toBeNull();
    expect(onClose).not.toHaveBeenCalled();
    expect(document.activeElement).toBe(button("Change"));
    act(() => void document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("Save waits for a day that differs from the race", () => {
    mount(plan());
    act(() => button("Change").click());
    expect(button("Save").disabled).toBe(true);
    pick("2026-10-24");
    expect(button("Save").disabled).toBe(false);
  });
});
