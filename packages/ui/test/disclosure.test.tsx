/**
 * System 4 — a state change moves nothing at or above the thing you touched.
 *
 *   Firing a disclosure, or a query resolving, must not move the trigger and
 *   must not move anything above it. Growth BELOW the trigger is expected and
 *   fine.
 *
 * Nothing in a node-environment suite can measure a pixel, so none of these
 * tests pretends to. They assert the four structural properties that, when
 * they hold, make the pixel measurement come out right — and each one guards a
 * defect that actually shipped:
 *
 *  1. GATE COMPLETENESS. Every query a screen declares before its first-paint
 *     gate is either IN the gate or explicitly marked `not-structural`. The
 *     Plan page told a plan owner "Nothing planned yet" because two of its
 *     four queries were not in the gate; nobody had to make a decision to
 *     leave them out, which is exactly why this is a scan and not a comment.
 *  2. NO FABRICATED ANSWERS. `?? 0` / `?? []` / `?? false` may not stand in
 *     for a query that has not answered and then decide what renders. That is
 *     the recurring bug class in this codebase, hit four times.
 *  3. DOM ORDER. A disclosure's detail is written after its trigger, and the
 *     trigger is not inside the branch it toggles — so it cannot be pushed
 *     down by its own content, and cannot delete itself.
 *  4. ONE DERIVATION. The garden's attention count and the block it jumps to
 *     come from one function and one sentence.
 */
import { createElement } from "react";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { describe, expect, it } from "vitest";
import type { CoachProposalDto } from "@rg/api-client";
import type { WorkoutDto } from "@rg/domain";
import { settling } from "../src/components.js";
import { ProposalCard } from "../src/screens/coach-panel.js";
import { attentionPhrase, gardenAttention } from "../src/screens/garden.js";

const read = (rel: string) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8");
/** Comments in this codebase quote the very strings these scans count, so
 *  every textual assertion reads CODE only. */
const decomment = (t: string) => t.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
const src = {
  garden: read("../src/screens/garden.tsx"),
  plan: read("../src/screens/plan.tsx"),
  settings: read("../src/screens/settings.tsx"),
  coachPanel: read("../src/screens/coach-panel.tsx"),
  moveSheet: read("../src/screens/move-sheet.tsx"),
  studioModal: read("../src/screens/studio-modal.tsx"),
  components: read("../src/components.tsx"),
  css: read("../src/styles.css"),
};
const code = {
  garden: decomment(src.garden),
  coachPanel: decomment(src.coachPanel),
};
/** One CSS rule's declarations, by its exact selector text. */
const cssRule = (selector: string) => {
  const from = at(src.css, `${selector} {`);
  return src.css.slice(from, src.css.indexOf("}", from));
};

function render(el: React.ReactElement): string {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } });
  return renderToStaticMarkup(
    createElement(QueryClientProvider, { client: qc }, createElement(MemoryRouter, null, el)),
  );
}

// ── 1. The gate ────────────────────────────────────────────────────────────

describe("`settling` is a first-paint gate, not a spinner on every refetch", () => {
  it("reads isLoading, never isFetching", () => {
    const body = src.components.slice(
      src.components.indexOf("export function settling("),
      src.components.indexOf("const FOCUSABLE ="),
    );
    expect(body).toContain("isLoading");
    // `isFetching` is true for a background revalidate. Gating on it would
    // blank a screen that already has every answer in cache — a worse move
    // than the one this system exists to stop.
    expect(body).not.toContain("isFetching");
  });

  it("a settled query is not settling, and one in flight is", () => {
    expect(settling({ isLoading: false }, { isLoading: false })).toBe(false);
    expect(settling({ isLoading: false }, { isLoading: true })).toBe(true);
    // Absent queries are not an excuse to hold the screen forever.
    expect(settling(undefined, null)).toBe(false);
    expect(settling()).toBe(false);
  });
});

/**
 * Every `const x = useQuery(...)` (or a named query hook) a screen declares
 * BEFORE its gate, paired with whether it is in the gate's argument list.
 */
function gateAudit(source: string, component: string): { named: string[]; gated: string[]; exempt: string[] } {
  const from = source.indexOf(`export function ${component}() {`);
  expect(from, `no ${component}`).toBeGreaterThan(-1);
  const gateAt = source.indexOf("settling(", from);
  expect(gateAt, `${component} has no settling() gate`).toBeGreaterThan(-1);
  const head = source.slice(from, gateAt);
  const gateArgs = source.slice(gateAt + "settling(".length, source.indexOf(")", gateAt));
  // IDENTIFIERS, not comma-separated argument text: an entry may legitimately
  // be conditional (the garden's ribbon query is in the gate only when the
  // dock — the box that renders it — was open at mount), and splitting on
  // commas would read `a ? q : null` as one unrecognisable argument and
  // report the query as ungated.
  const gated = gateArgs.match(/[A-Za-z_$][\w$]*/g) ?? [];

  const named: string[] = [];
  const exempt: string[] = [];
  // `useQuery`, plus this package's one-fetch-two-readers hooks.
  const re = /const (\w+) = (useQuery\(|useRaceHub\(|useWeekWorkouts\()/g;
  for (let m = re.exec(head); m; m = re.exec(head)) {
    const name = m[1]!;
    // An explicit, reviewed opt-out written directly above the declaration.
    const before = head.slice(Math.max(0, m.index - 400), m.index);
    if (/not-structural:/.test(before.slice(before.lastIndexOf("\n\n")))) exempt.push(name);
    else named.push(name);
  }
  return { named, gated, exempt };
}

describe("a screen's first paint waits for every query that decides its structure", () => {
  it.each([
    ["plan.tsx", "PlanScreen"] as const,
    ["garden.tsx", "GardenScreen"] as const,
  ])("%s / %s", (file, component) => {
    const source = file === "plan.tsx" ? src.plan : src.garden;
    const { named, gated, exempt } = gateAudit(source, component);
    for (const q of named) {
      expect(
        gated,
        `\`${q}\` is declared in ${component} before the gate but is not in it. ` +
          `Either add it to settling(...), or write "not-structural: <why>" above ` +
          `its declaration — a query that decides whether a BLOCK exists must be ` +
          `in the gate, or the screen paints one layout and then another.`,
      ).toContain(q);
    }
    // The exemption has to stay a deliberate minority, not the default.
    expect(named.length).toBeGreaterThan(exempt.length);
  });

  it("the Plan page gates on all four of its structural queries", () => {
    const { gated } = gateAudit(src.plan, "PlanScreen");
    // `plan` + `coachPlans` are the two that `emptyPlan` is an AND of; without
    // them the page stated "Nothing planned yet" to somebody with a plan.
    // `raceHub` is the race strip, which used to land 1.5s late.
    expect(gated).toEqual(expect.arrayContaining(["week", "plan", "coachPlans", "raceHub"]));
  });

  it("the garden gates on the week the ribbon draws", () => {
    const { gated } = gateAudit(src.garden, "GardenScreen");
    expect(gated).toEqual(expect.arrayContaining(["garden", "today", "weekWorkouts"]));
  });

  it("…and neither fetches nor waits for it where the ribbon cannot render", () => {
    // The ribbon lives INSIDE the dock panel, and from lg the dock opens
    // collapsed. Gating on a query whose only reader is not on screen bought
    // a request that fed nothing and then held first paint on it — measured
    // 3078ms at 1440×900 with the endpoint delayed 3s, with `.week-ribbon`
    // still absent when the spinner let go. Both halves have to be
    // conditional: dropping it from the gate alone would leave the wasted
    // request, and gating without disabling would leave the wasted wait.
    expect(code.garden).toMatch(/const weekWorkouts = useWeekWorkouts\([\s\S]{0,120}?dockOpen,?\s*\)/);
    expect(code.garden).toMatch(/function useWeekWorkouts\(monday: string, enabled = true\)/);
    expect(code.garden).toMatch(/queryKey: \["week-workouts", monday\],[\s\S]{0,120}?\n\s*enabled,/);
    // …and the gate's copy of the question is asked ONCE, at mount. Read
    // live, opening the dock later would throw the whole painted screen back
    // to "Loading the garden" while the query ran.
    expect(code.garden).toContain("const [gateOnRibbon] = useState(dockOpen);");
    expect(code.garden).toMatch(/settling\(garden, today, gateOnRibbon \? weekWorkouts : null\)/);
  });
});

// ── 2. No fabricated answers ───────────────────────────────────────────────

describe("a default never stands in for an answer that has not arrived", () => {
  it("the Plan page's empty state is claimed from data it holds, not from `?? 0`", () => {
    const line = src.plan.split("\n").find((l) => l.includes("const emptyPlan ="));
    expect(line).toBeDefined();
    const decl = src.plan.slice(src.plan.indexOf("const emptyPlan ="), src.plan.indexOf(";", src.plan.indexOf("const emptyPlan =")));
    expect(decl).not.toMatch(/\?\?\s*0/);
    // Both answers must be in hand — an ERRORED query is not an empty plan.
    expect(decl).toContain("plan.data");
    expect(decl).toContain("coachPlans.data");
  });

  it("Settings never decides `connected` from a query in flight", () => {
    const at = src.settings.indexOf("export function CorosConnectSection()");
    const body = src.settings.slice(at, src.settings.indexOf("\nfunction DiagRows", at));
    // The `connected` boolean may stay as it is — what must exist is a branch
    // ABOVE it that renders neither answer while the query is still loading.
    const branchAt = body.indexOf("status.isLoading");
    const connectedAt = body.indexOf("connected && !badCreds");
    expect(branchAt, "no loading branch in the COROS card").toBeGreaterThan(-1);
    expect(branchAt).toBeLessThan(connectedAt);
  });

  it("the week ribbon's `?? []` cannot fire during the first paint", () => {
    // It still reads `?? []` for the errored case, which is honest — but the
    // screen's gate now covers the query, so the empty array can only ever
    // mean "the server said there are none".
    expect(src.garden).toContain("const weekWorkouts = useWeekWorkouts(");
    const gate = src.garden.slice(src.garden.indexOf("if (settling("), src.garden.indexOf("\n", src.garden.indexOf("if (settling(")));
    expect(gate).toContain("weekWorkouts");
  });
});

// ── 3. DOM order: the detail comes after the trigger ───────────────────────

/** Index of `needle` in `hay`, asserted to exist. */
function at(hay: string, needle: string): number {
  const i = hay.indexOf(needle);
  expect(i, `\`${needle}\` not found`).toBeGreaterThan(-1);
  return i;
}

describe("a disclosure's detail is written after its trigger", () => {
  it("the coach proposal's rationale and error follow the actions row", () => {
    const card = src.coachPanel.slice(
      at(src.coachPanel, "export function ProposalCard("),
      at(src.coachPanel, "export type ThreadItem ="),
    );
    const actions = at(card, "proposal-actions");
    expect(at(card, "coach-prop-why")).toBeGreaterThan(actions);
    expect(at(card, "coach-prop-error")).toBeGreaterThan(actions);
  });

  it("the garden's how-it-works banner follows the link that opens it", () => {
    // Anchored on the two things that genuinely exist and genuinely bind the
    // pair — the trigger's `aria-controls` and the banner's matching `id` —
    // rather than on a class name. The anchor here used to be
    // `garden-below-toggle`, which had no rule in styles.css at all; worse,
    // the FIRST occurrence of that string in the file was inside the comment
    // above the button, so this scan was measuring prose. Code only, and only
    // names the app would break without.
    const below = code.garden.slice(at(code.garden, 'className="garden-below"'));
    expect(at(below, "{howItWorks}")).toBeGreaterThan(at(below, 'aria-controls="garden-how-it-works"'));
    expect(src.garden).toContain('<Banner kind="info" id="garden-how-it-works">');
  });

  it("the move sheet's custom fields follow the button that opens them", () => {
    expect(at(src.moveSheet, 'id="mv-custom"')).toBeGreaterThan(at(src.moveSheet, "Choose another time"));
  });
});

describe("a disclosure trigger survives its own click", () => {
  it("Settings' diagnostics toggle is not inside the branch it toggles", () => {
    const card = src.settings.slice(at(src.settings, '<Card title="Diagnostics">'), at(src.settings, "\nfunction DiagRows"));
    // The shape that shipped was `{!open ? <button/> : <content/>}` — the
    // button lived in the collapsed branch, so opening deleted it and only a
    // reload (which also lost the state) could close it again.
    expect(card).not.toMatch(/\{!open \?\s*\(?\s*<button/);
    expect(card).toContain('aria-expanded={open}');
    expect(card).toMatch(/Hide diagnostics.*Show diagnostics|Show diagnostics.*Hide diagnostics/s);
  });

  it("the move sheet's custom-time toggle is not inside the branch it toggles", () => {
    expect(src.moveSheet).not.toMatch(/\{custom \?[\s\S]{0,900}Choose another time/);
    expect(src.moveSheet).toContain("aria-expanded={custom}");
  });

  it("both of them name the region they control", () => {
    expect(src.settings).toContain('aria-controls="diag-body"');
    expect(src.moveSheet).toContain('aria-controls="mv-custom"');
  });

  it("a closed disclosure body takes no room, gap included", () => {
    // In a `.stack` (flex + gap) an empty box is not free — it is a whole gap.
    expect(cssRule(".disclosure-body:empty")).toContain("display: none");
  });

  it("a destructive confirm is a nested DIALOG, not a row in the action row's foot", () => {
    // Three shapes have been tried. (1) Replacing the trigger in place: React
    // reconciles two `<button>`s in the same slot by REUSING the DOM node, so
    // the box under the reader's finger turned red without moving — measured on
    // the workout sheet at 1440, dy +52 / dx −97 as the confirm's sentence
    // re-wrapped the row around it. (2) A disclosure in the pinned foot, which
    // `column-reverse` opens on the far side of the action row: that keeps the
    // trigger still but puts the confirm somewhere it does not belong —
    // measured at 390, 169.2px ABOVE its own trigger with Match activity /
    // Move it / Skip it in between, and 117.2px above even when the row does
    // not wrap. It reads correctly in exactly one of the four
    // width × wrapped-row combinations. (3) This: a dialog, over the trigger,
    // titled with the question, at every width.
    for (const [name, source, trigger] of [
      ["workout sheet", src.plan, "Remove from plan"],
      ["studio modal", src.studioModal, "Retire…"],
    ] as const) {
      const code = decomment(source);
      // The confirm is a ConfirmDialog, and the trigger says so.
      expect(code, name).toContain("<ConfirmDialog");
      expect(code, name).toContain('aria-haspopup="dialog"');
      // …and no longer a disclosure region in the foot.
      expect(code, name).not.toContain("confirm-retire");
      expect(code, name).not.toContain("confirm-remove");
      // The trigger is not inside the branch it opens…
      expect(code, name).not.toMatch(new RegExp(`\\{!?confirm\\w* \\?[\\s\\S]{0,400}?${trigger}`));
      // …the dialog is written after it…
      expect(at(code, "<ConfirmDialog"), name).toBeGreaterThan(at(code, trigger));
      // …and the trigger's label is a constant, so the row cannot re-wrap.
      const decl = code.slice(at(code, trigger));
      expect(decl.slice(0, 260), name).not.toMatch(/\?\s*"[^"]*"\s*:\s*"[^"]*"/);
    }
    // It opens as a QUESTION and it is centred, because a bottom-anchored
    // confirm lands its destructive button in the same band as the action row
    // that opened it — measured at 390, centre-to-centre 0.0px from the
    // trigger, with `elementFromPoint` at the pre-press point returning
    // "Remove from plan".
    const components = decomment(src.components);
    const dialog = components.slice(at(components, "export function ConfirmDialog("));
    expect(dialog.slice(0, 900)).toContain("centered");
    expect(cssRule(".sheet-backdrop--centered")).toContain("align-items: center");
    // The one press that must never be the default: the dialog element takes
    // focus, not the button that does the damage.
    expect(src.components).toContain("dialog?.focus()");
  });
});

describe("an open sheet's frame is stable; growth inside it scrolls", () => {
  it("the pin is measured on a PRESS, never on open", () => {
    const hook = src.components.slice(
      at(src.components, "function usePinnedTop("),
      at(src.components, "\n/**\n * Bottom sheet on mobile"),
    );
    // Pinning at open freezes whatever the dialog happened to be at that
    // instant — for a dialog whose content arrives with a query, the loading
    // state. That shipped once: a spinner-sized studio modal froze a 476px cap
    // over a 900px viewport and hid the weeks table it had shown before.
    expect(hook).toContain('el.addEventListener("click", pin, true)');
    expect(hook).not.toMatch(/pin\(\);\s*\n/); // never called straight from the effect
    expect(hook).toContain("--sheet-hold");
    expect(hook).toContain("--sheet-pin");
    // A resize releases it: the frozen numbers describe a viewport that is
    // gone, and a rotation across 1024 would apply one width's numbers under
    // the other width's rules.
    expect(hook).toContain('window.addEventListener("resize", release)');
  });

  it("…and it is not scoped to one width any more", () => {
    // `min-width: 1024px` inside the hook meant every in-flow disclosure in
    // every MOBILE sheet raised that sheet's top edge, since a bottom sheet
    // spends all of its growth upward: measured at 390, −223px for the move
    // sheet's "Choose another time", −129 for "Full structure", −17 for
    // "Remove from plan".
    const hook = src.components.slice(
      at(src.components, "function usePinnedTop("),
      at(src.components, "\n/**\n * Bottom sheet on mobile"),
    );
    expect(hook).not.toContain("min-width: 1024px");
  });

  it("each width spends the pin on whichever edge is free", () => {
    // Bottom sheet: the bottom edge is the viewport's, so the frame is frozen
    // with `height` and a collapsed disclosure leaves its room in the
    // scroller rather than dropping the top edge back onto the reader.
    expect(cssRule(".sheet-backdrop[data-pinned] > .sheet")).toContain(
      "height: min(var(--sheet-hold, 85dvh), 85dvh)",
    );
    // Centred dialog: the bottom edge is free, so the dialog GROWS DOWNWARD
    // into the backdrop below it and the disclosure is simply visible (R1).
    // Capping it at `--sheet-hold` as well left the confirm 59.6px below the
    // fold at 1440 with ~250px of dead backdrop under the dialog.
    const lg = src.css.slice(src.css.lastIndexOf(".sheet-backdrop[data-pinned] {"));
    expect(lg).toContain("align-items: flex-start");
    expect(lg.slice(0, 900)).toContain("margin-top: var(--sheet-pin, 0px)");
    expect(lg.slice(0, 900)).toContain("max-height: calc(100dvh - var(--sheet-pin, 0px) - 1.5rem)");
    expect(lg.slice(0, 900)).not.toMatch(/max-height: min\(\s*var\(--sheet-hold/);
    // …and `--fill`, whose content column needs a definite height, keeps one.
    expect(lg.slice(0, 2000)).toContain(".sheet-backdrop[data-pinned] > .sheet--fill");
  });

  it("…but raising that ceiling never grows a dialog that was already full", () => {
    // The cost of R1: a body that was ALREADY clipped answers a higher ceiling
    // by taking it, so the studio modal went 720 → 786px at 1440 on a press
    // that disclosed nothing, and handed 10px of that to the body — which
    // pushed its pinned action row, "Retire…" and "Rename" included, down 10px.
    const hook = src.components.slice(
      at(src.components, "function usePinnedTop("),
      at(src.components, "\n/**\n * Bottom sheet on mobile"),
    );
    expect(hook).toContain("body.scrollHeight > body.clientHeight + 1");
    expect(hook).toContain("--sheet-body-hold");
    expect(hook).toContain('back.dataset.bodyHeld = "true"');
    // …and released with everything else, or the next open inherits a height
    // measured against a viewport that is gone.
    const release = hook.slice(at(hook, "const release = ()"), at(hook, "const pin = ()"));
    expect(release).toContain("bodyHeld");
    expect(release).toContain("--sheet-body-hold");
    const lg = src.css.slice(src.css.lastIndexOf(".sheet-backdrop[data-pinned] {"));
    expect(lg).toContain(".sheet-backdrop[data-body-held] > .sheet > .sheet-body");
    expect(lg).toContain("height: var(--sheet-body-hold)");
  });

  it("the foot grows AWAY from its action row at both widths", () => {
    // A block added to a bottom-anchored foot grows it upward out of the body,
    // and with that block last in the DOM the action row went with it:
    // "Retire…" measured −61.2px at 390. The DOM order is the same at both
    // widths — only the visual direction flips — so the block stays the next
    // tab stop after the control that armed it.
    expect(cssRule(".sheet-foot")).toContain("flex-direction: column-reverse");
    const lg = src.css.slice(src.css.lastIndexOf(".sheet-backdrop[data-pinned] {"));
    expect(lg).toMatch(/\.sheet-foot \{\s*flex-direction: column;/);
    // One disclosure still opens here — the studio's rename, which is editing
    // and not a question about the press that opened it. It keeps
    // [actions · disclosure] in the DOM, at every width.
    const studioFoot = src.studioModal.slice(at(src.studioModal, "const footer ="));
    expect(at(studioFoot, "{actions}")).toBeLessThan(at(studioFoot, 'id="studio-rename"'));
    // Nothing destructive does: those are dialogs (see the confirm test above),
    // because `column-reverse` keeps the trigger still by putting the confirm
    // on the far side of a row it does not belong to.
    expect(decomment(src.plan)).not.toContain("disclosure-body");
  });

  it("a sheet's entrance does not outlive itself and capture the sheets inside it", () => {
    // `forwards` keeps `transform` applied after the animation ends, which
    // makes the sheet the containing block for the nested move/match sheets:
    // their backdrops became `inset: 0` of the PARENT (250/400.6 at 1440, not
    // 0/900), so the pin's numbers were 3px out and a disclosure slid the
    // nested dialog's own title row.
    const anim = src.css.slice(at(src.css, "animation: sheet-in"));
    expect(anim.slice(0, 80)).toContain("backwards");
    expect(anim.slice(0, 80)).not.toContain("both");
  });

  it("only the sheet's BODY scrolls, so that is where the growth can land", () => {
    expect(cssRule(".sheet")).toContain("overflow: hidden");
    expect(cssRule(".sheet-head")).toContain("flex: none");
    expect(cssRule(".sheet-foot")).toContain("flex: none");
    expect(cssRule(".sheet-body")).toContain("flex: 1 1 auto");
    expect(src.components).toContain('className={`sheet-body${fill ? "" : " scroller"}`}');
  });
});

describe("a trigger's own box does not change when it fires", () => {
  it("in-prose and in-row triggers keep their label and move the caret instead", () => {
    // "How the garden works" (148px) used to become "Hide" (31px) — inline in
    // a wrapping paragraph, so the box did not shrink in place, it re-flowed
    // onto the previous line and the before/after rectangles did not overlap.
    const below = code.garden.slice(at(code.garden, 'aria-controls="garden-how-it-works"'));
    expect(below.slice(0, 400)).not.toMatch(/showWeather \? "Hide"/);
    expect(below).toContain("disclosure-caret");
    // Same species, one row over: "Why?" → "Hide" is a 7px width change.
    expect(code.coachPanel).not.toMatch(/\{why \? "Hide" : "Why\?"\}/);
    expect(src.coachPanel).toContain("disclosure-caret");
  });

  it("the caret glyph box is fixed-width, so ▸ and ▾ occupy the same space", () => {
    const rule = cssRule(".disclosure-caret");
    expect(rule).toContain("display: inline-block");
    expect(rule).toMatch(/width:\s*1em/);
  });

  it("every disclosure trigger this system touched has a 44px tap pad", () => {
    // A bare `.linklike` in prose was in NONE of the pad selector lists — the
    // control measured 147.9 × 21.6px of hit area.
    const padded = src.css.slice(0, at(src.css, ".tap-pad::after,"));
    expect(padded).toContain(".garden-below-intro .linklike,");
    expect(src.css).toContain(".garden-below-intro .linklike::after,");
    // A pad is clamped to what its container grants, so the container has to
    // grant it: 21.6px needs (44 − 21.6)/2 = 11.2px per side.
    expect(cssRule(".garden-below-intro")).toContain("--tap-clear");
  });

  it("the race strip's toggle wears the app's chrome, not the browser's", () => {
    const rule = cssRule(".race-strip-toggle");
    // Without these three the UA defaults stood: `appearance: auto`,
    // `2px outset buttonborder`, `background: buttonface` — 1.34:1 in dark.
    expect(rule).toContain("appearance: none");
    expect(rule).toContain("background: none");
    expect(rule).toMatch(/border:\s*0/);
  });
});

// ── 4. One derivation ──────────────────────────────────────────────────────

const wk = (id: string, title: string) => ({ id, title }) as unknown as WorkoutDto;

describe("the garden's attention count and its destination come from one place", () => {
  it("counts both kinds of thing that need you", () => {
    const a = gardenAttention({
      needsAttention: [wk("1", "Threshold 5x5")],
      unresolved: [wk("2", "Easy Run"), wk("3", "Long Run")],
    });
    expect(a.count).toBe(3);
    expect(a.mismatched).toHaveLength(1);
    expect(a.unresolved).toHaveLength(2);
  });

  it("is zero, not a crash, when the query errored", () => {
    expect(gardenAttention(undefined).count).toBe(0);
  });

  it("has exactly one sentence, and it agrees with itself", () => {
    expect(attentionPhrase(1)).toBe("1 workout needs attention");
    expect(attentionPhrase(3)).toBe("3 workouts need attention");
    // The link said "3 workouts need attention ↓" and the banner it jumped to
    // spoke for 1, because each counted its own thing. The literal may exist
    // only inside `attentionPhrase`; both readers call it.
    const occurrences = code.garden.split("workouts need attention").length - 1;
    expect(
      occurrences,
      "`workouts need attention` is written more than once in garden.tsx — " +
        "that is how the count and the banner drifted apart the first time",
    ).toBe(1);
    expect(code.garden.split("attentionPhrase(").length - 1).toBeGreaterThanOrEqual(3); // decl + 2 readers
  });

  it("the jump target is the attention block, not the whole lower page", () => {
    // `id="garden-attention"` on `.garden-below` resolved 352px above the
    // first thing that needed you, because that region opens with prose.
    expect(src.garden).not.toMatch(/className="garden-below" id="garden-attention"/);
    expect(src.garden).toMatch(/className="garden-attention" id="garden-attention"/);
    // …and the scroll margin moved with the id.
    expect(cssRule(".garden-attention")).toContain("scroll-margin-top");
    expect(cssRule(".garden-below")).not.toContain("scroll-margin-top");
  });
});

// ── The disclosure that started it all, rendered ───────────────────────────

describe("ProposalCard renders a closed, addressable disclosure", () => {
  const proposal = {
    id: "p1",
    title: "Move Saturday's long run to Sunday",
    evidence: "A 6h hike sits on Saturday.",
    rationale: "A long run on the back of a full day on your feet flattens the week.",
    flags: [],
    ops: [{ kind: "move", workoutId: "w1", toDate: "2026-08-23" }],
    status: "pending",
  } as unknown as CoachProposalDto;

  it("the trigger is present, closed, and points at the detail it reveals", () => {
    const html = render(
      createElement(ProposalCard, {
        proposal,
        title: proposal.title,
        onApprove: () => undefined,
        onDecline: () => undefined,
      }),
    );
    expect(html).toContain('aria-expanded="false"');
    expect(html).toContain('aria-controls="proposal-why-p1"');
    // Closed, the rationale is not in the document at all — so the only thing
    // that can move when it opens is what is below it.
    expect(html).not.toContain(proposal.rationale);
    // And the committing actions are before the trigger, where they stay put.
    expect(html.indexOf("Make it so")).toBeLessThan(html.indexOf("aria-expanded"));
  });
});
