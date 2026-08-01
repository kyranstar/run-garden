# Strava API — verified state as of August 2026

Research for a private, single-user, read-only app (reads own activities, never uploads).
Legend: [verified] = confirmed directly on developers.strava.com / strava.com / swagger, or by
multiple independent sources. [inferred] = well-known behavior consistent with docs but not
explicitly confirmed in this pass.

---

## 1. OAuth2

Source: https://developers.strava.com/docs/authentication/

- Authorize URL: `GET https://www.strava.com/oauth/authorize` (mobile variant:
  `/oauth/mobile/authorize`). [verified]
- Token exchange: `POST https://www.strava.com/oauth/token` with `client_id`, `client_secret`,
  `code`, `grant_type=authorization_code`. [verified]
- Access tokens expire after **6 hours**; response carries `expires_in` and `expires_at`
  (epoch). [verified]
- Refresh: same token URL with `grant_type=refresh_token`. **Refresh tokens rotate**: every
  successful token call may return a new refresh token and "once a new refresh token code has
  been returned, the older code will no longer work" — always persist the latest one.
  [verified]
- Smart reuse: if the current access token still has >1 hour of life, the refresh call returns
  it unchanged; a new access token is only minted within 1 hour of expiry. [verified]
- Scopes (from the docs scope table): [verified]
  - `read` — public segments/routes/profile data, etc.
  - `read_all` — private routes/segments/events.
  - `activity:read` — activities visible to Everyone and Followers, **excluding privacy-zone
    data**.
  - `activity:read_all` — everything in `activity:read` **plus privacy-zone data and
    activities set to "Only You"**. Required to reliably read your own private activities.
  - `profile:read_all` — profile info even when visibility is Followers/Only You (weight, FTP,
    zones). Not needed just to list/read activities; `GET /athlete` basics work with any
    authenticated token. [inferred — scope table verified, /athlete minimal-scope behavior is
    long-standing convention]
- Recommended scope string for this app: `read,activity:read_all`. [inferred]

## 2. Webhook Events API

Source: https://developers.strava.com/docs/webhooks/

- Create subscription: `POST https://www.strava.com/api/v3/push_subscriptions` with form data
  `client_id`, `client_secret`, `callback_url` (max 255 chars), `verify_token`. [verified]
- Callback validation: Strava GETs your `callback_url` with `hub.mode=subscribe`,
  `hub.verify_token`, `hub.challenge`; you must respond 200 with JSON body echoing the
  challenge: `{ "hub.challenge": "..." }` (content-type `application/json`). [verified]
- Events delivered: activity **create / update / delete** (update fires only for Title, Type,
  Privacy changes) and **athlete deauthorization**. [verified]
- Payload fields: `object_type` ("activity" | "athlete"), `object_id`, `aspect_type`
  ("create" | "update" | "delete"), `updates` (hash; for activity updates keys may be
  `title`, `type`, `private` with `"true"`/`"false"`; for deauth always
  `"authorized": "false"`), `owner_id`, `subscription_id`, `event_time`. [verified]
- Delivery contract: your endpoint must return **200 OK within 2 seconds**; otherwise Strava
  retries, **up to 3 total attempts**. Process async, ack immediately. [verified]
- **One subscription per application.** [verified]
- View subscription: `GET https://www.strava.com/api/v3/push_subscriptions?client_id=&client_secret=`;
  delete: `DELETE .../push_subscriptions/{id}` (client_id/client_secret as query params).
  [verified]
- No approval process is documented for webhooks — available to all apps ("We encourage all
  API applications to use our webhook events API"). [verified]

## 3. Rate limits

Source: https://developers.strava.com/docs/rate-limits/

- Default (new "single-player" apps): **overall 200 requests / 15 min and 2,000 / day**;
  separate **read (non-upload) limit of 100 / 15 min and 1,000 / day**. Non-upload = every
  endpoint except POST uploads/activities/media. [verified]
- After self-serve upgrade in the API dashboard (athlete capacity 10): 400 / 15 min,
  4,000 / day overall. [verified via getting-started docs]
- Headers: `X-RateLimit-Limit` + `X-RateLimit-Usage` (overall) and `X-ReadRateLimit-Limit` +
  `X-ReadRateLimit-Usage` (read), each as two comma-separated values: `15min,daily`
  (e.g. `100,1000`). [verified]
- Exceeding a limit returns `429 Too Many Requests` with a JSON error; requests that violate
  the 15-min limit still count against the daily limit. [verified]

## 4. Getting API access (changed June 2026)

Sources: https://developers.strava.com/docs/getting-started/ ,
https://communityhub.strava.com/insider-journal-9/an-update-to-our-developer-program-13428 ,
https://appsforstrava.com/blog/strava-developer-program-changes-2026 ,
https://finance.biggo.com/news/202606011823_Strava_API_Fee_2026

- Create an app at https://www.strava.com/settings/api (Client ID/Secret, first
  access+refresh token, Authorization Callback Domain shown there). [verified]
- **New (effective June 1, 2026): a paid Strava subscription (~$11.99/mo US) is required for
  Standard-tier API access.** The getting-started docs now say "A Strava subscription is
  required." Existing developers had until June 30, 2026 (3 months free offered). It's the
  normal membership, per developer, not a separate fee. Extended Access tier (big partners
  like Garmin) is exempt. [verified]
- New apps start in **"single-player mode"**: only your own account can authenticate — this
  replaces the old "athlete cap of 1" framing and is exactly what a personal app needs; no
  review required. Self-serve upgrade to 10 athletes; beyond 10 requires app review
  (Standard vs Extended Access tiers replaced the old queue). [verified]
- **Upcoming breaking changes announced for June 1, 2027**: base URL moves to
  `https://www.api-v3.strava.com`, auth tokens must be sent via request headers only (no
  query-param tokens), and `POST /oauth/deauthorize` retires. Build with
  `Authorization: Bearer` headers and a configurable base URL now. [verified via program
  announcement]

## 5. API Agreement constraints (current agreement effective June 1, 2026)

Sources: https://www.strava.com/legal/api ,
https://press.strava.com/articles/updates-to-stravas-api-agreement ,
https://communityhub.strava.com/developers-api-7/ai-inference-with-strava-data-is-it-prohibited-under-the-new-api-agreement-13256 ,
https://press.strava.com/articles/strava-launches-mcp-connector

- Current agreement shows **Effective Date: June 1, 2026**. [verified]
- Display/disclosure: "Strava Data provided by a specific user can only be displayed or
  disclosed in your Developer Application to that user." A private app showing your own data
  only to you is squarely permitted. No sharing with other users/third parties without
  explicit consent. [verified]
- Storage: no explicit caching/retention limits found in the current text; on termination you
  must "promptly cease using and permanently delete" all Strava API Materials and Strava
  Data. [verified, with the caveat below]
- No replicating/competing with Strava functionality; comply with privacy law; no
  interference with platform operation. [verified]
- **AI restrictions**: the Nov 11, 2024 revision added (and enforcement has cited) this
  clause: *"You may not use the Strava API Materials (including Strava Data), directly or
  indirectly, for any model training related to artificial intelligence, machine learning or
  similar applications."* [verified via Strava press release, TechRepublic, and a Nov 2025
  enforcement case]. Caveat: repeated extraction passes over the live June 2026 agreement
  page did not surface this sentence, but multiple mid-2026 secondary sources state the AI
  restriction remains in force and was not softened; treat it as current.
  [verified-by-secondary-sources]
- **Is passing your OWN data through an LLM for personal summaries restricted?** The clause
  literally bans *model training*, not inference. However: (a) Strava has enforced against an
  inference-only third-party AI app (StravaChat was told to shut down, Nov 2025 —
  https://x.com/matt_ambrogi/status/1987186940123197442); (b) a May 2026 community thread
  asking Strava to clarify inference vs training got **no official answer**; (c) Strava's
  sanctioned path for AI analysis of your own data is now the **official Strava MCP
  Connector** (launched June 1, 2026, subscriber feature, read-only, works with Claude
  web/desktop/Claude Code). For a private single-user app the practical risk is low (data
  shown only to the owning athlete, nothing distributed), but LLM inference over API data is
  a gray area that Strava has interpreted broadly against public apps. [verified facts;
  risk assessment inferred]

## 6. Endpoints and field names

Sources: https://developers.strava.com/docs/reference/ ,
https://developers.strava.com/swagger/swagger.json

- `GET /athlete/activities` (getLoggedInAthleteActivities): query params `before` (epoch int),
  `after` (epoch int), `page` (int, default 1), `per_page` (int, default 30). [verified]
  Max `per_page` is not stated in swagger; long-standing effective max is 200. [inferred]
  Returns SummaryActivity[] (no streams, no laps, no description).
- `GET /activities/{id}` (getActivityById): query param `include_all_efforts` (boolean,
  "To include all segments efforts"). Returns DetailedActivity. Requires `activity:read_all`
  for Only-You activities. [verified]
- `GET /activities/{id}/streams` (getActivityStreams): `keys` (array, required) with enum
  `time, distance, latlng, altitude, velocity_smooth, heartrate, cadence, watts, temp,
  moving, grade_smooth`; `key_by_type` (boolean, required, default true, "Must be true").
  [verified from swagger.json]
- `GET /activities/{id}/laps` (getLapsByActivityId): path param `id` only; no pagination.
  [verified]
- Activity model field names (SummaryActivity/DetailedActivity): [verified]
  - `id` (int64), `external_id` (string), `upload_id` (int64)
  - `start_date`, `start_date_local` (ISO 8601 strings), `timezone` (string, e.g.
    `"(GMT-08:00) America/Los_Angeles"` [inferred format])
  - `elapsed_time`, `moving_time` (integer seconds), `distance` (float meters)
  - `sport_type` (string enum; the legacy `type` field is still present in responses but
    `sport_type` is the current field — `type` is deprecated in favor of it [verified
    presence of both; deprecation noted in reference])
  - `average_heartrate` (float), `average_watts` (float), `device_watts` (boolean — true when
    watts come from a power meter), `device_name` (string, DetailedActivity only [inferred])
  - `map.summary_polyline` (encoded polyline inside the `map` object; `map.polyline` only on
    detailed. [verified summary_polyline; polyline-on-detailed inferred])
