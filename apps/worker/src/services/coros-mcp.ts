import { and, eq, inArray, sql } from "drizzle-orm";
import { oauthStates, providerConnections, sleepRecords } from "@rg/database";
import { addDays, fingerprint, newId, nowInstant, todayInZone, type LocalDate } from "@rg/domain";
import { decryptSecret, encryptSecret } from "../auth/crypto.js";
import type { Env } from "../env.js";
import { chunkIds, type Db } from "./db.js";

/**
 * The official COROS sleep connection (sleep/recovery phase 2).
 *
 * COROS's partner API needs a company-style application with private docs,
 * but their official MCP server (mcp.coros.com, first-party, free) exposes
 * `querySleepData` behind a bog-standard OAuth 2.0 stack — RFC 8414
 * discovery, RFC 7591 dynamic client registration (probe-verified
 * 2026-08-19: registration returns a public client with offline_access),
 * PKCE, refresh tokens. So the worker acts as an ordinary OAuth public
 * client on the athlete's own COROS account. This never touches the mobile
 * API that logs the phone app out (client.ts `readSleep: false` stays).
 *
 * Everything here is defensive about shapes: the tool's exact input/output
 * schema is unpublished, so arguments are built FROM the server's own
 * tools/list inputSchema, and the normalizer accepts the shapes the README
 * describes (durations as minutes/seconds, stages as times or ratios).
 * A shape we can't read is an error category on the connection — never a
 * guessed sleep record.
 */

const PROVIDER = "coros_mcp" as const;
const MCP_URL = "https://mcp.coros.com/mcp";
const SCOPES = "openid mcp.tools offline_access";
const PROTOCOL_VERSION = "2025-06-18";
/** Refresh when the access token is within this many ms of expiry. */
const REFRESH_SKEW_MS = 5 * 60 * 1000;
/** Sleep pulls are cheap but not free — at most one per this window. */
const SYNC_MIN_INTERVAL_MS = 6 * 3600 * 1000;
/** First pull reaches back this far; steady state re-reads a week. */
const FIRST_SYNC_DAYS = 42;
const STEADY_SYNC_DAYS = 7;

// ── OAuth plumbing ──────────────────────────────────────────────────────────

interface AuthEndpoints {
  issuer: string;
  authorizeUrl: string;
  tokenUrl: string;
  registrationUrl?: string;
  revocationUrl?: string;
}

/** RFC 9728 → RFC 8414: the MCP endpoint names its auth server; the auth
 * server names its endpoints. Discovered fresh at connect time so the right
 * regional server (mcpus/mcpeu/mcpcn) is picked for this athlete, then
 * pinned in connection meta for every later refresh. */
async function discoverAuth(fetchImpl: typeof fetch): Promise<AuthEndpoints> {
  const prRes = await fetchImpl(new URL("/.well-known/oauth-protected-resource", MCP_URL).toString());
  if (!prRes.ok) throw new Error(`protected-resource metadata ${prRes.status}`);
  const pr = (await prRes.json()) as { authorization_servers?: string[] };
  const issuer = pr.authorization_servers?.[0];
  if (!issuer) throw new Error("no authorization_servers in protected-resource metadata");
  const asRes = await fetchImpl(new URL("/.well-known/oauth-authorization-server", issuer).toString());
  if (!asRes.ok) throw new Error(`auth-server metadata ${asRes.status}`);
  const meta = (await asRes.json()) as Record<string, string>;
  if (!meta.authorization_endpoint || !meta.token_endpoint) {
    throw new Error("auth-server metadata missing endpoints");
  }
  return {
    issuer,
    authorizeUrl: meta.authorization_endpoint,
    tokenUrl: meta.token_endpoint,
    registrationUrl: meta.registration_endpoint,
    revocationUrl: meta.revocation_endpoint,
  };
}

function redirectUri(env: Env): string {
  return `${env.APP_URL}/api/auth/coros-mcp/callback`;
}

function b64url(bytes: Uint8Array): string {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
}

async function pkcePair(): Promise<{ verifier: string; challenge: string }> {
  const verifier = b64url(crypto.getRandomValues(new Uint8Array(32)));
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier));
  return { verifier, challenge: b64url(new Uint8Array(digest)) };
}

type ConnRow = typeof providerConnections.$inferSelect;

async function connRow(db: Db, userId: string): Promise<ConnRow | undefined> {
  return (
    await db
      .select()
      .from(providerConnections)
      .where(and(eq(providerConnections.userId, userId), eq(providerConnections.provider, PROVIDER)))
      .limit(1)
  )[0];
}

interface McpMeta {
  issuer?: string;
  tokenUrl?: string;
  revocationUrl?: string;
  clientId?: string;
  /** Last tool-shape problem, for prod diagnosis; never a secret. */
  lastToolError?: string;
  [key: string]: unknown;
}

/**
 * Begin the browser flow: discover, register this app as a public client
 * (per user — registration is free and a per-user client avoids any shared
 * mutable app state), park the PKCE verifier in oauth_states, and hand back
 * the authorize URL.
 */
export async function startCorosMcpAuth(
  db: Db,
  env: Env,
  userId: string,
  redirectTo: string,
  fetchImpl: typeof fetch = fetch,
): Promise<string> {
  const auth = await discoverAuth(fetchImpl);
  const existing = await connRow(db, userId);
  const meta: McpMeta = { ...(existing?.meta as McpMeta | null) };
  let clientId = meta.issuer === auth.issuer ? meta.clientId : undefined;
  if (!clientId) {
    if (!auth.registrationUrl) throw new Error("auth server offers no dynamic registration");
    const reg = await fetchImpl(auth.registrationUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        client_name: "run.garden",
        redirect_uris: [redirectUri(env)],
        grant_types: ["authorization_code", "refresh_token"],
        response_types: ["code"],
        token_endpoint_auth_method: "none",
        scope: SCOPES,
      }),
    });
    if (!reg.ok) throw new Error(`client registration ${reg.status}`);
    const body = (await reg.json()) as { client_id?: string };
    if (!body.client_id) throw new Error("registration returned no client_id");
    clientId = body.client_id;
  }

  const now = nowInstant();
  const values = {
    status: existing?.encryptedAccessToken ? existing.status : "disconnected",
    meta: {
      ...meta,
      issuer: auth.issuer,
      tokenUrl: auth.tokenUrl,
      revocationUrl: auth.revocationUrl,
      clientId,
    },
    updatedAt: now,
  };
  if (existing) {
    await db.update(providerConnections).set(values).where(eq(providerConnections.id, existing.id));
  } else {
    await db.insert(providerConnections).values({
      id: newId(),
      userId,
      provider: PROVIDER,
      createdAt: now,
      ...values,
    });
  }

  const { verifier, challenge } = await pkcePair();
  const state = b64url(crypto.getRandomValues(new Uint8Array(24)));
  await db.insert(oauthStates).values({
    state,
    provider: PROVIDER,
    codeVerifier: verifier,
    redirectTo,
    createdAt: now,
    expiresAt: new Date(Date.parse(now) + 10 * 60 * 1000).toISOString(),
  });

  const url = new URL(auth.authorizeUrl);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("client_id", clientId);
  url.searchParams.set("redirect_uri", redirectUri(env));
  url.searchParams.set("scope", SCOPES);
  url.searchParams.set("state", state);
  url.searchParams.set("code_challenge", challenge);
  url.searchParams.set("code_challenge_method", "S256");
  return url.toString();
}

/** One-shot state consumption — same replay rule as the google flow. */
export async function consumeCorosMcpState(
  db: Db,
  state: string,
): Promise<{ codeVerifier: string; redirectTo: string | null } | null> {
  const row = (
    await db.select().from(oauthStates).where(eq(oauthStates.state, state)).limit(1)
  )[0];
  if (!row || row.provider !== PROVIDER) return null;
  await db.delete(oauthStates).where(eq(oauthStates.state, state));
  if (row.expiresAt < nowInstant() || !row.codeVerifier) return null;
  return { codeVerifier: row.codeVerifier, redirectTo: row.redirectTo };
}

interface TokenResponse {
  access_token?: string;
  refresh_token?: string;
  expires_in?: number;
  scope?: string;
}

async function storeTokens(
  db: Db,
  env: Env,
  row: ConnRow,
  tokens: TokenResponse,
): Promise<void> {
  const now = nowInstant();
  await db
    .update(providerConnections)
    .set({
      status: "connected",
      encryptedAccessToken: tokens.access_token
        ? await encryptSecret(tokens.access_token, env.TOKEN_ENCRYPTION_KEY)
        : row.encryptedAccessToken,
      // Rotating refresh tokens: keep the newest, never null out a stored one.
      encryptedRefreshToken: tokens.refresh_token
        ? await encryptSecret(tokens.refresh_token, env.TOKEN_ENCRYPTION_KEY)
        : row.encryptedRefreshToken,
      accessTokenExpiresAt: new Date(
        Date.parse(now) + (tokens.expires_in ?? 3600) * 1000,
      ).toISOString(),
      scope: tokens.scope ?? row.scope,
      lastErrorCategory: null,
      updatedAt: now,
    })
    .where(eq(providerConnections.id, row.id));
}

/** Exchange the authorization code; store tokens encrypted. */
export async function completeCorosMcpAuth(
  db: Db,
  env: Env,
  userId: string,
  code: string,
  codeVerifier: string,
  fetchImpl: typeof fetch = fetch,
): Promise<boolean> {
  const row = await connRow(db, userId);
  const meta = row?.meta as McpMeta | null;
  if (!row || !meta?.tokenUrl || !meta.clientId) return false;
  const res = await fetchImpl(meta.tokenUrl, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      code,
      redirect_uri: redirectUri(env),
      client_id: meta.clientId,
      code_verifier: codeVerifier,
    }),
  });
  if (!res.ok) {
    console.error("coros-mcp: code exchange failed", res.status);
    return false;
  }
  const tokens = (await res.json()) as TokenResponse;
  if (!tokens.access_token) return false;
  await storeTokens(db, env, row, tokens);
  return true;
}

/**
 * A live access token, refreshing when close to expiry. Returns null (and
 * marks the connection) when the athlete has to reconnect — the sweep and
 * the settings page both read that category, no throwing across the sync.
 */
export async function corosMcpAccessToken(
  db: Db,
  env: Env,
  userId: string,
  fetchImpl: typeof fetch = fetch,
): Promise<string | null> {
  const row = await connRow(db, userId);
  if (!row || row.status === "disconnected" || !row.encryptedAccessToken) return null;
  const meta = row.meta as McpMeta | null;
  const expiresAt = row.accessTokenExpiresAt ? Date.parse(row.accessTokenExpiresAt) : 0;
  if (expiresAt - Date.now() > REFRESH_SKEW_MS) {
    return decryptSecret(row.encryptedAccessToken, env.TOKEN_ENCRYPTION_KEY);
  }
  if (!row.encryptedRefreshToken || !meta?.tokenUrl || !meta.clientId) {
    await markNeedsReauth(db, row);
    return null;
  }
  const refreshToken = await decryptSecret(row.encryptedRefreshToken, env.TOKEN_ENCRYPTION_KEY);
  const res = await fetchImpl(meta.tokenUrl, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: refreshToken,
      client_id: meta.clientId,
    }),
  });
  if (!res.ok) {
    // invalid_grant = the refresh token is dead; anything else is transient.
    if (res.status === 400 || res.status === 401) await markNeedsReauth(db, row);
    console.error("coros-mcp: refresh failed", res.status);
    return null;
  }
  const tokens = (await res.json()) as TokenResponse;
  if (!tokens.access_token) {
    await markNeedsReauth(db, row);
    return null;
  }
  await storeTokens(db, env, row, tokens);
  return tokens.access_token;
}

async function markNeedsReauth(db: Db, row: ConnRow): Promise<void> {
  await db
    .update(providerConnections)
    .set({ status: "error", lastErrorCategory: "needs_reauth", updatedAt: nowInstant() })
    .where(eq(providerConnections.id, row.id));
}

/** Best-effort revoke, then forget the tokens. */
export async function disconnectCorosMcp(
  db: Db,
  env: Env,
  userId: string,
  fetchImpl: typeof fetch = fetch,
): Promise<void> {
  const row = await connRow(db, userId);
  if (!row) return;
  const meta = row.meta as McpMeta | null;
  if (row.encryptedRefreshToken && meta?.revocationUrl && meta.clientId) {
    try {
      const token = await decryptSecret(row.encryptedRefreshToken, env.TOKEN_ENCRYPTION_KEY);
      await fetchImpl(meta.revocationUrl, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ token, client_id: meta.clientId }),
      });
    } catch {
      // Revocation is a courtesy; forgetting the tokens is the guarantee.
    }
  }
  await db
    .update(providerConnections)
    .set({
      status: "disconnected",
      encryptedAccessToken: null,
      encryptedRefreshToken: null,
      accessTokenExpiresAt: null,
      lastErrorCategory: null,
      updatedAt: nowInstant(),
    })
    .where(eq(providerConnections.id, row.id));
}

// ── MCP JSON-RPC over Streamable HTTP ───────────────────────────────────────

interface McpToolDef {
  name: string;
  inputSchema?: {
    properties?: Record<string, { type?: string; description?: string; format?: string }>;
    required?: string[];
  };
}

/** POST one JSON-RPC request; tolerate both plain-JSON and SSE responses
 * (Streamable HTTP servers may answer either way). */
async function mcpRequest(
  token: string,
  method: string,
  params: unknown,
  fetchImpl: typeof fetch,
): Promise<unknown> {
  const res = await fetchImpl(MCP_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
      Authorization: `Bearer ${token}`,
      "MCP-Protocol-Version": PROTOCOL_VERSION,
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  if (!res.ok) throw new Error(`mcp ${method} http ${res.status}`);
  const text = await res.text();
  let payload: { result?: unknown; error?: { code?: number; message?: string } } | null = null;
  if ((res.headers.get("content-type") ?? "").includes("text/event-stream")) {
    // Last data: line wins — the response message for our single request.
    for (const line of text.split("\n")) {
      if (line.startsWith("data:")) {
        try {
          payload = JSON.parse(line.slice(5).trim());
        } catch {
          /* keep older parse */
        }
      }
    }
  } else {
    payload = JSON.parse(text);
  }
  if (!payload) throw new Error(`mcp ${method}: unreadable response`);
  if (payload.error) throw new Error(`mcp ${method}: ${payload.error.code} ${payload.error.message}`);
  return payload.result;
}

/** The stateless-server handshake: initialize is cheap and spec-polite. */
async function mcpToolList(token: string, fetchImpl: typeof fetch): Promise<McpToolDef[]> {
  await mcpRequest(token, "initialize", {
    protocolVersion: PROTOCOL_VERSION,
    capabilities: {},
    clientInfo: { name: "run.garden", version: "1.0" },
  }, fetchImpl).catch(() => undefined);
  const result = (await mcpRequest(token, "tools/list", {}, fetchImpl)) as {
    tools?: McpToolDef[];
  };
  return result.tools ?? [];
}

/**
 * Build the date-range arguments FROM the tool's own inputSchema — the exact
 * property names/formats are unpublished, so the schema is the contract.
 * Recognizes start/from and end/to properties; integers get YYYYMMDD,
 * strings get ISO unless the schema itself says YYYYMMDD.
 */
export function buildDateArgs(
  tool: McpToolDef,
  startDate: LocalDate,
  endDate: LocalDate,
): Record<string, unknown> {
  const args: Record<string, unknown> = {};
  const props = tool.inputSchema?.properties ?? {};
  const compact = (d: LocalDate) => Number(d.replaceAll("-", ""));
  for (const [name, schema] of Object.entries(props)) {
    const n = name.toLowerCase();
    const isStart = /start|from|begin/.test(n);
    const isEnd = /end|to$|until/.test(n);
    if (!isStart && !isEnd) continue;
    if (!/date|day|time/.test(n) && !/date|day/.test(schema.description?.toLowerCase() ?? "")) continue;
    const date = isStart ? startDate : endDate;
    const wantsCompact =
      schema.type === "integer" ||
      schema.type === "number" ||
      /yyyymmdd/i.test(schema.description ?? "") ||
      /yyyymmdd/i.test(schema.format ?? "");
    args[name] = wantsCompact ? compact(date) : date;
  }
  return args;
}

// ── Sleep normalization ─────────────────────────────────────────────────────

export interface NormalizedNight {
  date: LocalDate;
  durationSeconds: number;
  deepSeconds: number | null;
  remSeconds: number | null;
  lightSeconds: number | null;
  awakeSeconds: number | null;
  startTime: string | null;
  endTime: string | null;
  qualityScore: number | null;
}

const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);

function corosDayToIso(v: unknown): LocalDate | null {
  if (typeof v === "string" && /^\d{4}-\d{2}-\d{2}$/.test(v)) return v;
  const n = typeof v === "number" ? v : typeof v === "string" ? Number(v) : NaN;
  if (!Number.isInteger(n) || n < 19000101 || n > 21000101) return null;
  const s = String(n);
  return `${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6, 8)}`;
}

/** Seconds from a value that may be seconds or minutes: COROS's private API
 * ships sleep in minutes; a "main sleep" under 20 hours read as minutes but
 * over 1200 read as seconds disambiguates every real night. */
function toSeconds(v: number | null): number | null {
  if (v == null || v <= 0) return null;
  return v <= 1200 ? Math.round(v * 60) : Math.round(v);
}

function toInstant(v: unknown): string | null {
  if (typeof v === "string" && v.includes("T")) return v;
  const n = num(v);
  if (n == null) return null;
  // Epoch seconds vs milliseconds.
  const ms = n > 1e12 ? n : n > 1e9 ? n * 1000 : null;
  return ms ? new Date(ms).toISOString() : null;
}

/**
 * One night object from whatever container the tool returned. Field names
 * follow the two shapes COROS is known to use (the private statistic API's
 * sleepData block, and Training-Hub-style camelCase); anything unreadable
 * returns null rather than a guess.
 */
export function normalizeNight(raw: Record<string, unknown>): NormalizedNight | null {
  const inner =
    typeof raw.sleepData === "object" && raw.sleepData !== null
      ? { ...raw, ...(raw.sleepData as Record<string, unknown>) }
      : raw;
  const date =
    corosDayToIso(inner.happenDay) ??
    corosDayToIso(inner.date) ??
    corosDayToIso(inner.day) ??
    (toInstant(inner.endTime)?.slice(0, 10) as LocalDate | undefined) ??
    null;
  if (!date) return null;
  const total = toSeconds(
    num(inner.totalSleepTime) ?? num(inner.sleepTime) ?? num(inner.duration) ?? num(inner.totalTime),
  );
  if (total == null || total < 30 * 60 || total > 20 * 3600) return null;
  const part = (v: unknown, ratio: unknown): number | null => {
    const abs = toSeconds(num(v));
    if (abs != null) return abs;
    const r = num(ratio);
    // Stage ratios arrive as 0..1 or 0..100.
    if (r != null && r > 0) return Math.round(total * (r > 1 ? r / 100 : r));
    return null;
  };
  const score = num(inner.performance) ?? num(inner.score) ?? num(inner.qualityScore);
  return {
    date,
    durationSeconds: total,
    deepSeconds: part(inner.deepTime, inner.deepRatio),
    remSeconds: part(inner.eyeTime ?? inner.remTime, inner.remRatio ?? inner.eyeRatio),
    lightSeconds: part(inner.lightTime, inner.lightRatio),
    awakeSeconds: part(inner.wakeTime ?? inner.awakeTime, inner.wakeRatio),
    startTime: toInstant(inner.startTime),
    endTime: toInstant(inner.endTime),
    qualityScore: score != null && score >= 0 && score <= 100 ? score : null,
  };
}

/** Dig night objects out of the tool result: structuredContent when the
 * server sends it, else the first parseable JSON text block; then every
 * array of objects that normalizes. */
export function extractNights(result: unknown): NormalizedNight[] {
  const root = (result ?? {}) as {
    structuredContent?: unknown;
    content?: Array<{ type?: string; text?: string }>;
  };
  let data: unknown = root.structuredContent;
  if (data === undefined) {
    for (const item of root.content ?? []) {
      if (item.type === "text" && item.text) {
        try {
          data = JSON.parse(item.text);
          break;
        } catch {
          /* not JSON — keep looking */
        }
      }
    }
  }
  if (data === undefined) return [];
  const nights = new Map<string, NormalizedNight>();
  const walk = (node: unknown, depth: number): void => {
    if (depth > 6 || node === null || typeof node !== "object") return;
    if (Array.isArray(node)) {
      for (const item of node) walk(item, depth + 1);
      return;
    }
    const obj = node as Record<string, unknown>;
    const night = normalizeNight(obj);
    if (night) {
      nights.set(night.date, night); // newest write wins within one payload
      return;
    }
    for (const v of Object.values(obj)) walk(v, depth + 1);
  };
  walk(data, 0);
  return [...nights.values()].sort((a, b) => (a.date < b.date ? -1 : 1));
}

// ── Ingest + sweep ──────────────────────────────────────────────────────────

/** Fingerprint-skipped, COALESCEd upsert — the ingestDailyHealth contract. */
export async function ingestSleep(
  db: Db,
  userId: string,
  nights: NormalizedNight[],
): Promise<{ written: number; skipped: number }> {
  if (nights.length === 0) return { written: 0, skipped: 0 };
  const now = nowInstant();
  const incoming = nights.map((n) => ({ n, id: `${userId}:${n.date}`, fp: fingerprint(n) }));
  const stored = new Map<string, string | null>();
  // chunkIds keeps every batch under D1's SQL-variable cap (house pattern,
  // same as ingestDailyHealth) even though a sleep window is ≤42 rows.
  for (const ids of chunkIds(incoming.map((r) => r.id))) {
    const existing = await db
      .select({ id: sleepRecords.id, contentFingerprint: sleepRecords.contentFingerprint })
      .from(sleepRecords)
      .where(inArray(sleepRecords.id, ids));
    for (const row of existing) stored.set(row.id, row.contentFingerprint);
  }

  let written = 0;
  let skipped = 0;
  for (const { n, id, fp } of incoming) {
    if (stored.get(id) === fp) {
      skipped++;
      continue;
    }
    await db
      .insert(sleepRecords)
      .values({
        id,
        userId,
        date: n.date,
        startTime: n.startTime,
        endTime: n.endTime,
        durationSeconds: n.durationSeconds,
        deepSeconds: n.deepSeconds,
        remSeconds: n.remSeconds,
        lightSeconds: n.lightSeconds,
        awakeSeconds: n.awakeSeconds,
        qualityScore: n.qualityScore,
        provider: "coros",
        contentFingerprint: fp,
        updatedAt: now,
      })
      .onConflictDoUpdate({
        target: sleepRecords.id,
        set: {
          startTime: sql`COALESCE(excluded.start_time, ${sleepRecords.startTime})`,
          endTime: sql`COALESCE(excluded.end_time, ${sleepRecords.endTime})`,
          durationSeconds: sql`excluded.duration_seconds`,
          deepSeconds: sql`COALESCE(excluded.deep_seconds, ${sleepRecords.deepSeconds})`,
          remSeconds: sql`COALESCE(excluded.rem_seconds, ${sleepRecords.remSeconds})`,
          lightSeconds: sql`COALESCE(excluded.light_seconds, ${sleepRecords.lightSeconds})`,
          awakeSeconds: sql`COALESCE(excluded.awake_seconds, ${sleepRecords.awakeSeconds})`,
          qualityScore: sql`COALESCE(excluded.quality_score, ${sleepRecords.qualityScore})`,
          contentFingerprint: fp,
          updatedAt: now,
        },
      });
    written++;
  }
  return { written, skipped };
}

/**
 * A values-REDACTED skeleton of an unreadable payload: keys and types only,
 * arrays sampled to their first element, capped small. Safe to store in
 * connection meta and show back to the account's own user — it can name
 * fields like "sleepScore" but never carry a reading.
 */
export function shapeSkeleton(value: unknown, depth = 0): unknown {
  if (depth > 5) return "…";
  if (value === null) return "null";
  if (Array.isArray(value)) {
    return value.length === 0 ? [] : [shapeSkeleton(value[0], depth + 1), `×${value.length}`];
  }
  if (typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>).slice(0, 30)) {
      out[k] = shapeSkeleton(v, depth + 1);
    }
    return out;
  }
  return typeof value;
}

export interface McpSleepSyncResult {
  status: "ok" | "not_connected" | "needs_reauth" | "tool_missing" | "shape_error" | "error";
  written?: number;
  skipped?: number;
}

/** One athlete's sleep pull. Throttled by lastSyncAt outside (the sweep). */
export async function syncCorosMcpSleep(
  db: Db,
  env: Env,
  userId: string,
  timezone: string,
  fetchImpl: typeof fetch = fetch,
): Promise<McpSleepSyncResult> {
  const row = await connRow(db, userId);
  if (!row || row.status === "disconnected") return { status: "not_connected" };
  const token = await corosMcpAccessToken(db, env, userId, fetchImpl);
  if (!token) return { status: "needs_reauth" };

  const today = todayInZone(timezone);
  const anySleep = (
    await db.select({ id: sleepRecords.id }).from(sleepRecords).where(eq(sleepRecords.userId, userId)).limit(1)
  )[0];
  const startDate = addDays(today, -(anySleep ? STEADY_SYNC_DAYS : FIRST_SYNC_DAYS));

  try {
    const tools = await mcpToolList(token, fetchImpl);
    const tool = tools.find((t) => t.name === "querySleepData");
    if (!tool) return { status: "tool_missing" };
    const args = buildDateArgs(tool, startDate, today);
    const result = await mcpRequest(token, "tools/call", { name: tool.name, arguments: args }, fetchImpl);
    const nights = extractNights(result);
    if (nights.length === 0) {
      // Not necessarily wrong (a brand-new watch), but when the payload had
      // content we couldn't read, record the shape for prod diagnosis.
      const hadContent = JSON.stringify(result ?? {}).length > 200;
      if (hadContent) {
        // Store the payload's SKELETON (keys/types only, values redacted) so
        // the real wire shape is diagnosable from the account itself — the
        // schema was never published, and a name alone diagnoses nothing.
        const skeleton = JSON.stringify(shapeSkeleton(result)).slice(0, 2000);
        await db
          .update(providerConnections)
          .set({
            meta: { ...(row.meta as McpMeta | null), lastToolError: `unrecognized querySleepData shape: ${skeleton}` },
            lastErrorCategory: "shape_error",
            updatedAt: nowInstant(),
          })
          .where(eq(providerConnections.id, row.id));
        return { status: "shape_error" };
      }
    }
    const { written, skipped } = await ingestSleep(db, userId, nights);
    await db
      .update(providerConnections)
      .set({ lastSyncAt: nowInstant(), lastErrorCategory: null, updatedAt: nowInstant() })
      .where(eq(providerConnections.id, row.id));
    return { status: "ok", written, skipped };
  } catch (e) {
    console.error("coros-mcp sleep sync failed", String(e).slice(0, 300));
    return { status: "error" };
  }
}

/** All connected athletes, throttled — riding the same cron as the COROS
 * read sweep. Sleep lands wake-date keyed, so one pull a night is plenty. */
export async function corosMcpSleepSweep(
  db: Db,
  env: Env,
  loadTimezone: (userId: string) => Promise<string>,
  fetchImpl: typeof fetch = fetch,
): Promise<void> {
  const rows = await db
    .select()
    .from(providerConnections)
    .where(and(eq(providerConnections.provider, PROVIDER), eq(providerConnections.status, "connected")));
  for (const row of rows) {
    const last = row.lastSyncAt ? Date.parse(row.lastSyncAt) : 0;
    if (Date.now() - last < SYNC_MIN_INTERVAL_MS) continue;
    const timezone = await loadTimezone(row.userId);
    await syncCorosMcpSleep(db, env, row.userId, timezone, fetchImpl).catch(() => undefined);
  }
}
