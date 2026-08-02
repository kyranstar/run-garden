/**
 * Redaction rules shared by the write spikes' sanitized reports. Reports are
 * committed to the repo, so they must never carry tokens, emails, or COROS
 * user identifiers — see docs/COROS_WRITE_PROTOCOL.md.
 */

/** Recursively drop COROS-internal user identifiers from raw snapshots. */
export function stripUserIds(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stripUserIds);
  if (value !== null && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (/userid/i.test(k)) continue;
      out[k] = stripUserIds(v);
    }
    return out;
  }
  return value;
}

/** A userId is only ever reported as its first 4 characters. */
export function redactUserId(userId: string | null | undefined): string | undefined {
  if (!userId) return undefined;
  return `${userId.slice(0, 4)}…`;
}
