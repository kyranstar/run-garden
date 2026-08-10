# Garden Reward Loop — Bundle 1 "The moment lands" — Design

*2026-08-05 · First of three bundles fixing `docs/reports/2026-08-05-garden-ux-audit-2.md` (audit items A1, A2, A3, A4, A5a–d, B3, B4, D1). Approved forks: signal-driven freshness + server-side seen watermark; preview folds forward read-only; wildlife first-arrival stays a light moment; rain-front impulse ships in this bundle.*

## Goal

When training lands, the garden shows it — same day, while you watch, with sensation. Four structural drops in the reward loop get closed: the stale query, the fragile preview, the day-late refresh-mortal ceremony, and the total absence of event-triggered motion.

**Non-goals (later bundles or deferred):** PR/weekly-review surfacing, notifications/tray (Bundle 2); new species/wildlife content, `ground` gate kind (Bundle 3); snapshot crossfade; sound; timeline event enrichment (audit D5); any engine simulation change — `SIMULATION_VERSION` stays 3.

## §1 Freshness (audit A1)

**Signal:** `SyncStatus.lastCorosReadAt` (`apps/worker/src/services/sync-status.ts`), already polled every 30s by `SyncPanel` (`packages/ui/src/screens/today.tsx:35`).

- In `SyncPanel`, keep the previous `lastCorosReadAt` in a ref; when it changes (and was previously non-null), invalidate `["garden"]` and `["garden-timeline"]`. `["today"]` already self-polls.
- Add `["garden"]` to the invalidation lists of the three completion-affecting mutations: match (`match-sheet.tsx:23-28`), link (`runs.tsx:99-104`), skip/defer/unskip (`today.tsx:164-169`).
- No new polling loops. No change to `staleTime`.

**Effect:** the scene updates ≤30s after a sync lands while the app is open, and immediately after any manual completion action.

## §2 Same-day preview folds forward (audit A2)

`buildGardenView` (`apps/worker/src/services/garden-sync.ts:517-533`) currently previews today only when `lastSimulatedDate === yesterday`. Replace the gate with a read-only fold:

- Starting from the durable snapshot, `simulateDay` forward from `lastSimulatedDate + 1` through today. For intermediate days, use each day's already-resolved inputs where they exist (same input-building path the durable sim uses); for unresolved days, neutral inputs (`completedRuns: [], missedRuns: [], restObserved: false, planGap: false`, current rest-mode flag).
- Today's day input is built exactly as now (completed runs + orphan activities).
- As today (`garden-sync.ts:527`), the folded snapshot **becomes the returned view snapshot** — the scene renders today's rain/plants, not yesterday's; this is what the §6 rain-front trigger observes.
- Preview events returned to the client = events from **today's** simulated day only (intermediate days' events are dropped — they'll arrive as durable rows when those days resolve; surfacing them early would double-report).
- Nothing is persisted; the durable `advanceGarden` path is untouched.
- Preview now runs whenever `completedRuns.length > 0` for today **or** the fold changed `weatherState`/condition (so a comeback run after a long gap previews its recovery rain).

Bound: the fold spans at most the resolution grace window in practice; cap at 14 days defensively (beyond that, fall back to the durable snapshot and no preview — matches the drought plateau anyway).

## §3 Server-side seen state + the arrival block (audit A3 + A4)

### Data

New table in `packages/database/src/schema/garden.ts` + migration `0004_garden_seen`:

```ts
export const gardenSeen = sqliteTable("garden_seen", {
  userId: text("user_id").primaryKey(),
  lastSeenDate: text("last_seen_date").notNull(),   // LocalDate of newest seen durable event
  lastSeenSeq: integer("last_seen_seq").notNull(),  // seq within that date
  celebratedSpeciesIds: text("celebrated_species_ids", { mode: "json" })
    .$type<string[]>().notNull().default([]),        // same-day (preview) unlocks already celebrated
  updatedAt: text("updated_at").notNull(),
});
```

### API

- `GET /api/garden` additionally returns `seen: { lastSeenDate, lastSeenSeq, celebratedSpeciesIds } | null` (null = never marked). Null is disambiguated by durable-event existence: a brand-new garden (no durable events) marks-seen silently without celebrating genesis; an existing garden missing the row (migration day) defaults the watermark to start-of-yesterday so the first post-deploy load doesn't replay all history as one arrival block.
- `POST /api/garden/seen` body `{ lastSeenDate, lastSeenSeq, celebratedSpeciesIds }` — upsert. `celebratedSpeciesIds` is client-computed and client-pruned to same-day entries (size-bounded by the 46-species catalog).

### Client: `selectArrival` (new pure module)

New file `packages/ui/src/screens/arrival.ts` — extracted from `garden.tsx` (which is 1615 lines and growing): `eventSentence`, `BEAT_PRIORITY`, and a new pure function:

```
selectArrival(events, seen, codex): {
  ceremonies: Array<{ kind: "species", speciesId } | { kind: "ground", ground }>,
  beatLines: string[],   // since-watermark durable events, priority-sorted
  todayLines: string[],  // preview events
}
```

Rules:
- **Ceremonies** = durable `species_unlocked` past the watermark ∪ preview `species_unlocked`, minus `celebratedSpeciesIds`, plus durable `region_unlocked` past the watermark (§4). Ordered: grounds first, then species by rarity desc.
- **The suppression ternary dies.** The arrival block renders ceremony queue → beat lines → today lines in one container, each section present when non-empty, with a single "See all → Log" link. Caps stay (3 beat / 2 today) but overflow is now reachable.
- Events consumed by a ceremony don't repeat as beat lines.

### Ceremony queue UX

- Sequential cards: dismissing one advances to the next; "See it in the garden →" selects the plant and advances.
- Mark-seen `POST` fires once per arrival-block presentation: on explicit dismiss of the last item, or after 6s of the block being visible with no ceremonies pending (debounced; fire-and-forget with one retry).
- `localStorage["rg-last-visit"]` and its read/write effects (`garden.tsx:794-797, 881-890`) are removed.
- The ceremony works on every route mount of GardenScreen exactly as now; cross-route chips remain out of scope for this bundle.

## §4 Region ceremony + rarity-aware verbs (audit B3 + B4)

- `UnlockCeremony` gains a `kind: "species" | "ground"` variant. Ground cards reuse the existing carving copy (`arrival.ts` ceremony sentences: "Long runs carved the stream — new ground, new water.") and the GroundsShelf inline SVG icons (`codex.tsx:522-567`, exported).
- `eventSentence` for `plant_added` becomes rarity-aware via `SPECIES_BY_ID`: uncommon → "An uncommon {name} took root."; rare → "A rare {name} has taken root — a lucky find." Common phrasing unchanged.
- `wildlife_arrived` inside the arrival window triggers a `sparkle` impulse (§6) anchored near the wildlife's scene anchor; copy unchanged; **no ceremony card** (approved fork).

## §5 Sensation: bars, sprout-in, glow (audit A5a–c)

- **Balance fill transition:** `.balance-bar-fill { transition: width 0.45s ease; }` under the existing `prefers-reduced-motion: no-preference` guard.
- **Sprout-in:** `GardenScene` gains `enteringPlantIds?: string[]`. Matching plant groups get a wrapper class animating `transform: scale(0.05→1)` over 600ms, `transform-origin` at the plant's base anchor, ease-out; keyframes emitted with the existing `sceneCss` block; skipped entirely under `reducedMotion` (plants appear instantly, as today). Transform-only — zero rng draws, zero filters. Source: `plant_added` events in the arrival window (durable-past-watermark ∪ preview).
- **Glow:** `GardenScene` gains `highlightPlantId?: string | null`, applying the existing outline filter (`sky.tsx:65-83`). GardenScreen schedules it: among arrival-window new plants, rarest first, 4s each, max 3 plants, then stops. **Invariant: at most one filtered plant at any time** — a user selection immediately cancels the scheduled glow (selected wins).

## §6 One-shot impulse channel + rain front (audit A5d)

`AtmosphereLayer` gains `impulse?: { kind: "rain_front" | "sparkle"; key: string; x?: number; y?: number } | null`.

- Implementation: an impulse system rendered alongside weather systems. When `key` changes, capture `t₀ = now`; every particle is analytic in `(t − t₀)` (pure function of seed + elapsed — same contract as `particles.ts:5-9`). System self-expires (rain front ~2.5s: a streak/splash band sweeping left→right; sparkle ~2s: ~12 golden motes rising from the anchor). Expired impulses draw nothing; no per-frame state.
- Never mounted under `reducedMotion` (the layer already isn't); no filters; canvas-only.
- **Triggers (GardenScreen):**
  - `rain_front`: a `useEffect` watching `snapshot.state.weatherState` transition into `fresh_rain`/`recovery_rain` across refetches while `viewingLive` (prev-value ref; no fire on first mount).
  - `sparkle`: rare/uncommon `plant_added` or `wildlife_arrived` in the arrival window; anchor passed as normalized scene coords from the plant's `position` (or the wildlife anchor fallback), scaled inside the layer.

## §7 The sun ticks (audit D1)

`hourOfDay` (`garden.tsx:802`) becomes state advanced by a 60s `setInterval` (ambient's proven pattern, `ambient.tsx:107-114`). Interval always on while mounted; a discrete once-a-minute update is not motion, so no reduced-motion gate.

## Error handling

- Mark-seen POST failure: fire-and-forget with one retry; on failure the same arrivals re-present next visit (idempotent, mildly repetitive, never lossy).
- Fold-forward failure (bad stored day input): catch per-day, fall back to the durable snapshot + no preview — never a 500 on `GET /garden`.
- Missing `seen` row + non-genesis garden (migration day): treat watermark as "start of yesterday" so the first post-deploy load doesn't dump the entire history as one giant arrival block.

## Testing

- **Worker** (`apps/worker/test`): fold-forward — gaps of 0/1/2/14 days, unresolved-day neutrality, events limited to today's day, cap fallback; seen route — upsert, shape validation; migration-day watermark default.
- **UI**: `selectArrival` pure-function suite (durable ∪ preview − celebrated; ground ordering; suppression-ternary regression: beat and today both render); invalidation wiring via existing screen-test harness (mock lastCorosReadAt change → garden query invalidated).
- **Renderer** (`packages/garden-renderer/test`): `enteringPlantIds` wrapper presence + absence under reducedMotion; determinism regression (same snapshot ± entering/highlight props → identical geometry, only wrapper/filter attrs differ); impulse system — analytic-in-elapsed contract (two renders at same `(t−t₀)` identical), self-expiry.
- **Verification:** full suite under Node 21 (`pnpm test`); typecheck; visual spot-check via the export harness (`EXPORT_DIR` scenes) for the entrance wrapper markup.

## Rollout

One D1 migration (`0004_garden_seen`), additive. No engine version bump, no COROS surface touched, no PWA cache shape change (new `seen` field is additive to the garden payload). Commits to `main`, push (deploy) when the bundle is green.
