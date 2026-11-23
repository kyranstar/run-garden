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

- **Export**: Settings → "Export everything" assembles every account table
  from `GET /api/settings/export/manifest` and `GET
  /api/settings/export/table/:name` pages into one JSON file — sanitized:
  provider tokens are nulled, sessions and OAuth handshakes are never
  included.
- **Restore**: `POST /api/settings/restore/begin|rows|finish` loads that file
  back into the signed-in account; it refuses another schema version, never
  touches the user row or sessions, and never restores a token.
- **Full delete**: `POST /api/settings/delete-all` (requires the literal
  confirmation phrase) removes all rows for the user.
- **Provider disconnect**: per-provider disconnect endpoints null out the
  encrypted tokens.
- **Device revoke**: revoked devices fail signature auth permanently.
- **Local erase**: the desktop "Erase credentials" action clears the Keychain.

## LifeOS reads the plan (read-only token)

`GET /api/lifeos/plan?from=&to=` lets LifeOS, the owner's habit app on their iPhone, read each day's planned
sessions, rest days and which sessions were done (`apps/worker/src/routes/lifeos.ts`):

- **Bearer token, not a cookie.** The token is 32 random bytes made on the owner's Mac by LifeOS's
  `scripts/rungarden.sh connect`; it goes only to the phone (over the developer cable link, into its Keychain).
  Cloudflare holds only its SHA-256, as the Worker secret `LIFEOS_TOKEN_SHA256`, compared in constant time.
- **Off unless set.** Without the secret the route answers 404. Rotating is running `connect` again; turning it
  off is `wrangler secret delete LIFEOS_TOKEN_SHA256`.
- **Read-only and narrow.** GET only, the owner's (`ALLOWED_GOOGLE_EMAIL`) plan only, at most 31 days, fields
  limited to a session's id, title, sport, category, time, planned minutes, state and the matched activity's start.
  No health readings, no activities' telemetry, `Cache-Control: no-store`.

## Paired phones: their expiry and Renew (every scope)

A phone paired from the laptop (native device sign-in, `apps/worker/src/auth/native-devices.ts`) works for 30 days from
its confirmation, whatever scope it holds (`training-slice-v1` through `training-v5`). The laptop's **Renew**
(`POST /api/native/devices/:id/renew`, Settings → Devices, offered from 7 days out) sets that to 30 days from the server's
acceptance — never +30 on the old expiry:

- **Cookie only.** A device token never renews itself or another: it is refused by its scope's list and again by the route.
- **The account's own, and live.** Only an active, unexpired device of the signed-in account; revoked, expired (an expiry
  of exactly now included) and pending devices are refused.
- **Audited and idempotent.** One `native_device_renewed` audit `{deviceId, label, from, to}` per renew; a repeat within
  10 minutes writes nothing, and the expiry never moves back.
- **Nothing else changes.** Scope, token, state, label, confirmation and last use are kept.
- **Off with the switch.** 404 while the kill switch (`NATIVE_DEVICES`) is off; 423 during a restore.
- **Never by itself.** Nothing renews in the background: no read, grant or step-down moves the expiry.

## What every paired phone reads of the account (every scope)

`GET /api/native/me` (`apps/worker/src/routes/native.ts`), on every scope: the account's id, the phone's own label,
expiry and scope, and — since R1.1 — **the account's time zone**: its IANA name as Settings holds it (`America/New_York`
until the owner sets one). Every date and time the phone sends is judged on that clock (today, a day gone, a time already
past), so the phone needs it to say "today" and "now" as run-garden will. A time zone names a broad region, so it says
roughly where the account's clock is set; that is all it says. Never the email, connections, restore state or any other
preference. New pairings say so in their consent words (Settings → Devices, the pairing note); a phone paired before
R1.1 gets it on its next read without being asked again.

## LifeOS reads through its device (`training-v4`)

The paired phone's own credential (native device sign-in) reads the plan and the record behind it, replacing the plan
token above once LifeOS has moved over (stage 2c; the token's section goes at cleanup). Three GETs in
`apps/worker/src/routes/native.ts`, on the `training-v4` scope only (`apps/worker/src/auth/device-scope.ts`):

- **Its own named consent.** v4 is a scope of its own, never a widened one: the laptop grants it in place to a v3 phone
  (Settings → Devices, *Allow reading your plan and history*, whose line says what it reads and never reads) and steps
  it back to v3 in place; new pairings mint it. Revoke and the kill switch (`NATIVE_DEVICES`) stop it as every device.
  Neither the grant, the step-down nor any read moves the device's 30-day expiry: only the laptop's Renew does, as for
  every scope (*Paired phones: their expiry and Renew*, above).
- **Bounded, by shape at the gate and by value in the route.** Each pair holds a query rule (exact keys, each once, each
  in its grammar; anything else is 403 `out_of_scope` before the route): `/days?from&to`, at most 14 days within
  today − 90 … today + 14 on the account's clock; `/history?before&limit`, pages of whole days until they reach `limit`
  (1–30) rows — so a page can carry up to `limit` − 1 + 60, a single day being cut at 60 — back one year;
  `/sessions/:id/ahead`, no query, one session on a later day.
- **Reads only.** None writes anything — no outline, build or preview stored, no block, check, garden, reconcile, match,
  provider job, audit or note, no `waitUntil` — beyond the gate's own hourly `last_used_at`. *What's in it* for an engine
  slot is built in memory and never stored. While a restore replaces the account each answers 503
  `restore_in_progress` (`retryable: true`), never a half-restored plan.
- **The account's own, and narrow.** Every row, match, activity and session is held to the device's account (the QA
  account's phone reads only the QA account). A session carries its title, time, length, state, how it was done, its
  kind and plan's name; an activity its sport, title in words, local start time, length, distance (runs only) and
  source; a played session its logged sets, the moves it reached and its note. Never heart rate, pace, laps, elevation,
  training load, cadence, power, routes or location, telemetry, the watch's feel rating, the device's name, the
  body-check readings, the garden, coach text, email or connections. `Cache-Control: no-store`.

## LifeOS uses the library and coach through its device (`training-v5`)

R1 (the LifeOS migration's DESIGN-3, kit v0.20): v4's reads, unchanged, and the library, take-back and the coach designer,
on the `training-v5` scope only (`apps/worker/src/auth/device-scope.ts`; routes in `routes/native-library.ts`,
`routes/native-take-back.ts`, `routes/native.ts`, `routes/coach-runs.ts`, `routes/coach.ts`).

- **Its own named consent, and it shares nothing.** v5 is a scope of its own: the laptop grants it in place to a v4 phone
  (Settings → Devices, *Allow your library and coach*, whose line names everything it allows, what it reads of the coach,
  that coach use counts toward the week's AI limit, and that it shares nothing about the owner's day) and steps it back to
  v4 in place (*Stop library and coach*: what it added stays). New pairings mint it, and the pairing says the same: the AI
  limit, that it reads the coach's questions and what the coach remembers (the coach's own words), that everything else is
  plain facts, and that it shares nothing of the day. Revoke and the kill
  switch stop it as every device.
- **What the phone reads of the coach: an allowlist, field by field — never the trail; the coach's words only in its
  questions and in memory**
  (`services/device-view.ts`, review A MAJOR-1 and MAJOR-1r). The laptop's coach answers carry the coach's working trail
  and its words — what each tool read and was given, the opening's line, a chip's words, the weekly review, titles, finish
  lines. Every coach answer a v5 phone gets is rebuilt route by route from named fields only: ids, kinds, statuses, days,
  times, counts, minutes and categories, and lines the app writes from them (*Read your readiness*, *30 min strength*,
  *Plan this week*). A proposal's ops are typed fields (day, time, minutes before and after, kind, a move's day before);
  the opening and its chips are kinds, ids, days and the app's labels — a phone's *Rework* sends the chip's id and the
  server looks up its words. Two things the grant names pass, as the owner must act on them — both model-written text,
  sent only to the owner's own paired phone: the question the coach asks (its words and chips; a word filter removes
  sentences naming common readings, but the coach's own words may still mention them; a condition check as
  `check: "condition"` alone), and memory items, `{id, kind, body, confidence, pinned, expiresAt, learnedAt, source}`. The
  owner's own typed words come back only on a phone's own runs (a laptop's run shows none of its words). What
  `record_answer` or `remember` kept, and an answer to the coach's question kept as a check-in answer, carries its undo
  handle (R1.2): an opaque token naming the run and the call (`ra:`, `rm:` or `aa:`), never a word of what was kept, so
  the phone's Undo can take it back. Beyond those two,
  the structured fields are the guarantee: never a reading, a pace, a zone, cadence, power, training load, elevation, a
  condition's name or check, the memory core, a document's steps or notes, or the account's id. *Planned follow-up:* a
  structured question format — the ask tool takes a typed question kind whose text and chips the app renders, free-text
  questions laptop-only — so that questions too carry no model-written text to the phone. A take-back's `changed_since` says how the session stands as `{date, time, state,
  archived, title, minutes}`. Pinned by `device-never-list.test.ts`: readings, a pace, effort figures, a condition and
  memory lines planted where the coach reads and words them — its trail, the opening, a chip, the weekly review — reach no
  v5 answer. The laptop's (cookie) answers are unchanged.
- **Every training write is run-garden's own.** A saved workout is put on the plan through the Studio's own create (judged
  for its day, its watch copy owed and its calendar booked as a Studio save's); a coach proposal's ops are applied only by
  an approve naming its op ids and the proposal's `version` (a phone's approve without them is 403 at the gate, a stale
  version 409 `proposal_changed`, nothing written), and never one whose run didn't finish (409 `incomplete`). A phone
  approves the designer's proposals only, never the thread coach's. No automatic training writes, no notifications. A
  phone may choose the day and time of one new workout as it approves it (`at`, R1.2; the phone never holds the draft's
  document that Edit before approve sends). They are judged as a place's are: the same rule, refusals and words. It is
  400 for a revise, a change, more than one op, or from the laptop.
- **An ask of the coach goes once (R1.2).** A phone's ask may carry its own key, `clientId` (a UUID it makes per ask; 400
  from the laptop). A resend is answered the run its first create made, `repeated`, live or over: never a second run, and
  never a second paid request, a re-pair between them included. Creating a run spends nothing; the model runs only in a
  step. The key is the account and the clientId, hashed (never the device, whose id a re-pair changes), and its lookup is
  held to the account. It is an audit row `coach.device_ask` holding `{clientId, runId}`, never the ask's words, written in
  the run's own batch: an ask that started nothing wrote no key and may go again.
- **Receipt-bound take-back, of what this phone made.** Each place and each approved new or revised workout, move and skip
  writes a take-back receipt (`take_back_receipts`, migration 0040) in the same batch as the write, holding the row's
  compare columns as the write left them and who made it (`made_by`); an approve's revise that adopts a coach or imported
  session writes none (it is changed on the laptop). A phone takes back only what it made — its own places and approves;
  another phone's or the laptop's are `not_found` to it — until the session's day ends on the account's clock, 8 days at
  most. `POST /api/native/take-back` claims a receipt only while its row still reads exactly that, and in the same batch
  writes the inverse through run-garden's own writer (an archive, never a delete; a revision back as a new
  revision; a move back; an unskip) and checks it landed — so a later edit, a started, done, performed or matched session,
  a day gone, a race or a programme's session, a group not named whole, a dependent, or a receipt past its 8 days refuses
  it in words and writes nothing. A group (one approve's ops) goes back newest first and is checked whole before anything
  of it is written: an earlier version its day no longer allows is `cant_restore` for the whole group. Retries are
  idempotent by `requestId`. What the watch and the calendar still have to undo is read live (`GET
  /api/native/receipts/:id`): the watch's delete pending while owed or running, done only once verified, failed else; the
  calendar's event pending until the sync has written it. The account's own receipts only.
  *The watch follows a phone (R1.2):*
  - a place makes its session's watch copy before it answers;
  - a take-back syncs the calendar in its own request;
  - a phone's read of a receipt then runs that one session's next watch step: its queued push or delete, else its owed
    copy. One record at a time per account (a lock): a record that meets another's lock makes nothing, and the next read
    or the hourly run makes it. Never another session's work, and never two steps.

  This is one step a request, because the free plan's budget holds no route and its watch job together. Each calendar step
  takes only the room its request has left, and the half-hourly run books the rest. Nothing runs with COROS writes off or
  while a restore runs.
  *A phone's receipt read is mutation-capable (R1.3):* though a GET, that step can write the session's copy and its push, or
  send a queued push or delete to COROS. LifeOS sends it only in the foreground, from its delivery. It is never a passive
  check or a background read: the harness reads a receipt with the laptop's cookie, which runs no step and writes nothing
  (tested).
  *Who an automatic match may pair (R1.3):* matching runs from when things happened, not when they were imported. A scored
  match needs the session on the activity's own training day, and the session there before the activity ended. A session
  the COROS import wrote has no known creation (its row's time is when run-garden read it), so only its day holds it. The
  write re-checks, in its own transaction, that the session is still open, on that day and unmatched, and that the
  activity has never been matched and no app session owns it. An activity whose match was undone is never matched again by
  the machine, and every reader (the coach's and take-back's included) reads an undone match as none; a manual match is
  never overridden. It applies to the matches written from now on: no stored match is rescored or redone.
  *Rolling back:* code from before R1 leaves `take_back_receipts` and `native_device_sharing` rows in place on delete-all
  (its registry doesn't know them); a rollback is followed by deleting both tables' rows of the account by `user_id`,
  or by a forward fix — migration 0040 is additive and safe under the old code.
- **The day frame: built, and off until the owner turns it on.** Switch A is per phone (`native_device_sharing`, a sign-in's
  bookkeeping: never exported, restored or copied; delete-all removes it; a step-down below v5 turns it off), set only by
  the phone with the disclosure version the owner accepted. A run with a `frame` is refused 409 `sharing_off` unless the
  phone's switch is on under that very version; the frame is typed fields only (days, today's energy word, free windows as
  clock times, the day's end, how full each day is, coverage, the consent) with exact keys at every level — no free text
  of LifeOS's day reaches run-garden. It is kept with the run, read into its opening context as data and shown on the
  laptop's run view. A phone run is marked `via: lifeos` from the device that signed it in, never from the body.
- **Once switch A has been on, the account's coach is read by Anthropic only (R1.5; DESIGN-3 §3.12.4).** Every Claude
  call asks the AI Gateway for Anthropic first (`providerOptions.gateway.order: ["anthropic"]`), which keeps Claude on
  Bedrock or Vertex as fallbacks when Anthropic is down. Once switch A has ever been on for the account, the frame and
  whatever the coach wrote after reading it (a workout's name and notes, a proposal, a receipt, a memory, a read) can be
  anywhere in the account. So the account is pinned, not the text: **every** coach model call for it — a run's every step,
  its designers' and reviewers', each repair and retry, a new conversation's, a replay, the thread coach's wake and its
  repairs, an activity's read and a backfill digest, the Studio's plan calls, the weekly review — is sent
  `only: ["anthropic"]`, no `order`, whatever the model. One rule, no exceptions. If Anthropic can't serve a call, it fails
  as an ordinary provider error and is never sent elsewhere. Turning switch A off never unpins: what was derived stays.
  Pinned = the switch's own audit rows (`native_device_sharing_set`, `toTraining: true`) say A was ever on, **or** a phone's
  switch A is on now. The audit rows are the account's: exported and restored with it, removed by delete-all. A restore's
  wipe and "Start fresh" spare them, as the switch itself survives both, so a file from before A can't make the account read
  "never on"; and the live switch is the backstop, since a frame can go only while it is on. Both are read inside the
  budget statement each of those calls already makes, so the pin adds no statement. An account that never turned A on is
  routed exactly as before. The saved-posts import and the music tags read no coach text and are left as they are.
  **Rolling back:** once switch A has ever been on for an account, don't roll back below R1.5: that account's
  framed-derived text would go unpinned. Roll forward instead. Before A has ever been on, rolling back is safe. LifeOS keeps
  A "Not available yet" until R1.5 is live, so no account has had A on today.
- **What the coach remembers.** A phone reads, edits and deletes the account's memory as the laptop does; it may add one
  stated line (≤ 140 characters, note, fact or rule) only on the owner's tap and only with switch A on under the very
  words the owner accepted (`consent`, as a frame), kept with provenance `lifeos`; it never supersedes what the owner
  confirmed.
- **The library, trimmed.** A move's row and page carry one verdict for the switched-on profiles together (ok, caution,
  never) — never a profile's name, its notes, the account's saved-post links or its corrections. Templates are listed
  without their documents; one template's own read carries its document, what it derives to (never a condition's
  name) and, since R1.1, *What's in it* (`moves`: each move's library id, name and dose in words, the shape and renderer
  of a session's *What's in it*), nothing a v5 phone doesn't already read. Every read is `no-store` and 503 during a
  restore. A resent place (the same `clientId`) is answered the place it made before anything else is judged (R1.1), so
  a lost answer never reads as refused while that place stands; once it is off the plan (taken back, or removed on the
  laptop), the resend is answered 422 `taken_back` (R1.2), never as still on the plan.
- **The QA account's phone has no coach.** After `requireUser` (where the QA account's switches go off), every coach route
  answers 404 `coach_off` to it — no run, no model call, no `llm_usage` row. Its library, place and take-back work on its
  fixtures only. The $20 weekly cutoff is unchanged; a call's 32,000-token ceiling is reserved at its worst case first.
- **The QA account's library is synthetic (R1.4).** Its seed saves two templates, fixture-named as its sessions are
  (`QA Quick reset`, under ten minutes; `QA Hold series`, timed-hold mobility), on the QA account only; the purge removes
  them with everything else and checks zero rows. No provider is ever attached to it — no COROS, no calendar — so a
  place, *Do it now* or a take-back there writes no watch job and no calendar link, and every receipt's compensation is
  an empty list: nothing for a provider to do. **What QA proves, and what it doesn't:** take-back timing on the QA account
  is the phone's and the server's only. The watch's copy, its removal and their timing need the owner's physical device
  and his own account; QA evidence never stands in for them. The harness's state (`/api/qa/run/state`) names the
  templates and the receipts (ids, states, times — no document).

## One provider, no third-party egress

COROS is the only external training-data source (README, "Why COROS is the
only source"), and it is reached solely from the desktop bridge on your own
machine — credentials never leave it. The Strava integration was removed in
2026-08; its OAuth tokens, source links, and webhook inbox are deleted by
migration `0007`, so no credential for it survives in the database.
