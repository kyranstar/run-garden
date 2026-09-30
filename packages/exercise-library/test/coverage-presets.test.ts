import { expect, test } from "vitest";
import {
  EXERCISES, LOCATION_PRESETS, MODE_IDS, coreFamilyOf, coverageProblems, eligible, flareSafe, makeEngineData, type EngineData,
} from "../src/index.js";

// Ported from the standalone tests/data.test.js: every block a mode uses must have real choices at every
// location preset — with TMJ both active and cared for.

const data = makeEngineData({ activeProfiles: ["tmj"], careProfiles: ["tmj"], exercises: EXERCISES });

for (const loc of LOCATION_PRESETS) {
  for (const mode of MODE_IDS) {
    test(`coverage: ${loc.name} × ${mode}`, () => {
      const ok = EXERCISES.filter(ex => eligible(data, ex, { equipment: loc.equipment, mode }));
      for (const [block, share] of Object.entries(data.skeleton.shares[mode])) {
        if (!share || block === "core") continue;
        const roles = data.skeleton.blocks[block as "care"]?.roles ?? [];
        const n = ok.filter(ex => ex.roles.some(r => roles.includes(r))).length;
        expect(n, `${block} has ${n} candidates`).toBeGreaterThanOrEqual(3);
      }
      if (data.modes[mode].coreCount[1]) {
        for (const fam of data.coreFamilies) {
          const n = ok.filter(ex => coreFamilyOf(data, ex) === fam.id).length;
          expect(n, `core family ${fam.id} has no option`).toBeGreaterThanOrEqual(1);
        }
      }
      if (mode === "recovery") for (const ex of ok) expect(flareSafe(data, ex), `${ex.id} is not flare-safe`).toBe(true);
    });
  }
}

test("coverage also holds with TMJ active but not cared for, and with no profile at all", () => {
  const variants: Array<[string, EngineData]> = [
    ["active only", makeEngineData({ activeProfiles: ["tmj"], careProfiles: [], exercises: EXERCISES })],
    ["no profile", makeEngineData({ activeProfiles: [], careProfiles: [], exercises: EXERCISES })],
  ];
  for (const [name, d] of variants) {
    for (const loc of LOCATION_PRESETS) for (const mode of MODE_IDS) expect(coverageProblems(d, loc, mode), `${name} ${loc.id} ${mode}`).toEqual([]);
  }
});
