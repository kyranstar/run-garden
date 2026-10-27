/** Types for recut-saves-lib.mjs (the re-cut script's SQL): its test imports it. */
export const BATCH_ID_RE: RegExp;
export function recutStatements(batchIds: readonly string[]): string[];
export function checkStatements(batchIds: readonly string[]): string[];
