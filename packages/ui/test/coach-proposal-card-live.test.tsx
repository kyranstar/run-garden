// @vitest-environment jsdom
/**
 * Stage 3 Task 9 — a designed suggestion's card, live (spec §8): read from the server's manifest, decided workout by
 * workout.
 *
 *  - Every workout and change a checkbox when there is more than one to decide, all chosen; Approve sends the chosen
 *    (none named: all) and asks again while some `remaining`; a 409 `proposal_changed` once more, after reading the
 *    suggestion again.
 *  - A workout's line: its day and time, minutes, effort, place and review mean; its review one tap down; Edit opens its
 *    draft in the builder. A change: its own line, its own checkbox, no Edit. A suggestion of changes alone shows.
 *  - Decided lines say how they ended: where an applied one went (a link to that day on the Plan), a refused one why in
 *    plain words — open again to approve.
 *  - Decline takes an optional reason.
 *  - A stop's note heads it.
 *
 * The server is a stubbed fetch. Synthetic data only.
 */
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter } from "react-router-dom";
import { QueryClientProvider } from "@tanstack/react-query";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DESIGN_APPLYING_STALE_MS, type DesignApproveResponse, type DesignChangeLineDto, type DesignLineDto } from "@rg/api-client";
import { ProposalCard } from "../src/screens/studio/proposal-card.js";
import { primedClient } from "./studio-fixtures.js";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;
let host: HTMLElement | null = null;

afterEach(() => {
  act(() => root?.unmount());
  host?.remove();
  root = null;
  vi.unstubAllGlobals();
});

const json = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status, headers: { "Content-Type": "application/json" } });

/** Thursday 15 Oct 2026; its week's Monday is the 12th. */
const THU = "2026-10-15";

const line = (opId: string, over: Partial<DesignLineDto> = {}): DesignLineDto => ({
  opId,
  kind: "new",
  date: THU,
  time: "18:00",
  title: `Workout ${opId}`,
  minutes: 24,
  summary: `Workout ${opId} · 24 min`,
  effort: "Develop",
  place: "Home",
  parts: ["Warm-up", "Main · Superset × 3"],
  detail: ["Glute bridge 2 × 12"],
  reviewMean: 4.25,
  review: {
    dimensions: [{ id: "intent", label: "Intent clarity", score: 5, note: "One clear aim." }],
    mustFix: [],
    improvements: [],
    changes: ["Swapped the jumps for bridges."],
    accepted: [],
    rounds: 2,
    note: null,
  },
  issues: [{ code: "test_unmeasured", message: "The test move isn't one its key result reads." }],
  outcome: null,
  written: null,
  ...over,
});

const change = (opId: string, over: Partial<DesignChangeLineDto> = {}): DesignChangeLineDto => ({
  opId,
  kind: "skip",
  workoutId: "w-strength",
  date: "2026-10-13",
  time: null,
  summary: "Strength A — skipped",
  was: null,
  effect: "comes off the plan — a flare day",
  why: "Your knee needs a rest day before Thursday.",
  issues: [],
  outcome: null,
  ...over,
});

interface Call {
  method: string;
  path: string;
  body: any;
}

/** The suggestion's reads in turn (the last repeats), and the approve's and decline's answers in turn. */
function serve(s: { reads: unknown[]; approve?: Array<Partial<DesignApproveResponse> | { status: number; error: string }>; decline?: unknown }): Call[] {
  const calls: Call[] = [];
  let reads = 0;
  let approves = 0;
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: string, init?: RequestInit) => {
      const method = init?.method ?? "GET";
      const path = String(input).split("?")[0]!;
      const body = init?.body ? JSON.parse(String(init.body)) : undefined;
      calls.push({ method, path, body });
      if (method === "GET" && path === "/api/coach/proposals/dp-1") return json(s.reads[Math.min(reads++, s.reads.length - 1)]);
      if (method === "POST" && path === "/api/coach/proposals/dp-1/approve") {
        const a = s.approve?.[approves++];
        if (!a) return json({ error: "offline" }, 503);
        if ("error" in a && typeof a.status === "number") return json({ error: a.error }, a.status);
        return json({ ok: true, status: "partially_approved", applied: [], changed: [], refused: [], settled: [], remaining: [], ...a });
      }
      if (method === "POST" && path === "/api/coach/proposals/dp-1/decline") return json(s.decline ?? { ok: true, status: "declined", declined: [], settled: [] });
      return json({ error: "offline" }, 503);
    }),
  );
  return calls;
}

function mount(flags: string[] = []) {
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  const qc = primedClient();
  act(() => {
    root!.render(createElement(QueryClientProvider, { client: qc }, createElement(MemoryRouter, null, createElement(ProposalCard, { proposalId: "dp-1", flags }))));
  });
}

const settle = (ms = 0) =>
  act(async () => {
    await new Promise((r) => setTimeout(r, ms));
  });
const text = () => (document.body.textContent ?? "").replace(/\s+/g, " ");
async function until(test: () => boolean, what: string) {
  for (let i = 0; i < 150; i++) {
    if (test()) return;
    await settle(5);
  }
  throw new Error(`waited for ${what}; the page says: ${text()}`);
}
async function click(el: Element | null | undefined, what: string) {
  if (!el) throw new Error(`no ${what} in: ${text()}`);
  await act(async () => {
    (el as HTMLElement).click();
  });
  await settle();
}
const button = (name: string) => [...document.querySelectorAll<HTMLButtonElement>("button")].find((b) => b.textContent?.trim() === name) ?? null;
const boxes = () => [...document.querySelectorAll<HTMLInputElement>('input[type="checkbox"]')];
const posts = (calls: Call[], what: string) => calls.filter((c) => c.method === "POST" && c.path === `/api/coach/proposals/dp-1/${what}`);
const pending = (lines: DesignLineDto[], changes: DesignChangeLineDto[] = [], status = "pending") => ({ id: "dp-1", status, resolvedAt: null, lines, changes });

describe("a designed suggestion's card", () => {
  it("each workout's line: day and time, minutes, effort, place, the review's mean and what could be better; the scores one tap down; Edit opens its draft", async () => {
    serve({ reads: [pending([line("op-a", { review: { ...line("op-a").review!, improvements: ["Hold the last bridge for a slow count of three."] } })])] });
    mount(["The coach stopped at this design's spending limit; this is what had been reviewed by then."]);
    await until(() => text().includes("Workout op-a"), "the card");
    expect(text()).toContain("The coach stopped at this design's spending limit; this is what had been reviewed by then.");
    expect(text()).toContain("Thu 6 PM · 24 min · Develop · Home · Review 4.3");
    // On the card, no tap: what could be better, and the day's costs.
    const card = document.querySelector<HTMLElement>(".coach-pc")!;
    const shown = (el: Element | null) => !!el && !el.closest("[hidden]");
    const better = [...card.querySelectorAll("li")].find((li) => li.textContent === "Hold the last bridge for a slow count of three.");
    expect(shown(better!)).toBe(true);
    const cost = [...card.querySelectorAll("p, li")].find((el) => el.textContent === "The test move isn't one its key result reads.");
    expect(shown(cost!)).toBe(true);
    // One workout to decide: no checkbox.
    expect(boxes()).toHaveLength(0);
    // The moves, one tap on its name; the review's scores, one tap on "See the review".
    const moves = card.querySelector<HTMLElement>(".coach-pc-detail")!;
    expect(moves.hidden).toBe(true);
    await click(button("Workout op-a"), "the title");
    expect(moves.hidden).toBe(false);
    expect(moves.textContent).toContain("Glute bridge 2 × 12");
    const review = card.querySelector<HTMLElement>(".coach-pc-review")!;
    expect(review.hidden).toBe(true);
    expect(review.textContent).toContain("Intent clarity");
    await click(button("See the review"), "See the review");
    expect(review.hidden).toBe(false);
    expect(review.textContent).toContain("5 of 5 · One clear aim.");
    expect(review.textContent).toContain("Swapped the jumps for bridges.");
    const edit = [...document.querySelectorAll<HTMLAnchorElement>("a")].find((a) => a.textContent === "Edit");
    expect(edit?.getAttribute("href")).toBe("/studio/build/proposal/dp-1/op-a");
  });

  it("a partial approve: every one chosen at first; unchecking one approves the others, by id", async () => {
    const calls = serve({
      reads: [pending([line("op-a"), line("op-b")], [change("adj-w-strength")])],
      approve: [{ applied: [], remaining: [] }],
    });
    mount();
    await until(() => boxes().length === 3, "three checkboxes");
    expect(boxes().every((b) => b.checked)).toBe(true);
    expect(button("Approve")).not.toBeNull();
    await click(boxes()[2], "op-b's checkbox");
    expect(button("Approve 2")).not.toBeNull();
    await click(button("Approve 2"), "Approve 2");
    await until(() => posts(calls, "approve").length === 1, "the approve");
    expect(posts(calls, "approve")[0]!.body).toEqual({ opIds: ["adj-w-strength", "op-a"] });
  });

  it("all chosen: one approve names none, then asks again while some remain", async () => {
    const calls = serve({
      reads: [pending([line("op-a"), line("op-b"), line("op-c")])],
      approve: [{ remaining: ["op-b", "op-c"] }, { remaining: ["op-c"] }, { remaining: [], status: "approved" }],
    });
    mount();
    await until(() => !!button("Approve"), "Approve");
    await click(button("Approve"), "Approve");
    await until(() => posts(calls, "approve").length === 3, "three approves");
    expect(posts(calls, "approve").map((c) => c.body)).toEqual([{}, { opIds: ["op-b", "op-c"] }, { opIds: ["op-c"] }]);
  });

  it("a 409 proposal_changed: the suggestion read again, the approve asked once more", async () => {
    const calls = serve({
      reads: [pending([line("op-a")])],
      approve: [{ status: 409, error: "proposal_changed" }, { remaining: [], status: "approved" }],
    });
    mount();
    await until(() => !!button("Approve"), "Approve");
    const before = calls.filter((c) => c.method === "GET").length;
    await click(button("Approve"), "Approve");
    await until(() => posts(calls, "approve").length === 2, "the second approve");
    const order = calls.map((c) => `${c.method} ${c.path.replace("/api/coach/proposals/dp-1", "")}`);
    const firstApprove = order.indexOf("POST /approve");
    expect(order.slice(firstApprove + 1)).toContain("GET ");
    expect(order.indexOf("GET ", firstApprove)).toBeLessThan(order.lastIndexOf("POST /approve"));
    expect(calls.filter((c) => c.method === "GET").length).toBeGreaterThan(before);
  });

  it("a second 409 is said, not retried again", async () => {
    const calls = serve({ reads: [pending([line("op-a")])], approve: [{ status: 409, error: "proposal_changed" }, { status: 409, error: "proposal_changed" }] });
    mount();
    await until(() => !!button("Approve"), "Approve");
    await click(button("Approve"), "Approve");
    await until(() => text().includes("This suggestion changed meanwhile"), "the line");
    expect(posts(calls, "approve")).toHaveLength(2);
  });

  it("decided lines say how they ended: where an applied one went, a refused one why — and a refused one is open again", async () => {
    serve({
      reads: [
        pending(
          [
            line("op-a", {
              outcome: { status: "applied", at: "", workoutId: "w-9", rev: 1, written: { date: THU, time: "18:00", title: "Workout op-a", minutes: 24 } },
              written: { date: THU, time: "18:00", title: "Workout op-a", minutes: 24, summary: "", edited: false, moved: false },
            }),
            line("op-b", { outcome: { status: "refused", at: "", error: "past_date", why: "Wed 14 Oct has passed." } }),
            line("op-c", { outcome: { status: "refused", at: "", error: "invalid_doc", why: "The day now refuses it: tuck jumps are closed today." } }),
          ],
          [change("adj-1", { outcome: { status: "refused", at: "", error: "not_editable", cause: "programme", why: "It's a programme's session." } })],
          "partially_approved",
        ),
      ],
    });
    mount();
    await until(() => text().includes("On your plan for Thu 6 PM"), "the applied line");
    const link = [...document.querySelectorAll<HTMLAnchorElement>("a")].find((a) => a.textContent === "On your plan for Thu 6 PM");
    expect(link?.getAttribute("href")).toBe("/plan?week=2026-10-12&workout=w-9");
    expect(text()).toContain("Not added: Its day has passed.");
    expect(text()).not.toContain("Wed 14 Oct has passed.");
    expect(text()).toContain("Not added: The day doesn't allow it now: tuck jumps are closed today.");
    expect(text()).not.toContain("The day now refuses it");
    // A change refused is "not changed", never "not added" (fix round, M7).
    expect(text()).toContain("Not changed: It's a programme's session: the programme plans it.");
    // Open again: the three refused ones are chosen; the applied one is not offered.
    expect(boxes()).toHaveLength(3);
    expect(button("Approve")).not.toBeNull();
    const edits = [...document.querySelectorAll<HTMLAnchorElement>("a")].filter((a) => a.textContent === "Edit").map((a) => a.getAttribute("href"));
    expect(edits).toEqual(["/studio/build/proposal/dp-1/op-b", "/studio/build/proposal/dp-1/op-c"]);
  });

  it("a change: its own plain line and checkbox, no Edit; a suggestion of changes alone shows, and says what an applied one was", async () => {
    serve({
      reads: [
        pending([], [
          change("adj-1"),
          change("adj-2", {
            kind: "move",
            workoutId: "w-run",
            summary: "Easy run",
            was: "Tue",
            effect: null,
            outcome: { status: "applied", at: "", workoutId: "w-run", before: { date: "2026-10-13", time: "07:00", title: "Easy run", minutes: 30 } },
          }),
        ]),
      ],
    });
    mount();
    await until(() => text().includes("Strength A — skipped"), "the change");
    expect(text()).toContain("Tue: Strength A — skipped · comes off the plan — a flare day — Your knee needs a rest day before Thursday.");
    expect(text()).toContain("Done · it was Tue 7 AM, 30 min");
    expect([...document.querySelectorAll("a")].filter((a) => a.textContent === "Edit")).toHaveLength(0);
    // One left to decide: no checkbox, and Approve takes it.
    expect(boxes()).toHaveLength(0);
    expect(button("Approve")).not.toBeNull();
  });

  it("Decline takes an optional reason — the athlete's words — for the chosen ones", async () => {
    const calls = serve({ reads: [pending([line("op-a"), line("op-b")])], decline: { ok: true, status: "pending", declined: ["op-a"], settled: [] } });
    mount();
    await until(() => boxes().length === 2, "the checkboxes");
    await click(boxes()[1], "op-b's checkbox");
    await click(button("Decline"), "Decline");
    const why = document.querySelector<HTMLTextAreaElement>(".coach-pc-decline textarea")!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(why, "  too much on Thursday  ");
      why.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await click(button("Decline"), "Decline");
    await until(() => posts(calls, "decline").length === 1, "the decline");
    expect(posts(calls, "decline")[0]!.body).toEqual({ opIds: ["op-a"], reason: "too much on Thursday" });
  });

  it("a change an approve is applying: being added, still open — Approve finishes it; a decline that meets it says it can't be declined", async () => {
    const applying = change("adj-1", { outcome: { status: "applying", at: new Date().toISOString(), before: { date: "2026-10-13", time: "07:00", title: "Strength A", minutes: 35 } } });
    const calls = serve({
      reads: [pending([line("op-a")], [applying])],
      approve: [{ remaining: [] }],
      decline: { ok: true, status: "pending", declined: ["op-a"], settled: [], inFlight: ["adj-1"] },
    });
    mount();
    await until(() => text().includes("Being changed"), "the change in flight");
    // Still the athlete's: chosen with the workout.
    expect(boxes()).toHaveLength(2);
    expect(boxes().every((b) => b.checked)).toBe(true);
    await click(button("Decline"), "Decline");
    await click(button("Decline"), "Decline");
    await until(() => text().includes("Already being changed — it can't be declined now."), "the in-flight line");
    expect(posts(calls, "decline")[0]!.body).toEqual({});
    await click(button("Approve"), "Approve");
    await until(() => posts(calls, "approve").length === 1, "the approve that finishes it");
    expect(text()).not.toContain("Already being changed");
  });

  it("a change whose approve died mid-way (its claim gone stale) says it didn't finish — approve or decline", async () => {
    const stale = new Date(Date.now() - DESIGN_APPLYING_STALE_MS - 60_000).toISOString();
    serve({ reads: [pending([], [change("adj-1", { outcome: { status: "applying", at: stale, before: { date: "2026-10-13", time: "07:00", title: "Strength A", minutes: 35 } } })])] });
    mount();
    await until(() => text().includes("Didn't finish — approve or decline"), "the stale claim");
    expect(text()).not.toContain("Being changed");
    expect(button("Approve")).not.toBeNull();
    expect(button("Decline")).not.toBeNull();
  });

  it("the card's stale window is the worker's own (APPLYING_STALE_MS in design-approve.ts)", () => {
    const source = readFileSync(
      // A path, not `new URL(…, import.meta.url)`: Vite rewrites that form outside the package into a served URL.
      resolve(dirname(fileURLToPath(import.meta.url)), "../../../apps/worker/src/services/design-approve.ts"),
      "utf8",
    );
    const expr = /export const APPLYING_STALE_MS = ([\d_ *]+);/.exec(source)?.[1];
    expect(expr, "the worker's constant, a product of numbers").toBeDefined();
    const ms = expr!.split("*").reduce((n, part) => n * Number(part.trim().replace(/_/g, "")), 1);
    expect(ms).toBe(DESIGN_APPLYING_STALE_MS);
  });

  it("a decline that met every one in flight (409 in_flight) says so on its lines", async () => {
    const applying = change("adj-1", { outcome: { status: "applying", at: new Date().toISOString(), before: { date: "2026-10-13", time: "07:00", title: "Strength A", minutes: 35 } } });
    vi.stubGlobal("fetch", vi.fn(async (input: string, init?: RequestInit) => {
      const path = String(input).split("?")[0]!;
      if ((init?.method ?? "GET") === "GET" && path === "/api/coach/proposals/dp-1") return json(pending([], [applying]));
      if (path === "/api/coach/proposals/dp-1/decline") return json({ error: "in_flight", opIds: ["adj-1"], status: "pending", declined: [], settled: [] }, 409);
      return json({ error: "offline" }, 503);
    }));
    mount();
    await until(() => text().includes("Being changed"), "the change");
    await click(button("Decline"), "Decline");
    await click(button("Decline"), "Decline");
    await until(() => text().includes("Already being changed — it can't be declined now."), "the in-flight line");
    expect(text()).not.toContain("Couldn't reach the coach");
  });

  it("an approve that met a change in flight (the 200's `inFlight`): that change is being changed, the others approved — none said to have failed", async () => {
    const applied = line("op-a", {
      outcome: { status: "applied", at: "", workoutId: "w-9", rev: 1, written: { date: THU, time: "18:00", title: "Workout op-a", minutes: 24 } },
    });
    // The read after the approve raced the other approve's claim: the change is still undecided on it.
    const calls = serve({
      reads: [pending([line("op-a")], [change("adj-1")]), pending([applied], [change("adj-1")], "partially_approved")],
      approve: [{ applied: [], remaining: [], inFlight: ["adj-1"], status: "partially_approved" }],
    });
    mount();
    await until(() => !!button("Approve"), "Approve");
    await click(button("Approve"), "Approve");
    await until(() => text().includes("On your plan for"), "the workout approved");
    await until(() => text().includes("Being changed"), "the change in flight");
    expect(text()).not.toMatch(/Couldn't|being changed right now|being added right now|Not changed|Didn't finish|try again/);
    expect(document.querySelector(".coach-pc-error")).toBeNull();
    expect(posts(calls, "approve")).toHaveLength(1);
  });

  it("an approve that met every change in flight (409 in_flight) says they're being changed, on the server's word — never an error, whatever this device's clock says", async () => {
    // Stale by this device's clock; the server, whose window it is, says the approve that claimed it is applying it still.
    const stale = new Date(Date.now() - DESIGN_APPLYING_STALE_MS - 60_000).toISOString();
    const claimed = change("adj-1", { outcome: { status: "applying", at: stale, before: { date: "2026-10-13", time: "07:00", title: "Strength A", minutes: 35 } } });
    const approves: unknown[] = [];
    vi.stubGlobal("fetch", vi.fn(async (input: string, init?: RequestInit) => {
      const path = String(input).split("?")[0]!;
      if ((init?.method ?? "GET") === "GET" && path === "/api/coach/proposals/dp-1") return json(pending([], [claimed]));
      if (path === "/api/coach/proposals/dp-1/approve") {
        approves.push(init?.body);
        return json({ error: "in_flight", opIds: ["adj-1"], status: "pending", applied: [], changed: [], refused: [], settled: [], remaining: [] }, 409);
      }
      return json({ error: "offline" }, 503);
    }));
    mount();
    await until(() => text().includes("Didn't finish — approve or decline"), "the claim, stale by this clock");
    await click(button("Approve"), "Approve");
    await until(() => text().includes("Being changed"), "the server's word");
    expect(text()).not.toContain("Didn't finish");
    expect(text()).not.toMatch(/Couldn't|right now|try again/);
    expect(document.querySelector(".coach-pc-error")).toBeNull();
    expect(approves).toHaveLength(1);
  });

  it("a change's advisory note shows as its message", async () => {
    serve({ reads: [pending([], [change("adj-1", { issues: [{ code: "sanctioned_rest", message: "This would be the second sanctioned skip in a rolling week." }] })])] });
    mount();
    await until(() => text().includes("This would be the second sanctioned skip in a rolling week."), "the note");
  });

  it("Decline with no reason and all chosen names nothing", async () => {
    const calls = serve({ reads: [pending([line("op-a")])] });
    mount();
    await until(() => !!button("Decline"), "Decline");
    await click(button("Decline"), "Decline");
    await click(button("Decline"), "Decline");
    await until(() => posts(calls, "decline").length === 1, "the decline");
    expect(posts(calls, "decline")[0]!.body).toEqual({});
  });

  it("a suggestion closed with its run, or never shown, is no card", async () => {
    for (const status of ["unreviewed", "cancelled", "rehearsal"]) {
      serve({ reads: [pending([line("op-a")], [], status)] });
      mount();
      await settle(20);
      expect(document.querySelector(".coach-pc"), status).toBeNull();
      act(() => root?.unmount());
      host?.remove();
    }
    root = null;
  });
});
