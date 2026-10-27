// @vitest-environment jsdom
/**
 * THE TODAY CARD FOR THE OPEN BATCH (the saves flow redesigned §3.1, §2's anti-goal): at the top of Today while a batch
 * is open — "9 new moves from your saves", "4 more were already yours", one button, Fit them in. Fit them in fits the
 * batch with every new move on the coach's call and opens the coach with the fit (one tap from Today); a tap on the card
 * opens the coach. Nothing without the coach or an open batch. Synthetic data only.
 */
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, describe, expect, it, vi } from "vitest";
import { FIT_SAVES_REQUEST, type OpenSavesBatchDto } from "@rg/saves";
import { SavesTodayCard } from "../src/components/saves-today-card.js";
import { CoachOpenContext, type CoachOpener } from "../src/screens/studio/coach-ask.js";
import { FITTING_LINE, OPEN_FIRST_LINE } from "../src/screens/studio/saves-model.js";
import { button, click, json, serve, settle, until, type Call, type Routes } from "./coach-live-harness.js";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;
let host: HTMLElement | null = null;

afterEach(() => {
  act(() => root?.unmount());
  host?.remove();
  root = host = null;
  vi.unstubAllGlobals();
});

const OPEN: OpenSavesBatchDto = {
  id: "b1",
  counts: { new: 9, linked: 4 },
  groups: [{ group: "hip", count: 5 }, { group: "neck", count: 4 }],
  line: "Nine new moves came in from your saves: 5 hip and 4 neck. Want me to fit them into the week, or choose first?",
  fitting: false,
};

/** The card on its own, with the coach's sheet in the app (a spy) or not (null). */
function mount(coach: CoachOpener | null = { open: vi.fn() }) {
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  let el = createElement(MemoryRouter, null, createElement(SavesTodayCard));
  if (coach) el = createElement(CoachOpenContext.Provider, { value: coach }, el);
  act(() => root!.render(createElement(QueryClientProvider, { client }, el)));
  return coach;
}

const card = () => host!.querySelector<HTMLElement>('section[aria-label="From your saves"]');
const words = () => (host!.textContent ?? "").replace(/\s+/g, " ").trim();
const opened = (calls: Call[]) => calls.filter((c) => c.path === "/api/my-saves/open").length;

function server(open: OpenSavesBatchDto | null, more: Routes = {}): Call[] {
  return serve({ "GET /api/my-saves/open": { open }, ...more });
}

describe("the Today card for the open batch", () => {
  it("no card without an open batch, or with the coach off", async () => {
    let calls = server(null);
    mount();
    await until(() => opened(calls) > 0, "the open batch read");
    await settle(20);
    expect(host!.innerHTML).toBe("");
    act(() => root!.unmount());
    host!.remove();

    // Every row removed: counts 0/0 is nothing to show (the server's line would read "Zero saved moves…").
    calls = server({ ...OPEN, counts: { new: 0, linked: 0 }, groups: [] });
    mount();
    await until(() => opened(calls) > 0, "the open batch read");
    await settle(20);
    expect(host!.innerHTML).toBe("");
    act(() => root!.unmount());
    host!.remove();

    // The read failing (the feature off: 404) draws nothing either.
    calls = serve({ "GET /api/my-saves/open": json({ error: "not_found" }, 404) });
    mount();
    await until(() => opened(calls) > 0, "the open batch read");
    await settle(20);
    expect(host!.innerHTML).toBe("");
    act(() => root!.unmount());
    host!.remove();

    // The coach off: no card, and no read.
    calls = server(OPEN);
    mount(null);
    await settle(30);
    expect(host!.innerHTML).toBe("");
    expect(opened(calls)).toBe(0);
  });

  it("the card's words, word for word", async () => {
    server(OPEN);
    mount();
    await until(() => !!card(), "the card");
    const c = card()!;
    expect(c.classList.contains("dock-panel")).toBe(true);
    expect(c.querySelector(".saves-today-head")?.textContent).toBe("9 new moves from your saves");
    expect(c.querySelector(".saves-today-sub")?.textContent).toBe("4 more were already yours");
    // Nothing else on it: the headline, the line under it, the button.
    expect(c.textContent).toBe("9 new moves from your saves" + "4 more were already yours" + "Fit them in");
    const fit = button("Fit them in", c)!;
    expect(fit.className).toBe("btn btn-primary");
    expect(c.querySelectorAll("button.btn")).toHaveLength(1);
  });

  it("one new move and nothing already yours: the headline alone", async () => {
    server({ ...OPEN, counts: { new: 1, linked: 0 }, groups: [{ group: "hip", count: 1 }] });
    mount();
    await until(() => !!card(), "the card");
    expect(card()!.querySelector(".saves-today-head")?.textContent).toBe("1 new move from your saves");
    expect(card()!.querySelector(".saves-today-sub")).toBeNull();
  });

  it("Fit them in fits and opens the coach with the fit", async () => {
    const order: string[] = [];
    const calls = server(OPEN, {
      "POST /api/my-saves/batches/b1/fit": (body: unknown) => {
        order.push("fit");
        return { batchId: "b1", request: FIT_SAVES_REQUEST, moves: 9, links: 13, body };
      },
    });
    const coach = mount({ open: vi.fn(() => order.push("open")) })!;
    await until(() => !!card(), "the card");
    await click(button("Fit them in", card()!), "Fit them in");
    await until(() => (coach.open as ReturnType<typeof vi.fn>).mock.calls.length === 1, "the coach opened");
    expect(order).toEqual(["fit", "open"]);
    expect(calls.find((c) => c.path === "/api/my-saves/batches/b1/fit")!.body).toEqual({ choices: {} });
    expect(coach.open).toHaveBeenCalledWith({ fit: { batchId: "b1", request: FIT_SAVES_REQUEST } });
    // Nothing cancelled here: the coach's conversation says whether its run started.
    expect(calls.some((c) => c.path.endsWith("/fit/cancel"))).toBe(false);
  });

  it("a tap on the card opens the coach", async () => {
    const calls = server(OPEN);
    const coach = mount()!;
    await until(() => !!card(), "the card");
    await click(card()!.querySelector(".saves-today-open"), "the card's body");
    expect(coach.open).toHaveBeenCalledTimes(1);
    expect((coach.open as ReturnType<typeof vi.fn>).mock.calls[0]).toEqual([]);
    expect(calls.some((c) => c.method === "POST")).toBe(false);
  });

  it("while fitting: Fitting in… open the coach, in place of the button — and it opens the coach", async () => {
    server({ ...OPEN, fitting: true });
    const coach = mount()!;
    await until(() => !!card(), "the card");
    expect(button("Fit them in", card()!)).toBeNull();
    expect(words()).toContain(FITTING_LINE);
    await click(button(FITTING_LINE, card()!), FITTING_LINE);
    expect(coach.open).toHaveBeenCalledTimes(1);
  });

  it("409 batch_open says finish the batch that is open first", async () => {
    const calls = server(OPEN, { "POST /api/my-saves/batches/b1/fit": json({ error: "batch_open" }, 409) });
    const coach = mount()!;
    await until(() => !!card(), "the card");
    await click(button("Fit them in", card()!), "Fit them in");
    await until(() => words().includes(OPEN_FIRST_LINE), "the refusal said");
    expect(coach.open).not.toHaveBeenCalled();
    // A refused fit is never cancelled: nothing of it started.
    expect(calls.some((c) => c.path.endsWith("/fit/cancel"))).toBe(false);
  });
});
