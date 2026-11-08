import { describe, expect, it } from "vitest";
import { PROFILES, TMJ } from "../src/index.js";

// A profile's daytime cue: the few words a calendar reminder carries as its title through the day (condition care
// gaps, Task 3). The words live on the profile, so no worker or screen code holds them.

describe("every profile's daytime cue", () => {
  it.each(Object.values(PROFILES).map((p) => [p.id, p] as const))("%s: none, or a few words on one line", (_id, p) => {
    if (p.cue === undefined) return;
    expect(p.cue.trim()).toBe(p.cue);
    expect(p.cue.length).toBeGreaterThan(0);
    expect(p.cue.length).toBeLessThanOrEqual(40);
    expect(p.cue).not.toMatch(/[\n\r]/);
  });
});

describe("the TMJ cue", () => {
  it("is the profile's own words", () => {
    expect(TMJ.cue).toBe("Teeth apart, jaw soft");
  });
});
