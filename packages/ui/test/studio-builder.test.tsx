/**
 * Stage 2 Task 6 — the builder, as it first draws (spec §8): a new workout is warm-up, main and cool-down with
 * suggestions in each; a part that loads a hinge prompts a glute activation; an error keeps Start off with its reason
 * beside it and a Fix; the item sheet reorders by buttons. Static renders of the real screen, its queries primed.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { QueryClientProvider } from "@tanstack/react-query";
import { describe, expect, it } from "vitest";
import { DEFAULT_SCHEDULING_PREFERENCES, type WorkoutDoc } from "@rg/domain";
import { EXERCISES } from "@rg/exercise-library";
import { edit, newDoc, startEditing, suggestedItem, suggestForPart, type DraftDoc, type EditAction } from "@rg/workout";
import { features } from "../src/features.js";
import { BuilderRoute } from "../src/screens/studio/builder.js";
import { STUDIO_DRAFT_QUERY } from "../src/studio-drafts.js";
import { TEMPLATES_QUERY } from "../src/screens/studio/add-sheet.js";
import { ItemSheet } from "../src/screens/studio/item-sheet.js";
import { buildCtxOf, judgeDraft, suggestCtxOf } from "../src/screens/studio/build-model.js";
import { emptyStudioCtx, studioCtxFrom } from "../src/screens/studio/model.js";
import { localTodayGuess } from "../src/components.js";
import { libraryDto, placesDto, primedClient, profileDto, staticRouter, text, todayDto, TODAY, type Primed } from "./studio-fixtures.js";

const rec = (id: string) => EXERCISES.find((r) => r.id === id)!;
const HOME_GEAR = ["mat", "kettlebell", "dumbbells", "bench", "chair", "band", "wall"];

function draft(...actions: EditAction[]): DraftDoc {
  let s = startEditing(newDoc("structured", { title: "Hips & posture", source: { kind: "studio" } }));
  for (const a of actions) s = edit(s, a, EXERCISES);
  return s.doc;
}
const into = (part: number, id: string, extra: object = {}): EditAction => ({ type: "addItem", part, item: { ...suggestedItem(rec(id), "main"), ...extra } as never });

/** The builder at `path`, with the device's draft (or none) and the Studio's reads primed. */
function renderBuilder(path: string, opts: { draft?: DraftDoc | null; primed?: Primed; templates?: unknown } = {}): string {
  const qc = primedClient({ places: placesDto(HOME_GEAR), ...opts.primed });
  qc.setQueryData(STUDIO_DRAFT_QUERY, opts.draft ? { doc: opts.draft, updatedAt: 1 } : null);
  qc.setQueryData(["settings"], { prefs: DEFAULT_SCHEDULING_PREFERENCES });
  if (opts.templates) qc.setQueryData(TEMPLATES_QUERY, opts.templates);
  return renderToStaticMarkup(createElement(QueryClientProvider, { client: qc }, staticRouter(path, createElement(BuilderRoute))));
}

/** Each part as drawn: its name, and the moves it suggests (by their ＋'s names). */
function parts(html: string): Array<{ name: string; ghost: boolean; suggested: string[]; items: string[] }> {
  return html
    .split('<section class="stu-part')
    .slice(1)
    .map((chunk) => {
      const body = chunk.slice(0, chunk.indexOf("</section>"));
      return {
        // The name is a term that explains itself: the button's own word, not its popover's sentence.
        name: /<span class="stu-part-name eyebrow">(?:<span class="term-wrap"><button[^>]*>)?([^<]+)/.exec(body)?.[1] ?? "",
        ghost: chunk.startsWith(" stu-part--ghost"),
        suggested: [...body.matchAll(/aria-label="Add ([^"]+)"/g)].map((m) => m[1]!),
        items: [...body.matchAll(/<span class="stu-item-name">([^<]+)/g)].map((m) => m[1]!),
      };
    });
}

describe("a new workout", () => {
  it("is warm-up, main and cool-down, each with suggestions and a way to add any move", () => {
    const html = renderBuilder("/studio/build/new");
    const ps = parts(html);
    expect(ps.map((p) => p.name)).toEqual(["Warm-up", "Main", "Cool-down"]);
    for (const p of ps) {
      expect(p.suggested.length, p.name).toBeGreaterThan(0);
      expect(p.suggested.length, p.name).toBeLessThanOrEqual(3);
      expect(p.items).toEqual([]);
    }
    expect((html.match(/Add a move<\/button>/g) ?? []).length).toBe(3);
    // The other parts are one tap away.
    expect(text(html.slice(html.indexOf("stu-add-parts")))).toMatch(/^[^]*Activation Power Accessory Conditioning/);
  });

  it("an empty workout can't start yet, and says so in plain words", () => {
    const html = renderBuilder("/studio/build/new");
    expect(html).toMatch(/<button[^>]*class="btn btn-primary stu-build-start"[^>]*disabled=""[^>]*>Start now<\/button>/);
    expect(text(html)).toContain("Add a move first.");
    expect(html).toMatch(/<button[^>]*disabled=""[^>]*>Schedule…<\/button>/);
    // Nothing to sum up yet: the summary waits for a move.
    expect(html).toContain('<div class="stu-build-sum" hidden="">');
  });

  it("…and with no player to start it in, Schedule waits on a move too, and the actions still say so", () => {
    features.player = false;
    try {
      const html = renderBuilder("/studio/build/new");
      expect(html).not.toContain("stu-build-start");
      expect(text(html)).toContain("Add a move first.");
      expect(html).toMatch(/<button[^>]*disabled=""[^>]*>Schedule…<\/button>/);
    } finally {
      features.player = true;
    }
  });

  it("the draft on this device is what opens, its title and why in their fields", () => {
    const d = draft({ type: "setIntent", intent: { summary: "Open the hips." } }, into(0, "catCow"));
    const html = renderBuilder("/studio/build/new", { draft: d });
    expect(html).toContain('value="Hips &amp; posture"');
    expect(html).toContain(">Open the hips.</textarea>");
    expect(parts(html)[0]!.items).toEqual(["Cat-cow"]);
  });
});

describe("activate before loading", () => {
  it("a hinge in the main part prompts a glute activation, where the part would go", () => {
    const html = renderBuilder("/studio/build/new", { draft: draft(into(1, "deadlift")) });
    const ps = parts(html);
    expect(ps.map((p) => [p.name, p.ghost])).toEqual([
      ["Warm-up", false],
      ["Activation", true],
      ["Main", false],
      ["Cool-down", false],
    ]);
    const ghost = ps[1]!;
    expect(ghost.suggested.length).toBeGreaterThan(0);
    // Each suggestion says why, one tap down: here, that it wakes the glutes before the deadlift.
    const chunk = html.slice(html.indexOf("stu-part--ghost"), html.indexOf("</section>", html.indexOf("stu-part--ghost")));
    expect(text(chunk)).toContain("Wakes the glutes before Deadlift.");
    const first = EXERCISES.find((r) => r.name === ghost.suggested[0])!;
    expect(first.purposes).toContain("activation");
    expect(first.muscles.primary.some((m) => m === "glute-max" || m === "glute-med")).toBe(true);
  });

  it("with no lift there is nothing to activate, and no prompt", () => {
    const html = renderBuilder("/studio/build/new", { draft: draft(into(1, "catCow")) });
    expect(html).not.toContain("stu-part--ghost");
  });
});

describe("errors block, with their reason and a Fix", () => {
  it("a move today's reading rules out keeps Start off, the note says why with its Fix, and the actions say where to look", () => {
    const d = draft({ type: "setIntent", intent: { effort: "develop" } }, into(1, "halfKneelingPress", { alternates: [{ libraryId: "floorPress" }] }));
    const html = renderBuilder("/studio/build/new", { draft: d, primed: { library: libraryDto({ tmj: true }), today: todayDto({ value: 3 }) } });
    const why = "Half-kneeling one-arm press isn&#x27;t allowed with today&#x27;s Jaw / head check at 3.";
    // Start is off. One voice per fact: the note says what (below); the actions say only that Start waits on it, and the
    // full reason is Start's own description, for a screen reader on the button.
    const start = /<button[^>]*class="btn btn-primary stu-build-start"[^>]*>Start now<\/button>/.exec(html)![0];
    expect(start).toContain('disabled=""');
    const describedBy = /aria-describedby="([^"]+)"/.exec(start)![1]!;
    expect(html).toContain(`<span id="${describedBy}" hidden="">${why}</span>`);
    expect(html).toContain('<p class="stu-build-why">Fix the note above to start.</p>');
    expect((html.match(new RegExp(why.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&"), "g")) ?? []).length).toBe(2);
    // The note is in the summary — never folded away (the summary is folded here, a phone's default) — with its Fix,
    // and the item is marked.
    expect(html).toMatch(/class="stu-sum-body" hidden=""/);
    expect(html.indexOf("stu-note stu-note--error")).toBeLessThan(html.indexOf('class="stu-sum-body"'));
    const note = html.slice(html.indexOf("stu-note stu-note--error"));
    expect(note).toContain(why);
    expect(note).toMatch(/<button[^>]*>Swap in Floor press<\/button>/);
    expect(html).toContain("<span class=\"visually-hidden\">To fix: </span>");
    expect(html).toContain(", needs a fix");
  });

  it("warnings are costs: shown, Start still on", () => {
    const d = draft(into(1, "gobletSquat"));
    const html = renderBuilder("/studio/build/new", { draft: d, primed: { places: placesDto(["mat"]) } });
    expect(text(html)).toMatch(/Goblet squat needs kettlebell or dumbbells, which this place doesn't have\./);
    expect(html).not.toMatch(/<button[^>]*class="btn btn-primary stu-build-start"[^>]*disabled/);
  });
});

describe("the item sheet", () => {
  const d = draft(into(1, "gobletSquat"), into(1, "deadlift"));
  const doc = d as WorkoutDoc;
  const sheet = (part: number, item: number) =>
    renderToStaticMarkup(
      createElement(
        QueryClientProvider,
        { client: primedClient() },
        staticRouter(
          "/studio/build/new",
          createElement(ItemSheet, {
            doc,
            part,
            item,
            rec: rec(item === 0 ? "gobletSquat" : "deadlift"),
            notes: [],
            unit: "lb",
            bc: buildCtxOf(emptyStudioCtx, TODAY),
            ctx: emptyStudioCtx,
            library: EXERCISES,
            onEdit: () => undefined,
            onMoved: () => undefined,
            onRemove: () => undefined,
            onFix: () => undefined,
            onCheck: () => undefined,
            checkLabel: () => "",
            onClose: () => undefined,
          }),
        ),
      ),
    );

  it("reorders by buttons — up and down, never a drag — the first move of a part going up into the part before", () => {
    const first = sheet(1, 0);
    expect(first).toMatch(/<button[^>]*class="btn"[^>]*>(<svg[^]*?<\/svg>)?Move up<\/button>/);
    expect(first).toMatch(/<button[^>]*class="btn"[^>]*>(<svg[^]*?<\/svg>)?Move down<\/button>/);
    expect(first).not.toContain("draggable");
    expect(/<button[^>]*>(<svg[^]*?<\/svg>)?Move up<\/button>/.exec(first)![0]).not.toContain("disabled");
  });

  it("types a rep range or a hold in minutes: those fields bring up a keyboard with more than digits", () => {
    expect(sheet(1, 0)).toMatch(/<input[^>]*inputMode="text"[^>]*value="5–8"/);
    expect(sheet(1, 0)).toMatch(/<input[^>]*inputMode="numeric"[^>]*value="2"/);
  });

  it("doses with steppers, the load as typed in the athlete's unit, and a cue", () => {
    const html = sheet(1, 0);
    expect(html).toContain('aria-label="One set fewer"');
    expect(html).toContain('aria-label="More: reps"');
    // A loaded move takes a load, its hint the athlete's unit.
    expect(html).toMatch(/<input[^>]*aria-label="Load"[^>]*placeholder="lb"/);
    expect(html).toMatch(/<input[^>]*aria-label="Cue"/);
    expect(text(html)).toContain("Swap");
  });
});

describe("the summary", () => {
  it("says the minutes, the kind and the place", () => {
    const d = draft(into(1, "gobletSquat"));
    const html = renderBuilder("/studio/build/new", { draft: d });
    const j = judgeDraft(d, buildCtxOf({ ...emptyStudioCtx, place: { name: "Home", equipment: HOME_GEAR }, today: TODAY }, TODAY), TODAY);
    expect(text(html)).toContain(`${j.derived!.estimatedMinutes} min · Strength · Home`);
  });

  it("what is left to fix is also a live region — and nothing to fix is said plainly, so a Fix that clears the last one is heard", () => {
    const d = draft(into(1, "gobletSquat"));
    // A cost (gear this place lacks) is a note to see, not something to fix.
    const costs = renderBuilder("/studio/build/new", { draft: d, primed: { places: placesDto(["mat"]) } });
    expect(costs).toContain('<span class="stu-sum-count">1 note</span>');
    expect(costs).toContain('<span class="visually-hidden" role="status">Nothing to fix.</span>');
    expect(renderBuilder("/studio/build/new", { draft: d })).toContain('<span class="visually-hidden" role="status">Nothing to fix.</span>');
    const ruled = draft({ type: "setIntent", intent: { effort: "develop" } }, into(1, "halfKneelingPress", { alternates: [{ libraryId: "floorPress" }] }));
    const errors = renderBuilder("/studio/build/new", { draft: ruled, primed: { library: libraryDto({ tmj: true }), today: todayDto({ value: 3 }) } });
    expect(errors).toContain('<span class="visually-hidden" role="status">1 to fix</span>');
  });
});

describe("the neutral note marker (a workout that can't change)", () => {
  it("is quiet: the note's circle and the move's marker in the soft ink, never the danger colour", () => {
    const css = readFileSync(fileURLToPath(new URL("../src/styles.css", import.meta.url)), "utf8");
    expect(css).toMatch(/\.stu-note--note \.stu-note-icon \{\s*color: var\(--ink-soft\);/);
    expect(css).toMatch(/\.stu-item-flag--note \{\s*color: var\(--ink-soft\);/);
    expect(css).not.toMatch(/\.stu-note--note[^{]*\{[^}]*--danger/);
  });
});

describe("suggestions, once a part has a move", () => {
  it("fold to one line — names that explain themselves, and one ＋ that opens the part's Add a move; an empty part keeps its rows", () => {
    const html = renderBuilder("/studio/build/new", { draft: draft(into(0, "catCow")) });
    const warmup = html.slice(html.indexOf('data-part="0"'), html.indexOf("</section>", html.indexOf('data-part="0"')));
    expect(warmup).toMatch(/<div class="stu-sug-line"><span class="stu-sugs-k" id="([^"]+)">Suggested:<\/span><ul class="stu-sug-names" aria-labelledby="\1">/);
    expect(warmup).not.toContain("stu-sug-list");
    // Each name its own item — a list a screen reader counts, never one string run together — and told apart by its
    // own outline, never by a character: a library name can hold " · " itself ("Active pigeon · back-leg lift").
    const names = warmup.slice(warmup.indexOf('<ul class="stu-sug-names"'), warmup.indexOf("</ul>", warmup.indexOf('<ul class="stu-sug-names"')));
    const items = names.split("<li>").slice(1);
    expect(items.length).toBeGreaterThan(1);
    for (const li of items) expect((li.match(/class="term(?: tap-pad)?"/g) ?? []).length).toBe(1);
    expect(names).not.toContain("stu-sep");
    expect(names).not.toContain("·");
    const css = readFileSync(fileURLToPath(new URL("../src/styles.css", import.meta.url)), "utf8");
    expect(/\.stu-sug-names li \{[^}]*border: 1px solid var\(--border(-strong)?\);[^}]*border-radius: var\(--radius-pill\);/.exec(css)).not.toBeNull();
    // One control per action (the spec's mock): the line's ＋ is the part's Add a move, and there is no second one.
    expect((warmup.match(/aria-label="Add [^"]*"/g) ?? [])).toEqual(['aria-label="Add a move to Warm-up"']);
    // …and it is the row's last chip, "＋ Add", wrapping with the names — never a ＋ left alone on a line of its own.
    expect(names).toMatch(/<li class="stu-sug-more"><button type="button" class="stu-sug-add stu-sug-add--chip" aria-label="Add a move to Warm-up"><span class="stu-sug-chip" aria-hidden="true"><svg[^]*<\/svg>Add<\/span><\/button><\/li>$/);
    const line = warmup.slice(warmup.indexOf('<div class="stu-sug-line">'));
    expect(line.slice(line.indexOf("</ul>"), line.indexOf("</div>"))).toBe("</ul>");
    // Drawn as the names are (an outline), in a box that keeps the 44px floor of its own.
    expect(/\.stu-sug-chip \{[^}]*border: 1px solid var\(--border-strong\);[^}]*border-radius: var\(--radius-pill\);/.exec(css)).not.toBeNull();
    // Its item is no pill of its own (the chip inside is): one outline, not two.
    expect(css).toMatch(/\.stu-sug-names li\.stu-sug-more \{\s*padding: 0;\s*border: 0;\s*\}/);
    expect(warmup).not.toContain("Add a move</button>");
    // The empty cool-down still lists its suggestions a row each, each with its own ＋.
    const cool = html.slice(html.indexOf('data-part="2"'));
    expect(cool).toContain('class="stu-sug-list"');
    // …and, its rows each adding one move, its own Add a move for any other.
    expect(cool).toContain("Add a move</button>");
  });
});

describe("Stage 2 whole-branch review: the 44 px floor and activation offered once (M6, M7)", () => {
  const css = readFileSync(fileURLToPath(new URL("../src/styles.css", import.meta.url)), "utf8");

  it("the Goals link is a 44 px box of its own; a part's name and a suggested name wear the app's pad, their rows granting it room", () => {
    expect(css).toMatch(/\.stu-build-goals-edit \{[^}]*display: inline-flex;[^}]*min-width: var\(--tap\);[^}]*min-height: var\(--tap\);/);
    const html = renderBuilder("/studio/build/new", { draft: draft(into(0, "catCow")) });
    // The part names and the suggested names are terms with the pad (44 px, clamped to what the row grants).
    expect(html).toMatch(/<span class="stu-part-name eyebrow"><span class="term-wrap"><button type="button" class="term tap-pad"/);
    const names = html.slice(html.indexOf('<ul class="stu-sug-names"'), html.indexOf("</ul>", html.indexOf('<ul class="stu-sug-names"')));
    expect((names.match(/class="term tap-pad"/g) ?? []).length).toBeGreaterThan(1);
    // …and the containers say how far a pad may reach: the names' rows part by exactly that much.
    expect(css).toMatch(/\.stu-sug-names \{[^}]*--tap-clear: var\(--space-5\);[^}]*gap: var\(--tap-clear\) var\(--space-2\);/);
    expect(css).toMatch(/\.stu-part-head \{[^}]*--tap-clear: var\(--space-5\);/);
  });

  it("while the activation prompt is shown, Add a part doesn't offer Activation a second time", () => {
    const withLift = renderBuilder("/studio/build/new", { draft: draft(into(1, "deadlift")) });
    expect(withLift).toContain("stu-part--ghost");
    const offered = text(withLift.slice(withLift.indexOf("stu-add-parts")));
    expect(offered).not.toContain("Activation");
    expect(offered).toContain("Power");
    // No prompt (no lift): Activation is one of the parts on offer.
    expect(text(renderBuilder("/studio/build/new").slice(renderBuilder("/studio/build/new").indexOf("stu-add-parts")))).toContain("Activation");
  });
});

describe("the day's advice to ease off (CUJ R15)", () => {
  it("a flare day's go-Recover stays in view on a phone, beside the errors; the other costs fold away", () => {
    const d = draft({ type: "setIntent", intent: { effort: "develop" } }, into(1, "proneYTW"));
    const html = renderBuilder("/studio/build/new", { draft: d, primed: { library: libraryDto({ tmj: true }), today: todayDto({ value: 6 }) } });
    // Folded, a phone's default…
    expect(html).toMatch(/class="stu-sum-body" hidden=""/);
    const body = html.indexOf('class="stu-sum-body"');
    // …and the advice is above the fold, with its Fix.
    const advice = html.indexOf("Jaw/head is at 6 right now.");
    expect(advice).toBeGreaterThan(-1);
    expect(advice).toBeLessThan(body);
    expect(html.split("Jaw/head is at 6 right now.").length - 1).toBe(1);
    expect(html.slice(advice, body)).toMatch(/<button[^>]*class="btn btn-small stu-note-fix"[^>]*>[^<]*Recover[^<]*<\/button>/);
    // A cost that isn't the day's advice still folds away.
    const inView = html.slice(html.indexOf('class="stu-sum"'), body);
    expect(text(html.slice(body))).toMatch(/flare/);
    expect(text(inView)).not.toMatch(/isn&#x27;t flare-safe|isn't flare-safe/);
  });
});

describe("the athlete's focus areas (CUJ R7)", () => {
  it("with nothing built yet, the cool-down suggests easing them, as the suggestions are told", () => {
    const d = draft();
    const profile = profileDto([{ id: "neck", refs: ["neck"] }]);
    const html = renderBuilder("/studio/build/new", { draft: d, primed: { profile } });
    const today = localTodayGuess();
    const want = (p?: typeof profile) => {
      const ctx = studioCtxFrom(undefined, undefined, placesDto(HOME_GEAR), p);
      const cool = d.parts.findIndex((x) => x.purpose === "cooldown");
      return suggestForPart(d, cool, EXERCISES, suggestCtxOf(buildCtxOf(ctx, today), today)).map((s) => EXERCISES.find((r) => r.id === s.libraryId)!.name);
    };
    const shown = parts(html).find((p) => p.name === "Cool-down")!.suggested;
    expect(want(profile)).not.toEqual(want());
    expect(shown).toEqual(want(profile).slice(0, shown.length));
    expect(shown.length).toBeGreaterThan(0);
  });
});
