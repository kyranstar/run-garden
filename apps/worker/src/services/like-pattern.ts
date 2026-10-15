/**
 * Text search in SQL with LIKE, within what D1 accepts: a pattern is escaped (ESCAPE '\') and held to D1's 50 bytes of
 * UTF-8 ("LIKE or GLOB pattern too complex" past it). Shared by the workouts list (routes/workouts.ts) and the coach
 * designer's read tools.
 */

const Q_MAX = 40;
/** D1 refuses a LIKE pattern over this many BYTES ("LIKE or GLOB pattern too complex"). */
const LIKE_MAX_BYTES = 50;
/** Words a search matches at most (each one more LIKE). */
export const LIKE_WORDS_MAX = 6;

/**
 * q as a LIKE pattern (ESCAPE '\'): trimmed and cut at 40 characters, its `\`, `%` and `_` escaped, between two `%`
 * wildcards — then shortened a whole character at a time (never half an emoji, never a backslash without its
 * character) until the pattern is within D1's 50 bytes of UTF-8. An all-whitespace q is no filter (null). LIKE folds
 * case for ASCII only, so "é" does not match "É".
 */
export function likePatternOf(raw: string | undefined): string | null {
  const chars = [...(raw?.trim() ?? "")].slice(0, Q_MAX);
  const bytes = new TextEncoder();
  for (let n = chars.length; n > 0; n--) {
    const q = chars.slice(0, n).join("").trim();
    if (!q) return null;
    const pattern = `%${q.replace(/[\\%_]/g, (ch) => `\\${ch}`)}%`;
    if (bytes.encode(pattern).length <= LIKE_MAX_BYTES) return pattern;
  }
  return null;
}

/** One pattern per word of q (at most LIKE_WORDS_MAX, the same word once): a row matches when it says every word. */
export function likeWordPatterns(raw: string | undefined): string[] {
  const words = [...new Set((raw ?? "").trim().split(/\s+/).filter(Boolean))].slice(0, LIKE_WORDS_MAX);
  return words.map(likePatternOf).filter((p): p is string => p !== null);
}
