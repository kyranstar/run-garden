# Costs

Run Garden is designed to cost **$0–5/month** in infrastructure with a hard
**$10 per rolling 7 days** ceiling on the only metered variable (LLM), and to
degrade gracefully rather than surprise you. No paid notification, analytics,
or observability services are used anywhere — observability is the app's own
`sync_runs`/`sync_errors` tables and the diagnostics screen.

## Cloudflare (Workers + D1 + cron + assets)

A single-user deployment fits comfortably in Cloudflare's free tier
(100k requests/day; D1 free tier: 5M reads/100k writes per day, 5 GB):

| Load source | Scale |
|---|---|
| Cron: `*/30` calendar sync + hourly reconcile/garden + weekly review | ~72 scheduled runs/day |
| Bridge: snapshot every ~30 min + job poll every 45 s from one Mac | ~2k requests/day |
| Your own PWA usage + occasional Strava webhooks | negligible |

The **$5/mo Workers Paid** plan is a worthwhile upgrade for headroom (higher
CPU limits, bigger D1 quotas) but is not required. Expected bill: **$0 on
free tier, $5 with the paid plan.** Static assets (the PWA) are free.

## LLM (Anthropic, optional)

The only LLM use is **one weekly-review narrative** (`claude-haiku-4-5`,
priced in code at $1/M input + $5/M output tokens, ≤ 400 output tokens,
20 s timeout, 1 retry, cached by facts fingerprint —
`apps/worker/src/services/llm.ts`). One review consumes on the order of a
thousand tokens: **fractions of a cent per week** in normal use.

Enforced budget per rolling 7 days (from `llm_usage` cost records):

| Threshold | Amount | Behavior |
|---|---|---|
| Warn | **$2** | Settings shows a warning |
| Cutoff | **$8** | AI calls disabled automatically; facts stored without narrative |
| Absolute max | **$10** | Never exceeded — the cutoff fires first |

AI can also be disabled globally (`AI_DEFAULT_ENABLED=0`) or per-user
(preferences). The app is fully functional with AI off.

## Strava subscription (optional integration)

Since June 2026, Strava requires an active **Strava subscription
(~$12/mo)** on the developer's account for API access. That is **Strava's
requirement, not Run Garden infrastructure** — if you don't pay it, simply
don't connect Strava: COROS remains the complete source for completions, and
you only lose Strava titles/route polylines and the webhook fast-path.

## Scenarios

| Scenario | What happens | Cost impact |
|---|---|---|
| **Normal week** | Cron + one bridge + one weekly review | $0–5 infra, ~$0.01 LLM |
| **Heavy historical backfill** (importing months of activities) | A burst of D1 writes + garden checkpoint replay; bounded by D1 daily quotas — worst case the backfill spreads across a second day | $0 extra on paid plan; free tier may throttle for a day |
| **Increased AI usage** (re-running reviews, future AI features) | Budget enforcement: warn at $2, hard stop at $8/rolling week | Capped ≤ $10/week by construction |
| **Desktop offline for several days** | Jobs wait (`Waiting for Mac`), moves stay calendar-only, no missed-run misreads (grace periods) — nothing retries hot | $0 |
| **Large garden history** (years) | Replay uses Monday checkpoints, so resimulation reads stay proportional to one week + the affected span | $0 |

## Summary

| Line item | Monthly |
|---|---|
| Cloudflare Workers + D1 | $0 (free tier) or $5 (paid plan) |
| LLM (weekly review) | ≈ $0.05 typical; ≤ $10/**week** hard ceiling |
| Strava subscription (optional, Strava's fee) | ~$12 if you want Strava connected |
| Google Calendar API, COROS MCP, PWA hosting | $0 |
