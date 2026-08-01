# COROS Official API Surface — Research Notes

Researched 2026-08-01. Feeds the run-garden integration decision. Every claim is tagged
`[verified]` (checked against a primary source, URL in Sources) or `[inferred]`.

## Summary

- COROS has **no public developer portal and no public API reference**. Official API access is
  granted through a standardized application (email + form), issuing OAuth 2.0 client
  credentials; docs are shared only after approval. `[verified]`
- The application process is aimed at **platforms/companies**, not personal-use developers. COROS
  explicitly tells individual users to forward the application contact to the developer of the app
  they want connected. Nothing prohibits a solo developer applying on behalf of their own app, and
  COROS describes the process as "standardized, objective... non-discriminatory" (GDPR / EU Data
  Act framing), but there is no self-service personal-access path. `[verified]` (openness to solo
  apps: `[inferred]`)
- **An official write path exists at the partner level**: Runna, TrainingPeaks, Final Surge, and
  Decathlon all get structured workouts/training plans into the COROS calendar and onto the watch.
  For TrainingPeaks the mechanism is COROS pulling from TrainingPeaks' API; for Runna/Decathlon the
  wording indicates pushing to the COROS server. `[verified]`
- COROS ships an **official MCP server** (`https://mcp.coros.com/mcp`, repo `coroslab/COROS-MCP`),
  live since 2026-05-05 — the first official MCP from a major watch brand. It is currently
  **read-only**; three training-plan tools including two write tools (`generateTrainingPlan`,
  `updateTrainingPlan`) are documented as **"coming soon"**. `[verified]`
- Practical takeaway for run-garden: today, an individual can get official *read* access via the
  MCP with nothing but a COROS account login; official *write* (scheduling workouts) is either
  (a) partner API access via the application process, or (b) waiting for the MCP write tools.
  `[verified]` (that these are the only official routes: `[inferred]` from absence of any other
  documented path)

## Access model

- Application process (support article "Submit an API Application", created 2023-07-03, last
  updated 2026-07-27) `[verified]`:
  1. Submit company details, technical contacts, and OAuth 2.0 redirect URIs via
     `api@coros.com` and an application form (Feishu/Lark form:
     `https://coros-teams.feishu.cn/share/base/form/shrcnLqSduZsaNhbvDJTO2x0Vlf`).
  2. Accept "standard, non-discriminatory API Terms of Use, which include standard security
     requirements, data privacy compliance, and system rate limits."
  3. Receive **API Client ID and Secret** once "identity and security specifications are verified."
- Exact quote for individuals `[verified]`: "If you are an individual user looking to connect
  COROS to a specific app, please forward this email (api@coros.com) to the developer of that
  platform so they can complete standard onboarding and enable the connection."
- COROS frames access as open to "any platform that satisfies our standard security and
  operational requirements," motivated by GDPR and the EU Data Act. `[verified]`
- API documentation is **private** — Nango's integration page states COROS provides docs only
  after application approval and lists no OAuth endpoints or scopes publicly. `[verified]`
- Hostname checks on 2026-08-01 `[verified]`: `open.coros.com` → HTTP 404 at root (host exists,
  nothing public served); `apis.coros.com` → connection failed (no public service);
  `api.coros.com` → 404 at root; `mcp.coros.com` → 401 (live, auth-gated). No public endpoint
  documentation exists on any of these. Community projects (e.g. `NYT87/coros-connect`,
  `cygnusb/coros-mcp`) instead reverse-engineer the private COROS Training Hub app API, which
  "could break anytime." `[verified]`
- Aggregators (Terra, Spike) offer COROS data through their own platforms — a paid indirect route
  that avoids applying to COROS directly. Terra's COROS integration is read-only (activity, daily,
  sleep). `[verified]`

## Read capabilities

No public endpoint list exists for the partner API `[verified]`. What it demonstrably exposes,
based on what partners receive:

- Completed activities/workout files — synced outbound to Strava, TrainingPeaks, Runna, Final
  Surge, etc. `[verified]`
- Resting heart rate, HRV, and sleep data — COROS states these sync to TrainingPeaks alongside
  completed activities. `[verified]`
- Via Terra (aggregator on top of COROS): activity payloads with heart rate, GPS position, power,
  calories, distance; daily summaries; sleep metrics. `[verified]`
- The official MCP (see below) demonstrates the read surface COROS is willing to expose:
  activities + laps + FIT files, daily health, sleep, sleep HRV, stress/health time series,
  recovery status, menstrual cycles, VO2max/race predictions, training load, training schedule,
  devices, profile. `[verified]`
- Concrete partner-API endpoint paths: **not publicly documented anywhere I could find.**
  `[verified absence]`

## Write capabilities

- **Partner-level write to the COROS training calendar exists and is in production**
  `[verified]`:
  - Runna: "the next two weeks of workouts will be synced automatically to your COROS app";
    edits propagate automatically; "Runna cannot send workouts to COROS on dates in the past."
  - Decathlon (COROS's own description): "sync structured workouts and training plans to the
    COROS server for use in the COROS app and COROS Training Hub."
  - TrainingPeaks: "Your COROS account can receive workouts and training plans from
    TrainingPeaks"; supported structured workout types are **Run, Bike, Swim, Strength** only.
  - Final Surge: "Sync your Final Surge workouts to COROS."
- This write path is **partner-only**: it requires completing the API application; there is no
  documented self-service or personal-token way to push a workout. `[verified absence of any
  other path; "partner-only" is inferred from that absence]`
- Official MCP write tools (`generateTrainingPlan` — "Create and save a COROS training plan based
  on designed structured workouts. Supports running, cycling, strength, rest workouts, and phase
  descriptions." — and `updateTrainingPlan`) are listed **"coming soon"** in the official repo
  (repo state: last commit 2026-06-26, checked 2026-08-01). `[verified]`
- COROS's own MCP page says authorization "may include both read access to analyze training data
  and write access for supported actions within the connected experience" but details no specific
  write action — consistent with write being announced but not yet shipped. `[verified quote;
  interpretation inferred]`
- the5krunner (2026-05-13) independently reported the MCP as read-only at launch with "write
  permissions as a near-term update." `[verified]`
- Community write path exists today via the **unofficial** app API (e.g. `cygnusb/coros-mcp`
  manages "structured workouts" through the reverse-engineered API) — unsupported and fragile.
  `[verified existence; not official]`

## Partner integrations (how third-party plans reach COROS calendars)

- User-facing flow is uniform `[verified]`: user links accounts (OAuth-style login either in the
  partner app with COROS credentials, e.g. Runna, or in the COROS app under Settings → 3rd Party
  Apps → Data Sync, e.g. TrainingPeaks); the partner plan then appears in the COROS app's
  **Training Plan Library → My Training Plans**; the user starts the plan and taps "Sync with your
  device" to push workouts to the watch. The watch also receives updated plans on each app sync.
- Directionality differs by partner:
  - **TrainingPeaks → COROS is a COROS-side pull**: "Coros will pull TrainingPeaks Structured
    Workouts for the next 7 days in your TrainingPeaks calendar (including today)"; changes must
    be made in TrainingPeaks and manually refreshed in the COROS app. So that integration
    consumes TrainingPeaks' partner API — it does not prove a COROS write endpoint. `[verified
    via TrainingPeaks help article snippet]`
  - **Runna → COROS is a push with a 2-week window** and automatic propagation of edits;
    Decathlon "sync[s] structured workouts and training plans to the COROS server" — these
    indicate COROS accepts inbound structured-workout writes from approved partners. `[verified
    quotes; push mechanism inferred from wording]`
- Constraints observed `[verified]`: TP sync window 7 days, Runna window 2 weeks; structured
  workouts only (text-description workouts don't sync); Run/Bike/Swim/Strength only; plan
  modifications cannot be made on the COROS side; Runna requires a Premium subscription.

## Official MCP status

- **Official and first-party** `[verified]`: repo `github.com/coroslab/COROS-MCP` ("first
  officially supported MCP from a major sports watch brand"), announced on coros.com, hosted at
  `https://mcp.coros.com/mcp` with regional standalone URLs `mcpcn`/`mcpeu`/`mcpus.coros.com/mcp`.
  Free of charge. Launched 2026-05-05; regions consolidated 2026-05-19; major data expansion
  2026-06-22/23 (FIT files incl. GPS + second-by-second data, laps/splits, sleep HRV, stress and
  health-check time series, menstrual cycles, workout feedback/notes).
- **Auth** `[verified]`: OAuth-style browser authorization against the user's COROS account
  (stateless MCP flow; no `Mcp-Session-Id`). Works with ChatGPT, Claude, Codex, Cursor, etc.
  There is also an npm agent skill (`npm install -g coros-mcp`) with a login-gateway helper
  script for CLI agents.
- **Tools live as of repo state 2026-06-26** `[verified]`, 22 total:
  - Activity: `querySportRecords`, `getActivityDetail`, `analyzeActivityDetail`,
    `queryActivityLapData`, `queryCustomActivityLapData`, `downloadActivityFitFiles`,
    `queryActivityFitFileDownloadUrls`
  - Health: `queryDailyHealthData`, `querySleepData`, `querySleepHrv`, `queryAvgHeartRate`,
    `queryRestingHeartRate`, `queryStressLevel`, `queryHealthCheckTimeSeries`,
    `queryStressTimeSeries`, `queryRecoveryStatus`, `queryMenstruationCycles`
  - Training: `queryFitnessAssessmentOverview`, `queryTrainingLoadAssessment`,
    `queryTrainingSchedule`
  - Other: `queryDevices`, `queryUserInfo`
- **Coming soon** `[verified]`: `queryTrainingPlanDetail`, `generateTrainingPlan`,
  `updateTrainingPlan`.
- Limits `[verified]`: 50 FIT-file retrievals per account per calendar day.

## Duration estimate fields

- The only official reference to planned-workout estimates is the `queryTrainingPlanDetail` tool
  description (coming soon): "Query training plan details for confirming the current plan, workout
  dayNo, idInPlan, **estimated metrics**, and original workout structure before updating a plan."
  `[verified quote]` — strongly suggests planned workouts carry estimated metrics (duration and/or
  distance) in the data model, but the field schema is unpublished. `[inferred]`
- `queryTrainingSchedule` (live) returns the week's/date-range plan and "internal identifiers for
  subsequent planning tools"; whether its payload includes estimated durations is **not publicly
  documented**. `[verified absence]`
- The COROS app itself displays estimated duration for planned structured workouts, so the value
  exists server-side; exposure through the partner API is undocumented publicly. `[inferred]`
- Related but distinct: `queryRecoveryStatus` returns "estimated full recovery time."
  `[verified]`

## Sources (URLs)

Primary / official:
- https://support.coros.com/hc/en-us/articles/17085887816340-Submit-an-API-Application — API
  application process (full text retrieved via Zendesk JSON API, updated 2026-07-27)
- https://support.coros.com/hc/en-us/articles/360040256531-Supported-3rd-Party-Apps — partner
  list incl. Runna/Decathlon/Final Surge descriptions (updated 2026-07-31)
- https://support.coros.com/hc/en-us/articles/7909668497940-Syncing-Runna-Training-Plans-to-COROS
  (updated 2026-07-29)
- https://support.coros.com/hc/en-us/articles/360052332691-Downloading-Training-Plans-from-TrainingPeaks-to-COROS
  (updated 2026-08-01)
- https://github.com/coroslab/COROS-MCP — official MCP repo (README + CHANGELOG + skill,
  cloned; last commit 2026-06-26)
- https://coros.com/stories/coros-metrics/c/mcp-testing — official MCP announcement/testing page
- https://mcp.coros.com/mcp — official MCP endpoint (401 unauthenticated, confirmed live)
- Application form: https://coros-teams.feishu.cn/share/base/form/shrcnLqSduZsaNhbvDJTO2x0Vlf
- Contact: api@coros.com

Secondary:
- https://help.trainingpeaks.com/hc/en-us/articles/360041756752-Coros — TrainingPeaks side of the
  integration (7-day pull; via search snippet, page not fetched directly)
- https://the5krunner.com/2026/05/13/coros-mcp-ai-data/ — independent analysis of MCP at launch
  (15 endpoints, read-only, write signposted; partially outdated by the June 2026 update)
- https://docs.nango.dev/integrations/all/coros — confirms COROS API docs are private,
  no public OAuth endpoints/scopes
- https://tryterra.co/integrations/coros — aggregator read-only COROS data (activity/daily/sleep)
- https://github.com/cygnusb/coros-mcp — community MCP on the unofficial API (has workout writes)
- https://github.com/NYT87/coros-connect , https://github.com/xballoy/coros-api — community
  clients of the unofficial Training Hub API
