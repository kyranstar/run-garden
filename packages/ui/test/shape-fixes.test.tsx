// @vitest-environment jsdom
/**
 * THE NEW SHAPE, THE FIX ROUND (stream B; the integrated review of 2026-10-18, `fix-brief.md` §B):
 *
 *  - I1: Today's card above the fold on a phone — a shorter hero the card's column overlaps, the beat line under the
 *    card, one-line banners, a card with proper inner padding.
 *  - I2: the coach's ● on the phone's pill is seen: an ink dot ringed in the bar's surface, at the pill's corner.
 *  - I4: Extend, Wind down and a new plan go to the thread coach (its message, its words), with a quiet line; the
 *    suggestion appears on Plan. "Ask about this plan" stays the conversation's.
 *  - I6: what needs the athlete shows on the card whatever leads it.
 *  - Minors: the Coach's word in the bar's ink (green while its sheet is open), level with the others; no inner scroll
 *    in the desktop card; Today's h1 says Today; "Nothing was applied" reaches the Plan's coach cards.
 *
 * Synthetic data only.
 */
import { act, createElement, useContext, type ReactElement } from "react";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createRoot, type Root } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CoachMessageDto, CoachPlanDto, PlanDetailResponse } from "@rg/api-client";
import { initialSnapshot } from "@rg/garden-engine";
import { GARDEN_PART_KEYS, GardenBody, GardenScreen, type GardenParts } from "../src/screens/garden.js";
import { nothingAppliedOf, replyOf } from "../src/screens/plan.js";
import { THREAD_REQUESTS, PlanSheet } from "../src/screens/plan-sheet.js";
import { YourPlans } from "../src/screens/plan-cards.js";
import { TimezoneNudge } from "../src/screens/today.js";
import { CoachOpenContext, CoachSeeingContext, SeeingRegistry, type CoachOpener } from "../src/screens/studio/coach-ask.js";
import { AppShell } from "../src/shell.js";
import { SceneMarkContext } from "../src/scene-mark.js";

vi.mock("@rg/garden-renderer", () => ({ GardenScene: () => null }));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const here = dirname(fileURLToPath(import.meta.url));
const read = (rel: string) => readFileSync(resolve(here, "../src", rel), "utf8");
const css = read("styles.css").replace(/\/\*[\s\S]*?\*\//g, "");
const noop = () => undefined;

/** The body of the base-layer rule for exactly `selector` (outside any media query). */
function baseRule(selector: string): string {
  let out = css;
  for (const m of css.matchAll(/@media[^{]+\{/g)) {
    let depth = 1;
    let i = m.index! + m[0].length;
    for (; i < css.length && depth > 0; i++) {
      if (css[i] === "{") depth++;
      else if (css[i] === "}") depth--;
    }
    out = out.replace(css.slice(m.index!, i), "");
  }
  for (const m of out.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    if (m[1]!.split(",").map((s) => s.trim()).includes(selector)) return m[2]!;
  }
  return "";
}
/** Every lg block's body, joined. */
const lg = [...css.matchAll(/@media \(min-width: 1024px\) \{/g)]
  .map((m) => {
    let depth = 1;
    let i = m.index! + m[0].length;
    for (; i < css.length && depth > 0; i++) {
      if (css[i] === "{") depth++;
      else if (css[i] === "}") depth--;
    }
    return css.slice(m.index! + m[0].length, i - 1);
  })
  .join("\n");
const lgRule = (selector: string): string => {
  for (const m of lg.matchAll(/([^{}]+)\{([^{}]*)\}/g)) if (m[1]!.split(",").map((s) => s.trim()).includes(selector)) return m[2]!;
  return "";
};

// ── Tokens and contrast ─────────────────────────────────────────────────────
const rawCss = read("styles.css");
function block(open: string, from = 0): string {
  const at = rawCss.indexOf(open, from);
  let depth = 1;
  let i = at + open.length;
  for (; i < rawCss.length && depth > 0; i++) {
    if (rawCss[i] === "{") depth++;
    else if (rawCss[i] === "}") depth--;
  }
  return rawCss.slice(at + open.length, i - 1);
}
const tokens = (body: string) => Object.fromEntries([...body.matchAll(/(--[\w-]+):\s*(#[0-9a-fA-F]{3,6})\s*;/g)].map((m) => [m[1]!, m[2]!.toLowerCase()]));
const light = tokens(block(":root {"));
const dark = { ...light, ...tokens(block(':root:not([data-theme="light"]) {', rawCss.indexOf("@media (prefers-color-scheme: dark)"))) };
const hex6 = (h: string) => (h.length === 4 ? `#${h[1]}${h[1]}${h[2]}${h[2]}${h[3]}${h[3]}` : h);
function lum(h: string): number {
  const x = hex6(h);
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(x.slice(i, i + 2), 16) / 255).map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
  return 0.2126 * r! + 0.7152 * g! + 0.0722 * b!;
}
const ratio = (a: string, b: string) => {
  const [x, y] = [lum(a), lum(b)];
  return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05);
};
const tokenOf = (decl: string, prop: string): string | null => new RegExp(`${prop}:[^;]*?var\\((--[\\w-]+)\\)`).exec(decl)?.[1] ?? null;

describe("I2 — the coach's ● is seen on the green pill", () => {
  it("sits on the pill's corner, an ink dot ringed in the bar's surface, contrasting in both themes", () => {
    expect(read("shell.tsx")).toMatch(/<span className="nav-coach-pill">[\s\S]*?<CoachNavMark \/>[\s\S]*?<\/span>/);
    const dot = baseRule(".nav-coach-mark > [aria-hidden]");
    const ink = tokenOf(dot, "background");
    const ring = /box-shadow:[^;]*var\((--[\w-]+)\)/.exec(dot)?.[1] ?? null;
    const pill = tokenOf(baseRule(".nav-coach-pill"), "background");
    expect([ink, ring, pill]).toEqual(["--ink", "--bg-raised", "--green"]);
    for (const [theme, t] of [["light", light], ["dark", dark]] as const) {
      // The ring parts the dot from the pill; the dot reads on the ring.
      expect(ratio(t[ring!]!, t[pill!]!), `${theme}: ring on pill`).toBeGreaterThanOrEqual(3);
      expect(ratio(t[ink!]!, t[ring!]!), `${theme}: dot on ring`).toBeGreaterThanOrEqual(3);
    }
    expect(baseRule(".nav-coach-mark")).toContain("position: absolute");
    expect(baseRule(".nav-coach-pill")).toContain("position: relative");
  });
});

describe("the athlete's mark on Today's picture (phones; the lead's follow-up to I1)", () => {
  // The page a place renders: here, whatever the shell hands the picture.
  const Probe = () => createElement("div", { "data-probe": "" }, useContext(SceneMarkContext));
  const shellAt = (path: string) =>
    renderToStaticMarkup(
      createElement(
        QueryClientProvider,
        { client: new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity, enabled: false } } }) },
        createElement(MemoryRouter, { initialEntries: [path] }, createElement(AppShell, { who: "sam@example.test", children: createElement(Probe) })),
      ),
    );

  it("on Today the shell hands its mark to the picture, and draws no row of its own; the other places keep the row", () => {
    const today = shellAt("/");
    expect(today).toMatch(/<div data-probe=""><a [^>]*class="athlete-mark"/);
    expect(today.match(/class="athlete-mark"/g)).toHaveLength(1);
    for (const path of ["/plan", "/growth"]) {
      const html = shellAt(path);
      expect(html, path).toMatch(/<div class="athlete-row"><a [^>]*class="athlete-mark"/);
      expect(html, path).toContain('<div data-probe=""></div>');
    }
  });

  it("Today's picture carries it, over the scene", () => {
    const marked = Object.fromEntries(GARDEN_PART_KEYS.map((k) => [k, createElement("i", { "data-part": k })])) as unknown as GardenParts;
    const html = renderToStaticMarkup(
      createElement(SceneMarkContext.Provider, { value: createElement("b", { "data-mark": "" }) }, createElement(GardenBody, { parts: marked })),
    );
    const hero = html.slice(html.indexOf('class="stage-hero"'), html.indexOf('class="hud-dock"'));
    expect(hero).toContain('<div class="athlete-row athlete-on-scene"><b data-mark=""></b></div>');
    // Without a mark handed to it (a page outside the shell), nothing is drawn for it.
    expect(renderToStaticMarkup(createElement(GardenBody, { parts: marked }))).not.toContain("athlete");
  });

  it("at the picture's top-right, a 44 px target, a solid chip whose letter reads in both themes; gone at lg with the row", () => {
    const at = baseRule(".athlete-on-scene");
    for (const decl of ["position: absolute", "top: var(--space-4)", "right: var(--space-4)", "margin: 0"]) expect(at).toContain(decl);
    expect(at).toMatch(/z-index: \d+/);
    expect(baseRule(".athlete-mark")).toContain("min-width: var(--tap)");
    expect(baseRule(".athlete-mark")).toContain("min-height: var(--tap)");
    const chip = baseRule(".athlete-mark > span");
    const [bg, ink, edge] = [tokenOf(chip, "background"), tokenOf(chip, "color"), tokenOf(chip, "border")];
    expect([bg, ink, edge]).toEqual(["--bg-raised", "--ink", "--border-strong"]);
    for (const [theme, t] of [["light", light], ["dark", dark]] as const) {
      expect(ratio(t[ink!]!, t[bg!]!), `${theme}: the letter on its chip`).toBeGreaterThanOrEqual(4.5);
    }
    expect(lg).toMatch(/\.athlete-row \{\s*display: none;/);
  });

  it("while the garden loads, and when it can't, Today still carries the mark — on a row of its own (no picture yet)", async () => {
    window.matchMedia = ((q: string) => ({ matches: false, media: q, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {} })) as unknown as typeof window.matchMedia;
    for (const [what, answer] of [
      ["loading", () => new Promise<Response>(() => undefined)],
      ["failed", async () => new Response("{}", { status: 500, headers: { "Content-Type": "application/json" } })],
    ] as const) {
      vi.stubGlobal("fetch", vi.fn(answer));
      const host = document.createElement("div");
      document.body.appendChild(host);
      const root = createRoot(host);
      const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
      act(() =>
        root.render(
          createElement(
            QueryClientProvider,
            { client: qc },
            createElement(MemoryRouter, null, createElement(SceneMarkContext.Provider, { value: createElement("b", { "data-mark": "" }) }, createElement(GardenScreen))),
          ),
        ),
      );
      try {
        const words = what === "loading" ? "Loading the garden" : "Couldn't load the garden";
        for (let i = 0; i < 200 && !host.innerHTML.includes(words); i++) await act(async () => void (await new Promise((r) => setTimeout(r, 5))));
        expect(host.innerHTML, what).toContain(words);
        expect(host.innerHTML, what).toContain('<div class="athlete-row"><b data-mark=""></b></div>');
      } finally {
        act(() => root.unmount());
        host.remove();
        vi.unstubAllGlobals();
      }
    }
  });

  it("no empty box for a restore that isn't there: the row's room is the page's", () => {
    expect(shellAt("/plan")).not.toContain('<div style="margin-bottom:var(--space-6)"></div>');
  });
});

describe("minors — the Coach's word", () => {
  it("in the bar's own ink, green only while the coach's sheet is open; its pill keeps the word level with the others", () => {
    expect(baseRule(".bottom-nav .nav-coach")).not.toContain("color: var(--green-ink)");
    expect(css).toMatch(/body:has\(\.coach-sheet\) \.bottom-nav \.nav-coach \{[^}]*color: var\(--green\)/);
    // The pill is as tall as the others' glyphs: its padding comes off the column with a negative margin.
    expect(baseRule(".bottom-nav .nav-coach-pill")).toMatch(/margin-block: calc\(-1 \* var\(--space-1\)\)/);
  });
});

describe("I1 — Today's card above the fold on a phone", () => {
  it("a shorter hero: 240–300 px", () => {
    expect(baseRule(".stage-hero")).toMatch(/height: clamp\(240px, [\d.]+vh, 300px\)/);
  });

  it("the card's column overlaps the hero's foot below lg (straight after it, never over a ceremony), not on the stage", () => {
    expect(baseRule(".stage-hero + .hud-dock")).toMatch(/margin-top: calc\(-1 \* var\(--space-\d+\)\)/);
    expect(baseRule(".hud-dock")).toContain("position: relative");
    expect(lgRule(".stage-hero + .hud-dock")).toContain("margin-top: 0");
    // The scene's words rise clear of the card's overlap.
    expect(baseRule(".hud-topleft")).toMatch(/bottom: calc\(var\(--space-\d+\) \+ var\(--space-\d+\)\)/);
  });

  it("the beat line comes after the card (the card first, at both widths)", () => {
    const marked = Object.fromEntries(GARDEN_PART_KEYS.map((k) => [k, createElement("i", { "data-part": k })])) as unknown as GardenParts;
    const order = [...renderToStaticMarkup(createElement(GardenBody, { parts: marked })).matchAll(/data-part="(\w+)"/g)].map((m) => m[1]);
    expect(order.indexOf("today")).toBeLessThan(order.indexOf("beat"));
  });

  it("the card has proper inner padding", () => {
    expect(baseRule(".dock-panel")).toContain("padding: var(--space-6)");
  });

  it("the time zone prompt says both zones in one sentence, and each button's name holds its visible words", () => {
    const real = Intl.DateTimeFormat.prototype.resolvedOptions;
    const spy = vi.spyOn(Intl.DateTimeFormat.prototype, "resolvedOptions").mockImplementation(function (this: Intl.DateTimeFormat) {
      return { ...real.call(this), timeZone: "Asia/Tokyo" };
    });
    try {
      const qc = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } });
      qc.setQueryData(["settings"], { prefs: { timezone: "America/New_York" } });
      const html = renderToStaticMarkup(createElement(QueryClientProvider, { client: qc }, createElement(TimezoneNudge)));
      const text = html.replace(/<button[\s\S]*?<\/button>/g, "").replace(/<[^>]+>/g, "").trim();
      expect(text).toBe("Your device is on Tokyo time; your days run on New York time.");
      const buttons = [...html.matchAll(/<button([^>]*)>([\s\S]*?)<\/button>/g)].map((m) => {
        const shown = m[2]!.replace(/<[^>]+>/g, "").trim();
        return [/aria-label="([^"]+)"/.exec(m[1]!)?.[1] ?? shown, shown];
      });
      expect(buttons.map(([, shown]) => shown)).toEqual(["Use Tokyo", "Keep"]);
      // Label in name: a voice user says what they see.
      for (const [name, shown] of buttons) expect(name!.toLowerCase().startsWith(shown!.toLowerCase()), `${name} / ${shown}`).toBe(true);
      expect(buttons.map(([name]) => name)).toEqual(["Use Tokyo time", "Keep New York time"]);
    } finally {
      spy.mockRestore();
    }
    // The sentence is never cut short; the two choices never break apart.
    expect(baseRule(".tz-nudge-text")).not.toContain("text-overflow");
    expect(baseRule(".tz-nudge .banner-actions")).toContain("flex-wrap: nowrap");
    expect(read("screens/garden.tsx")).toContain("<Banner kind=\"info\">Calendar mirroring is paused.</Banner>");
  });
});

describe("minors — the desktop card and Today's heading", () => {
  it("no inner scroll in the card: it shows its rows and its actions whole", () => {
    const garden = read("screens/garden.tsx");
    expect(garden).not.toMatch(/className="dock-panel today-card scroller"/);
    expect(lgRule(".dock-panel")).not.toContain("max-height");
  });

  it("on the stage the card's column may rise the whole stage — under the scene's tool — and is never cut at its top", () => {
    // Its only cap is the stage itself (a fixed 32rem cap scrolled every card with Also today rows); a card taller
    // than the whole stage (a short laptop, three banners, the body check open) scrolls rather than lose its title.
    const dock = lgRule(".hud-dock");
    expect(dock).toMatch(/max-height: calc\(100% - clamp\([^)]*\) - clamp\([^)]*\) - var\(--space-\d+\)\)/);
    expect(dock).toContain("width: var(--dock-width)");
    expect(dock).toContain("right: var(--stage-gutter)");
    expect(lgRule(".dock-panel")).toMatch(/min-height: 0;[\s\S]*overflow-y: auto/);
  });

  it("the stage's moment and its voice keep left of the card's column, never under or over it", () => {
    const stage = lgRule(".garden-stage");
    expect(stage).toContain("--stage-gutter: clamp(1.6rem, 3.2vw, 3.2rem)");
    expect(stage).toContain("--dock-width: min(26rem, 38vw)");
    const ceremony = lgRule(".hud-ceremony");
    expect(ceremony).toContain("left: calc((100% - var(--dock-width) - var(--stage-gutter)) / 2)");
    expect(ceremony).toContain("max-width: calc(100% - var(--dock-width) - 3 * var(--stage-gutter))");
    expect(ceremony).toContain("transform: translateX(-50%)");
    expect(lgRule(".hud-topleft")).toContain("max-width: min(36rem, 44vw, calc(100% - var(--dock-width) - 3 * var(--stage-gutter)))");
  });

  it("Today's heading says Today", () => {
    expect(read("screens/garden.tsx")).toContain('<h1 className="visually-hidden">Today</h1>');
  });
});

// ── I6: the attention line for every kind of lead ──────────────────────────
const TODAY = "2026-10-05";
const base = {
  id: "run-1", title: "Easy Run", category: "easy", qualitySubtype: null, sport: "run", originalPlanDate: TODAY, lastVerifiedCorosDate: TODAY,
  effectiveDate: TODAY, effectiveTime: "07:00", workoutSeconds: 2700, calendarSeconds: 2700, stageSummary: null, calendarSyncState: "synced",
  corosSyncState: "synced", completionState: "scheduled", archived: false, origin: null, contentState: null, programId: null,
};
const slot = { ...base, id: "slot-1", title: "Garden program", category: "strength", sport: "strength", origin: "program", contentState: "outline", programId: "p1" };
const rest = { ...base, id: "rest-1", title: "Rest", category: "rest" };

describe("I6 — what needs the athlete shows whatever leads the card", () => {
  let root: Root | null = null;
  let host: HTMLDivElement | null = null;
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date(`${TODAY}T08:00:00`));
    window.matchMedia = ((q: string) => ({ matches: false, media: q, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {} })) as unknown as typeof window.matchMedia;
  });
  afterEach(() => {
    vi.useRealTimers();
    act(() => root?.unmount());
    host?.remove();
    root = host = null;
    vi.unstubAllGlobals();
  });

  async function card(lead: Record<string, unknown>, around: (el: ReactElement) => ReactElement = (el) => el) {
    const today = {
      today: TODAY, nextWorkout: lead, upcoming: [lead], todaySessions: [{ workout: lead, build: null }], conditions: [], unresolved: [],
      needsAttention: [{ ...base, id: "w-9" }], sync: { pendingCorosJobs: 0, corosConnected: true, corosWritesEnabled: false, calendarConnected: true },
      readiness: { latest: null, baseline: null, sampleDays: 10, verdict: null }, focus: null, consistency: { weeks: [], adherencePct: null, streakWeeks: 0 },
    };
    const garden = { snapshot: initialSnapshot("2026-09-01"), events: [], seen: null, restMode: { active: false }, codex: [], species: [], wildlife: [], visitors: [] };
    vi.stubGlobal("fetch", vi.fn(async (url: string) => {
      const path = url.replace(/\?.*$/, "");
      const body = path === "/api/plan/today" ? today : path === "/api/garden" ? garden : path === "/api/settings" ? { prefs: { units: "km", timezone: "America/Los_Angeles" } } : {};
      return new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json" } });
    }));
    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    act(() => root!.render(createElement(QueryClientProvider, { client: qc }, createElement(MemoryRouter, null, around(createElement(GardenScreen))))));
    for (let i = 0; i < 300 && !host.querySelector("#dock-panel"); i++) await act(async () => void (await new Promise((r) => setTimeout(r, 10))));
    return host.querySelector<HTMLElement>("#dock-panel")!;
  }

  for (const [kind, lead] of [["a run", base], ["a programme session", slot], ["a rest day", rest]] as const) {
    it(`${kind}: "1 workout needs attention"`, async () => {
      const c = await card(lead);
      expect(c.querySelector(".today-attention")?.textContent).toContain("1 workout needs attention");
    });
  }

  it("a rest day is seen as one, by the nav's Coach and by the card's Ask — the coach offers a rest day's own chips", async () => {
    const opened: unknown[] = [];
    const seen = new SeeingRegistry();
    const c = await card(rest, (el) =>
      createElement(CoachSeeingContext.Provider, { value: seen }, createElement(CoachOpenContext.Provider, { value: { open: (a) => void opened.push(a) } }, el)),
    );
    expect(seen.current).toMatchObject({ kind: "day", id: TODAY, rest: true });
    act(() => c.querySelector<HTMLButtonElement>(".today-actions .ask-coach")!.click());
    expect(opened).toEqual([{ seeing: expect.objectContaining({ kind: "day", id: TODAY, rest: true }), request: null }]);
  });
});

// ── I4: the thread coach does what the conversation can't yet ──────────────
const coachPlan: CoachPlanDto = { id: "cp1", discipline: "run", name: "Fall Half Block", status: "active", startDate: "2026-07-13", endDate: "2026-10-04", raceDate: null, source: "coach" };
const detail = { plan: coachPlan, weeks: [], progressions: [], sessions: { planned: 48, done: 20 }, adherencePct: 86 } as unknown as PlanDetailResponse;

describe("I4 — Extend, Wind down and a new plan go to the thread coach", () => {
  let root: Root | null = null;
  let host: HTMLDivElement | null = null;
  afterEach(() => {
    act(() => root?.unmount());
    host?.remove();
    root = host = null;
  });
  function mount(el: ReactElement, coach: CoachOpener | null, prime: Array<[unknown[], unknown]> = []) {
    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity, enabled: false } } });
    for (const [k, d] of prime) qc.setQueryData(k, d);
    const routed = createElement(MemoryRouter, null, el);
    act(() => root!.render(createElement(QueryClientProvider, { client: qc }, coach ? createElement(CoachOpenContext.Provider, { value: coach }, routed) : routed)));
  }
  const button = (name: string) => [...document.querySelectorAll<HTMLButtonElement>("button")].find((b) => b.textContent === name);
  const ASKED = "Asked your coach. Its suggestion will appear on Plan.";

  it("the thread coach's own words, as before", () => {
    expect(THREAD_REQUESTS.extend("Fall Half Block")).toBe('Extend "Fall Half Block" — draft the next weeks in the same shape.');
    expect(THREAD_REQUESTS.windDown("Fall Half Block")).toBe('Wind down "Fall Half Block" — draft the final taper week.');
  });

  it("Extend and Wind down send the thread coach their words, never open the conversation, and say so quietly", async () => {
    const sent: string[] = [];
    const opened: unknown[] = [];
    mount(
      createElement(PlanSheet, { planId: "cp1", plans: [coachPlan], onClose: noop, onRetire: async () => null, onRename: noop, onAskThread: (b: string) => sent.push(b) }),
      { open: (a) => opened.push(a) },
      [[["plan-detail", "cp1"], detail]],
    );
    await act(async () => button("Extend")!.click());
    expect(sent).toEqual(['Extend "Fall Half Block" — draft the next weeks in the same shape.']);
    expect(document.querySelector('[role="status"]')?.textContent).toBe(ASKED);
    expect(opened).toEqual([]);
    // "Ask about this plan" stays the conversation's.
    await act(async () => button("Ask about this plan")!.click());
    expect(opened).toEqual([{ request: "How is my Fall Half Block plan going?" }]);
  });

  it("with no thread coach to send to, Extend and Wind down are not offered", () => {
    mount(createElement(PlanSheet, { planId: "cp1", plans: [coachPlan], onClose: noop, onRetire: async () => null, onRename: noop }), { open: noop }, [[["plan-detail", "cp1"], detail]]);
    expect(button("Extend")).toBeUndefined();
    expect(button("Wind down")).toBeUndefined();
  });

  it("Extend and Wind down wait while a request is out and until the thread coach answers: a second tap sends nothing", async () => {
    const sent: string[] = [];
    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity, enabled: false } } });
    qc.setQueryData(["plan-detail", "cp1"], detail);
    const draw = (threadBusy: boolean) =>
      act(() =>
        root!.render(
          createElement(
            QueryClientProvider,
            { client: qc },
            createElement(
              MemoryRouter,
              null,
              createElement(PlanSheet, { planId: "cp1", plans: [coachPlan], onClose: noop, onRetire: async () => null, onRename: noop, onAskThread: (b: string) => sent.push(b), threadBusy }),
            ),
          ),
        ),
      );
    // The thread coach already thinking (asked from elsewhere): they wait from the start.
    draw(true);
    expect(button("Extend")!.disabled && button("Wind down")!.disabled).toBe(true);
    draw(false);
    await act(async () => button("Extend")!.click());
    await act(async () => button("Extend")!.click());
    await act(async () => button("Wind down")!.click());
    expect(sent).toHaveLength(1);
    expect(button("Extend")!.disabled && button("Wind down")!.disabled).toBe(true);
    draw(true); // the thread coach is thinking
    expect(button("Extend")!.disabled).toBe(true);
    draw(false); // it has answered
    expect(button("Wind down")!.disabled).toBe(false);
    await act(async () => button("Wind down")!.click());
    expect(sent).toEqual(['Extend "Fall Half Block" — draft the next weeks in the same shape.', 'Wind down "Fall Half Block" — draft the final taper week.']);
  });

  it("no Plan with the coach until §8: its interview needs the thread's chat, which the Plan no longer has", () => {
    mount(createElement(YourPlans, { plans: [], programs: undefined, today: "2026-08-11", onOpenPlan: noop }), { open: noop });
    expect(button("Plan with the coach")).toBeUndefined();
    expect(read("screens/plan-cards.tsx")).not.toContain("Plan with the coach");
  });

  it("the Plan wires the sheet to the thread coach's send and its thinking, and passes its cards the lost work's receipt", () => {
    const plan = read("screens/plan.tsx");
    expect(plan).toMatch(/<PlanSheet[\s\S]*?onAskThread=\{coach\.send\}[\s\S]*?threadBusy=\{coach\.busy\}/);
    expect(plan).not.toMatch(/<YourPlans[^/]*?onAskThread/);
    expect(plan).toContain("<ThreadCoachCards {...coachProps} nothingApplied={nothingAppliedOf(coach.state.data?.messages ?? [])}");
  });
});

describe("minors — the last wake's lost work reaches the Plan", () => {
  const m = (id: string, role: CoachMessageDto["role"], body: string): CoachMessageDto => ({ id, role, body, refs: {}, at: `2026-10-0${id}T08:00:00Z` });
  const lost = "One plan change didn't make it: “Ease Tuesday” — it edits the past. Nothing was applied. Ask again — naming one day at a time helps — and it will come back as a proposal you can approve.";

  it("the newest message, when it is a receipt that applied nothing; else none", () => {
    expect(nothingAppliedOf([m("1", "user", "Ease my week"), m("2", "receipt", lost)])).toBe(lost);
    expect(nothingAppliedOf([m("1", "receipt", lost), m("2", "user", "Try Wednesday")])).toBeNull();
    expect(nothingAppliedOf([m("1", "coach", "Done — two changes below.")])).toBeNull();
    // Only a receipt is the app's account of a lost wake: the coach's own words quoting it are not.
    expect(nothingAppliedOf([m("1", "coach", "Last time: Nothing was applied. This time it went through.")])).toBeNull();
    expect(nothingAppliedOf([])).toBeNull();
  });

  it("the thread coach's reply in words: its newest message after the athlete's latest request; else none", () => {
    const asked = m("1", "user", 'Extend "Fall Half Block" — draft the next weeks in the same shape.');
    expect(replyOf([asked, m("2", "coach", "Two more weeks fit before your race."), m("3", "coach", "Here is the shape I'd keep.")])).toEqual({
      text: "Here is the shape I'd keep.",
      at: "2026-10-03T08:00:00Z",
    });
    // A receipt is not its words; nothing said yet, or nothing asked: none.
    expect(replyOf([asked, m("2", "receipt", "1 change made.")])).toBeNull();
    // A newer request not yet answered: the older answer is not its reply.
    expect(replyOf([asked, m("2", "coach", "Two more weeks fit."), m("3", "user", "Wind down instead")])).toBeNull();
    expect(replyOf([m("1", "coach", "An older word."), m("2", "user", "Wind down please")])).toBeNull();
    expect(replyOf([m("1", "coach", "A word with nothing asked.")])).toBeNull();
    expect(replyOf([])).toBeNull();
    expect(read("screens/plan.tsx")).toMatch(/<ThreadCoachCards[^>]*reply=\{replyOf\(coach\.state\.data\?\.messages \?\? \[\]\)\}/);
  });
});
