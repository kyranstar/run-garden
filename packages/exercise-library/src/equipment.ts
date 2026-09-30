import type { EquipmentId } from "./vocab.js";

// Equipment labels and generic location presets. Presets list gear only: a person's own places and
// implement weights come from their account, never from the library.

export const EQUIPMENT: Readonly<Record<EquipmentId, string>> = {
  mat: "Mat", "yoga-block": "Yoga block", kettlebell: "Kettlebell", dumbbells: "Dumbbells", bench: "Bench",
  chair: "Sturdy chair", wall: "Wall", towel: "Towel", band: "Resistance band", "massage-ball": "Massage ball",
  "foam-roller": "Foam roller", "pull-up-bar": "Pull-up bar", cable: "Cable machine", barbell: "Barbell", machine: "Machines",
};

export interface LocationPreset {
  id: string;
  name: string;
  equipment: readonly EquipmentId[];
}

export const LOCATION_PRESETS: readonly LocationPreset[] = [
  { id: "home", name: "Home", equipment: ["mat", "yoga-block", "kettlebell", "bench", "chair", "wall", "towel"] },
  { id: "gym", name: "Gym", equipment: ["mat", "yoga-block", "kettlebell", "dumbbells", "bench", "chair", "wall", "towel", "band", "cable", "foam-roller", "pull-up-bar", "machine", "barbell"] },
  { id: "mat", name: "Mat only", equipment: ["mat", "wall", "towel", "chair"] },
];

/** Gear the library suggests getting next (it unlocks moves that are otherwise hidden). */
export const DEFAULT_WISHLIST: readonly EquipmentId[] = ["band", "massage-ball"];
