/**
 * Stage 2 Task 7 — templates and quick starts, pure (spec §9): the list's order (pinned first), a row's facts, the
 * home's tiles (condition care only with a profile with care on; the athlete's pinned templates after the built-in
 * ones), a quick start built on the device and seeded by the day, and the builder's address for one.
 */
import { describe, expect, it } from "vitest";
import type { TemplateDto } from "@rg/api-client";
import { PROFILES } from "@rg/exercise-library";
import { deriveDoc, newDoc, suggestedItem, edit, startEditing, toProposable, type QuickStartKind } from "@rg/workout";
import { EXERCISES } from "@rg/exercise-library";
import { quickKindOf, sourceKey, sourceOfPath } from "../src/screens/studio/build-model.js";
import { emptyStudioCtx, type StudioCtx } from "../src/screens/studio/model.js";
import { CATEGORY_LABELS } from "../src/components.js";
import { builderBack } from "../src/screens/studio/templates-model.js";
import {
  daySeed,
  lastUsedText,
  quickHref,
  quickStartFor,
  quickTiles,
  sortTemplates,
  templateFacts,
  templateHref,
} from "../src/screens/studio/templates-model.js";

const TODAY = "2026-10-11";
const doc = () =>
  toProposable(
    edit(startEditing(newDoc("structured", { title: "Hips & posture", source: { kind: "studio" } })), {
      type: "addItem",
      part: 1,
      item: suggestedItem(EXERCISES.find((r) => r.id === "gobletSquat")!, "main"),
    }, EXERCISES).doc,
  )!;

function tpl(id: string, over: Partial<TemplateDto> = {}): TemplateDto {
  return {
    id,
    name: id,
    doc: doc(),
    pinned: false,
    uses: 0,
    lastUsedAt: null,
    createdAt: "2026-10-01T12:00:00.000Z",
    updatedAt: "2026-10-01T12:00:00.000Z",
    minutes: 20,
    discipline: "strength",
    ...over,
  };
}

const withTmj: StudioCtx = { ...emptyStudioCtx, profiles: [PROFILES.tmj], today: TODAY };

describe("the templates list's order", () => {
  it("pinned first, then the most recently used, never-used last, then by name", () => {
    const list = [
      tpl("Zebra", { lastUsedAt: null }),
      tpl("Old", { lastUsedAt: "2026-09-01T12:00:00.000Z" }),
      tpl("Pinned B", { pinned: true }),
      tpl("Recent", { lastUsedAt: "2026-10-10T12:00:00.000Z" }),
      tpl("Apple", { lastUsedAt: null }),
      tpl("Pinned A", { pinned: true, lastUsedAt: "2026-10-02T12:00:00.000Z" }),
    ];
    expect(sortTemplates(list).map((t) => t.id)).toEqual(["Pinned A", "Pinned B", "Recent", "Old", "Apple", "Zebra"]);
    // The caller's array is left as it was.
    expect(list[0]!.id).toBe("Zebra");
  });
});

describe("a template's row", () => {
  it("says its minutes, its kind and when it was last used", () => {
    const facts = templateFacts(tpl("a", { lastUsedAt: "2026-10-08T12:00:00.000Z" }), TODAY);
    expect(facts).toEqual(["20 min", "Strength", "Used 3 days ago"]);
  });

  it("its minutes and kind are the server's, as the home's tile says them — not worked out again here", () => {
    // The document is a goblet squat (a strength workout of another length): the server's numbers are what is said.
    expect(templateFacts(tpl("a", { minutes: 34, discipline: "yoga" }), TODAY)).toEqual(["34 min", "Yoga", "Not used yet"]);
    expect(templateFacts(tpl("a", { minutes: 45, discipline: "run" }), TODAY)).toEqual(["45 min", "Run", "Not used yet"]);
    // One map says a kind's word, the builder's summary's too (CATEGORY_LABELS): rename a kind there, and it is renamed here.
    const was = CATEGORY_LABELS.yoga;
    CATEGORY_LABELS.yoga = "Mobility";
    try {
      expect(templateFacts(tpl("a", { minutes: 34, discipline: "yoga" }), TODAY)).toEqual(["34 min", "Mobility", "Not used yet"]);
    } finally {
      CATEGORY_LABELS.yoga = was!;
    }
    // Only a row the server said nothing of is worked out on the device.
    const derived = templateFacts(tpl("a", { minutes: null, discipline: null }), TODAY);
    expect(derived[0]).toMatch(/^\d+ min$/);
    expect(derived[0]).not.toBe("20 min");
    expect(derived[1]).toBe("Strength");
    // What the server did say is kept; only the rest is worked out.
    expect(templateFacts(tpl("a", { minutes: 34, discipline: null }), TODAY)).toEqual(["34 min", "Strength", "Not used yet"]);
  });

  it("with the server's numbers, the document is not read again on the device (no derive per row per render)", () => {
    // A document this device could not derive from: the row still says the server's numbers.
    const unreadable = { parts: null } as unknown as TemplateDto["doc"];
    expect(templateFacts(tpl("a", { doc: unreadable, minutes: 12, discipline: "strength" }), TODAY)).toEqual(["12 min", "Strength", "Not used yet"]);
  });

  it("a template whose document no longer reads says it can't be opened", () => {
    expect(templateFacts(tpl("a", { doc: null }), TODAY)).toEqual(["Can't be opened"]);
  });

  it("last used: today, yesterday, days ago, a date past two months, or not yet", () => {
    expect(lastUsedText(null, TODAY)).toBe("Not used yet");
    expect(lastUsedText("2026-10-11T12:00:00.000Z", TODAY)).toBe("Used today");
    expect(lastUsedText("2026-10-10T12:00:00.000Z", TODAY)).toBe("Used yesterday");
    expect(lastUsedText("2026-09-12T12:00:00.000Z", TODAY)).toBe("Used 29 days ago");
    expect(lastUsedText("2026-08-02T12:00:00.000Z", TODAY)).toBe("Used Aug 2");
    expect(lastUsedText("not a date", TODAY)).toBe("Not used yet");
  });
});

describe("the home's quick starts", () => {
  it("desk reset and hip opener, each a link to the builder; condition care only with a profile with care on", () => {
    const plain = quickTiles({ ...emptyStudioCtx, today: TODAY });
    expect(plain.map((t) => [t.title, t.href])).toEqual([
      ["Desk reset", "/studio/build/quick/desk_reset"],
      ["Hip opener", "/studio/build/quick/hip_opener"],
    ]);
    const cared = quickTiles(withTmj);
    expect(cared[0]!.href).toBe("/studio/build/quick/condition_care");
    expect(cared[0]!.title).toBe("Jaw care");
    expect(cared).toHaveLength(3);
  });

  it("then the athlete's pinned templates that can be opened, pinned order; never an unpinned or unreadable one", () => {
    const tiles = quickTiles({ ...emptyStudioCtx, today: TODAY }, [
      tpl("t1", { name: "Not pinned" }),
      tpl("t2", { name: "Pinned later", pinned: true, minutes: 25 }),
      tpl("t3", { name: "Pinned recent", pinned: true, minutes: 12, lastUsedAt: "2026-10-10T12:00:00.000Z" }),
      tpl("t4", { name: "Broken", pinned: true, doc: null }),
    ]);
    expect(tiles.slice(2).map((t) => [t.title, t.minutes, t.href])).toEqual([
      ["Pinned recent", 12, "/studio/build/template/t3"],
      ["Pinned later", 25, "/studio/build/template/t2"],
    ]);
  });

  it("a pinned template's minutes are the list's: the server's, else worked out from its document", () => {
    const t = tpl("t1", { name: "Said nothing", pinned: true, minutes: null, discipline: null });
    const [tile] = quickTiles(emptyStudioCtx, [t]).slice(2);
    expect(tile!.minutes).not.toBeNull();
    expect(`${tile!.minutes} min`).toBe(templateFacts(t, TODAY)[0]);
  });
});

describe("a quick start, built on the device", () => {
  const kinds: QuickStartKind[] = ["desk_reset", "hip_opener"];

  it("is the same workout all day, and a different one on another day", () => {
    for (const kind of kinds) {
      const a = quickStartFor(kind, { ...emptyStudioCtx, today: TODAY }, TODAY);
      const b = quickStartFor(kind, { ...emptyStudioCtx, today: TODAY }, TODAY);
      expect(a).toEqual(b);
      expect("doc" in a).toBe(true);
    }
    // Over a week, each tile gives more than one workout.
    for (const kind of kinds) {
      const days = ["2026-10-11", "2026-10-12", "2026-10-13", "2026-10-14", "2026-10-15", "2026-10-16", "2026-10-17"];
      const seen = new Set(days.map((d) => JSON.stringify(quickStartFor(kind, { ...emptyStudioCtx, today: d }, d))));
      expect(seen.size, kind).toBeGreaterThan(1);
    }
    expect(daySeed("2026-10-11")).toBe(20261011);
  });

  it("condition care is built with the profile on, and says why not without one", () => {
    const made = quickStartFor("condition_care", withTmj, TODAY);
    expect("doc" in made && made.doc.parts.length).toBeTruthy();
    const none = quickStartFor("condition_care", emptyStudioCtx, TODAY);
    expect("reason" in none && none.reason).toMatch(/condition profile/);
  });

  it("leaves out the moves the athlete set aside", () => {
    const first = quickStartFor("hip_opener", { ...emptyStudioCtx, today: TODAY }, TODAY);
    const ids = "doc" in first ? first.doc.parts.flatMap((p) => p.items.flatMap((i) => (i.kind === "exercise" ? [i.libraryId] : []))) : [];
    expect(ids.length).toBeGreaterThan(0);
    const prefs = new Map(ids.map((id) => [id, { rating: null, pinned: false, excluded: true, lastDoneOn: null, timesDone30d: 0, doneCleanly: false }] as const));
    const again = quickStartFor("hip_opener", { ...emptyStudioCtx, today: TODAY, prefs }, TODAY);
    const now = "doc" in again ? again.doc.parts.flatMap((p) => p.items.flatMap((i) => (i.kind === "exercise" ? [i.libraryId] : []))) : [];
    for (const id of ids) expect(now).not.toContain(id);
  });
});

describe("the builder's address for a quick start", () => {
  it("/studio/build/quick/:kind for a kind there is; anything else is no address", () => {
    expect(quickHref("hip_opener")).toBe("/studio/build/quick/hip_opener");
    expect(sourceOfPath("/studio/build/quick/hip_opener")).toEqual({ kind: "quick", quick: "hip_opener" });
    expect(sourceOfPath("/studio/build/quick/condition_care/")).toEqual({ kind: "quick", quick: "condition_care" });
    expect(sourceOfPath("/studio/build/quick/jumping_jacks")).toBeNull();
    expect(sourceOfPath("/studio/build/quick")).toBeNull();
    expect(sourceKey({ kind: "quick", quick: "desk_reset" })).toBe("quick:desk_reset");
    expect(quickKindOf("desk_reset")).toBe("desk_reset");
    expect(quickKindOf("nope")).toBeNull();
    expect(templateHref("a b")).toBe("/studio/build/template/a%20b");
  });
});

describe("the builder's way back (Stage 2 whole-branch review I1, M9)", () => {
  it("goes where it was opened from: the templates list, Plan, Today, a Studio search or move — else the Studio", () => {
    expect(builderBack("templates")).toEqual({ href: "/studio/templates", label: "Templates" });
    expect(builderBack("plan")).toEqual({ href: "/plan", label: "Plan" });
    // The nav's own word for that screen (re-review N7).
    expect(builderBack("today")).toEqual({ href: "/", label: "Garden" });
    expect(builderBack({ href: "/studio?q=goblet" })).toEqual({ href: "/studio?q=goblet", label: "Studio" });
    expect(builderBack({ href: "/studio/move/gobletSquat?q=goblet" })).toEqual({ href: "/studio/move/gobletSquat?q=goblet", label: "Studio" });
    // Only a Studio address: anything else the history state might hold goes to the Studio's home.
    expect(builderBack({ href: "https://example.com/studio" })).toEqual({ href: "/studio", label: "Studio" });
    expect(builderBack({ href: "/settings" })).toEqual({ href: "/studio", label: "Studio" });
    expect(builderBack(undefined)).toEqual({ href: "/studio", label: "Studio" });
  });
});

describe("one workout, one length, on every screen (Stage 2 whole-branch review I4)", () => {
  it("a quick start's tile, the builder, the templates list (saved as one) and Plan and Today (its row) say the same minutes", async () => {
    const { formatMinutes } = await import("../src/components.js");
    const { judgeDraft, buildCtxOf } = await import("../src/screens/studio/build-model.js");
    const ctx = { ...emptyStudioCtx, today: TODAY };
    for (const tile of quickTiles(ctx)) {
      const kind = tile.key as QuickStartKind;
      const made = quickStartFor(kind, ctx, TODAY);
      if (!("doc" in made)) throw new Error(made.reason);
      // The builder: the workout as it opens there.
      const builder = judgeDraft(startEditing(made.doc).doc, buildCtxOf(ctx, TODAY), TODAY).derived!.estimatedMinutes;
      // The tile: the very workout it opens, not a nominal length.
      expect(tile.minutes, kind).toBe(builder);
      // Saved as a template: the list says the server's minutes, derived the same way.
      const saved = tpl("t", { doc: made.doc, minutes: deriveDoc(made.doc, EXERCISES).estimatedMinutes });
      expect(templateFacts(saved, TODAY)[0], kind).toBe(`${builder} min`);
      // Started or scheduled: Plan and Today say its row's length — the derived minutes the server stores (I4).
      expect(formatMinutes(builder * 60), kind).toBe(`${builder} min`);
    }
  });
});
