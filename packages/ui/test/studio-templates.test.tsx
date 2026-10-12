/**
 * Stage 2 Task 7 — templates and instant quick starts (spec §3, §9), as they render:
 *
 *  - `/studio/templates`: name, minutes, kind, last used; pinned first (said in words, not colour); each name opens the
 *    builder; Start on every template that can be opened; the rest (Schedule, Rename, Pin, Delete) one tap down.
 *  - the home: the quick starts are links to the builder, pre-filled — condition care only while a profile with care
 *    is on — then the athlete's pinned templates and a "Yours" tile; "Templates (n)" beside "New workout".
 *  - `/studio/build/quick/:kind`: the builder, pre-filled on arrival from the bundled library (no network), with Start
 *    now in reach; a quick start that can't be built says why in plain words.
 */
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { QueryClientProvider } from "@tanstack/react-query";
import { describe, expect, it } from "vitest";
import type { TemplateDto } from "@rg/api-client";
import { EXERCISES } from "@rg/exercise-library";
import { edit, newDoc, startEditing, suggestedItem, toProposable } from "@rg/workout";
import { features } from "../src/features.js";
import { BuilderRoute } from "../src/screens/studio/builder.js";
import { StudioScreen } from "../src/screens/studio/screen.js";
import { TemplatesScreen } from "../src/screens/studio/templates.js";
import { emptyStudioCtx } from "../src/screens/studio/model.js";
import { quickStartFor } from "../src/screens/studio/templates-model.js";
import { libraryDto, placesDto, primedClient, staticRouter, text, todayDto, TODAY, type Primed } from "./studio-fixtures.js";

const goblet = () =>
  toProposable(
    edit(startEditing(newDoc("structured", { title: "Legs", source: { kind: "studio" } })), {
      type: "addItem",
      part: 1,
      item: suggestedItem(EXERCISES.find((r) => r.id === "gobletSquat")!, "main"),
    }, EXERCISES).doc,
  )!;

function tpl(id: string, name: string, over: Partial<TemplateDto> = {}): TemplateDto {
  return {
    id,
    name,
    doc: goblet(),
    pinned: false,
    uses: 0,
    lastUsedAt: null,
    createdAt: "2026-10-01T12:00:00.000Z",
    updatedAt: "2026-10-01T12:00:00.000Z",
    minutes: 14,
    discipline: "strength",
    ...over,
  };
}

const TEMPLATES = [
  tpl("t-old", "Old favourite", { lastUsedAt: "2026-09-20T12:00:00.000Z" }),
  tpl("t-pin", "Hips & posture", { pinned: true, lastUsedAt: "2026-10-08T12:00:00.000Z" }),
  tpl("t-broken", "Broken one", { doc: null, minutes: null, discipline: null }),
  tpl("t-new", "Never used"),
];

function renderAt(path: string, el: React.ReactElement, p: Primed & { templates?: TemplateDto[] } = {}): string {
  const qc = primedClient({ places: placesDto(["mat", "kettlebell", "dumbbells", "bench", "chair", "band", "wall"]), today: todayDto(null, false), library: libraryDto(), ...p });
  if (p.templates) qc.setQueryData(["templates"], { templates: p.templates });
  return renderToStaticMarkup(createElement(QueryClientProvider, { client: qc }, staticRouter(path, el)));
}

const rows = (html: string) => [...html.matchAll(/<li class="stu-tpl[^"]*"[\s\S]*?<\/li>/g)].map((m) => m[0]);

describe("the templates list", () => {
  const list = () => renderAt("/studio/templates", createElement(TemplatesScreen), { templates: TEMPLATES });

  it("is a page titled Templates, its way back the Studio", () => {
    const html = list();
    expect(html).toContain(">Templates</h1>");
    expect(html).toMatch(/<a class="btn stu-build-back" href="\/studio">[\s\S]*?Studio<\/a>/);
  });

  it("lists pinned first, then the most recently used, then the rest by name", () => {
    const names = rows(list()).map((r) => /class="stu-tpl-open"[^>]*>([^<]*)</.exec(r)![1]);
    expect(names).toEqual(["Hips &amp; posture", "Old favourite", "Broken one", "Never used"]);
  });

  it("each row: its name opens the builder; minutes, kind, last used; a pin is said in words", () => {
    const [pinned, old] = rows(list());
    expect(pinned).toContain('href="/studio/build/template/t-pin"');
    expect(text(pinned!)).toMatch(/Pinned · \d+ min · Strength · Used 3 days ago/);
    expect(text(old!)).toMatch(/^Old favourite \d+ min · Strength · Used 21 days ago/);
    expect(text(old!)).not.toContain("Pinned");
  });

  it("Start on each template that can be opened; the other actions one tap down, named for the template", () => {
    const r = rows(list());
    expect(r[0]).toMatch(/<button type="button" class="btn stu-tpl-start">Start<\/button>/);
    expect(r[0]).toContain('aria-label="Hips &amp; posture: more"');
    // One that no longer reads can't be started (or opened), but can still be renamed or deleted.
    const broken = r[2]!;
    expect(text(broken)).toContain("Can't be opened");
    expect(broken).not.toContain("stu-tpl-start");
    expect(broken).toContain('aria-label="Broken one: more"');
  });

  it("with the player off, nothing offers to Start", () => {
    features.player = false;
    try {
      expect(list()).not.toContain("stu-tpl-start");
    } finally {
      features.player = true;
    }
  });

  it("with none yet, it says so and offers a new workout", () => {
    const html = renderAt("/studio/templates", createElement(TemplatesScreen), { templates: [] });
    expect(text(html)).toContain("No templates yet");
    expect(html).toMatch(/<a class="btn btn-primary[^"]*" href="\/studio\/build\/new">/);
    expect(html).not.toContain("stu-tpl-list");
  });
});

describe("the home's quick starts", () => {
  /** The quick starts' section, up to its end. */
  const quick = (p: Parameters<typeof renderAt>[2] = {}) => {
    const html = renderAt("/studio", createElement(StudioScreen), p);
    const at = html.indexOf(">Quick starts</h2>");
    return html.slice(at, html.indexOf("</section>", at));
  };
  const tiles = (html: string) => [...html.matchAll(/<a class="stu-qs[^"]*" href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/g)].map((m) => [m[1]!, text(m[2]!)]);

  it("every tile is a link to the builder, pre-filled; condition care only while a profile with care is on", () => {
    expect(tiles(quick())).toEqual([
      ["/studio/build/quick/desk_reset", "Desk reset 8 min"],
      ["/studio/build/quick/hip_opener", "Hip opener 10 min"],
      // Its visible word, then what it opens for a screen reader.
      ["/studio/templates", "Yours : your templates"],
    ]);
    const cared = tiles(quick({ library: libraryDto({ tmj: true }) }));
    expect(cared[0]).toEqual(["/studio/build/quick/condition_care", "Jaw care 5 min"]);
    expect(cared).toHaveLength(4);
  });

  it("the athlete's pinned templates follow, then Yours, which opens the templates", () => {
    const t = tiles(quick({ templates: TEMPLATES }));
    expect(t.map(([href]) => href)).toEqual([
      "/studio/build/quick/desk_reset",
      "/studio/build/quick/hip_opener",
      "/studio/build/template/t-pin",
      "/studio/templates",
    ]);
    expect(t[2]![1]).toMatch(/^Hips & posture 14 min$/);
    // Yours is named for what it opens, its visible word first.
    expect(quick()).toMatch(/<a class="stu-qs stu-qs--yours" href="\/studio\/templates">[\s\S]*Yours<span class="visually-hidden">: your templates<\/span><\/a>/);
  });

  it("Templates, with how many, sits beside New workout", () => {
    const html = renderAt("/studio", createElement(StudioScreen), { templates: TEMPLATES });
    const rowOf = (h: string) => {
      const at = h.indexOf('class="stu-build-row"');
      expect(at).toBeGreaterThan(-1);
      return h.slice(at, h.indexOf("<section", at));
    };
    const row = rowOf(html);
    expect(row.indexOf("/studio/build/new")).toBeLessThan(row.indexOf('href="/studio/templates"'));
    expect(text(row)).toMatch(/New workout Templates \(4\)$/);
    // Before the list is read: no count yet, the link the same.
    expect(text(rowOf(renderAt("/studio", createElement(StudioScreen))))).toMatch(/New workout Templates$/);
  });
});

describe("a quick start in the builder", () => {
  const at = (kind: string, p: Primed = {}) => renderAt(`/studio/build/quick/${kind}`, createElement(BuilderRoute), p);

  it("opens pre-filled on arrival, from the bundled library, with Start now in reach", () => {
    const html = at("hip_opener");
    const made = quickStartFor("hip_opener", { ...emptyStudioCtx, today: TODAY, place: { name: "Home", equipment: ["mat", "kettlebell", "dumbbells", "bench", "chair", "band", "wall"] } }, TODAY);
    if (!("doc" in made)) throw new Error(made.reason);
    expect(html).toContain(`value="${made.doc.title}"`);
    const names = [...html.matchAll(/<span class="stu-item-name">([^<]*)/g)].map((m) => m[1]);
    const want = made.doc.parts.flatMap((p) => p.items.map((i) => (i.kind === "exercise" ? EXERCISES.find((r) => r.id === i.libraryId)!.name : "")));
    expect(names).toEqual(want);
    expect(names.length).toBeGreaterThan(1);
    // Start now is on, in the pinned actions.
    expect(html).toMatch(/<button type="button" class="btn btn-primary stu-build-start">Start now<\/button>/);
  });

  it("waits for what it is judged with rather than building a different workout first", () => {
    // Nothing read yet: no workout is shown that the reads could change.
    const qc = primedClient({});
    const html = renderToStaticMarkup(createElement(QueryClientProvider, { client: qc }, staticRouter("/studio/build/quick/desk_reset", createElement(BuilderRoute))));
    expect(html).not.toContain("stu-item-name");
    expect(html).toContain("Opening the workout");
  });

  it("a quick start that can't be built says why in plain words, and the way back", () => {
    const html = at("condition_care");
    expect(text(html)).toContain("Condition care needs a condition profile with care switched on.");
    expect(html).toMatch(/<a class="btn" href="\/studio">Back to the Studio<\/a>/);
    expect(html).not.toContain("stu-build-start");
  });

  it("condition care, with the profile on, is the profile's own care", () => {
    const html = at("condition_care", { library: libraryDto({ tmj: true }), today: todayDto({ value: 2 }) });
    expect(html).toContain('value="Jaw care"');
    expect(html).toContain("stu-build-start");
  });
});
