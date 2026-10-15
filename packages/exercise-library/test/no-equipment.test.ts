/**
 * "No equipment" (the Studio's place chip, a document's `setting.placeId` "none"): bodyweight plus what any room has —
 * its walls, a chair, the floor (a mat or a towel on it), a towel. A hotel room has all of them; nothing is brought.
 * One definition, read by the app and the server alike.
 */
import { describe, expect, it } from "vitest";
import { EQUIPMENT, EQUIPMENT_IDS, EXERCISES, hasEquipment, LOCATION_PRESETS, NO_EQUIPMENT_GEAR, NO_EQUIPMENT_PLACE_ID, noEquipmentPlace } from "../src/index.js";

describe("No equipment", () => {
  it("is the room's own props, words of the vocabulary: a wall, a chair, the floor's mat, a towel — no gear one brings", () => {
    expect([...NO_EQUIPMENT_GEAR].sort()).toEqual(["chair", "mat", "towel", "wall"]);
    for (const id of NO_EQUIPMENT_GEAR) expect(EQUIPMENT_IDS).toContain(id);
    // Nothing a bare room lacks: every one is in the barest preset too ("Mat only").
    const matOnly = LOCATION_PRESETS.find((p) => p.id === "mat")!;
    for (const id of NO_EQUIPMENT_GEAR) expect(matOnly.equipment).toContain(id);
    expect(NO_EQUIPMENT_GEAR.map((id) => EQUIPMENT[id])).not.toContain(undefined);
  });

  it('is the place "none", named "No equipment", with those props', () => {
    expect(NO_EQUIPMENT_PLACE_ID).toBe("none");
    expect(noEquipmentPlace()).toEqual({ id: "none", name: "No equipment", equipment: NO_EQUIPMENT_GEAR });
    // A fresh one each time: a caller that changes its copy changes no one else's.
    expect(noEquipmentPlace()).not.toBe(noEquipmentPlace());
  });

  it("a hotel room's bodyweight moves need nothing more — wall angels, a chair's incline plank and thoracic extension; a goblet squat does", () => {
    const rec = (id: string) => EXERCISES.find((r) => r.id === id)!;
    for (const id of ["wallAngels", "inclinePlank", "chairThoracicExtension"]) expect(hasEquipment(rec(id), NO_EQUIPMENT_GEAR), id).toBe(true);
    expect(hasEquipment(rec("gobletSquat"), NO_EQUIPMENT_GEAR)).toBe(false);
  });
});
