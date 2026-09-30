import { TMJ } from "./tmj.js";
import type { ConditionProfile } from "./types.js";

export * from "./types.js";
export { TMJ } from "./tmj.js";

/** Every condition profile the library knows. Every record must be rated for each of them. */
export const PROFILES = { tmj: TMJ } as const satisfies Record<string, ConditionProfile>;
export type ProfileId = keyof typeof PROFILES;

export const PROFILE_IDS = Object.keys(PROFILES) as ProfileId[];

export function isProfileId(id: string): id is ProfileId {
  return Object.prototype.hasOwnProperty.call(PROFILES, id);
}

export function profileById(id: string): ConditionProfile {
  if (!isProfileId(id)) throw new Error(`Unknown condition profile "${id}" (known: ${PROFILE_IDS.join(", ")})`);
  return PROFILES[id];
}
