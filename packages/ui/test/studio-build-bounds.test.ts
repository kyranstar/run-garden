/**
 * Stage 2 batch-end minors — `editRefusal`'s bounds are read from the schema only when a refusal needs them, and never
 * throw: a schema (or a zod) that no longer says a bound costs that one message its number, never the app its start.
 */
import { describe, expect, it, vi } from "vitest";

vi.mock("@rg/domain", async (importOriginal) => {
  const real = await importOriginal<typeof import("@rg/domain")>();
  // A part schema that no longer bounds rounds or a part's why — as a change to it, or to zod's internals, might leave it.
  return { ...real, partSchema: real.partSchema.omit({ rounds: true, why: true }) };
});

describe("editRefusal's bounds", () => {
  it("are read when a refusal needs them: the module loads without them, and the message falls back to plain words", async () => {
    const { editRefusal } = await import("../src/screens/studio/build-model.js");
    expect(editRefusal({ type: "setPart", part: 0, patch: { rounds: 99 } }, "invalid")).toBe("That number of rounds doesn't fit.");
    expect(editRefusal({ type: "setPart", part: 0, patch: { why: "x".repeat(400) } }, "invalid")).toBe("That why is too long.");
    // The bounds the schema still writes are said as before.
    expect(editRefusal({ type: "setIntent", intent: { goals: [] } }, "invalid")).toBe("A workout serves at most 6 goals.");
    expect(editRefusal({ type: "setPart", part: 0, patch: { restBetweenRoundsSec: 2000 } }, "invalid")).toBe("Rest between rounds goes up to 15 min.");
  });
});
