/**
 * STAGING is inert by construction: cron triggers are empty in wrangler.toml,
 * and this guard makes every outbound fetch except the Google sign-in token
 * exchange throw. A staging Worker holding a copy of real data can therefore
 * never reach COROS, Calendar, the MCP or the LLM gateway.
 */
export const STAGING_ALLOWED_ORIGINS = ["https://oauth2.googleapis.com"] as const;

export class StagingOutboundBlocked extends Error {
  constructor(origin: string) {
    super(`staging_outbound_blocked:${origin}`);
    this.name = "StagingOutboundBlocked";
  }
}

const ORIGINAL = Symbol.for("rg.staging.originalFetch");
type Holder = typeof globalThis & { [ORIGINAL]?: typeof fetch };

function resolveUrl(input: RequestInfo | URL): URL | null {
  const raw = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
  try {
    return new URL(raw);
  } catch {
    return null; // relative: same-origin, not an outbound host
  }
}

function allowedOrigin(origin: string): boolean {
  return (STAGING_ALLOWED_ORIGINS as readonly string[]).includes(origin);
}

export function stagingAllows(url: string): boolean {
  const u = resolveUrl(url);
  return u ? allowedOrigin(u.origin) : true;
}

export function installStagingGuard(): void {
  const g = globalThis as Holder;
  if (g[ORIGINAL]) return;
  const original = globalThis.fetch;
  g[ORIGINAL] = original;
  // Plain-function call of the stored original: workerd rejects a stored
  // fetch invoked as a method.
  globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
    const u = resolveUrl(input);
    if (u && !allowedOrigin(u.origin)) {
      return Promise.reject(new StagingOutboundBlocked(u.origin));
    }
    return original(input, init);
  }) as typeof fetch;
}

export function uninstallStagingGuardForTests(): void {
  const g = globalThis as Holder;
  const original = g[ORIGINAL];
  if (!original) return;
  globalThis.fetch = original;
  delete g[ORIGINAL];
}
