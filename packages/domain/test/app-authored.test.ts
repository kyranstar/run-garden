/**
 * THE ONE PREDICATE for the app's own sessions (ruling 2a-R4, extended by Stage 2 spec §10): a programme's slot, an
 * on-demand session, and a document workout made in the Studio or from a template. Every such row reaches the watch
 * only by the athlete's own Send, is never rewritten by the import, and books its calendar event through the
 * reconciler. Only the Studio's and a template's rows are document workouts (their content is their document).
 */
import { describe, expect, it } from "vitest";
import { APP_AUTHORED_ORIGINS, DOC_ORIGINS, appAuthoredRow, docOriginRow } from "../src/watch-address.js";

describe("appAuthoredRow / docOriginRow", () => {
  it("the app's own sessions: programme, on-demand, Studio and template", () => {
    expect([...APP_AUTHORED_ORIGINS]).toEqual(["program", "on_demand", "studio", "template"]);
    for (const origin of APP_AUTHORED_ORIGINS) expect(appAuthoredRow({ origin })).toBe(true);
    for (const origin of [null, "coros", "coach", "import", ""]) expect(appAuthoredRow({ origin })).toBe(false);
  });

  it("document workouts: only the Studio's and a template's", () => {
    expect([...DOC_ORIGINS]).toEqual(["studio", "template"]);
    expect(docOriginRow({ origin: "studio" })).toBe(true);
    expect(docOriginRow({ origin: "template" })).toBe(true);
    for (const origin of [null, "program", "on_demand", "coach", "coros"]) expect(docOriginRow({ origin })).toBe(false);
  });
});
