# COROS Integration Findings

Research date: **2026-08-01**. This document consolidates the verified state of every
COROS integration path and records the decisions the implementation is built on.

Detailed source-level evidence (with repo/file/line citations for every claim) lives in:

- [`docs/research/coros-official-api.md`](research/coros-official-api.md) — official API / MCP
- [`docs/research/coros-community-clients.md`](research/coros-community-clients.md) — reverse-engineered Training Hub API (the implementation reference for the bridge)

Claims below are tagged [verified] (source code, captured payloads, or live-confirmed
docs in maintained repos) or [inferred].

---

## 1. Summary of the landscape

| Path | Status (2026-08) | Used by Run Garden as |
|---|---|---|
| Official COROS REST API | Partner-only; application via api@coros.com; no public docs [verified] | Not used (no self-service access) |
| **Official COROS MCP** (`https://mcp.coros.com/mcp`) | Live, free, OAuth via COROS account. 22 **read** tools: activities, laps, FIT, sleep, HRV, recovery, training load, `queryTrainingSchedule` [verified] | Optional cloud read provider; **runtime capability probing** for the announced write tools |
| Official MCP write tools (`updateTrainingPlan`, `generateTrainingPlan`, `queryTrainingPlanDetail`) | Publicly listed **"coming soon"** in `coroslab/COROS-MCP` (changelog 2026-06-24) [verified] | Auto-upgrade target: when `tools/list` starts returning them, official writes become preferred |
| **Unofficial Training Hub web API** (`teamapi`/`teameuapi`/`teamcnapi.coros.com`) | Fully reverse-engineered; schedule **read and write live-tested** by community repos [verified] | **Primary read/write path, via the desktop bridge only** |
| COROS mobile-app API (`api*.coros.com`) | AES-encrypted login; **logs the user out of the COROS phone app** (two independent reports) [verified] | **Never used** |

Capability priority mapping (per product requirement):

1. Official supported write → **not available today**; detected at runtime via MCP `tools/list`.
2. Verified unofficial Training Hub schedule-update → **available**; the implemented write path.
3. Remove-and-reinsert fallback → available (`status:3` delete + `status:1` create with full
   program clone); implemented as the degraded fallback.
4. Calendar-only scheduling → implemented as the automatic fallback state.
5. Manual COROS instructions → implemented in the write-failure UI.

---

## 2. Unofficial Training Hub API — verified facts the bridge is built on

### Authentication [verified]

- `POST {regionalHost}/account/login` with
  `{"account": email, "accountType": 2, "pwd": md5hex(password)}` →
  `data.accessToken`, `data.userId`.
- Regional hosts: `https://teamapi.coros.com` (US), `https://teameuapi.coros.com` (EU),
  `https://teamcnapi.coros.com` (CN/Asia). Login succeeds cross-region but the token is
  only valid on the account's regional host.
- Headers on authenticated calls: `accessToken: <token>` plus
  `yfheader: {"userId":"<userId>"}` for the `/training/*` family.
- Token TTL ≈ 24 h, no refresh endpoint → re-login. Server-side validity check: any cheap
  authenticated call (community repos use `GET /dashboard/query`) returning result `1019`
  means expired.
- Response envelope: `{apiCode, message, result, data}`; success is `result === "0000"`;
  HTTP status is 200 even for logical errors. Known codes: `1019` invalid token,
  `1030` bad credentials, `1031` parameter error, `1001` wrong param names,
  `5011` date range too wide.
- Web login does **not** log out the phone app (multiple web tokens coexist) [verified].
  The mobile-app login **does** [verified] — which is why sleep-stage data (mobile-only)
  is excluded from the bridge (see §5).
- Logins from datacenter IPs are rejected (403) [verified] → all Training Hub calls run
  from the desktop bridge on a residential connection. The cloud worker never calls
  `teamapi.*`.

### Schedule read [verified]

- `GET {base}/training/schedule/query?startDate=YYYYMMDD&endDate=YYYYMMDD&supportRestExercise=1`
  returns the **active plan object**: `data.id` (planId), `name`, `startDay`, `endDay`,
  `maxIdInPlan`, `pbVersion`, `version`, `entities[]` (calendar placements), `programs[]`
  (workout definitions), joined by `idInPlan`.
- Range must stay modest (±45 days works; multi-year spans → `5011`).
- `entities[]`: `id`, `idInPlan`, `planId`, `planProgramId`, `happenDay` (YYYYMMDD),
  `dayNo` (1-based offset from plan start), `sortNo`, `sortNoInSchedule`, `completeRate`,
  `sportData{}` (the matched completed activity).
- `programs[]`: workout structure (`exercises[]`), `sportType` (workout namespace:
  1=Run 2=Bike 3=Swim 4=Strength), `subType` 65535 = structured, and the
  **native duration-estimate fields** (§3).
- `POST /training/plan/query` returns only library plans, **not** the active plan —
  never used to resolve the write target [verified-live].
- Program names/overviews are i18n keys (`T1120`, `sid_run_warm_up_dist`); resolved via
  the unauthenticated CDN bundle
  `https://static.coros.com/locale/coros-traininghub-v2/en-US.prod.js`.

### Schedule write [verified, live-tested in community repos]

One endpoint: `POST {base}/training/schedule/update` with
`{entities:[…], programs:[…], versionObjects:[{id, status, planProgramId, planId}], pbVersion:2}`.

- `versionObjects[].status`: **1 = create, 2 = update, 3 = delete**.
- **Update** (our preferred path for date moves): send the **full raw entity and program
  objects exactly as read**, with only the intended field (`happenDay`, plus recomputed
  `dayNo`) modified. Requires `idInPlan` and `planId`. This preserves plan ID, program ID,
  `idInPlan`, structure, targets, and version fields — exactly what the product requires.
- **Create**: `idInPlan` must be `maxIdInPlan + 1`, re-read fresh immediately before the
  push; the counter is monotonic and never decrements. Read-then-write is racy →
  **all COROS writes are serialized** through the single job-queue executor.
- **Delete**: `versionObjects` only; hard delete; `0000` on success.
- **One workout per call** — multi-entity payloads are rejected ("Plan data is illegal").
- The update response does **not** echo server-assigned ids → the bridge always performs a
  fresh `schedule/query` read-after-write and matches on `idInPlan` to verify.
- `planId: ""` auto-targets the active plan (create path).
- The server recomputes `distance`/`trainingLoad` from targets; HR bpm targets are
  remapped to the account's zones (do not expect exact HR round-trips).

### Duration estimates — the precise source fields [verified]

- **Primary: `programs[].duration` (integer seconds)**, mirrored by `estimatedTime`.
  This is the COROS-native estimate for every scheduled plan workout.
- Distance fields are in **COROS distance units = centimetres** (1 km = 100000);
  `distance` is a 2-dp string, `estimatedDistance` an int.
- `trainingLoad` (mirrored by `estimatedValue`) is the native load estimate.
- **Calculation endpoint: `POST /training/program/calculate`** with a full program object
  returns `planDuration` (seconds), `planDistance`, `planTrainingLoad` (Training Hub
  path) or bare `duration`/`trainingLoad` (library path) — the bridge reads
  `planDuration ?? duration`.

### Completed activities [verified]

- `GET /activity/query?size≤200&pageNumber&startDay&endDay&modeList=100,101,102,103` →
  `data.dataList[]`: `labelId` (activity id), `date`, `name`, `sportType`
  (activity namespace: 100 Run, 101 Indoor Run, 102 Trail, 103 Track…), `startTime`/
  `endTime` (unix **seconds**), `startTimezone` (15-minute units), `distance`,
  `totalTime`, `workoutTime`, `trainingLoad`, `avgHr`, `maxHr`, `device`, `calorie`
  (**physical cal — divide by 1000 for kcal**).
- `POST /activity/detail/query` → `summary` (~130 fields incl. `avgPace`,
  `adjustedPace`, `trainingLoad`, `currentVo2Max`), `lapList[]` (distances in cm,
  times in **centiseconds**), streams, zones.
- **`summary.planId` + `summary.programId` + `hasProgram` link a completed activity to
  its scheduled plan workout** — the authoritative planned-to-completed match signal.
- FIT/TCX/GPX export via `/activity/detail/download` (`fileType` 4=FIT) → signed URL.

### Daily health [verified]

- `GET /dashboard/query` (no params): HRV (`sleepHrvData`), `rhr`, `lthr`, `ltsp`,
  `recoveryPct`, `fullRecoveryHours`, zones. Also the cheapest token-validity probe.
- `GET /analyse/dayDetail/query?startDay&endDay` (≤24 weeks): per-day `rhr`,
  `trainingLoad`, `tiredRateNew`, `ati`/`cti` (acute/chronic load), `vo2max`,
  `staminaLevel`.

### Watch synchronization [verified]

There is **no working server-side push to the watch** (`/training/plan/sync` errors).
Calendar changes reach the watch when the COROS **phone app** next syncs. Product
consequence: after a verified write we say **"COROS calendar updated · Open COROS to
sync your watch"** and never claim "Updated on watch". `verifyWatchSync` is always
`false` in the capability report.

---

## 3. Decisions

| # | Decision | Rationale |
|---|---|---|
| D1 | Bridge speaks the Training Hub **web** API only; the mobile API is never called | Mobile login kills the user's phone-app session [verified]; web tokens coexist safely |
| D2 | Sleep duration/stages are **not** read via the bridge | Only available on the mobile API. Optional source: the official COROS MCP sleep tools (cloud OAuth). Sleep-dependent analytics suppress themselves when absent |
| D3 | Bridge is a TypeScript sidecar vendoring the verified endpoint/payload shapes above, pinned to this research snapshot | Community repos are MIT; shapes cross-verified across 5+ independent implementations |
| D4 | Date moves use `schedule/update` with `status:2` and the full re-read raw entity/program | Preserves identity fields; live-tested pattern |
| D5 | Remove-and-add fallback clones the raw program byte-for-byte, creates with `idInPlan = maxIdInPlan+1`, verifies, then deletes the original — insert-before-delete, with rollback | Ordering chosen so a mid-operation failure leaves a duplicate (visible, recoverable) rather than a lost workout |
| D6 | All writes serialized; re-read before write; idempotency by operation id; ambiguous network failures trigger read-before-retry | `maxIdInPlan` monotonic race + non-idempotent endpoint [verified] |
| D7 | Native duration = `programs[].duration`; calculation endpoint as fallback #2 | §2 verified field semantics |
| D8 | Official COROS MCP client (worker-side, OAuth) probes `tools/list` at connect and daily; capability report drives the UI | Official write tools are announced; when they ship, jobs route to the official path automatically per the product's priority order |
| D9 | Worker never holds COROS credentials; bridge runs on the Mac (residential IP) | Datacenter-IP 403s [verified] + product security requirement |
| D10 | Result-code handling: `1019` → re-login once and retry; `1030` → surface bad-credentials; `5011` → shrink range; anything else → sanitized error category | §2 envelope semantics |

## 4. Live write spike — status

The reversible write spike (move one approved low-risk workout one day and back, §"Initial
live write test" of the product spec) is implemented as a guided harness:

- `pnpm coros:spike` (CLI, runs the bridge locally), and
- the desktop app's Settings → COROS → "Run schedule write test".

It requires real COROS credentials, which are not available in this environment, so it
**has not yet been executed against a live account**. The harness snapshots raw objects,
performs the one-day move via the direct-update path, verifies both dates, reverses,
re-verifies, and writes a sanitized report to `docs/reports/coros-write-spike-<date>.json`.
Until the spike passes on the real account, the app treats unofficial writes as
**unproven** and ships with `corosWritesEnabled` defaulting to calendar-only + explicit
opt-in after a successful spike. This is the safety behavior the product spec requires.

## 5. Risk register (top items)

1. **`maxIdInPlan` race** — mitigated by single serialized executor + fresh read before
   every write + read-after-write verification.
2. **Payload fidelity fragility** — hand-built topologies can be rejected; we never
   hand-build: updates resend raw read objects; re-inserts clone raw programs.
   Any COROS web-app payload change can break writes → capability re-probing + clean
   calendar-only degradation is mandatory (and implemented).
3. **Unofficial auth model** — MD5 password to a reverse-engineered endpoint; 24 h TTL;
   credentials live only in the macOS Keychain; the cloud never sees them.
4. **HR target remapping** — irrelevant for date moves (we never rewrite targets), but
   remove-and-add verification compares structure with tolerance for server-normalized
   HR values.
