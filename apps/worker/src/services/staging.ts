/**
 * STAGING is inert by construction: cron triggers are empty in wrangler.toml,
 * and this guard makes every outbound fetch except the Google sign-in token
 * exchange throw. A staging Worker holding a copy of real data can therefore
 * never reach COROS, Calendar, the MCP or the LLM gateway.
 *
 * The exception is ONE request — a POST to exactly the token URL — not the
 * OAuth origin (Audit 2 M1): staging shares production's OAuth client, so a
 * call to `/revoke` on the same origin would disconnect production's
 * Calendar.
 */
export const STAGING_ALLOWED_REQUEST = { method: "POST", url: "https://oauth2.googleapis.com/token" } as const;

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

/** The method a fetch call will use: init's, else the Request's, else GET. */
function methodOf(input: RequestInfo | URL, init?: RequestInit): string {
  const fromRequest = typeof input === "object" && !(input instanceof URL) ? input.method : undefined;
  return (init?.method ?? fromRequest ?? "GET").toUpperCase();
}

function allowed(u: URL, method: string): boolean {
  return method === STAGING_ALLOWED_REQUEST.method && u.href === STAGING_ALLOWED_REQUEST.url;
}

export function stagingAllows(url: string, method = "GET"): boolean {
  const u = resolveUrl(url);
  return u ? allowed(u, method.toUpperCase()) : true;
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
    if (u && !allowed(u, methodOf(input, init))) {
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
