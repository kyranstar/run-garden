/**
 * The coach's trail keeps what each tool gave back (design 2026-11-05 §6.4): a bounded copy of the result's data in the
 * tool_result event, so "Read 6 moves from your saves" opens to the six moves; nothing too big is ever kept as a cut
 * JSON head that would render as raw JSON.
 */
import { describe, expect, it } from "vitest";
import { bounded, EVENT_PAYLOAD_MAX_CHARS, toolResultPayload } from "../src/services/coach-runs.js";

describe("toolResultPayload", () => {
  it("keeps the result's data, its provenance and what was missing", () => {
    const data = { moves: [{ id: "myZorbexNod", name: "Zorbex nod", new: true }], routines: [], insights: [] };
    const p = toolResultPayload("read_saves", { offset: 0 }, { data, provenance: { source: "your saves", asOf: "x" }, missing: ["3 more"] }, true);
    expect(p).toMatchObject({ tool: "read_saves", ok: true, input: { offset: 0 }, data, missing: ["3 more"] });
  });
  it("data bigger than the coach was given says so: the coach saw it cut at 8 KB (final review)", () => {
    const big = { rows: "z".repeat(9_000) };
    expect(toolResultPayload("read_plan", {}, { data: big }, true)).toMatchObject({ data: big, cutForModel: true });
    expect(toolResultPayload("read_plan", {}, { data: { rows: "small" } }, true).cutForModel).toBeUndefined();
  });
  it("an input up to 8,000 characters is kept whole", () => {
    const input = { lines: "x".repeat(7_000) };
    expect(toolResultPayload("pin_moves", input, { data: null }, true).input).toEqual(input);
  });
});

describe("bounded", () => {
  it("a value over its cap says how big it was — never a cut head of JSON", () => {
    expect(EVENT_PAYLOAD_MAX_CHARS).toBe(16_000);
    expect(bounded({ a: "y".repeat(20_000) })).toEqual({ tooLong: true, chars: expect.any(Number) });
    expect(bounded({ a: 1 })).toEqual({ a: 1 });
  });
});
