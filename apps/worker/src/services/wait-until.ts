/**
 * `c.executionCtx` THROWS (not undefined) outside a real Workers runtime —
 * Hono's getter guards it — so every background hand-off goes through this:
 * real runtime → waitUntil; tests/no-ctx → fire-and-forget with errors eaten
 * (the promise's own .catch(), never an unhandled rejection).
 */
export function waitUntilSafe(c: { executionCtx?: { waitUntil?: (p: Promise<unknown>) => void } }, p: Promise<unknown>): void {
  const guarded = p.catch(() => undefined);
  try {
    c.executionCtx?.waitUntil?.(guarded);
  } catch {
    void guarded;
  }
}
