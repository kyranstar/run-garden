# Build status tracker

Internal working document. Updated continuously during the build so progress survives
context compaction. Not user documentation.

## Environment facts

- Machine: macOS (darwin 24.1), Node v21.7.3, pnpm 10.32.0, git 2.47.1
- No Rust toolchain locally → Tauri desktop app is written completely but compiled via
  documented command / CI, not in this session.
- Network available (npm registry reachable).
- Repo: /Users/kyranadams/src/run-garden (git, branch main)

## Locked architecture decisions

- pnpm monorepo, TypeScript-first, internal packages consumed as source (exports → src/,
  no build step for internal packages; Vite/wrangler/vitest compile TS directly).
- Scope `@rg/*` for packages. Product display name lives in `packages/domain/src/branding.ts`
  only. DB name, calendar name etc. read from config, not hardcoded.
- Zod v3, Luxon for timezone/DST math, Hono v4 on Cloudflare Workers, D1 + Drizzle,
  React 18 + Vite + React Router v7 (library mode) + TanStack Query v5, Tauri 2.
- COROS bridge: TypeScript service in services/coros-bridge, NDJSON over stdio,
  spawned as Tauri sidecar (packaged w/ bun --compile or run via node in dev).
  Credentials held by Rust core via keyring crate; passed to sidecar over stdin only.
- Device auth: Ed25519 keypair on desktop, public key registered with worker,
  job claims/results signed. WebCrypto Ed25519 on worker for verification.
- Garden: event-sourced deterministic engine in packages/garden-engine, seeded PRNG
  (mulberry32 on stable hash), SVG renderer in packages/garden-renderer.
- LLM: worker-side only, Haiku class, hard budget in D1 `llm_usage`.

## Phase checklist

- [x] Phase 0: repo init, root configs
- [ ] Phase 1: COROS/Strava research (3 background agents running; findings land in
      docs/research/*.md → consolidate into docs/COROS_INTEGRATION_FINDINGS.md)
- [ ] Phase 2 foundation: domain → database → providers → scheduling → calendar →
      analytics → garden-engine → garden-renderer → ui → api-client → worker → web →
      coros-bridge → desktop
- [ ] Phase 3: core vertical loop wired (fixture mode end-to-end)
- [ ] Phase 4: garden vertical loop + visual QA
- [ ] Phase 5: full P0 (states, errors, tests, docs)
- [ ] Phase 6: P1 analytics modules
- [ ] Phase 7: hardening, screenshots, final report

## Notes / gotchas discovered

- RESEARCH (verified by agents, details in docs/research/):
  - COROS official MCP exists: https://mcp.coros.com/mcp (repo coroslab/COROS-MCP,
    launched 2026-05, free, OAuth via COROS account). 22 READ tools incl.
    queryTrainingSchedule, activities+laps+FIT, sleep, HRV, recovery, training load.
    Write tools (generateTrainingPlan, updateTrainingPlan, queryTrainingPlanDetail)
    are listed "coming soon". → OfficialCorosProvider = MCP client in worker with
    runtime tools/list capability probing; writes stay on desktop bridge until
    official write tools ship. No public REST API for individuals (partner path
    via api@coros.com only).
  - Strava: API access requires Strava subscription since 2026-06-01 (~$12/mo).
    Single-player mode (own account) needs no review. Webhooks: hub.challenge echo,
    200 within 2s, 3 attempts. 2027-06-01 breaking: base URL www.api-v3.strava.com +
    header-only auth → make base URL configurable, always use Bearer header.
    AI terms: no "model training"; inference gray area after StravaChat enforcement →
    EXCLUDE Strava-sourced fields from LLM inputs (weekly review uses COROS/derived
    aggregates only). Strava integration must be clearly optional (it already is per spec).
- Strava webhook: subscription creation needs callback URL live first; document ordering.
