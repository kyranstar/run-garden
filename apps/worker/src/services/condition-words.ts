/**
 * A CONDITION'S WORDS, ONE HOME: what the check is called, its scale and its reference points, and the daytime cue, read
 * from the profile (the library) and nowhere else — for the profile's view (condition-views.ts), the objectives board's
 * rows, the coach's reads of a key result that measures the check, the board's save, and the cue's calendar events
 * (condition-cues.ts). A profile the library no longer holds has no points, a scale of nothing to check against, no cue,
 * and is called by its id.
 */
import { isProfileId, profileById } from "@rg/exercise-library";

export interface CheckAnchorView {
  value: number;
  words: string;
}

/** The check's reference points as the views carry them (a copy, never the profile's own list); none for an unknown profile. */
export function checkAnchorsOf(profileId: string): CheckAnchorView[] {
  return isProfileId(profileId) ? profileById(profileId).check.anchors.map((a) => ({ value: a.value, words: a.words })) : [];
}

/** What the check is called (the profile's `check.label`); the id when the library no longer holds the profile. */
export const checkLabelOf = (profileId: string): string => (isProfileId(profileId) ? profileById(profileId).check.label : profileId);

/** Whether `value` lies on the profile's check scale; true for a profile the library no longer holds (nothing to judge by). */
export function onCheckScale(profileId: string, value: number): boolean {
  if (!isProfileId(profileId)) return true;
  const { min, max } = profileById(profileId).check;
  return value >= min && value <= max;
}

/** What the profile is called (its `label`); the id when the library no longer holds it. */
export const conditionLabelOf = (profileId: string): string => (isProfileId(profileId) ? profileById(profileId).label : profileId);

/** The profile's daytime cue — its words, and the profile's name for where it came from — or null when it has none. */
export function cueOf(profileId: string): { words: string; label: string } | null {
  if (!isProfileId(profileId)) return null;
  const { cue, label } = profileById(profileId);
  return cue ? { words: cue, label } : null;
}

/** The words a figure off the scale is refused with. */
export const OFF_SCALE_WORDS = (profileId: string): string => {
  const { min, max } = isProfileId(profileId) ? profileById(profileId).check : { min: 0, max: 10 };
  return `not on the check's ${min}–${max} scale`;
};
