/**
 * THE MUSIC DOCK's server half (2026-10-17): `/api/music` — the Spotify connection, run by the Worker (Authorization
 * Code with PKCE), and the dock's shortcuts in the preferences.
 *
 *  - Dark until the owner's Client ID arrives: every music route is a 404 while `SPOTIFY_CLIENT_ID` is empty, signed in
 *    or not, ahead of any sign-in.
 *  - PKCE: the challenge is S256 of the verifier the exchange sends; the verifier never leaves the server.
 *  - The state binds the login to the signed-in athlete (the callback may land in another browser — iOS opens a
 *    standalone app's login in Safari, and locally it lands on 127.0.0.1, not localhost): wrong, missing or expired is
 *    refused before Spotify is asked anything.
 *  - Tokens are kept encrypted in `provider_connections` (provider "spotify"); the client gets a short-lived access
 *    token, refreshed on the server when near expiry; a rotated refresh token is kept; `invalid_grant` is "reconnect".
 *  - Disconnect deletes the row. Statement counts pinned; no token is ever logged.
 *
 * The Spotify token endpoint is faked. Synthetic data only.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { and, eq } from "drizzle-orm";
import { schema } from "@rg/database";
import type { Env } from "../src/env.js";
import type { Db } from "../src/services/db.js";
import { createSession, SESSION_COOKIE } from "../src/auth/sessions.js";
import { b64urlEncode, decryptSecret, encryptSecret } from "../src/auth/crypto.js";
import { makeMusicRoutes } from "../src/routes/music.js";
import { settingsRoutes } from "../src/routes/misc.js";
import { SPOTIFY_SCOPES, SPOTIFY_TOKEN_URL } from "../src/services/spotify-auth.js";
import { loadPreferences } from "../src/services/calendar-sync.js";
import { isWrite, makeTestDb, makeTestUser, mountRoutes } from "./helpers.js";

const KEY = Buffer.alloc(32, 7).toString("base64");
const ID = "0123456789abcdefABCDEF";

function makeEnv(extra: Partial<Env> = {}): Env {
  return {
    DB: {} as unknown as Env["DB"],
    ASSETS: {} as unknown as Env["ASSETS"],
    APP_URL: "https://app.test",
    FIXTURE_MODE: "0",
    AI_DEFAULT_ENABLED: "1",
    SESSION_SECRET: "a-test-session-secret",
    TOKEN_ENCRYPTION_KEY: KEY,
    ALLOWED_GOOGLE_EMAIL: "runner@example.com",
    GOOGLE_CLIENT_ID: "g",
    GOOGLE_CLIENT_SECRET: "g",
    SPOTIFY_CLIENT_ID: "test-client-id",
    ...extra,
  } as Env;
}
const ON = makeEnv();

// ── The fake Spotify token endpoint ──────────────────────────────────────────

interface TokenCall {
  url: string;
  form: Record<string, string>;
  headers: Record<string, string>;
}
let tokenCalls: TokenCall[] = [];
let answerToken: (form: Record<string, string>) => Response | Promise<Response> = () => new Response("unset", { status: 500 });
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

const fakeFetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = String(input);
  if (url !== SPOTIFY_TOKEN_URL) throw new Error(`unexpected fetch ${url}`);
  const form = Object.fromEntries(new URLSearchParams(String(init?.body ?? "")));
  const headers: Record<string, string> = {};
  new Headers(init?.headers).forEach((value, key) => (headers[key] = value));
  tokenCalls.push({ url, form, headers });
  return answerToken(form);
}) as typeof fetch;

let clock = Date.parse("2026-10-17T12:00:00Z");
let db: Db;
let userId: string;
let cookie: string;
let statements: string[] = [];
let logs: string[] = [];

beforeEach(async () => {
  clock = Date.parse("2026-10-17T12:00:00Z");
  tokenCalls = [];
  answerToken = () => new Response("unset", { status: 500 });
  db = makeTestDb({ boundVariableCap: 100, onStatement: (s) => statements.push(s) });
  ({ userId } = await makeTestUser(db, { units: "mi" }));
  cookie = `${SESSION_COOKIE}=${await createSession(db, userId)}`;
  logs = [];
  for (const level of ["log", "info", "warn", "error", "debug"] as const) {
    vi.spyOn(console, level).mockImplementation((...args: unknown[]) => {
      logs.push(args.map(String).join(" "));
    });
  }
});
afterEach(() => {
  vi.restoreAllMocks();
  // No token, access or refresh, ever reaches a log line.
  for (const line of logs) expect(line).not.toMatch(/at-[a-z0-9]+|rt-[a-z0-9]+|fixture-access/);
});

async function call(
  method: string,
  path: string,
  opts: { env?: Env; signedIn?: boolean; body?: unknown } = {},
): Promise<{ status: number; headers: Headers; text: string; body: any; statements: string[] }> {
  const app = mountRoutes(db, "/api/music", makeMusicRoutes({ fetch: fakeFetch, now: () => clock }));
  statements = [];
  const res = await app.request(
    `https://app.test${path}`,
    {
      method,
      redirect: "manual",
      headers: {
        ...(opts.signedIn === false ? {} : { Cookie: cookie }),
        ...(opts.body === undefined ? {} : { "content-type": "application/json" }),
      },
      ...(opts.body === undefined ? {} : { body: JSON.stringify(opts.body) }),
    },
    opts.env ?? ON,
  );
  const text = await res.text();
  let body: unknown = null;
  try {
    body = JSON.parse(text);
  } catch {
    /* text */
  }
  return { status: res.status, headers: res.headers, text, body, statements: [...statements] };
}

const spotifyRow = async (who = userId) =>
  (
    await db
      .select()
      .from(schema.providerConnections)
      .where(and(eq(schema.providerConnections.userId, who), eq(schema.providerConnections.provider, "spotify")))
  )[0];

async function sha256b64url(text: string): Promise<string> {
  return b64urlEncode(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text))));
}

/** Start a login and answer the authorize URL's parameters. */
async function login(env: Env = ON): Promise<URLSearchParams> {
  const res = await call("GET", "/api/music/spotify/login", { env });
  expect(res.status).toBe(302);
  const to = new URL(res.headers.get("location")!);
  expect(`${to.origin}${to.pathname}`).toBe("https://accounts.spotify.com/authorize");
  return to.searchParams;
}

/** A connected account, as a completed login leaves it. */
async function connect(tokens: { access?: string; refresh?: string; expiresIn?: number } = {}): Promise<void> {
  const params = await login();
  answerToken = () =>
    json({ access_token: tokens.access ?? "at-first", token_type: "Bearer", scope: SPOTIFY_SCOPES.join(" "), expires_in: tokens.expiresIn ?? 3600, refresh_token: tokens.refresh ?? "rt-first" });
  const res = await call("GET", `/api/music/spotify/callback?code=code-1&state=${encodeURIComponent(params.get("state")!)}`, { signedIn: false });
  expect(res.status).toBe(302);
  tokenCalls = [];
}

// ── 1. Dark until the Client ID arrives ─────────────────────────────────────

describe("dark until the owner's Client ID arrives", () => {
  const routes: Array<[string, string, unknown?]> = [
    ["GET", "/api/music"],
    ["PUT", "/api/music", { shortcuts: [] }],
    ["GET", "/api/music/spotify/login"],
    ["GET", "/api/music/spotify/callback?code=c&state=s"],
    ["GET", "/api/music/spotify/token"],
    ["DELETE", "/api/music/spotify"],
    ["GET", "/api/music/fixture/v1/me/player/devices"],
  ];

  it("every music route is a 404 while SPOTIFY_CLIENT_ID is empty, unset or blank — signed in or not — and asks Spotify nothing", async () => {
    for (const env of [makeEnv({ SPOTIFY_CLIENT_ID: "" }), makeEnv({ SPOTIFY_CLIENT_ID: undefined }), makeEnv({ SPOTIFY_CLIENT_ID: "   " }), makeEnv({ SPOTIFY_CLIENT_ID: "", FIXTURE_MODE: "1" })]) {
      for (const [method, path, body] of routes) {
        for (const signedIn of [true, false]) {
          const res = await call(method, path, { env, signedIn, body });
          expect(res.status, `${method} ${path}`).toBe(404);
          expect(res.statements, `${method} ${path}`).toEqual([]);
        }
      }
    }
    expect(tokenCalls).toEqual([]);
  });

  it("through the Worker's own entry: a 404 before any sign-in can answer 401", async () => {
    const entry = (await import("../src/index.js")).default;
    const ctx = { waitUntil() {}, passThroughOnException() {} } as unknown as ExecutionContext;
    const off = makeEnv({ SPOTIFY_CLIENT_ID: "" });
    for (const [method, path, body] of routes) {
      const req = new Request(`https://app.test${path}`, { method, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
      expect((await entry.fetch(req, off, ctx)).status, `${method} ${path}`).toBe(404);
    }
    // Set, the routes sign in first.
    expect((await entry.fetch(new Request("https://app.test/api/music/spotify/token"), ON, ctx)).status).toBe(401);
    expect((await entry.fetch(new Request("https://app.test/api/music"), ON, ctx)).status).toBe(401);
  });

  it("set, the signed-in routes sign in first; the callback needs no session (its state names the athlete)", async () => {
    for (const [method, path, body] of routes.filter(([, p]) => !p.includes("callback") && !p.includes("fixture"))) {
      expect((await call(method, path, { signedIn: false, body })).status, `${method} ${path}`).toBe(401);
    }
  });
});

// ── 2. Login: PKCE and a state bound to the athlete ─────────────────────────

describe("login", () => {
  it("redirects to Spotify's authorize URL with the client id, the scopes, S256 and a state — one statement (the session)", async () => {
    const res = await call("GET", "/api/music/spotify/login");
    expect(res.status).toBe(302);
    expect(res.statements).toHaveLength(1);
    const to = new URL(res.headers.get("location")!);
    expect(to.searchParams.get("client_id")).toBe("test-client-id");
    expect(to.searchParams.get("response_type")).toBe("code");
    expect(to.searchParams.get("redirect_uri")).toBe("https://app.test/api/music/spotify/callback");
    expect(to.searchParams.get("code_challenge_method")).toBe("S256");
    expect(to.searchParams.get("code_challenge")).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(to.searchParams.get("state")).toBeTruthy();
    expect(to.searchParams.get("scope")!.split(" ").sort()).toEqual(
      ["playlist-modify-private", "playlist-read-private", "user-modify-playback-state", "user-read-currently-playing", "user-read-playback-state"],
    );
    // Nothing secret travels in the URL: no verifier, no secret.
    expect(res.headers.get("location")).not.toContain("a-test-session-secret");
  });

  it("the redirect URI is APP_URL's in production and the loopback IP locally (Spotify allows http only there, never `localhost`)", async () => {
    expect((await login(makeEnv({ APP_URL: "https://run-garden-api.kyranadams.workers.dev" }))).get("redirect_uri")).toBe(
      "https://run-garden-api.kyranadams.workers.dev/api/music/spotify/callback",
    );
    expect((await login(makeEnv({ APP_URL: "http://localhost:5173" }))).get("redirect_uri")).toBe("http://127.0.0.1:8787/api/music/spotify/callback");
  });

  it("two logins never share a state or a challenge", async () => {
    const a = await login();
    const b = await login();
    expect(a.get("state")).not.toBe(b.get("state"));
    expect(a.get("code_challenge")).not.toBe(b.get("code_challenge"));
  });
});

// ── 3. The callback: the state checked, the code exchanged, the tokens encrypted ─

describe("callback", () => {
  it("exchanges the code with the verifier whose S256 is the challenge, stores the tokens encrypted, and goes back into the app with the dock open", async () => {
    const params = await login();
    answerToken = () => json({ access_token: "at-one", token_type: "Bearer", scope: SPOTIFY_SCOPES.join(" "), expires_in: 3600, refresh_token: "rt-one" });
    const res = await call("GET", `/api/music/spotify/callback?code=the-code&state=${encodeURIComponent(params.get("state")!)}`, { signedIn: false });
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("https://app.test/?music=connected");

    expect(tokenCalls).toHaveLength(1);
    const form = tokenCalls[0]!.form;
    expect(form.grant_type).toBe("authorization_code");
    expect(form.code).toBe("the-code");
    expect(form.client_id).toBe("test-client-id");
    expect(form.redirect_uri).toBe("https://app.test/api/music/spotify/callback");
    expect(form.client_secret).toBeUndefined();
    expect(tokenCalls[0]!.headers["content-type"]).toBe("application/x-www-form-urlencoded");
    // PKCE: 43–128 unreserved characters, and S256 of it is what the authorize URL carried.
    expect(form.code_verifier).toMatch(/^[A-Za-z0-9._~-]{43,128}$/);
    expect(await sha256b64url(form.code_verifier!)).toBe(params.get("code_challenge"));

    const row = (await spotifyRow())!;
    expect(row.status).toBe("connected");
    expect(row.encryptedAccessToken).not.toContain("at-one");
    expect(row.encryptedRefreshToken).not.toContain("rt-one");
    expect(await decryptSecret(row.encryptedAccessToken!, KEY)).toBe("at-one");
    expect(await decryptSecret(row.encryptedRefreshToken!, KEY)).toBe("rt-one");
    expect(row.accessTokenExpiresAt).toBe(new Date(clock + 3600_000).toISOString());
    expect(row.scope).toBe(SPOTIFY_SCOPES.join(" "));
    // Two statements (the restore marker, one upsert) and one fetch.
    expect(res.statements).toHaveLength(2);
    expect(res.statements.filter(isWrite)).toHaveLength(1);
  });

  it("connecting again replaces the tokens on the same row", async () => {
    await connect({ access: "at-a", refresh: "rt-a" });
    await connect({ access: "at-b", refresh: "rt-b" });
    const rows = await db.select().from(schema.providerConnections).where(eq(schema.providerConnections.provider, "spotify"));
    expect(rows).toHaveLength(1);
    expect(await decryptSecret(rows[0]!.encryptedRefreshToken!, KEY)).toBe("rt-b");
  });

  it("refuses a wrong, tampered, foreign, missing or expired state — before asking Spotify, writing nothing", async () => {
    const params = await login();
    const state = params.get("state")!;
    const [body, sig] = state.split(".");
    const flipped = `${sig!.slice(0, -1)}${sig!.endsWith("A") ? "B" : "A"}`;
    const bad = [
      "",
      "garbage",
      `${body}.${flipped}`,
      `${body}`,
      `${body}.${sig}.extra`,
      // The same claims, signed with another secret.
      (await login(makeEnv({ SESSION_SECRET: "another-secret" }))).get("state")!,
    ];
    for (const s of bad) {
      const res = await call("GET", `/api/music/spotify/callback?code=c${s ? `&state=${encodeURIComponent(s)}` : ""}`, { signedIn: false });
      expect(res.status, s).toBe(400);
      expect(res.statements.filter(isWrite), s).toEqual([]);
    }
    // Missing altogether.
    expect((await call("GET", "/api/music/spotify/callback?code=c", { signedIn: false })).status).toBe(400);
    // Expired: ten minutes, and not a second more.
    clock += 10 * 60_000 + 1;
    expect((await call("GET", `/api/music/spotify/callback?code=c&state=${encodeURIComponent(state)}`, { signedIn: false })).status).toBe(400);
    expect(tokenCalls).toEqual([]);
    expect(await spotifyRow()).toBeUndefined();
  });

  it("just inside ten minutes the state still reads", async () => {
    const state = (await login()).get("state")!;
    clock += 10 * 60_000 - 1000;
    answerToken = () => json({ access_token: "at-x", expires_in: 3600, refresh_token: "rt-x", scope: "" });
    expect((await call("GET", `/api/music/spotify/callback?code=c&state=${encodeURIComponent(state)}`, { signedIn: false })).headers.get("location")).toBe(
      "https://app.test/?music=connected",
    );
  });

  it("the state binds the athlete who started it: the tokens land on their account, whoever's browser finishes", async () => {
    const other = await makeTestUser(db);
    const otherCookie = `${SESSION_COOKIE}=${await createSession(db, other.userId)}`;
    const params = await login();
    answerToken = () => json({ access_token: "at-z", expires_in: 3600, refresh_token: "rt-z", scope: "" });
    const app = mountRoutes(db, "/api/music", makeMusicRoutes({ fetch: fakeFetch, now: () => clock }));
    const res = await app.request(`https://app.test/api/music/spotify/callback?code=c&state=${encodeURIComponent(params.get("state")!)}`, { headers: { Cookie: otherCookie } }, ON);
    expect(res.status).toBe(302);
    expect(await spotifyRow()).toBeDefined();
    expect(await spotifyRow(other.userId)).toBeUndefined();
  });

  it("a refusal at Spotify, or a failed exchange, goes back to the app saying so and stores nothing", async () => {
    const state = (await login()).get("state")!;
    let res = await call("GET", `/api/music/spotify/callback?error=access_denied&state=${encodeURIComponent(state)}`, { signedIn: false });
    expect(res.headers.get("location")).toBe("https://app.test/?music=error");
    expect(tokenCalls).toEqual([]);
    answerToken = () => json({ error: "invalid_grant" }, 400);
    res = await call("GET", `/api/music/spotify/callback?code=c&state=${encodeURIComponent(state)}`, { signedIn: false });
    expect(res.headers.get("location")).toBe("https://app.test/?music=error");
    answerToken = () => json({ access_token: "at-no-refresh", expires_in: 3600 });
    res = await call("GET", `/api/music/spotify/callback?code=c&state=${encodeURIComponent(state)}`, { signedIn: false });
    expect(res.headers.get("location")).toBe("https://app.test/?music=error");
    expect(await spotifyRow()).toBeUndefined();
  });

  it("while a restore is replacing the account, the callback writes nothing", async () => {
    const state = (await login()).get("state")!;
    await db.insert(schema.accountState).values({ userId, restoreId: "r1", updatedAt: new Date(clock).toISOString() } as never);
    answerToken = () => json({ access_token: "at-r", expires_in: 3600, refresh_token: "rt-r", scope: "" });
    const res = await call("GET", `/api/music/spotify/callback?code=c&state=${encodeURIComponent(state)}`, { signedIn: false });
    expect(res.headers.get("location")).toBe("https://app.test/?music=error");
    expect(tokenCalls).toEqual([]);
    expect(await spotifyRow()).toBeUndefined();
  });
});

// ── 4. The client's token ───────────────────────────────────────────────────

describe("token", () => {
  it("not connected says so, without asking Spotify", async () => {
    const res = await call("GET", "/api/music/spotify/token");
    expect(res.body).toEqual({ connected: false, reason: "not_connected" });
    expect(tokenCalls).toEqual([]);
  });

  it("a fresh token is answered as stored, never cached — two statements, no fetch", async () => {
    await connect({ access: "at-fresh", expiresIn: 3600 });
    clock += 50 * 60_000; // ten minutes left
    const res = await call("GET", "/api/music/spotify/token");
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ connected: true, accessToken: "at-fresh", expiresAt: new Date(Date.parse("2026-10-17T12:00:00Z") + 3600_000).toISOString() });
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(res.statements).toHaveLength(2);
    expect(tokenCalls).toEqual([]);
  });

  it("near expiry it refreshes on the server (the client id, no secret) and keeps the refresh token when none comes back — three statements, one fetch", async () => {
    await connect({ access: "at-old", refresh: "rt-keep", expiresIn: 3600 });
    clock += 56 * 60_000; // four minutes left: inside the margin
    answerToken = () => json({ access_token: "at-new", token_type: "Bearer", expires_in: 3600, scope: SPOTIFY_SCOPES.join(" ") });
    const res = await call("GET", "/api/music/spotify/token");
    expect(res.body).toEqual({ connected: true, accessToken: "at-new", expiresAt: new Date(clock + 3600_000).toISOString() });
    expect(tokenCalls).toHaveLength(1);
    expect(tokenCalls[0]!.form).toEqual({ grant_type: "refresh_token", refresh_token: "rt-keep", client_id: "test-client-id" });
    expect(res.statements).toHaveLength(3);
    const row = (await spotifyRow())!;
    expect(await decryptSecret(row.encryptedAccessToken!, KEY)).toBe("at-new");
    expect(await decryptSecret(row.encryptedRefreshToken!, KEY)).toBe("rt-keep");
    expect(row.accessTokenExpiresAt).toBe(new Date(clock + 3600_000).toISOString());
    // And the next ask is answered from the row.
    tokenCalls = [];
    expect((await call("GET", "/api/music/spotify/token")).body.accessToken).toBe("at-new");
    expect(tokenCalls).toEqual([]);
  });

  it("an expired token refreshes too", async () => {
    await connect({ access: "at-old", expiresIn: 3600 });
    clock += 2 * 3600_000;
    answerToken = () => json({ access_token: "at-later", expires_in: 3600 });
    expect((await call("GET", "/api/music/spotify/token")).body.accessToken).toBe("at-later");
  });

  it("a rotated refresh token is kept", async () => {
    await connect({ refresh: "rt-one", expiresIn: 60 });
    answerToken = () => json({ access_token: "at-two", expires_in: 3600, refresh_token: "rt-two" });
    await call("GET", "/api/music/spotify/token");
    expect(await decryptSecret((await spotifyRow())!.encryptedRefreshToken!, KEY)).toBe("rt-two");
    clock += 2 * 3600_000;
    answerToken = () => json({ access_token: "at-three", expires_in: 3600 });
    await call("GET", "/api/music/spotify/token");
    expect(tokenCalls.at(-1)!.form.refresh_token).toBe("rt-two");
  });

  it("invalid_grant is 'reconnect': answered so, the row marked, and Spotify not asked again", async () => {
    await connect({ expiresIn: 60 });
    answerToken = () => json({ error: "invalid_grant", error_description: "Refresh token revoked" }, 400);
    const res = await call("GET", "/api/music/spotify/token");
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ connected: false, reason: "reconnect" });
    expect((await spotifyRow())!.status).toBe("error");
    tokenCalls = [];
    expect((await call("GET", "/api/music/spotify/token")).body).toEqual({ connected: false, reason: "reconnect" });
    expect(tokenCalls).toEqual([]);
    expect((await call("GET", "/api/music")).body).toMatchObject({ connected: false, reason: "reconnect" });
    // Connecting again heals it.
    await connect({ access: "at-healed" });
    expect((await call("GET", "/api/music/spotify/token")).body).toMatchObject({ connected: true, accessToken: "at-healed" });
  });

  it("invalid_grant after another request rotated the token answers the other request's token, not 'reconnect'", async () => {
    await connect({ refresh: "rt-one", expiresIn: 60 });
    answerToken = async () => {
      // Meanwhile another tab refreshed and Spotify rotated the refresh token.
      await db
        .update(schema.providerConnections)
        .set({
          encryptedAccessToken: await encryptSecret("at-other-tab", KEY),
          encryptedRefreshToken: await encryptSecret("rt-other-tab", KEY),
          accessTokenExpiresAt: new Date(clock + 3600_000).toISOString(),
        })
        .where(eq(schema.providerConnections.provider, "spotify"));
      return json({ error: "invalid_grant" }, 400);
    };
    const res = await call("GET", "/api/music/spotify/token");
    expect(res.body).toEqual({ connected: true, accessToken: "at-other-tab", expiresAt: new Date(clock + 3600_000).toISOString() });
    expect((await spotifyRow())!.status).toBe("connected");
  });

  it("Spotify down is a 502 that leaves the row as it was", async () => {
    await connect({ expiresIn: 60 });
    const before = await spotifyRow();
    answerToken = () => new Response("bad gateway", { status: 503 });
    const res = await call("GET", "/api/music/spotify/token");
    expect(res.status).toBe(502);
    expect(await spotifyRow()).toEqual(before);
  });

  it("a row without a refresh token (an account restored from a file, whose secrets never travel) is 'reconnect'", async () => {
    await connect();
    await db.update(schema.providerConnections).set({ encryptedRefreshToken: null, encryptedAccessToken: null }).where(eq(schema.providerConnections.provider, "spotify"));
    expect((await call("GET", "/api/music/spotify/token")).body).toEqual({ connected: false, reason: "reconnect" });
  });
});

// ── 5. Disconnect ────────────────────────────────────────────────────────────

describe("disconnect", () => {
  it("deletes the athlete's Spotify row only — three statements", async () => {
    await connect();
    const other = await makeTestUser(db);
    await db.insert(schema.providerConnections).values({ id: "o1", userId: other.userId, provider: "spotify", createdAt: "x", updatedAt: "x" });
    await db.insert(schema.providerConnections).values({ id: "c1", userId, provider: "coros", createdAt: "x", updatedAt: "x" });
    const res = await call("DELETE", "/api/music/spotify");
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true });
    expect(res.statements).toHaveLength(3);
    expect(await spotifyRow()).toBeUndefined();
    expect(await spotifyRow(other.userId)).toBeDefined();
    expect((await db.select().from(schema.providerConnections).where(eq(schema.providerConnections.id, "c1")))).toHaveLength(1);
    expect((await call("GET", "/api/music/spotify/token")).body).toEqual({ connected: false, reason: "not_connected" });
  });
});

// ── 6. The dock's read and the shortcuts ────────────────────────────────────

describe("the dock's read and its shortcuts", () => {
  const music = {
    shortcuts: [{ id: "spa", label: "Spa", uri: `spotify:playlist:${ID}`, shuffle: true }],
    minecraftPlaylistId: ID,
  };

  it("reads the connection and the shortcuts — three statements, no fetch", async () => {
    let res = await call("GET", "/api/music");
    expect(res.body).toEqual({ connected: false, music: { shortcuts: [] } });
    expect(res.statements).toHaveLength(3);
    await connect();
    res = await call("GET", "/api/music");
    expect(res.body).toEqual({ connected: true, music: { shortcuts: [] } });
    expect(tokenCalls).toEqual([]);
  });

  it("saves the shortcuts whole into the preferences, the rest untouched — three statements", async () => {
    const res = await call("PUT", "/api/music", { body: music });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ music });
    expect(res.statements).toHaveLength(3);
    const prefs = await loadPreferences(db, userId);
    expect(prefs.music).toEqual(music);
    expect(prefs.units).toBe("mi");
    expect((await call("GET", "/api/music")).body.music).toEqual(music);
  });

  it("refuses a shape that doesn't read, writing nothing", async () => {
    for (const bad of [{ shortcuts: [{ id: "a", label: "A", uri: "spotify:track:x" }] }, { shortcuts: "no" }, null, "text"]) {
      const res = await call("PUT", "/api/music", { body: bad });
      expect(res.status).toBe(400);
      expect(res.statements.filter(isWrite)).toEqual([]);
    }
    expect((await loadPreferences(db, userId)).music).toBeUndefined();
  });

  it("a save of any other setting keeps them; a music that doesn't read is refused there too, never saved as none", async () => {
    await call("PUT", "/api/music", { body: music });
    const settings = mountRoutes(db, "/api/settings", settingsRoutes);
    const put = (body: unknown) =>
      settings.request("https://app.test/api/settings", { method: "PUT", headers: { Cookie: cookie, "content-type": "application/json" }, body: JSON.stringify(body) }, ON);
    expect((await put({ units: "km" })).status).toBe(200);
    expect((await loadPreferences(db, userId)).music).toEqual(music);
    expect((await put({ music: { shortcuts: "broken" } })).status).toBe(400);
    expect((await loadPreferences(db, userId)).music).toEqual(music);
  });
});

// ── 7. Fixture mode (the fixture stack only) ────────────────────────────────

describe("fixture mode", () => {
  const FIXTURE = makeEnv({ FIXTURE_MODE: "1", APP_URL: "http://localhost:5272" });

  it("login connects a fixture account without leaving the machine, and the token names the fixture API", async () => {
    const res = await call("GET", "/api/music/spotify/login", { env: FIXTURE });
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("http://localhost:5272/?music=connected");
    expect(tokenCalls).toEqual([]);
    const token = await call("GET", "/api/music/spotify/token", { env: FIXTURE });
    expect(token.body).toMatchObject({ connected: true, apiBase: "/api/music/fixture/v1" });
    expect(tokenCalls).toEqual([]);
  });

  it("outside fixture mode the token never names another API, and the fixture API does not exist", async () => {
    await connect();
    expect((await call("GET", "/api/music/spotify/token")).body.apiBase).toBeUndefined();
    expect((await call("GET", "/api/music/fixture/v1/me/player/devices")).status).toBe(404);
  });
});

// ── 8. The switch's home, and the stand-in Spotify ──────────────────────────

describe("configuration", () => {
  it("SPOTIFY_CLIENT_ID is a production var (empty until the owner's id arrives); staging never declares it; the fixture stack sets it only when asked", async () => {
    const { readFileSync } = await import("node:fs");
    const toml = readFileSync(new URL("../wrangler.toml", import.meta.url), "utf8");
    const production = toml.slice(0, toml.indexOf("[env.staging]"));
    expect(production.match(/^\s*SPOTIFY_CLIENT_ID\s*=\s*"[^"]*"$/gm)).toHaveLength(1);
    expect(toml.slice(toml.indexOf("[env.staging]"))).not.toMatch(/SPOTIFY_CLIENT_ID/);
    const stack = readFileSync(new URL("../../web/e2e/fixture-stack.sh", import.meta.url), "utf8");
    expect(stack).toContain('if [ "${RG_E2E_SPOTIFY:-0}" = "1" ]; then MUSIC_VARS=(--var SPOTIFY_CLIENT_ID:fixture-client); fi');
  });
});

describe("the stand-in Spotify (fixture mode)", () => {
  const FIXTURE = makeEnv({ FIXTURE_MODE: "1", APP_URL: "http://localhost:5272" });
  async function api(method: string, path: string, body?: unknown, auth = "Bearer fixture-access-token") {
    const app = mountRoutes(db, "/api/music", makeMusicRoutes({ fetch: fakeFetch, now: () => clock }));
    const res = await app.request(
      `https://app.test/api/music/fixture/v1${path}`,
      { method, headers: { authorization: auth, ...(body === undefined ? {} : { "content-type": "application/json" }) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) },
      FIXTURE,
    );
    return { status: res.status, body: (await res.json().catch(() => null)) as any };
  }

  beforeEach(async () => {
    await api("DELETE", "/state");
  });

  it("answers as Spotify does: devices, a play that becomes now playing, a phone that refuses remote volume, no device", async () => {
    expect((await api("GET", "/me/player/devices", undefined, "Bearer wrong")).status).toBe(401);
    const devices = (await api("GET", "/me/player/devices")).body.devices;
    expect(devices.map((d: any) => [d.id, d.supports_volume])).toEqual([["fixture-phone", false], ["fixture-desktop", true]]);
    expect((await api("GET", "/me/player")).status).toBe(204);
    const album = (await api("GET", `/search?q=${encodeURIComponent("Minecraft Volume Alpha C418")}&type=album&limit=10`)).body.albums.items[0];
    expect(album.name).toBe("Minecraft - Volume Alpha");
    expect((await api("PUT", "/me/player/play?device_id=fixture-phone", { context_uri: album.uri, offset: { position: 17 } })).status).toBe(204);
    const now = (await api("GET", "/me/player")).body;
    expect([now.is_playing, now.item.name, now.device.id]).toEqual([true, "Sweden", "fixture-phone"]);
    expect((await api("PUT", "/me/player/volume?volume_percent=30&device_id=fixture-phone")).body.error.reason).toBe("VOLUME_CONTROL_DISALLOW");
    expect((await api("PUT", "/me/player/volume?volume_percent=30&device_id=fixture-desktop")).status).toBe(204);
    await api("PUT", "/state/devices", { none: true });
    const refused = await api("PUT", "/me/player/play", { context_uri: album.uri });
    expect([refused.status, refused.body.error.reason]).toEqual([404, "NO_ACTIVE_DEVICE"]);
  });
});
