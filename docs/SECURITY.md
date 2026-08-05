# Security & privacy

Single-user by construction, minimum credential surface, and honest data
handling. Implementation references throughout.

## COROS credentials: local-only, always

The COROS email/password/region live **only in the macOS Keychain**
(`apps/desktop/src-tauri/src/keychain.rs`, service
`com.rungarden.desktop`, via the Rust `keyring` crate). They are:

- **never sent to the cloud** — the worker has no COROS credential fields at
  all; the bridge runs on the Mac (also required because COROS rejects
  datacenter-IP logins);
- **never on argv or in environment variables** — the Tauri core passes them
  to the sidecar over **stdin only** (NDJSON `authenticate` request), and the
  sidecar holds them in process memory;
- **never logged** — the bridge's stdout carries protocol JSON only; stderr
  carries sanitized operation/result-code lines (`services/coros-bridge/src/main.ts`);
- sent to COROS as an MD5 hash over TLS (the Training Hub protocol), token TTL
  ≈ 24 h with automatic single re-login on expiry;
- erasable in one action: "Erase credentials" clears the Keychain entries and
  the sidecar's memory (`keychain::erase_all` + bridge `eraseCredentials`).

## Device signing (Ed25519)

Each desktop install generates an Ed25519 keypair; the private key lives only
in the Keychain (`K_DEVICE_PRIVATE_KEY`). Every bridge→worker request is
signed over the canonical message `METHOD\npath\ntimestamp\nsha256hex(body)`
(`services/coros-bridge/src/cloud-sync.ts`), sent as `x-device-id` /
`x-device-timestamp` / `x-device-signature` headers, and verified worker-side
with WebCrypto (`apps/worker/src/auth/crypto.ts: verifyEd25519`). Job results
additionally embed a signature field, and each write attempt records
`signature_valid`. Devices can be **paused** (stop claiming jobs) or
**revoked** (key rejected permanently) from the web UI
(`/api/devices/:id/pause`, `/api/devices/:id/revoke`).

Pairing (`apps/worker/src/routes/devices.ts`): the desktop registers its
public key as a pending handshake (15-min expiry), the user approves it by
signing in with the allowed Google account, and the device claims its id
exactly once — the handshake then transitions to `claimed` and cannot be
reused.

## Encrypted provider tokens (AES-GCM)

Google OAuth tokens are stored in `provider_connections` encrypted
with **AES-256-GCM** under `TOKEN_ENCRYPTION_KEY` (32-byte base64 secret;
payload = base64url(iv ‖ ciphertext), fresh random 12-byte IV per encryption —
`apps/worker/src/auth/crypto.ts`). Plaintext tokens never touch the database.

## Single-user Google gate, PKCE, state

- **Allowlist of one**: only `ALLOWED_GOOGLE_EMAIL` may complete sign-in;
  every other Google account is rejected at the callback
  (`apps/worker/src/auth/google.ts: emailAllowed`).
- Authorization Code flow with **PKCE (S256)** and a random single-use
  **state** stored server-side with a 10-minute expiry; states are consumed on
  callback and purged by cron.
- Calendar scopes are minimal: `calendar.app.created` (manage the dedicated
  calendar we create), `calendarlist.readonly`, `calendar.events`,
  `calendar.freebusy` — no full account read.

## Session cookie model

- Session token: 32 random bytes; the database stores only its **SHA-256**
  (`sessions.id`) — a database leak cannot forge cookies.
- Cookie: `rg_session`, `HttpOnly`, `SameSite=Lax`, `Secure` on HTTPS,
  `Max-Age` 30 days; expired sessions purged by cron.
- CSRF: mutating `/api/*` browser requests must present a same-app `Origin`
  (device-signed and webhook endpoints are exempt because they authenticate
  differently) — `apps/worker/src/index.ts`.

## Sanitized logs & diagnostics

- `sync_errors` stores an error **category** plus a message truncated to 300
  chars — never tokens, credentials, or payload bodies
  (`reconcile-daily.ts: recordSyncError`); structured console logs carry
  category-level fields only.
- COROS schedule snapshots persist **sanitized normalized summaries**, never
  credentials or raw health payloads (`coros_schedule_snapshots`).
- The write-spike report redacts the user id to 4 chars and recursively strips
  every `*userId*` field from raw snapshots (`services/coros-bridge/src/spike.ts`).
- The diagnostics endpoint (`GET /api/settings/diagnostics`) exposes sync
  runs/errors and states — not secrets.

## Your data, your exit

- **Export**: `GET /api/settings/export` streams a full JSON export of your
  data — sanitized: no tokens, no credentials.
- **Full delete**: `POST /api/settings/delete-all` (requires the literal
  confirmation phrase) removes all rows for the user.
- **Provider disconnect**: per-provider disconnect endpoints null out the
  encrypted tokens.
- **Device revoke**: revoked devices fail signature auth permanently.
- **Local erase**: the desktop "Erase credentials" action clears the Keychain.

## One provider, no third-party egress

COROS is the only external training-data source (README, "Why COROS is the
only source"), and it is reached solely from the desktop bridge on your own
machine — credentials never leave it. The Strava integration was removed in
2026-08; its OAuth tokens, source links, and webhook inbox are deleted by
migration `0007`, so no credential for it survives in the database.
