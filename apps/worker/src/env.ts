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
  /** "1" lets POST /api/import/standalone write (a dry run always answers). Off until the Phase 2d garden gate keeps
   * imported history out of the garden; 2d sets it in the same change. Var. */
  IMPORT_ENABLED?: string;
  /** "1" turns on program sessions on the watch (Phase 3, spec §6): the watch routes answer and queued pushes run.
   * A global switch, not a preference (ruling 3-R4). Absent (off) in every environment until the owner-approved first
   * push; off, nothing Phase 3 adds writes to COROS (unpushes and deletes still run, ruling 3-R10). Var. */
  WATCH_PUSH_ENABLED?: string;

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
  /** SHA-256 (hex) of the token LifeOS reads the plan with (`/api/lifeos/plan`). Unset: the endpoint is off. Secret. */
  LIFEOS_TOKEN_SHA256?: string;
}

export const stagingEnabled = (env: Env): boolean => env.STAGING === "1";

/** The watch switch (Phase 3): only "1" is on. A missing env (a test host with none) is off. */
export const watchPushEnabled = (env: Env | undefined): boolean => env?.WATCH_PUSH_ENABLED === "1";

export function fixtureModeEnabled(env: Env): boolean {
  return env.FIXTURE_MODE === "1";
}
