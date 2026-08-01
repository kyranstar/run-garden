export interface Env {
  DB: D1Database;
  ASSETS: Fetcher;

  APP_URL: string;
  FIXTURE_MODE: string;
  AI_DEFAULT_ENABLED: string;

  // Secrets
  SESSION_SECRET: string;
  TOKEN_ENCRYPTION_KEY: string; // base64, 32 bytes
  ALLOWED_GOOGLE_EMAIL: string;
  GOOGLE_CLIENT_ID: string;
  GOOGLE_CLIENT_SECRET: string;
  STRAVA_CLIENT_ID?: string;
  STRAVA_CLIENT_SECRET?: string;
  STRAVA_WEBHOOK_VERIFY_TOKEN?: string;
  ANTHROPIC_API_KEY?: string;
  /** Optional official COROS MCP bearer token for cloud reads / capability probing. */
  COROS_MCP_URL?: string;
  COROS_MCP_TOKEN?: string;
  /** Configurable for the 2027 Strava API base-URL migration. */
  STRAVA_API_BASE?: string;
}

export function fixtureModeEnabled(env: Env): boolean {
  return env.FIXTURE_MODE === "1";
}
