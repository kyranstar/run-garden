/**
 * Deterministic randomness. Every stochastic decision in the garden is seeded
 * by a stable string key so that replaying the same input events always yields
 * an identical garden, regardless of batching or platform.
 */

function fnv1a(str: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/** mulberry32 */
export function rng(seedKey: string): () => number {
  let a = fnv1a(seedKey);
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** One deterministic float in [0,1) for a key. */
export function roll(seedKey: string): number {
  return rng(seedKey)();
}

/** Deterministic integer in [0, n). */
export function pickIndex(seedKey: string, n: number): number {
  return Math.floor(roll(seedKey) * n);
}

/** Deterministic choice from a non-empty list. */
export function pick<T>(seedKey: string, items: readonly T[]): T {
  if (items.length === 0) throw new Error("pick from empty list");
  return items[pickIndex(seedKey, items.length)]!;
}
