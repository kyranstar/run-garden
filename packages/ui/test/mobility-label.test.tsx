/**
 * "Mobility", not "Yoga" (the owner, 2026-10-16: "yoga is for yoga programs, this is mobility generally"). Wherever one
 * workout's kind is said, the yoga kind of a workout the app made is "Mobility": a programme's session (an outline
 * too), a Studio or template workout, the thread coach's session and the coach's designed one. An import — a yoga
 * session from COROS or a standalone file — keeps "Yoga". The internal category stays `yoga`, and the garden's
 * "Yoga & mobility" meadow is not one workout. Five surfaces, as they render:
 *  - the Plan's workout sheet, the Today card's line and the week strip's line read the workout row (the server's
 *    `appMade`, and its origin);
 *  - the builder's summary and the templates list read the document's source.
 */
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { describe, expect, it } from "vitest";
import type { TemplateDto, WorkoutDto } from "@rg/api-client";
import type { WorkoutDoc } from "@rg/domain";
import { EXERCISES } from "@rg/exercise-library";
import { deriveDoc } from "@rg/workout";
import { CATEGORY_LABELS, workoutKindLabel } from "../src/components.js";
import { landingUnlock, type CodexEntry } from "../src/screens/codex.js";
import { plannedLiteOf, TodayMeta, WeekPull } from "../src/screens/garden.js";
import { RunWorkoutDetail } from "../src/screens/plan.js";
import { SummaryCard } from "../src/screens/studio/summary-card.js";
import { TemplatesScreen } from "../src/screens/studio/templates.js";
import { templateFacts } from "../src/screens/studio/templates-model.js";
import { libraryDto, placesDto, primedClient, profileDto, staticRouter, text, todayDto, TODAY } from "./studio-fixtures.js";

// ── Workout rows, as the server sends them ──────────────────────────────────────────────────────────────────────────

const DAY = "2026-10-15"; // a Thursday

function row(over: Partial<WorkoutDto>): WorkoutDto {
  return {
    id: "w-1", title: "Evening session", category: "yoga", qualitySubtype: null, sport: "yoga",
    originalPlanDate: DAY, lastVerifiedCorosDate: "", effectiveDate: DAY, effectiveTime: "18:00",
    workoutSeconds: 1800, calendarSeconds: 1800, stageSummary: null, calendarSyncState: "synced", corosSyncState: "calendar_only",
    completionState: "scheduled", archived: false, origin: null, contentState: null, programId: null,
    ...over,
  } as WorkoutDto;
}

/** Every kind of workout the app makes, as its row reads — and the import, which it doesn't. */
const MADE: Array<[string, WorkoutDto]> = [
  ["a programme's outline", row({ id: "slot-p1-2026-10-15", origin: "program", contentState: "outline", programId: "p1", appMade: true })],
  ["a Studio workout", row({ id: "doc-1", origin: "studio", contentState: "outline", programId: "studio-p", appMade: true })],
  ["a template's workout", row({ id: "doc-2", origin: "template", contentState: "outline", programId: "studio-p", appMade: true })],
  ["the thread coach's session", row({ id: "cw-prop1-0-0", origin: null, appMade: true })],
  ["the coach's designed workout", row({ id: "doc-3", origin: "studio", contentState: "outline", programId: "studio-p", appMade: true })],
];
const IMPORTED = row({ id: "imp-1", origin: null, title: "Yoga flow", lastVerifiedCorosDate: DAY, corosSyncState: "synced" });

// ── Documents, as the Studio holds them ─────────────────────────────────────────────────────────────────────────────

/** A move that is mobility and nothing else: a document of it alone derives the yoga kind. */
const STRENGTHY = new Set(["strength", "power", "activation", "conditioning", "balance"]);
const MOBILITY_MOVE = EXERCISES.find((e) => e.purposes.includes("mobility") && !e.purposes.some((p) => STRENGTHY.has(p)))!;

const mobilityDoc = (source: WorkoutDoc["source"]): WorkoutDoc => ({
  version: 1, title: "Easy range", intent: { summary: "Easy range for the hips.", goals: [], focus: [], effort: "recover" },
  parts: [{ purpose: "main", format: "flow", items: [{ kind: "exercise", libraryId: MOBILITY_MOVE.id, dose: { holdSec: 60, sets: 3 } }] }],
  source,
});

const DOCS_MADE: Array<[string, WorkoutDoc["source"]]> = [
  ["a programme's build", { kind: "engine" }],
  ["a Studio workout", { kind: "studio" }],
  ["a template", { kind: "template" }],
  ["the thread coach's session", { kind: "coach" }],
  ["the coach's designed workout", { kind: "coach", ref: "run:r1" }],
  ["the athlete's own", { kind: "athlete" }],
];
const DOCS_IMPORTED: Array<[string, WorkoutDoc["source"]]> = [
  ["a COROS import", { kind: "coros_import", ref: "plan-1:7" }],
  ["a standalone import", { kind: "standalone_import" }],
];

const plain = (html: string) => html.replace(/<!-- -->/g, "");

describe("the one helper", () => {
  it("the yoga kind is Mobility for a workout the app made — by the server's word, its origin or its document's source", () => {
    expect(workoutKindLabel("yoga", { appMade: true })).toBe("Mobility");
    for (const origin of ["program", "on_demand", "studio", "template"]) expect(workoutKindLabel("yoga", { origin }), origin).toBe("Mobility");
    for (const [what, source] of DOCS_MADE) expect(workoutKindLabel("yoga", { docSource: source.kind }), what).toBe("Mobility");
  });

  it("an import keeps Yoga, and every other kind its own word", () => {
    expect(workoutKindLabel("yoga", {})).toBe("Yoga");
    expect(workoutKindLabel("yoga", { origin: null, appMade: false })).toBe("Yoga");
    for (const [what, source] of DOCS_IMPORTED) expect(workoutKindLabel("yoga", { docSource: source.kind }), what).toBe("Yoga");
    expect(workoutKindLabel("strength", { appMade: true })).toBe("Strength");
    expect(workoutKindLabel("easy", { appMade: true })).toBe("Easy");
    expect(workoutKindLabel("no-such-kind", { appMade: true })).toBeUndefined();
    // The words are the one map's (CATEGORY_LABELS), the internal category untouched.
    expect(CATEGORY_LABELS.yoga).toBe("Yoga");
    expect(CATEGORY_LABELS.mobility).toBe("Mobility");
  });
});

describe("the Plan's workout sheet", () => {
  const sheet = (w: WorkoutDto) => {
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } });
    qc.setQueryData(["settings"], { prefs: { units: "km" } });
    qc.setQueryData(["workout", w.id], { workout: w, stages: [], match: null });
    return plain(renderToStaticMarkup(createElement(QueryClientProvider, { client: qc }, createElement(MemoryRouter, null,
      createElement(RunWorkoutDetail, { w, today: "2026-10-14", corosWritesEnabled: false, onClose: () => undefined })))));
  };
  const kindOf = (html: string) => /<span class="category-dot cat-yoga"[^>]*><\/span><span class="muted">([^<]*)<\/span>/.exec(html)?.[1];

  it.each(MADE)("%s says Mobility", (_what, w) => expect(kindOf(sheet(w))).toBe("Mobility"));
  it("an imported yoga session says Yoga", () => expect(kindOf(sheet(IMPORTED))).toBe("Yoga"));
});

describe("the Today card's line", () => {
  const meta = (w: WorkoutDto) => plain(renderToStaticMarkup(createElement(TodayMeta, { w })));
  const kindOf = (html: string) => /<span class="category-dot cat-yoga"[^>]*><\/span> ([^<]*)<\/p>/.exec(html)?.[1];

  it.each(MADE)("%s says mobility", (_what, w) => expect(kindOf(meta(w))).toBe("mobility"));
  it("an imported yoga session says yoga", () => expect(kindOf(meta(IMPORTED))).toBe("yoga"));
});

describe("the week strip's line", () => {
  // Moon lotus arrives with the fifth yoga-kind session; four are done.
  const codex: CodexEntry[] = [{
    speciesId: "moon_lotus", name: "Moon lotus", category: "flower", rarity: "common", unlocked: false, hint: "",
    progress: { current: 4, target: 5 }, unlockedOn: null, livingCount: 0,
  }];
  const pull = (w: WorkoutDto) => {
    // The row as the strip reads it (`plannedLiteOf`), then the quest's walk (`landingUnlock`), then the line.
    const landing = landingUnlock(codex, [plannedLiteOf(w)], "2026-10-13");
    expect(landing).not.toBeNull();
    return plain(renderToStaticMarkup(createElement(WeekPull, { landing: landing!, onOpenSpecies: () => undefined })));
  };
  const kindOf = (html: string) => /<strong>Thursday’s ([^<]*)<\/strong>/.exec(html)?.[1];

  it.each(MADE)("%s says mobility", (_what, w) => expect(kindOf(pull(w))).toBe("mobility"));
  it("an imported yoga session says yoga", () => expect(kindOf(pull(IMPORTED))).toBe("yoga"));
});

describe("the builder's summary", () => {
  const summary = (doc: WorkoutDoc) => {
    const derived = deriveDoc(doc, EXERCISES);
    expect(derived.category).toBe("yoga");
    return plain(renderToStaticMarkup(createElement(SummaryCard, {
      judged: { doc, derived, notes: [], blocked: null, checks: [] }, place: "Home", open: false,
      onToggle: () => undefined, onFix: () => undefined, onCheck: () => undefined, checkLabel: () => "",
    })));
  };
  const lineOf = (html: string) => /<span class="stu-sum-line">([^<]*)<\/span>/.exec(html)?.[1];

  it.each(DOCS_MADE)("%s says Mobility", (_what, source) => expect(lineOf(summary(mobilityDoc(source)))).toMatch(/^\d+ min · Mobility · Home$/));
  it.each(DOCS_IMPORTED)("%s says Yoga", (_what, source) => expect(lineOf(summary(mobilityDoc(source)))).toMatch(/^\d+ min · Yoga · Home$/));
});

describe("the templates list", () => {
  const tpl = (id: string, source: WorkoutDoc["source"]): TemplateDto => ({
    id, name: `Template ${id}`, doc: mobilityDoc(source), pinned: false, uses: 0, lastUsedAt: null,
    createdAt: "2026-10-01T12:00:00.000Z", updatedAt: "2026-10-01T12:00:00.000Z", minutes: 15, discipline: "yoga",
  });
  const list = (templates: TemplateDto[]) => {
    const qc = primedClient({ places: placesDto(["mat"]), today: todayDto(null, false), library: libraryDto(), profile: profileDto() });
    qc.setQueryData(["templates"], { templates });
    return renderToStaticMarkup(createElement(QueryClientProvider, { client: qc }, staticRouter("/studio/templates", createElement(TemplatesScreen))));
  };
  const rowFacts = (html: string) => [...html.matchAll(/<li class="stu-tpl[^"]*"[\s\S]*?<\/li>/g)].map((m) => text(m[0]));

  it("every template the app made says Mobility; an imported one says Yoga — on the row and in its facts", () => {
    const made = DOCS_MADE.map(([, source], i) => tpl(`m${i}`, source));
    const imported = DOCS_IMPORTED.map(([, source], i) => tpl(`i${i}`, source));
    for (const t of made) expect(templateFacts(t, TODAY), t.doc!.source.kind).toEqual(["15 min", "Mobility", "Not used yet"]);
    for (const t of imported) expect(templateFacts(t, TODAY), t.doc!.source.kind).toEqual(["15 min", "Yoga", "Not used yet"]);
    const rows = rowFacts(list([...made, ...imported]));
    expect(rows).toHaveLength(made.length + imported.length);
    expect(rows.filter((r) => r.includes("15 min · Mobility ·"))).toHaveLength(made.length);
    expect(rows.filter((r) => r.includes("15 min · Yoga ·"))).toHaveLength(imported.length);
  });
});
