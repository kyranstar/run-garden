/** Types for seed-saves-lib.mjs (the seed script's transform): its test imports it. */
export const TRAINING_CATEGORIES: readonly string[];
export const TRAINING_REASON: string;
export const NOT_TRAINING_REASON: string;
export const WEB_PROTOCOL: string;
export function isTraining(category: unknown): boolean;
export interface SeedBody {
  key: string;
  url: string;
  creator: { handle: string; name?: string };
  caption: string;
  hashtags: string[];
  mediaType: "video" | "carousel" | "image";
  postedAt?: string;
  seed: { status: "queued" | "filtered_out"; reason: string };
}
export function toSeed(record: unknown): SeedBody | null;
