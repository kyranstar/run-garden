# Data model

Single D1 (SQLite) database, schema defined with Drizzle in
`packages/database/src/schema/*.ts`, migrations generated into
`packages/database/migrations/` (applied by wrangler; see
[DEPLOYMENT.md](DEPLOYMENT.md)). All timestamps are ISO-8601 strings; local
dates are `YYYY-MM-DD`; JSON columns are typed `text(…, { mode: "json" })`.

## Identity & devices (`identity.ts`)

| Table | Purpose |
|---|---|
| `users` | The single allowed user (email unique, `google_sub` from OAuth) |
| `sessions` | Cookie sessions; **row id is the SHA-256 of the token** — the raw token exists only in the cookie; 30-day TTL, purged by cron |
| `oauth_states` | Short-lived OAuth `state` + PKCE verifier rows (Google/Strava), 10-min expiry, single-use |
| `provider_connections` | One row per provider (`google_calendar` \| `strava` \| `coros_mcp`) with **AES-GCM-encrypted** access/refresh tokens, scope, status, last error category |
| `desktop_devices` | Paired desktop bridges: Ed25519 public key (base64url raw), platform, reported bridge capabilities, `bridge_paused`, `last_seen_at`, `revoked_at` |
| `device_handshakes` | Short-lived pairing codes (pending → approved via Google sign-in → claimed once by the device), 15-min expiry |
| `user_preferences` | One JSON blob validated by `userPreferencesSchema` (timezone, times, buffers, calendar id, mirror window, AI/write toggles, rest mode, theme) |

## Plans & schedule (`schedule.ts`)

| Table | Purpose |
|---|---|
| `training_plans` | Imported COROS plans; `source_plan_id`, `pb_version`, `status` active/archived — a new active plan archives the old one |
| `training_plan_versions` | Append-only capture of plan revisions (version number, content fingerprint, summary) |
| `planned_workouts` | The core row: the **three dates** (`original_plan_date`, `last_verified_coros_date`, `effective_date`+`effective_time`), category/subtype, COROS ids (`source_workout_id`, `source_program_id`, `source_id_in_plan`), duration fields (`source_estimated_duration_seconds`, `fallback_estimated_duration_seconds`, `calendar_block_duration_seconds`, persisted `duration_estimate` JSON), the three sync/completion states, `missing_reads` absence counter, `resolution_date` (garden input) |
| `planned_workout_stages` | Flattened-with-parents stage tree (kind, repeat count, duration/distance, pace/HR targets, zones) |
| `schedule_overrides` | Audit of every placement change (`user_move` \| `user_skip` \| `time_change` \| `restore`) with source (`app` \| `calendar_edit` \| `reconciler`) |
| `coros_schedule_snapshots` | Sanitized normalized schedule captures (`scheduled_read` \| `pre_write` \| `post_write_verify` \| `spike`) — never credentials or raw health |
| `coros_write_jobs` | The serialized write queue: expected version + content fingerprint, original/destination dates, status machine, claim info, attempt count (max 5), `path_used`, `degraded`, `verified_at` |
| `coros_write_attempts` | One row per execution attempt (device, outcome, path, error category, observed date, signature validity) |
| `calendar_event_links` | Workout ↔ Google event mapping with `last_written_fingerprint` (manual-edit detection) and preserved `user_notes` |
| `calendar_event_suppressions` | "Do not recreate" markers (`user_deleted` \| `workout_removed`) |

## Activities (`activities.ts`)

| Table | Purpose |
|---|---|
| `activities` | One normalized row per **physical run**, possibly merged from both providers (`coros_activity_id` and/or `strava_activity_id`, both unique per user); COROS-authoritative metrics; `source_merge_confidence` |
| `activity_source_links` | **Provenance per source record**: provider, provider activity id (unique), `first_seen_at`/`last_seen_at`, `content_fingerprint`, `normalizer_version`, sanitized `raw_summary` |
| `activity_laps` | Per-lap duration/distance/HR/pace (feeds `decoupling`, `aerobicEfficiency`, `lowIntensityShare`, and the route's pacing halves) |
| `activity_stream_summaries` | Stream stats by type (sample count + aggregate stats; raw streams are not stored) |
| `workout_completion_matches` | Planned↔completed links: confidence, method (`coros_plan_link` \| `scored_auto` \| `scored_confirmed` \| `manual`), `provisional` (Strava-only, awaiting COROS), `undone_at` for reversals |
| `daily_health` | Per-day RHR/HRV/recovery/fatigue/7-day load from COROS (id = `userId:date`) |
| `sleep_records` | Sleep duration/stages when available (not readable via the bridge — mobile-only upstream; optional via official MCP), sleep-dependent analytics self-suppress |

## Garden (`garden.ts`)

| Table | Purpose |
|---|---|
| `garden_state` | Current snapshot JSON (authoritative for rendering; rebuildable by replay), simulation version, last simulated date |
| `garden_events` | **Immutable event log** — the replay source of truth; unique on (user, date, seq) |
| `garden_day_inputs` | The resolved per-day inputs fed to the simulation (auditable, replayable) |
| `garden_snapshots` | Monday checkpoints so long histories replay fast |
| `garden_plants` | Queryable projection of the snapshot's plants (position, health, hydration, maturity, state, habitat role) |
| `garden_species` | Catalog projection (the catalog itself lives in code: `packages/garden-engine/src/species.ts`) |
| `garden_unlocks` | Species unlock dates per user |
| `garden_wildlife` | Presence per wildlife kind (id = `userId:kind`) |
| `garden_scene_layouts` | Renderer/layout versioning for scene migrations |

## Analytics & product (`product.ts`)

| Table | Purpose |
|---|---|
| `computed_metrics` | Cached metric results keyed by `metric_key` with input fingerprint, status (`ok` \| `insufficient_data`), sample size |
| `motivation_evidence` | Evidence cards shown on Today (dismissable, unique per card) |
| `weekly_reviews` | One row per ISO week: deterministic `facts` JSON always; `narrative` only when the LLM ran (model + cost recorded) |
| `dismissed_insights` | Insight-card dismissals |
| `llm_usage` | Every LLM call: tokens, `cost_micros`, cache hit, request fingerprint — the source for budget enforcement |

## Operations (`ops.ts`)

| Table | Purpose |
|---|---|
| `sync_runs` | Every sync execution (kind, device, status, stats JSON) |
| `sync_errors` | Sanitized error records (category + truncated message — never tokens/payloads) |
| `provider_cursor_state` | Incremental-sync cursors (e.g. the Google Calendar events sync token), id = `userId:provider:cursorKey` |
| `webhook_events` | Webhook inbox with **dedupe-key primary id** (`strava:{type}:{id}:{aspect}:{event_time}`) and processing status |
| `audit_events` | User-relevant actions (moves, write results, deletions) |
| `schema_versions` | App-level component versions (`simulation` \| `normalizer` \| `estimator` \| `renderer`) — DB migrations themselves are tracked by wrangler/drizzle |

## Retained provenance fields

Provider data is never absorbed anonymously. Wherever external content lands,
these travel with it:

- **provider** + **provider id** (`activity_source_links.provider` /
  `provider_activity_id`, `planned_workouts.source_workout_id` /
  `source_program_id` / `source_id_in_plan`, `training_plans.source_plan_id`)
- **first/last seen** (`activity_source_links.first_seen_at` / `last_seen_at`)
- **content fingerprint** (stable hash of normalized content — drives change
  detection, write preconditions, calendar diffing, LLM caching)
- **normalizer version** (`activity_source_links.normalizer_version`, currently
  `1.0.0`) and **source version** (`pb_version`/`version` where COROS provides
  one), so historical rows can be re-normalized safely.
