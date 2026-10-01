export interface Env {
  DB: D1Database;
  ASSETS: Fetcher;

  APP_URL: string;
  FIXTURE_MODE: string;
  AI_DEFAULT_ENABLED: string;
  /** "1" on the staging Worker: no crons, outbound fetch guarded. Var. */
  STAGING?: string;
  /** "1" turns on the hash-only parity endpoints (/api/admin/parity/*)
   * outside staging. Var; unset in production unless a rehearsal needs it. */
  PARITY_ENABLED?: string;

  // Secrets
  SESSION_SECRET: string;
  TOKEN_ENCRYPTION_KEY: string; // base64, 32 bytes
  ALLOWED_GOOGLE_EMAIL: string;
  GOOGLE_CLIENT_ID: string;
  GOOGLE_CLIENT_SECRET: string;


  /** Vercel AI Gateway (OpenAI-compatible) — the only LLM path. Secret. */
  AI_GATEWAY_API_KEY?: string;
  /** Model slug behind the gateway; defaults to anthropic/claude-haiku-4.5. Var. */
  AI_GATEWAY_MODEL?: string;
  /** Override the gateway base URL if needed. Var. Ignored in fixture mode. */
  AI_GATEWAY_BASE_URL?: string;
  /** Fixture mode only: a recorded-model server on loopback (the coach replay
   * specs'). The one model a fixture-mode wake may call; without it, or when
   * it is not loopback, the wake answers with a canned reply. Var. */
  FIXTURE_MODEL_URL?: string;
  /** Plan Studio strong-tier model (full generate/major-revise); defaults to anthropic/claude-opus-5. Var. */
  AI_STUDIO_MODEL_STRONG?: string;
  /** Plan Studio cheap-tier model (minor edits); defaults to anthropic/claude-haiku-4.5. Var. */
  AI_STUDIO_MODEL_EDIT?: string;
  /** Ambient coach-read model; defaults to the strong tier. Var. */
  AI_COACH_READ_MODEL?: string;
  /** Optional official COROS MCP bearer token for cloud reads / capability probing. */
  COROS_MCP_URL?: string;
  COROS_MCP_TOKEN?: string;
}

export const stagingEnabled = (env: Env): boolean => env.STAGING === "1";

export function fixtureModeEnabled(env: Env): boolean {
  return env.FIXTURE_MODE === "1";
}
