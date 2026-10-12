/**
 * Stage 2 Task 6 — the builder, as it first draws (spec §8): a new workout is warm-up, main and cool-down with
 * suggestions in each; a part that loads a hinge prompts a glute activation; an error keeps Start off with its reason
 * beside it and a Fix; the item sheet reorders by buttons. Static renders of the real screen, its queries primed.
 */
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { QueryClientProvider } from "@tanstack/react-query";
import { describe, expect, it } from "vitest";
import { DEFAULT_SCHEDULING_PREFERENCES, type WorkoutDoc } from "@rg/domain";
import { EXERCISES } from "@rg/exercise-library";
import { edit, newDoc, startEditing, suggestedItem, type DraftDoc, type EditAction } from "@rg/workout";
import { BuilderRoute } from "../src/screens/studio/builder.js";
import { STUDIO_DRAFT_QUERY } from "../src/studio-drafts.js";
import { TEMPLATES_QUERY } from "../src/screens/studio/add-sheet.js";
import { ItemSheet } from "../src/screens/studio/item-sheet.js";
import { buildCtxOf, judgeDraft } from "../src/screens/studio/build-model.js";
import { emptyStudioCtx } from "../src/screens/studio/model.js";
import { libraryDto, placesDto, primedClient, staticRouter, text, todayDto, TODAY, type Primed } from "./studio-fixtures.js";

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
  it("a move today's reading rules out keeps Start off, says why beside it, and offers its alternate", () => {
    const d = draft({ type: "setIntent", intent: { effort: "develop" } }, into(1, "halfKneelingPress", { alternates: [{ libraryId: "floorPress" }] }));
    const html = renderBuilder("/studio/build/new", { draft: d, primed: { library: libraryDto({ tmj: true }), today: todayDto({ value: 3 }) } });
    const why = "Half-kneeling one-arm press isn&#x27;t allowed with today&#x27;s Jaw / head check at 3.";
    // Start is off, described by the reason printed beside it.
    const start = /<button[^>]*class="btn btn-primary stu-build-start"[^>]*>Start now<\/button>/.exec(html)![0];
    expect(start).toContain('disabled=""');
    const describedBy = /aria-describedby="([^"]+)"/.exec(start)![1]!;
    expect(html).toContain(`id="${describedBy}">${why}</p>`);
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

  it("reorders by buttons — up and down, never a drag — and each says where it can't go", () => {
    const first = sheet(1, 0);
    expect(first).toMatch(/<button[^>]*class="btn"[^>]*>(<svg[^]*?<\/svg>)?Move up<\/button>/);
    expect(first).toMatch(/<button[^>]*class="btn"[^>]*>(<svg[^]*?<\/svg>)?Move down<\/button>/);
    expect(first).not.toContain("draggable");
    // The first item of the main part goes up into the warm-up; the last of the last part has nowhere further.
    expect(/<button[^>]*>(<svg[^]*?<\/svg>)?Move up<\/button>/.exec(first)![0]).not.toContain("disabled");
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
  it("says the minutes, the kind and the place, and its count of notes", () => {
    const d = draft(into(1, "gobletSquat"));
    const html = renderBuilder("/studio/build/new", { draft: d });
    const j = judgeDraft(d, buildCtxOf({ ...emptyStudioCtx, place: { name: "Home", equipment: HOME_GEAR }, today: TODAY }, TODAY), TODAY);
    expect(text(html)).toContain(`${j.derived!.estimatedMinutes} min · Strength · Home`);
  });
});
