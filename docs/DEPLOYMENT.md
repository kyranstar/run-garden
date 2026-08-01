# Deployment

End-to-end setup for a personal production instance. One Cloudflare Worker
serves the API, the cron sync, and the built PWA; the desktop app runs on your
Mac. Budget expectations: [COSTS.md](COSTS.md).

## Prerequisites

- A **Cloudflare account** (free plan works; Workers paid plan `$5/mo`
  recommended for headroom — see [COSTS.md](COSTS.md))
- **Node 20+** and **pnpm** (`corepack enable`; version pinned in
  `package.json` `packageManager`)
- **Rust toolchain + Bun** — only for building the desktop app
  ([DESKTOP_APP.md](DESKTOP_APP.md))
- A Google account (the one in `ALLOWED_GOOGLE_EMAIL`), and optionally a
  Strava account with a Strava subscription and an Anthropic API key

## 1. Create the D1 database

```bash
pnpm install
cd apps/worker
npx wrangler login
npx wrangler d1 create run-garden-db
```

Paste the printed `database_id` into `apps/worker/wrangler.toml` under
`[[d1_databases]]` (replacing `REPLACE_WITH_D1_DATABASE_ID`).

## 2. Set the worker secrets

From `apps/worker/` (full key reference: root [.env.example](../.env.example)):

```bash
npx wrangler secret put SESSION_SECRET          # openssl rand -base64 32
npx wrangler secret put TOKEN_ENCRYPTION_KEY    # openssl rand -base64 32 (must be 32 bytes)
npx wrangler secret put ALLOWED_GOOGLE_EMAIL    # your Gmail address
npx wrangler secret put GOOGLE_CLIENT_ID
npx wrangler secret put GOOGLE_CLIENT_SECRET
# Optional integrations:
npx wrangler secret put STRAVA_CLIENT_ID
npx wrangler secret put STRAVA_CLIENT_SECRET
npx wrangler secret put STRAVA_WEBHOOK_VERIFY_TOKEN   # openssl rand -hex 16
npx wrangler secret put ANTHROPIC_API_KEY
npx wrangler secret put COROS_MCP_URL
npx wrangler secret put COROS_MCP_TOKEN
```

Then edit `wrangler.toml` `[vars]`: set `APP_URL` to your real workers.dev URL
(you'll know it after the first deploy — `https://run-garden-api.<your-subdomain>.workers.dev`;
deploy once, read the URL, set it, deploy again), keep `FIXTURE_MODE = "0"`.

## 3. Migrate, build, deploy

```bash
npx wrangler d1 migrations apply run-garden-db --remote
pnpm --filter @rg/web build          # the worker uploads apps/web/dist as assets
npx wrangler deploy
```

Verify: `curl https://<your-app-url>/api/health` →
`{"ok":true,"fixtureMode":false}`.

Deploys are also automated via `.github/workflows/deploy.yml`
(`workflow_dispatch` + push to main) once `CLOUDFLARE_API_TOKEN` and
`CLOUDFLARE_ACCOUNT_ID` are set as repository secrets.

## 4. Google OAuth + Calendar

In [console.cloud.google.com](https://console.cloud.google.com/):

1. Create a project; enable the **Google Calendar API**.
2. OAuth consent screen: External; add `ALLOWED_GOOGLE_EMAIL` as a **test
   user** (no verification needed — you are the only user, and Run Garden
   enforces that server-side anyway).
3. Credentials → OAuth client ID → **Web application** with authorized
   redirect URI:
   ```
   {APP_URL}/api/auth/google/callback
   ```
   (add `http://localhost:8787/api/auth/google/callback` for local dev).
4. Put the client ID/secret into the worker secrets (step 2).

Scopes requested: `openid email profile` for sign-in; for Calendar,
`calendar.app.created`, `calendarlist.readonly`, `calendar.events`,
`calendar.freebusy` (offline access → refresh token).

**Dedicated calendar**: after signing in, Settings → Calendar lets you create
a dedicated "Run Garden" calendar (recommended — the app fully manages its
events, and you can toggle its visibility in any calendar client) or pick an
existing one. The choice is stored in preferences (`calendarId`).

## 5. Strava (optional, read-only)

1. Create an app at [strava.com/settings/api](https://www.strava.com/settings/api).
   Note: since June 2026 Strava requires an active **Strava subscription**
   (~$12/mo) on your account for API access; new apps run in single-player
   mode (only your own account) with no review.
2. Set **Authorization Callback Domain** to your worker's host
   (`run-garden-api.<subdomain>.workers.dev`). The app's redirect URI is
   `{APP_URL}/api/strava/callback`, scope `activity:read_all`.
3. Put client ID/secret + your invented `STRAVA_WEBHOOK_VERIFY_TOKEN` into
   secrets, redeploy if you changed vars, then connect from Settings →
   Strava in the app.
4. **Webhook subscription — order matters**: the callback must be live
   *before* you create the subscription (Strava validates it synchronously
   with a `hub.challenge` GET, which the worker echoes). So: deploy first,
   then:

   ```bash
   curl -X POST https://www.strava.com/api/v3/push_subscriptions \
     -F client_id=YOUR_CLIENT_ID \
     -F client_secret=YOUR_CLIENT_SECRET \
     -F callback_url={APP_URL}/api/strava/webhook \
     -F verify_token=YOUR_STRAVA_WEBHOOK_VERIFY_TOKEN
   ```

   One subscription per application. Inspect/delete with
   `GET/DELETE https://www.strava.com/api/v3/push_subscriptions`. Without a
   webhook the app still works — completions arrive on the polling cadence
   instead of near-instantly.

## 6. Anthropic (optional)

Create a key at [console.anthropic.com](https://console.anthropic.com/) and
`wrangler secret put ANTHROPIC_API_KEY`. Only the Monday weekly review uses
it (Haiku-class model, hard $10/rolling-7-days ceiling — see
[COSTS.md](COSTS.md)). Skip it and the review shows deterministic facts
without a narrative.

## 7. Desktop pairing (COROS)

Build and launch the desktop app ([DESKTOP_APP.md](DESKTOP_APP.md)), point it
at your `APP_URL`, and follow the pairing flow: it opens a browser approval
page, you sign in with the allowed Google account, and the device claims its
id. Then enter your COROS credentials (stored only in the macOS Keychain) and
run the **schedule write test** before enabling schedule writes.

## 8. Install the PWA on your iPhone

Open your `APP_URL` in **Safari** → sign in → tap **Share** → **Add to Home
Screen**. The app installs standalone (portrait, themed), caches the shell,
and keeps recent read-only data available offline (clearly marked stale).

## Local development

See the [README](../README.md#local-development-no-real-accounts-needed):
`.dev.vars` with `FIXTURE_MODE=1`, `pnpm db:migrate:local`, `pnpm dev`, then
the fixture login/seed endpoints. No real accounts required.
