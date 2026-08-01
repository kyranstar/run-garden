# COROS Training Hub API — Community Client Survey (source-derived)

Research date: **2026-08-01**. Everything below is extracted from **source code, test fixtures, or
captured HTTP requests** in unofficial community clients, not from README prose (except where
explicitly marked). Each item is tagged:

- `[verified-in-source]` — the exact URL / field name / payload appears in code, a captured curl, or a fixture.
- `[verified-live]` — the repo's own docs state it was confirmed against a real account, and the code matches.
- `[inferred]` — deduced by me from surrounding code; not directly asserted anywhere.

Clone location used for this survey (shallow clones, `--depth 1`):
`/private/tmp/claude-501/-Users-kyranadams-src/d6194db3-aa2c-4c70-bb75-14b7b5ddd60d/scratchpad/coros-research/`

---

## 0. Repository inventory

### 0.1 Repos cloned and read

| Repo | Lang | Stars | Last push | License | What it covers | Verdict |
|---|---|---|---|---|---|---|
| **cygnusb/coros-mcp** | Python | 104 | 2026-07-24 | MIT | Auth (web + mobile AES), HRV, daily metrics, sleep, activities, workout programs, **full schedule CRUD**, calculate, exercise catalog, SQLite cache | **Best base.** Broadest + best-documented surface. |
| **laurenceomfoisy/open-coros-training** | Python | 1 | 2026-05-31 | MIT | Schedule write only, but with a **captured raw web-app payload** and a live-confirmed API doc | **Best schedule-WRITE reference.** Highest-fidelity write semantics. |
| **rowlando/coros-workout-mcp** | TypeScript | 25 | 2026-07-08 | MIT | Strength workout create; ships **raw DevTools curl captures** of calculate→add→query | Best raw-capture artifact. |
| **xballoy/coros-api** | TypeScript/Nest | 61 | 2026-07-27 | MIT | Activity export to FIT, training schedule → ICS. Zod schemas + MSW fixtures + Bruno collection | Best-maintained; strongest typing of read paths. |
| **Ericyuanxiang/coros-ai-coach** | Python | 3 | 2026-05-30 | MIT | Fork-lineage of coros-mcp with a **much wider endpoint table** (plan add/update/delete/copy, program detail/update/copy, account, teams, FIT import) | Best endpoint *breadth*; several endpoints unexercised. |
| **NYT87/coros-connect** | TypeScript | 15 | 2026-05-12 | MIT | Activity read/detail/download + FIT upload via OSS STS | Only source with the OSS/STS upload path. |
| **dlenski/corostc** | Python | 1 | 2025-11-07 | (see repo) | Activity list/download/upload/delete/update CLI | Cleanest activity-list field decoding. |
| **shenmiguo/coros-data-skill** | JS | 0 | 2026-07-22 | — | Dashboard, account, **`/training/plan/add`** and `/training/program/add` builders (CN region) | Only source with `/training/plan/add` body. |
| **gandroz/coros_data_extractor** | Python | 12 | 2025-12-19 | (see repo) | Activity export | Confirms base URL + pagination limits. |
| **coroslab/COROS-MCP** *(OFFICIAL)* | — | 19 | 2026-06-26 | none | Hosted OAuth MCP at `https://mcp.coros.com/mcp`. No local HTTP client to read. | Context only — see §11. |

### 0.2 `github.com/cygnusb/coros-mcp` — **exists** `[verified-in-source]`

`git ls-remote` returns HEAD `c23c8c06`, branches `main`, `feat/ruff-mypy-expanded-linting`,
`test/cache-coverage`, plus `refs/pull/1/head`. GitHub API: 104 stars, MIT, 1 open issue,
pushed 2026-07-24, not archived.

### 0.3 Other community repos found (not cloned; listed for completeness)

`futoshita/Coros-Training-Hub-Exporter` (23★, stale 2023), `simon-hv/splitlog`,
`mtzanidakis/coros-query`, `ricvath/coros-coach`, `ytasak/coros-mcp-go` (Go),
`zhaojingqian/local-coros-mcp`, `llpan91/coros-mcp` (fork of cygnusb),
`jgretz/coros-run-plan-mcp`, `dholliday3/coros-training-mcp`, `durkie/omniauth-coros` (Ruby OAuth
strategy for the *official partner* API, not this one), `Taerc-DUO/skill--openclaw-coros-coach`,
`liumy-qd/running-coach-skill`, `HenrikBrehm/triathlon-coach-skill`.

---

## 1. Transport basics

### 1.1 Region hosts (Training Hub "web" API) `[verified-in-source]`

`cygnusb/coros-mcp/coros_mcp/coros_api.py:65-70`:

```python
BASE_URLS = {
    "eu":   "https://teameuapi.coros.com",
    "us":   "https://teamapi.coros.com",
    "asia": "https://teamcnapi.coros.com",
    "cn":   "https://teamcnapi.coros.com",
}
```

Cross-confirmed by `xballoy/coros-api/api/environments/{America,Europe,China}.bru`
(`https://teamapi.coros.com`, `https://teameuapi.coros.com`, `https://teamcnapi.coros.com`),
`NYT87/coros-connect/src/config.ts:24-26`, `dlenski/corostc/corostc/__init__.py:20`,
`gandroz/.../data/constants.py:5`, and `shenmiguo/.../scripts/coros.js:6` (`teamcnapi`).

**Critical routing note** `[verified-in-source]` — `coros_api.py:63-64` comment:
> "Login works on teamapi.coros.com but tokens are only valid on the region-specific API host.
> Always use the regional URL for all calls."

Front-end origins seen in captures `[verified-in-source]`:
`https://trainingeu.coros.com` (EU, `rowlando/.../research/create-workout-request-all.txt`),
`https://t.coros.com` (Teams UI, `open-coros-training/coros/client.py:50-52` and
`shenmiguo/.../coros.js:12-13`), `https://training.coros.com` (`dlenski/corostc:19`).

Region cookie observed in the EU capture `[verified-in-source]`:
`CPL-coros-region=3` (EU) with `CPL-coros-token=<accessToken>`; `shenmiguo/.../coros.js:78` sets
`CPL-coros-region=2` (CN). ⇒ `[inferred]` region ids: 1=CN?, 2=CN/US?, 3=EU. `Ericyuanxiang/coros_api.py:2540`
documents a different mapping for the *public library* import endpoint: `1=CN, 2=US, 3=EU`.

### 1.2 Mobile-app API hosts (different service) `[verified-in-source]`

`cygnusb/coros-mcp/coros_mcp/coros_api.py:73-78`:

```python
MOBILE_BASE_URLS = {
    "eu":   "https://apieu.coros.com",
    "us":   "https://api.coros.com",
    "asia": "https://apicn.coros.com",
    "cn":   "https://apicn.coros.com",
}
```

### 1.3 Envelope `[verified-in-source]`

Every Training Hub response is:

```json
{ "apiCode": "91B8C17A", "message": "OK", "result": "0000", "data": <payload> }
```

Zod schema: `xballoy/coros-api/src/coros/common.ts:3-7` (`apiCode`, `message`, `result` all
`z.string()`). Success test: `result === "0000"` (`cygnusb/coros_api.py:97`,
`xballoy/base-request.ts:37`, `NYT87/src/types/enums.ts` `ResponseCodes.Success='0000'`).
`open-coros-training/coros/client.py:32` also accepts `"0"`.

**Known result codes** `[verified-in-source]`:

| code | meaning | source |
|---|---|---|
| `0000` | OK | all repos |
| `1019` | "Access token is invalid" / expired | `cygnusb/coros_api.py:417,1979` |
| `1030` | bad credentials | `open-coros-training/client.py:33`, `NYT87/enums.ts` |
| `1031` | "Parameter input error" | `open-coros-training/docs/API.md:82` (for `/training/plan/add`) |
| `1001` | "Service exceptions" (wrong param names on schedule/query) | `open-coros-training/docs/API.md:32` |
| `5011` | "The date is out of range" (schedule/query span too wide) | `open-coros-training/docs/API.md:33` |

HTTP status is 200 even for logical errors `[verified-in-source]` — `client.py:89-104` reads
`result` regardless of status.

### 1.4 Required headers on authenticated calls `[verified-in-source]`

```
accessToken: <token>                       # case-insensitive in practice: 'accessToken' and 'accesstoken' both used
yfheader:    {"userId":"<userId>"}         # JSON string; header name also seen as 'YFHeader'
Content-Type: application/json
```

- `cygnusb/coros_api.py:401-407` — `{"Content-Type","User-Agent","accessToken","yfheader"}`.
- `rowlando/src/coros-api.ts:95-101` — `{"Content-Type", accesstoken, yfheader}` (lowercase).
- `open-coros-training/coros/client.py:66-68` — `accessToken` + `YFHeader`.
- Captured web-app request uses **lowercase** `accesstoken:` and `yfheader: {"userId":"…"}`
  (`rowlando/research/create-workout-request-all.txt:4,19`).
- `xballoy` sends **only** `accessToken` and no `yfheader` for `/activity/query`,
  `/activity/detail/download`, `/training/schedule/query` — and those work
  (`query-activities.request.ts:126`, `download-activity-detail.request.ts:66`,
  `query-training-schedule.request.ts:91`). ⇒ `yfheader` is **not** universally required;
  it appears needed for the `/training/program/*` and `/training/exercise/query` family. `[inferred]`
- `dlenski/corostc/__init__.py:93` sets only `accessToken` and calls `/account/query` successfully.
- No CSRF, no request signing, no nonce on `teamapi.*` `[verified-live]`
  (`open-coros-training/docs/API.md:22-24`; the *browser* endpoint `t.coros.com/api/login`
  **does** require CSRF and is deliberately avoided).

User-Agent used by clients `[verified-in-source]`
(`cygnusb/coros_api.py:36`): a Chrome 145 macOS desktop UA. `open-coros-training/client.py:53-57`
uses Chrome 124 Linux and additionally sets `Origin: https://t.coros.com` and `Referer: https://t.coros.com/`.

### 1.5 IP reputation `[verified-live]`

`open-coros-training/coros/client.py:11` and `CLAUDE.md:13`:
> "Login 403s from datacenter IPs; run from a residential connection."

(Contradicted for the login *itself* by `client.py:23-26`, which says a residential IP is *not*
blocked and the 403 concern applies to datacenter ranges. Treat as: **run the bridge from a
residential IP**.)

---

## 2. Authentication

### 2.1 Web (Training Hub) login `[verified-in-source]` + `[verified-live]`

```
POST https://teameuapi.coros.com/account/login          (or teamapi / teamcnapi)
Content-Type: application/json

{
  "account": "<email or phone>",
  "accountType": 2,
  "pwd": "<md5-hex-lowercase(password)>"
}
```

Response:

```json
{
  "apiCode": "41C2B95C",
  "message": "OK",
  "result": "0000",
  "data": {
    "accessToken": "…",
    "userId": "…",
    "nickname": "…",
    "email": "…",
    "headPic": "…",
    "countryCode": "…",
    "birthday": 19900101
  }
}
```

Citations:
- `cygnusb/coros_mcp/coros_api.py:234-277` (body build + `data["accessToken"]`, `data["userId"]`).
- `rowlando/src/coros-api.ts:46-74` (identical body; reads `data.data.accessToken`, `data.data.userId`).
- `xballoy/src/coros/account/login.request.ts:57-71` (Zod `LoginBody{account,accountType,pwd}`,
  `LoginData{accessToken}`).
- `xballoy/src/testing/fixtures/login.ts:1-8` — literal success fixture shown above.
- `NYT87/src/CorosApi.ts:198-208` + `src/types/index.ts` `UserResponse{userId,nickname,email,headPic,countryCode,birthday}`.
- `dlenski/corostc/corostc/__init__.py:100-108` — reads `data['accessToken']`, `data['userId']`,
  `data['nickname']`, `data['email']`.
- `open-coros-training/docs/API.md:19-21` — confirmed live: valid ⇒ `0000`+`accessToken`; bad ⇒ `1030`.
- `shenmiguo/scripts/coros.js:63-70` — same body, CN host.
- Bruno collection `xballoy/api/Login.bru:11-15` — `{accountType:2, account, pwd: <md5>}`.

`accountType: 2` is hardcoded everywhere `[verified-in-source]`; nothing documents other values. `[inferred]`
it distinguishes email/phone vs. third-party login.

**Password hashing**: plain `md5(password).hexdigest()` — `hashlib.md5` (`coros_api.py:226-227`),
`createHash('md5')` (`rowlando:29-31`, `xballoy/login.request.ts:61`, `NYT87:203`). No salt, no
iteration. The web API *never* sees the plaintext password.

### 2.2 Token lifetime & refresh (web) `[verified-in-source]`

- `cygnusb/coros_api.py:80`: `TOKEN_TTL_MS = 24 * 60 * 60 * 1000` — clients assume **24h**.
- There is **no refresh endpoint**. Refresh = re-POST `/account/login`
  (`cygnusb/coros_api.py:379-394` `try_auto_login`).
- Validity is only checked **locally by timestamp** by default (`_is_token_valid`, line 125-127).
  Server-side verification was added as opt-in (`verify_web_token`, `coros_api.py:410-427`) —
  it does `GET /dashboard/query` and treats `result != "0000"` (e.g. `1019`) as invalid.
  This came from issue #49 (closed by PR #50, 2026-07-24).
- `open-coros-training` caches `{accessToken,userId}` to `~/.cache/coros/token.json`
  (`client.py:35,107-120`) with **no expiry logic at all**.
- There is **no logout-on-login** behavior documented for the *web* token; multiple web tokens
  appear to coexist. `[inferred]`
- `POST /account/logout` exists (`Ericyuanxiang/coros_api.py:71,2095-2105`) — sends auth headers,
  no body.

### 2.3 Mobile-app login (AES) — **invalidates the phone app session** `[verified-in-source]`

```
POST https://apieu.coros.com/coros/user/login
content-type: application/json
accept-encoding: gzip
user-agent: okhttp/4.12.0
request-time: <epoch millis>
yfheader: {"appVersion":1125917087236096,"clientType":1,"language":"en-US",
           "mobileName":"sdk_gphone64_arm64,google,Google","releaseType":1,
           "systemVersion":"13","timezone":4,"versionCode":"404080400"}

{
  "account":        "<AES-encrypted(email)>\n",
  "accountType":    2,
  "appKey":         "<random 16-digit decimal string>",
  "clientType":     1,
  "hasHrCalibrated": 0,
  "kbValidity":     0,
  "pwd":            "<AES-encrypted(md5hex(password))>\n",
  "region":         "310|Europe/Berlin|US",
  "skipValidation": false
}
```

`cygnusb/coros_mcp/coros_api.py:158-219`. Encryption scheme (`coros_api.py:134-155`), reverse
engineered from `libencrypt-lib.so` in the COROS Android APK:

1. XOR the UTF-8 plaintext bytes with `appKey` bytes, cyclically.
2. PKCS#7-pad to 16 bytes.
3. AES-128-CBC encrypt with `key = appKey.encode("ascii")`, `IV = b"weloop3_2015_03#"`.
4. base64 the ciphertext; append a trailing `"\n"`.

Response: `data.accessToken` (`coros_api.py:215-217`).

Key operational facts:
- **Mobile login logs you out of the COROS phone app.** `[verified-in-source]` — README:141 and
  README:242 of `cygnusb/coros-mcp`; independently reported as a bug in
  `Ericyuanxiang/coros-ai-coach` issue #1 ("使用 mobile 的 api 会导致手机 app 登出" — "using the mobile API
  logs the phone app out"), still open. cygnusb's mitigation: `login(..., skip_mobile=True)` is the
  **default** (`coros_api.py:234`) and the mobile token is acquired lazily on the first
  `fetch_sleep()` call (`_ensure_mobile_token`, `coros_api.py:1895-1926`).
- **Mobile token lifetime ≈ 1 hour** `[verified-in-source]` — `docs/mobile-token.md` "Token Lifetime".
- **Refresh = replay the stored encrypted payload.** `[verified-in-source]`
  `_refresh_mobile_token`, `coros_api.py:1849-1888`: "The server accepts replay of the same
  encrypted payload — no nonce or anti-replay protection." Triggered on `result == "1019"`
  (`coros_api.py:1979`).
- The Android device fingerprint in `yfheader` is **hardcoded** and is a known fragility
  (`cygnusb` issue **#48, still open**): if COROS starts version-gating `versionCode`/`appVersion`,
  all mobile calls break with no auto-update path.
- The `region` field `"310|Europe/Berlin|US"` is `<SIM MCC>|<device tz>|<locale>` and is **not**
  the account region; account routing is by base URL only (`coros_api.py:176-183`, closed issue #47).

### 2.4 What the bridge should do

`[inferred]` For a schedule/plan bridge you need **only the web token**. Avoid the mobile login
entirely unless you need sleep-stage/steps/stress data — it costs the user their phone app session.

---

## 3. Schedule / training-plan READ

### 3.1 `GET /training/schedule/query` — the active plan + calendar `[verified-in-source]` `[verified-live]`

```
GET {base}/training/schedule/query?startDate=YYYYMMDD&endDate=YYYYMMDD&supportRestExercise=1
Headers: accessToken, (yfheader)
```

- `cygnusb/coros_api.py:1086-1108` — params `startDate`, `endDate`, `supportRestExercise: 1`.
- `xballoy/src/coros/training-schedule/query-training-schedule.request.ts:84-87` — same three params.
- `xballoy/api/Query Training Schedule.bru:8` — literal URL
  `…/training/schedule/query?startDate=20260112&endDate=20260215&supportRestExercise=1`.
- `open-coros-training/coros/client.py:150-162`.

**Param-name gotchas** `[verified-live]` (`open-coros-training/docs/API.md:30-34`):
- Params are `startDate`/`endDate` (camelCase **Date**). Using `startDay`/`endDay` ⇒ `1001 Service exceptions`.
- Range is bounded: multi-year spans ⇒ `5011 "The date is out of range"`. A **±45 day (≈90 day)
  window works** (`client.py:164-176` `active_plan()`).
- `POST /training/plan/query` returns only **saved/library** plans, **not** the active in-schedule
  plan. The active plan comes from `schedule/query` only.

**Response shape** — `data` is the *active plan object* (not a list):

Top-level `data` keys `[verified-in-source]`, from cygnusb's strip list (`coros_api.py:1224-1231`)
plus positive reads:

```
id                 # ← the planId
name, overview
entities[]         # calendar placements
programs[]         # workout definitions, joined to entities by idInPlan
maxIdInPlan        # monotonic counter; next idInPlan = maxIdInPlan + 1
maxPlanProgramId
pbVersion, version
startDay, endDay, totalDay, createTime, updateTimestamp
status, type, unit, category, access, authorId, userId, thirdPartyId
weekStages[], subPlans[], userInfos[]
sportDatasInPlan[], sportDatasNotInPlan[]      # completed activities matched / unmatched
likeTpIds, starTimestamp, score, sourceUrl, inSchedule, pauseInApp
```

`entities[]` element `[verified-in-source]` (`coros_api.py:1218-1222` drop-list + `xballoy`
Zod schema + captured payload):

```
id                 # server entity id, e.g. "700000000000000002"
idInPlan           # string in reads ("6"), int accepted in writes
planId
planProgramId      # usually == idInPlan
planIdIndex
happenDay          # YYYYMMDD — string in reads, int in the captured web payload (20260530)
dayNo              # 1-based day offset from plan startDay
sortNo, sortNoInSchedule
userId, operateUserId
completeRate ("-1.00"), standardRate ("0"), score ("0")
thirdParty (bool), thirdPartyId
exerciseBarChart[]  # per-step bars for the calendar tile
sportData{}         # the MATCHED completed activity: {name, distance, duration, happenDay}
```

`xballoy/query-training-schedule.request.ts:26-33` types the entity as
`{id?, idInPlan?, planProgramId?, happenDay?, sportData?}` and `sportData` as
`{name?, distance?, duration?, happenDay?}`.

`programs[]` element `[verified-in-source]` (union of `coros_api.py:1208-1216` drop-list,
`open-coros-training/coros/templates/run_default.json` program keys, and the captured payload):

```
id, idInPlan, planId, planIdIndex, userId, authorId
name, overview
sportType                # 1=Run 2=Bike 3=Swim 4=Strength (workout namespace!)
subType                  # 65535 = structured workout
type, unit, status, deleted, access, pbVersion, version, createTimestamp, thirdPartyId
exercises[]              # the step list — see §5
exerciseBarChart[]
exerciseNum              # count of real (non-group) steps
totalSets, hybridTotalSets, sets
referExercise{intensityType,hrType,valueType}
targetType, targetValue  # workout-level target
--- DURATION / LOAD ESTIMATE FIELDS (what the bridge cares about) ---
duration                 # seconds (int)
estimatedTime            # seconds (int)  — mirrors duration
distance                 # STRING with 2dp, in "coros distance units": "302644.00"  (1 km == 100000)
estimatedDistance        # INT, same unit: 302644
distanceDisplayUnit      # 1 = km
elevGain, pitch
trainingLoad             # int, e.g. 35
estimatedValue           # int — mirrors trainingLoad
estimatedType            # 6 in the captured run
isTargetTypeConsistent
poolLength/poolLengthId/poolLengthUnit (swim), strengthType, gradeSystemVersion
sourceId, sourceUrl, headPic, videoUrl, videoCoverUrl, nickname, sex, star, essence, originEssence, simple
```

**Duration estimate → use `programs[].duration` (seconds), falling back to `entities[].sportData.duration`.**
`xballoy/src/coros/training-schedule/resolve-training-data.ts:50-63` (`resolveDurationSeconds`) does
exactly that; `formatPlannedLength` (lines 33-48) prefers `program.distance ?? entity.sportData.distance`,
then duration. `[verified-in-source]`

**Distance unit** `[verified-live]`: `open-coros-training/coros/pace.py:67,106-108` —
`CM_PER_KM = 100000`, i.e. distance is in **centimetres**; the captured `"302644.00"` == 3.03 km.
`shenmiguo/scripts/coros.js:466` divides activity `summary.distance` by 100000 to get km.

**Program name / overview are i18n keys** `[verified-in-source]`: names look like `T1120`, `T3001`,
`T1122`, `T1123`; overview like `sid_run_warm_up_dist`, `sid_run_training`, `sid_strength_squats`.
Resolve via the CDN bundle:

```
GET https://static.coros.com/locale/coros-traininghub-v2/en-US.prod.js      (no auth)
# body is `window.en_US={...};` — strip prefix + trailing ';' then JSON.parse
```
`rowlando/src/coros-api.ts:151-161`, `xballoy/src/coros/training-schedule/fetch-locale-map.ts:5-30`.
cygnusb instead does a local prettifier: `sid_strength_squats` → `Squats`
(`coros_api.py:1238-1244`).

### 3.2 `POST /training/plan/query` — library/saved plans `[verified-in-source]`

```
POST {base}/training/plan/query?teamId=&userId=
{ "statusList": [1, 2] }
```
`cygnusb/coros_api.py:768-785`. `rowlando`, `shenmiguo/coros.js:159` and
`open-coros-training/client.py:139-142` send an **empty body** `{}` (or none) — both accepted.

Response `data` is a **list**. Per-plan fields read `[verified-in-source]`
(`cygnusb/coros_api.py:749-765`):

```
id, name, overview, status, executeStatus,
startDay, endDay, totalDay, minWeeks, maxWeeks,
programs[], entities[]
```

⚠️ `[verified-live]` `open-coros-training/docs/API.md:27-29`: this endpoint returned **only** the
read-only Intervals-synced plan (`authorId 10110`), **not** the active plan. **Do not use it to
resolve the push target.**

### 3.3 `GET /training/plan/detail?id=<planId>` `[verified-in-source]`

`open-coros-training/coros/client.py:144-145`. `Ericyuanxiang/coros_api.py:54,2579-2586` calls it
with `{"id": <linkedId>, "region": <1|2|3>}` for public-library plans.

### 3.4 `GET /training/schedule/querysum` `[verified-in-source]` — declared but unused

`cygnusb/coros_api.py:57`: `"schedule_sum": "/training/schedule/querysum"  # GET — planned calendar aggregates`.
No call site in any repo. `[inferred]` likely takes the same date params and returns per-day totals.

### 3.5 `GET /training/program/detail?id=<id>&userId=<uid>` `[verified-in-source]`

`Ericyuanxiang/coros_api.py:1789-1807`. Also accepts `region` + `supportRestExercise=1` for
public-library programs (`:2579-2586`).

### 3.6 `POST /training/program/query` — workout library `[verified-in-source]`

Two observed bodies, both accepted:

```jsonc
{}                                                                    // cygnusb:733-746, shenmiguo:169
{"name":"","supportRestExercise":1,"startNo":0,"limitSize":10,"sportType":0}  // captured web app
{"programId":"<id>"}                                                  // shenmiguo:179-181
```

The captured one is authoritative for the web app
(`rowlando/research/create-workout-request-all.txt`, 3rd curl; mirrored in
`rowlando/src/coros-api.ts:491-503`).

**Response `data` is a bare array** (not `{list:[…]}`) `[verified-in-source]` — this was an actual
bug fixed in rowlando (`HOW-WE-BUILT-THIS.md` Phase 5) and matches `cygnusb/coros_api.py:746`
(`body.get("data", [])`).

Per-workout fields read `[verified-in-source]` (`cygnusb/coros_api.py:709-730`):
`id`, `name`, `sportType`, `estimatedTime` (seconds), `exerciseNum`, `exercises[]`
(each with `name`, `targetValue`, `intensityValue`, `intensityValueExtend`, `sets`).
Note: `duration` is **0 for strength workouts** — use `estimatedTime` (rowlando Phase 5).

### 3.7 `GET /training/exercise/query?userId=<uid>&sportType=<n>` `[verified-in-source]`

`cygnusb/coros_api.py:1822-1842`, `rowlando/src/coros-api.ts:139-148`.
`sportType=4` ⇒ strength catalog (~383–400 exercises, `[verified-live]` in both repos).
Each entry: `id` (stable string id used as `originId`), `name` (T-code), `overview` (`sid_…`),
`animationId`, `muscle[]`, `muscleRelevance[]`, `part[]`, `equipment[]`, `exerciseType`,
`targetType`, `targetValue`, `intensityType`, `intensityValue`, `restType`, `restValue`, `sets`,
`sortNo`, `sportType`, `status`, `createTimestamp`, `thumbnailUrl`, `sourceUrl`, `videoUrl`,
`coverUrlArrStr`, `videoUrlArrStr`, `videoInfos[]`
(`rowlando/src/coros-api.ts:222-255` maps every one of these).

Well-known structural strength ids `[verified-live]`
(`open-coros-training/coros/workout.py:31-33`): warmup `425898928110747648`,
cooldown `425898949585584128`, rest `426842174601216000`. Run-role originIds from the captured
template (`coros/templates/run_default.json`): warmup `425895398452936705` (`T1120`,
`sid_run_warm_up_dist`), work `426109589008859136` (`T3001`, `sid_run_training`),
recovery `425895398452936705` (`T1123`), cooldown `425895456971866112` (`T1122`).

---

## 4. Schedule WRITE — **yes, it exists, and it is live-tested**

### 4.1 The one endpoint: `POST /training/schedule/update` `[verified-in-source]` `[verified-live]`

It is a **single upsert/delete endpoint** driven by `versionObjects[].status`:

| status | meaning | source |
|---|---|---|
| `1` | create | `cygnusb/coros_api.py:1601`, `payloads/schedule_update_create_minimal.json:6` |
| `2` | update | `cygnusb/coros_api.py:1812`, same JSON `_notes` |
| `3` | delete | `cygnusb/coros_api.py:1728`, `open-coros-training/coros/plan.py:179` |

There is **no** `saveSchedule` / `addProgram` / separate delete endpoint in any repo.

**Who has actually tested writes:**
- `laurenceomfoisy/open-coros-training` — `docs/API.md` header says *"Verified end-to-end against a
  real account"*, dated 2026-05-30/31, with response `{"apiCode":"91B8C17A","message":"OK","result":"0000"}`
  recorded in `payloads/schedule_update_create_minimal.json:4`. `[verified-live]`
- `cygnusb/coros-mcp` — ships create/update/delete tools plus enrichment round-trip; README documents
  the returned identifiers. Payload-shape unit tests exist (`tests/test_workout_payloads.py`,
  `tests/test_post_release_review_fixes.py:168-182`) but there are **no recorded live responses** in
  the repo. Treat as `[verified-in-source]`, live status asserted only by docstrings.
- `rowlando/coros-workout-mcp` — does **not** touch the schedule (library workouts only).
- `Ericyuanxiang/coros-ai-coach` — same code lineage as cygnusb; no live evidence.

### 4.2 CREATE — minimal payload `[verified-in-source]`

`cygnusb/coros_api.py:1594-1603`:

```json
{
  "entities": [
    { "happenDay": "20260312", "idInPlan": 7, "sortNoInSchedule": 1 }
  ],
  "programs": [ { "…full program object…", "idInPlan": 7 } ],
  "versionObjects": [ { "id": 7, "status": 1 } ],
  "pbVersion": 2
}
```

`Ericyuanxiang/coros_api.py:1948-1957` is byte-identical in shape, but additionally sets on the
program: `planId`, `planIdIndex = idInPlan`, `userId`, `authorId` (`:1942-1946`).

### 4.3 CREATE — full web-app payload `[verified-in-source]` (the highest-fidelity artifact)

`laurenceomfoisy/open-coros-training/payloads/schedule_update_create_minimal.json` is a scrubbed
capture of the **exact body the COROS web app sends** when creating a default-template Run workout,
with the recorded response. Structure (`:12-119`):

```jsonc
{
  "entities": [{
    "completeRate": "-1.00", "dayNo": 12,
    "exerciseBarChart": [
      {"exerciseId":"700000000000000010","exerciseType":1,"height":93,"name":"T1120",
       "targetType":2,"targetValue":300,"value":300,"width":25,"widthFill":0}, …],
    "happenDay": 20260530,                      // INT here
    "id": "700000000000000002",
    "idInPlan": "6", "planProgramId": "6", "planId": "<PLAN_ID>", "planIdIndex": 0,
    "operateUserId": "<COROS_USER_ID>",
    "userId": 100000000000000100,               // note: derived, ends in 100
    "score": "0", "standardRate": "0",
    "sortNo": 1, "sortNoInSchedule": 1,
    "thirdParty": false, "thirdPartyId": 127,
    // UI-only decoration, still sent:
    "cloneable": true, "cardType": "entities", "dataType": "program",
    "name": "…", "overview": "", "sportType": 1, "childType": "planFuture",
    "iconConfig": {"name":"run","icon":"iconfont-sport icon-outrun","type":1,
                   "color":"#F8C032","label":"H2005"},
    "showCopy": true, "isBefore": false, "chartHeight": 372, "copying": false,
    "listItem": [{"program_value":"00:20:00","sport_value":"00:00:00"},
                 {"program_value":"3.03 km","sport_value":"0.00 km"},
                 {"program_value":"35 TL","sport_value":"0 TL"}]
  }],
  "programs": [{ … see §3.1 program fields; distance "302644.00", estimatedDistance 302644,
                 duration 1200, estimatedTime 1200, trainingLoad 35, estimatedValue 35,
                 estimatedType 6, targetType 2, targetValue 1200, subType 65535,
                 sourceId "425868113867882496", exercises[…5…], exerciseBarChart[…4…] }],
  "versionObjects": [{"id":"6","status":2,"planProgramId":"6","planId":"<PLAN_ID>"}],
  "pbVersion": 2
}
```

Recorded `_notes` in that file `[verified-in-source]`:
- `versionObjects[].status`: 1=create, 2=update, 3=delete.
- **"Server auto-creates a plan on first call and assigns planId / entity id / program id."**
- `exercises[].id` are small ints 1..N. A group exercise (`isGroup:true`) gets `id=2` and its
  children carry `groupId: 2`.
- Set `referExercise.intensityType=3` and `fastIntensityTypeName:"pace"` for pace-target workouts.
- `entity.userId` may be derived; pass `operateUserId = <real userId>`.

`open-coros-training/coros/workout.py:448-492` (`assemble_payload`) is the builder: it stamps
`idInPlan`, `planProgramId`, `planId`, `operateUserId` on the entity, and
`idInPlan`, `planId`, `authorId`, `userId`, `pbVersion` on the program.

### 4.4 Live-confirmed WRITE semantics `[verified-live]` (`open-coros-training/docs/API.md:36-50`, `coros/plan.py:1-7,212-264`)

1. **One workout per call.** Multi-entity payloads are rejected with **"Plan data is illegal"**.
2. `planId: ""` is accepted and **auto-targets the active plan**.
3. **`idInPlan` must be `maxIdInPlan + 1`, re-read fresh before every push.** The counter is
   monotonic; the server reassigns out-of-sequence ids. `cygnusb/coros_api.py:1586-1588` does the
   same (`int(pre_data.get("maxIdInPlan", 0)) + 1`) and explicitly warns the read-then-write is
   **racy** under concurrency for the same day (`:1577-1582`).
4. `pbVersion` need not match the plan's (pushed 2 against a plan at 9 — accepted), but sending the
   plan's current value is safer.
5. **Pace targets round-trip exactly**: `intensityType:3`, `intensityValue`/`intensityValueExtend`
   in **ms/km** (350000–380000 = 5:50–6:20/km). `referExercise.intensityType:3`.
6. **HR targets do NOT round-trip exactly**: a `145–152` bpm request came back `153–161`; the server
   remaps HR onto the account's own zones/threshold. `intensityType:2` is correct, bpm is advisory.
7. **The server recomputes `distance` / `trainingLoad`** from time targets + pace; submitted
   estimates are advisory.
8. Interval groups work: a repeat group with `sets:3` stored correctly and the server **relinked
   child `groupId`** to the group's server-assigned id.
9. For **runs**, a hand-built topology was initially rejected ("Plan data is illegal") — the repo
   clones a captured template (`coros/workout.py:1-13`) — but `docs/API.md:56-58` later confirms a
   **2-block run (warmup exerciseType 1 + training exerciseType 2, no group, no cooldown) is accepted**;
   the 4/5-slot clone is not strictly required.
10. For **gym/strength (sportType 4)**, hand-built flat lists are accepted; the "Plan data is
    illegal" constraint does **not** apply (`docs/API.md:74-78`).

### 4.5 UPDATE `[verified-in-source]`

`cygnusb/coros_api.py:1785-1819`:

```json
{
  "entities":  [ <raw entity from schedule/query, edited> ],
  "programs":  [ <raw or calculated program> ],
  "versionObjects": [
    { "id": "<idInPlan>", "status": 2,
      "planProgramId": "<planProgramId>", "planId": "<planId>" }
  ],
  "pbVersion": 2
}
```

Requires `idInPlan` **and** `planId` (raises otherwise, `:1803-1804`). Workflow the repo prescribes
(`server.py:1135-1157`): `list_planned_activities_raw` → edit → `calculate_workout_program` →
`update_scheduled_workout`. This is why the repo keeps a "raw" (unstripped) schedule fetch
(`coros_api.py:1125-1136`): "`/training/schedule/update` expects the full entity/program objects,
including planId, planProgramId, idInPlan, exerciseBarChart, and version fields."

### 4.6 DELETE `[verified-in-source]` `[verified-live]`

```json
{
  "versionObjects": [
    { "id": "<idInPlan>", "planProgramId": "<planProgramId or idInPlan>",
      "planId": "<planId>", "status": 3 }
  ],
  "pbVersion": 2
}
```

`cygnusb/coros_api.py:1710-1741`; `open-coros-training/coros/plan.py:176-183`;
`Ericyuanxiang/coros_api.py:1984-1992`. **No `entities`/`programs` needed.**

Live notes `[verified-live]` (`open-coros-training/docs/API.md:62-66`):
- Returns `0000`. Deletion is **hard** (not retrievable via read).
- Deletion does **NOT** decrement `maxIdInPlan`.
- ⚠️ the repo's `coros delete <date>` CLI removes **every** workout on that date.

### 4.7 Post-write identifier discovery `[verified-in-source]`

`schedule/update`'s response body **does not contain** the server-assigned ids
(`cygnusb/coros_api.py:1614-1616`). cygnusb re-GETs `schedule/query` for the same day and matches on
the client-computed `idInPlan` to recover `plan_id` (= `data.id`), `plan_program_id`
(= `entity.planProgramId`), `entity_id` (= `entity.id`) (`:1626-1641`). If that lookup fails it
returns `enrichment_ok: false` and empty strings.

### 4.8 Plan-level writes `[verified-in-source]` / `[inferred]`

| Endpoint | Method | Status |
|---|---|---|
| `/training/plan/add` | POST | Body shape **known** (see below), but `open-coros-training/docs/API.md:81` reports `1031 Parameter input error` on its attempt. |
| `/training/plan/update` | POST | Declared only (`Ericyuanxiang/coros_api.py:53`). No call site. `[inferred]` |
| `/training/plan/delete` | POST | Declared only (`:56`), body documented as `["id1", …]`. `[inferred]` |
| `/training/plan/copy` | POST | Used with `?id=<detailId>&region=<n>` + full detail JSON body (`:2603-2608`). |
| `/training/plan/sync` | — | `open-coros-training/docs/API.md:80`: **errors**; no working server-side watch push. |

`POST /training/plan/add` body `[verified-in-source]` — `shenmiguo/scripts/coros.js:279-286`:

```json
{
  "name": "<plan name>", "overview": "",
  "entities": [ {"happenDay":"", "idInPlan":1, "sortNoInSchedule":0,
                 "dayNo":<1-based>, "exerciseBarChart":[…]} ],
  "programs": [ {…full program…, "idInPlan":1} ],
  "weekStages": [], "maxIdInPlan": <n>, "totalDay": <n>, "unit": 0,
  "sourceId": "425868142590476288",
  "sourceUrl": "https://oss.coros.com/source/source_default/0/6097a29cf17a435f88b573c08679280b.jpg",
  "minWeeks": 1, "maxWeeks": <ceil(totalDay/7)>, "region": 2,
  "pbVersion": 9,
  "versionObjects": [ {"id":1,"status":1} ]
}
```
Returns `data` = the new `planId`. Note `entities[].happenDay = ""` and `dayNo` used instead —
a plan template is day-offset-relative, unlike the schedule which is date-absolute. `[verified-in-source]`

### 4.9 Watch delivery `[verified-live]`

`open-coros-training/docs/API.md:79-81` + `CLAUDE.md:33`: there is **no working server-side push to
the watch**. Workouts reach the watch when the COROS **phone app** next syncs near it.

---

## 5. Workout program structure (`programs[].exercises[]`)

### 5.1 Enum values `[verified-in-source]`

**`sportType` — workout namespace (≠ activity namespace!)** (`cygnusb/coros_api.py:684-706`,
`open-coros-training/coros/workout.py:28`):

```
1 = Running   2 = Indoor Cycling / Bike   3 = Swim   4 = Strength
200 = Road Bike, 201 = Indoor Cycling (alt)   (pass-through, unmapped)
```
Activity-namespace run ids 100/102/103 **all collapse to wire `sportType=1`**
(`coros_api.py:695,856`). cygnusb *rejects* callers passing `1` directly to force the running
metadata block to be applied (`:844-848`).

**`exerciseType`** `[verified-in-source]`:
```
0 = repeat-group container (isGroup:true)
1 = warm up
2 = main / training
3 = cool down
4 = rest / recovery
```
(`cygnusb/coros_api.py:958-970` uses 1/3; `shenmiguo/coros.js:295` documents 1=warmup 2=train
3=relax 4=rest; the captured run template uses `recovery → exerciseType 4`,
`cooldown → 3` — `run_default.json` exerciseRoles.)

**`intensityType`** `[verified-in-source]` (`cygnusb/coros_api.py:673`):
```
1 = weight   2 = heart rate   3 = pace   4 = speed   5 = none   6 = power   7 = cadence
8 = (pace variant; Ericyuanxiang/coros_api.py:1213 treats 3 and 8 as pace)
```

**`targetType`** `[verified-in-source]` / `[verified-live]`:
```
2 = TIME      → targetValue in whole SECONDS
3 = REPS      → targetValue = rep count
5 = DISTANCE  → targetValue in coros distance units (metres × 100; 6 km = 600000)
```
`open-coros-training/docs/API.md:53-55` confirms 5=distance **via `/training/program/calculate`** and
notes 1/3/4 are *not* distance (calculate returns 0). `targetDisplayUnit: 1` = km
(`coros/workout.py:302-309`); `shenmiguo/coros.js:334` uses `1` for <1000 m and `2` for ≥1000 m.

**`restType`** `[verified-in-source]` (`cygnusb/coros_api.py:1361-1368`, verified against
app-created workouts): `3` = "Skip rests" (`restValue: 0`); `1` = "Rest MM:SS" (`restValue` = seconds).

**`hrType`** `[verified-in-source]`: `1 = MaxHR`, `2 = %HRR`, `3 = %LTHR`
(`Ericyuanxiang/coros_api.py:1306`). cygnusb writes `hrType = 2` on HR steps and
`referExercise.hrType = 3` (`coros_api.py:985,1011`) — note the mismatch, both are in shipped code.

**`subType: 65535`** on the *program* marks a structured workout `[verified-in-source]`
(`coros_api.py:1016-1017`, captured payloads, `rowlando/src/coros-api.ts:410`).

### 5.2 Intensity encodings `[verified-in-source]`

**Pace** (`open-coros-training/coros/pace.py:36-38,176-190`):
```
intensityType: 3
intensityValue:       fast bound, MILLISECONDS per km   (5:50 → 350000)
intensityValueExtend: slow bound, ms/km                  (6:20 → 380000)
intensityMultiplier: 1000
intensityDisplayUnit: 1
isIntensityPercent: false, intensityCustom: 0, hrType: 0
```
`Ericyuanxiang/coros_api.py:1212-1217` corroborates `intensityMultiplier = 1000` for pace types
(3 and 8), `0` for HR/power/cadence.
(An alternative pace encoding `M*10000 + S*100` appears at `Ericyuanxiang/coros_api.py:1169-1173` —
unused in the live path; treat as `[inferred]`/legacy.)

**HR, absolute bpm** (`pace.py:139-148`):
`intensityType:2, isIntensityPercent:false, intensityValue:<lo bpm>, intensityValueExtend:<hi bpm>,
intensityPercent:0, intensityPercentExtend:0`

**HR, % of threshold** (`pace.py:166-173`): `isIntensityPercent:true`,
`intensityPercent: pct*1000`, `intensityPercentExtend: pct*1000`, `intensityValue/Extend: 0`.
The captured web payload shows `intensityPercent:91000, intensityPercentExtend:95000` alongside
bpm 145/152 and `intensityCustom:2` — i.e. the app sends **both**.

**Power** (`cygnusb/coros_api.py:904-905`, `Ericyuanxiang:1047-1055`):
`intensityType:6, intensityValue:<low W>, intensityValueExtend:<high W>` (0 = open-ended).

**Weight (strength)** `[verified-in-source]`, reverse-engineered from iOS payloads 2026-05-20
(`cygnusb/coros_api.py:1372-1420`, pinned by `tests/test_workout_payloads.py:52-97`):

| case | `intensityValue` | `intensityPercent` | `intensityDisplayUnit` | `intensityCustom` |
|---|---|---|---|---|
| bodyweight (omit both) | `""` (empty **string**) | 0 | `"6"` | 1 |
| kg | `round(kg × 1000)` | 0 | `"6"` | 0 |
| lbs | `round(lbs × 0.45359237 × 1000)` | `round(lbs × 1_000_000)` | `"7"` | 0 |
| explicit `kg=0` | `0` | 0 | `"6"` | 0 (renders "0.00 kg", ≠ bodyweight) |

`intensityType: 1` for all weight cases. Note `intensityDisplayUnit` is a **string** here.

### 5.3 `sortNo` scheme `[verified-in-source]`

`cygnusb/coros_api.py:868,909,933`: top-level step *n* gets `sortNo = 16777216 * n` (= 2²⁴·n);
sub-step *j* inside a group gets `groupSort + 65536 * (j+1)` (2¹⁶). `shenmiguo/coros.js:304,324,348`
starts at `16777216` and increments by `65536`. The captured template uses raw small ints
(1,2,4) for top-level and `33554432` / `33685504` for group members — both forms are accepted. `[inferred]`

### 5.4 Repeat-group container `[verified-in-source]`

`cygnusb/coros_api.py:877-893`:

```json
{ "id": <int>, "name": "Group", "exerciseType": 0, "sportType": <wire>,
  "intensityType": 0, "intensityValue": 0,
  "targetType": 2, "targetValue": <seconds per iteration>,
  "sets": <repeat count>, "sortNo": <16777216*n>,
  "restType": 3, "restValue": 0,
  "groupId": "0", "isGroup": true, "originId": "0" }
```
Children set `groupId: "<container id>"`, `isGroup:false`.
⚠️ `exerciseNum` / `totalSets` count **real steps only** — the container must not be counted
(`coros_api.py:995-999`).

### 5.5 Running-program required metadata block `[verified-in-source]`

`cygnusb/coros_api.py:949-1023` — without these the COROS app fails to parse or renders the workout
as strength on the watch:

per-exercise: `exerciseKind:0, gradeSystem:0, hrType, intensityMultiplier:0, intensityPercent:0,
intensityPercentExtend:0, onsightGradeOffset:0, overview:"", packageTime:0, sourceId:"0",
subType:0, targetDisplayUnit:0`

program-level: `duration, exerciseNum, gradeSystemVersion:0, hybridTotalSets:0, overview:"",
poolLength:0, poolLengthId:0, poolLengthUnit:0, referExercise{gradeSystem,hrType,intensityType,valueType:1},
sourceUrl:"", subType:65535, totalSets, trainingLoad:0, type:0, videoCoverUrl:"", videoUrl:""`

---

## 6. Workout duration/load calculation

### 6.1 `POST /training/program/calculate` `[verified-in-source]` `[verified-live]`

```
POST {base}/training/program/calculate
Body: the FULL program object (same shape as /training/program/add)
```

Raw capture: `rowlando/research/create-workout-request-all.txt` curl #1 →
`https://teameuapi.coros.com/training/program/calculate` with a complete 3-exercise strength
program (`access:1, authorId:"0", createTimestamp:0, distance:0, duration:0, essence:0,
estimatedType:0, estimatedValue:0, exerciseNum:0, exercises:[…], headPic:"", id:"0", idInPlan:"0",
name, nickname:"", originEssence:0, overview, pbVersion:2, planIdIndex:0, poolLength:2500,
profile:"", referExercise:{intensityType:1,hrType:0,valueType:1}, sex:0, shareUrl:"", simple:false,
sourceUrl:"<cloudfront default>", sportType:4, star:0, subType:65535, targetType:0, targetValue:0,
thirdPartyId:0, totalSets:0, trainingLoad:0, type:0, unit:0, userId:"0", version:0,
videoCoverUrl:"", videoUrl:"", fastIntensityTypeName:"weight", poolLengthId:1, poolLengthUnit:2,
sourceId:"425868133463670784"`).

**Response `data` — two documented field sets. This is an inconsistency to resolve empirically:**

(a) `plan*`-prefixed (Training Hub calendar path) `[verified-in-source]`,
`cygnusb/coros_api.py:1162-1196` + `Ericyuanxiang/coros_api.py:1769-1774`:

```
planDuration        # seconds
planDistance        # coros distance units (cm)
planTrainingLoad
planSets, planHybridTotalSets
planElevGain, planPitch
exerciseBarChart[]
actualDuration, actualDistance, actualElevGain, actualPitch, actualTrainingLoad
distanceDisplayUnit
```

(b) bare names (strength/library path) `[verified-in-source]`,
`rowlando/src/coros-api.ts:444-465`: `data.duration`, `data.totalSets`, `data.trainingLoad`.

`[inferred]` The response likely contains both families, or the shape varies by `sportType`.
**A bridge should read `planDuration ?? duration` and `planTrainingLoad ?? trainingLoad`.**

`apply_workout_calculation` (`cygnusb/coros_api.py:1162-1196`) is the authoritative write-back map:

```
exerciseBarChart   → exerciseBarChart
planDuration       → duration AND estimatedTime
planTrainingLoad   → trainingLoad AND estimatedValue
planElevGain       → elevGain
planDistance       → distance AND estimatedDistance (int(float(v)))
planSets           → sets            (only if 'sets' already present)
planHybridTotalSets→ totalSets       (only if 'totalSets' already present)
```

**Calculate-then-add is the web app's two-step pattern** `[verified-in-source]`
(`rowlando/HOW-WE-BUILT-THIS.md` Phase 2 + `src/coros-api.ts:467-482`): the `/add` body is the
same payload with `duration`, `totalSets`, `sets` filled from calculate, plus
`distance: "0"` (**string** in add, **number** in calculate) and `pitch: 0`.

### 6.2 `POST /training/program/add` `[verified-in-source]`

Two body flavours are accepted:

- **Full web-app fidelity** (`rowlando/src/coros-api.ts:376-427`, matching the capture): ~35
  program fields + ~40 fields per exercise.
- **Minimal** (`cygnusb/coros_api.py:941-947`): `{name, sportType, estimatedTime, access:1, exercises:[…]}`
  (+ the running metadata block for runs, §5.5).

`shenmiguo/coros.js:376` uses a third minimal form:
`{name, sportType:1, subType:65535, exercises, exerciseBarChart, overview}`.

Response: `data` = the new workout id **as a scalar** (`str(body.get("data",""))`,
`coros_api.py:1065`).

### 6.3 Other program endpoints

| Endpoint | Method | Body | Source |
|---|---|---|---|
| `/training/program/delete` | POST | `["id1","id2"]` (bare array) | `cygnusb/coros_api.py:1068-1079` `[verified-in-source]` |
| `/training/program/update` | POST | full modified workout JSON | `Ericyuanxiang/coros_api.py:1810-1829` `[verified-in-source]`, untested |
| `/training/program/copy` | POST | `?id=<id>&region=<n>` + full detail JSON | `Ericyuanxiang/coros_api.py:2603-2608` |

---

## 7. Activities

### 7.1 List — `GET /activity/query` `[verified-in-source]`

```
GET {base}/activity/query?size=<1..200>&pageNumber=<n>&startDay=YYYYMMDD&endDay=YYYYMMDD&modeList=100,101,102,103
Header: accessToken
```
`xballoy/query-activities.request.ts:111-121`, `cygnusb/coros_api.py:617-631`,
`dlenski/corostc/__init__.py:123-127`, `shenmiguo/coros.js:99-101`,
`xballoy/api/Query Activities.bru:8`.

Pagination limit: `size ≤ 200` (`xballoy` Zod `.max(200)`;
`gandroz/.../constants.py:15` — *"values higher than 200, e.g. 438, seem to make the API barf"*).

Response `data` `[verified-in-source]` (`xballoy/fixtures/query-activities.ts:12-28`):

```json
{ "apiCode":"C33BB719","message":"OK","result":"0000",
  "data": { "count": 1, "pageNumber": 1, "totalPage": 1,
            "dataList": [ {"date":20250115,"labelId":"abc123","name":"Morning Run","sportType":100} ] } }
```

Full `dataList[]` item fields `[verified-in-source]`
(`NYT87/src/types/index.ts` `interface Activity` + `dlenski:128-136` + `cygnusb:573-602`):

```
labelId (string, the activity id)   date (int YYYYMMDD)
name, device, imageUrl
sportType (int, ACTIVITY namespace)
startTime, endTime            # UNIX SECONDS
startTimezone, endTimezone    # in 15-MINUTE UNITS (dlenski:133-134: timedelta(minutes=tz*15))
distance                      # see unit note
totalTime, workoutTime
trainingLoad, unitType, total
avgHr, maxHr, calorie, avgPower, np,
ascent/totalAscent/elevationGain, descent/totalDescent, remark   # cygnusb's tolerant reads
```

⚠️ `calorie` is in **physical calories (cal), not kcal** `[verified-in-source]` —
`cygnusb/coros_api.py:575-579`: a 60-min run returns ~600 000 ⇒ divide by 1000 for kcal.

### 7.2 Detail — `POST /activity/detail/query` `[verified-in-source]`

Two request styles, both in shipped code:
- **form-encoded body**: `labelId`, `userId`, `sportType` (`cygnusb/coros_api.py:649-654`;
  `dlenski:64` uses `data=dict(labelId, sportType)`).
- **query params on a POST with empty body**: `?screenW=1024&screenH=1169&labelId=…&sportType=…`
  (`shenmiguo/coros.js:393-395`; `NYT87/src/CorosApi.ts:260-271` same minus screen dims).

Response `data` sections `[verified-in-source]` (`NYT87/src/types/activity.ts`,
`shenmiguo/coros.js:409-487`):

```
summary{}        # ~130 fields — see below
lapList[]        # {type, lapDistance, fastLapIndexList[], lapItemList[]}
frequencyList[]  # per-sample stream: timestamp, distance, gpsLat, gpsLon, heart, heartLevel,
                 #   speed, adjustedPace, altitude, slope, cadence, cadenceLength, power, level, levelMap{}
graphList[]      # {key, type, graphItem{avg,max,min,sum,count,asc,desc,maxXSecond,orderType,
                 #   clrLocation[], xScaleArr[], yScaleArr[]}}
zoneList[]       # HR/pace/power zone distribution
deviceList[], userInfo{}, userProfile{}, weather{}, sportFeelInfo{}, trackClimbInfo{},
climbProArr[], slopeLevelArr[], gpsLightDuration
```

`summary` highlights `[verified-in-source]` (full list in `NYT87/src/types/activity.ts:171-…`):
`distance, totalTime, workoutTime, pauseTime, calories, avgHr, maxHr, avgPace, adjustedPace,
avgMoveSpeed, avgSpeed, maxSpeed, avgCadence, maxCadence, avgPower, np, maxPower, elevGain,
totalDescent, minElev, maxElev, avgElev, avgGrade, maxGrade, trainingLoad, aerobicEffect,
anaerobicEffect, performance, tiredRate, currentVo2Max, hrmVo2Max, bestKm, bestLength, lengths,
avgStepLen, avgGroundTime, avgVertVibration, avgVertRatio, avgLegStiffness, avgRunningEf,
startTimestamp, endTimestamp, timezone, sportType, sportMode, deviceSportMode, userId, name,
sets, exercises, totalReps, staminaLevel7d, standardRate, hasProgram, planId, programId`

⚠️ **`summary.planId` and `summary.programId` link a completed activity back to the scheduled
workout.** `[verified-in-source]` — critical for a schedule bridge that wants completion matching.
Also `hasProgram` (0/1).

`lapItemList[]` fields `[verified-in-source]`: `lapIndex, distance, time, avgPace, adjustedPace,
avgHr, maxHr, minHr, avgCadence, maxCadence, avgPower, maxPower, avgSpeed, maxSpeed, avgElev,
minElev, maxElev, elevGain, calories, startTimestamp, endTimestamp, avgStrideLength, groundTime,
groundBalance, legStiffness, avgSwolf, avgStrokeRateLen, exerciseId, exerciseIndex, exerciseNameKey,
intensityType, intensityValue, lapType, lapTrainIndex, indexInOriginLap, …`
Units: `distance` in cm (`/100` → m), `time` in **centiseconds** (`/100` → s), `avgPace` in s/km
(`shenmiguo/coros.js:424-426`). `lapDistance == 100000` marks the 1 km auto-lap view (`:419`).

cygnusb strips `graphList`, `frequencyList`, `gpsLightDuration` from detail responses to keep them
small (`coros_api.py:661-663`).

### 7.3 File download — `POST /activity/detail/download` `[verified-in-source]`

```
POST {base}/activity/detail/download?labelId=<id>&sportType=<n>&fileType=<n>
Header: accessToken   (no body)
→ { "apiCode":"D755ECA8","message":"OK","result":"0000","data": { "fileUrl": "https://…" } }
```
`xballoy/download-activity-detail.request.ts:59-70` + fixture `fixtures/download-activity.ts:1-8`;
`NYT87/CorosApi.ts:280-291`; `Ericyuanxiang/coros_api.py:856-901` (form-encoded `labelId/userId/sportType/fileType`).
`dlenski/corostc:154-165` uses **GET** with the same params — also works.

`fileType` `[verified-in-source]` (`xballoy/api/Download Activity Detail.bru:31-37`,
`dlenski:21`): `0=CSV, 1=GPX, 2=KML, 3=TCX, 4=FIT`. Then plain `GET fileUrl` (unauthenticated
signed URL) for the bytes (`Ericyuanxiang:886-888`).

### 7.4 Activity sport-type codes `[verified-in-source]`

`xballoy/api/Query Activities.bru:39-73` (the most complete list):
```
100 Run · 101 Indoor Run · 102 Trail Run · 103 Track Run · 104 Hike · 105 Mtn Climb · 106 Climb
200 Road Bike · 201 Indoor Bike · 202 E-Bike · 203 Gravel · 204 MTB · 205 E-MTB · 299 Helmet Riding
300 Pool Swim · 301 Open Water
400 Gym Cardio · 401 GPS Cardio · 402 Strength
500 Ski · 501 Snowboard · 502 XC Ski · 503 Ski Touring
700 Rowing · 701 Indoor Rower · 702 Whitewater · 704 Flatwater · 705 Windsurfing · 706 Speedsurfing
800 Indoor Climb · 801 Bouldering
900 Walk · 901 Jump Rope · 902 Floor Climb
10000 Triathlon · 10001 Multisport · 10002 Ski Touring · 10003 Outdoor Climb
```
Additional from `gandroz/.../api_model.py`: `802 Outdoor Climb, 903 Elliptical, 904 Yoga`;
from `cygnusb:565-570`: `403 Yoga, 9807 Bike Commute`; `dlenski:56`: `98 CustomSport`.

### 7.5 Activity mutation `[verified-in-source]`

| Endpoint | Method | Body | Source |
|---|---|---|---|
| `/activity/update` | POST | `{"labelId":"…", …fields}` (e.g. `name`, `note`) | `Ericyuanxiang:904-927`, `dlenski:217-220`, `NYT87:392,417` |
| `/activity/delete` | POST | `{"labelId":"…"}` | `Ericyuanxiang:930-941`, `NYT87:382`; `dlenski:212-214` uses **GET** with `?labelId=` |
| `/activity/fit/import` | POST | multipart: `jsonParameter` (JSON string, web sends `{'source':123456,'timezone':-32}`) + `sportData` (file, gzip ok) | `dlenski:169-177`, `Ericyuanxiang:722-735`, `NYT87:367` |
| `/activity/fit/deleteSportImport` | POST | import id | `Ericyuanxiang:66`, `NYT87:311` |
| `/activity/fit/getImportSportList` | GET | — | `cygnusb:51`, `NYT87:323` |
| `/activity/team/query` | GET | `teamId,startDay,endDay,size` | `Ericyuanxiang:944-969` |
| `/openapi/oss/sts` | GET | `bucket,service,v=2,app_id,sign` → base64+salt-obfuscated S3 creds | `NYT87/CorosApi.ts:295-306`, salt `9y78gpoERW4lBNYL`, appId `1660188068672619112` (`src/config.ts:22,32`) |
| `/leavingmessage/{add,delete,list}` | POST | activity comments | `NYT87:430,444,453` |

---

## 8. Daily metrics, HRV, sleep

### 8.1 `GET /dashboard/query` — 7-day snapshot + HRV `[verified-in-source]`

No params. `data.summaryInfo` contains `[verified-in-source]`
(`cygnusb/coros_api.py:434-472`, `shenmiguo/coros.js:500-558`):

```
sleepHrvData{ happenDay, avgSleepHrv, sleepHrvBase, sleepHrvSd,
              sleepHrvAllIntervalList[],
              sleepHrvList[ {happenDay, avgSleepHrv, sleepHrvBase, sleepHrvSd, sleepHrvIntervalList[]} ] }
lthr, ltsp, fitnessMaxHr, rhr
recoveryPct, recoveryState, fullRecoveryHours
aerobicEnduranceScore, anaerobicCapacityScore, lactateThresholdCapacityScore
staminaLevel
lthrZone[{index,hr,ratio}], ltspZone[{index,pace,ratio}]
```
It is also the cheapest authenticated call and is what cygnusb uses to server-verify a token
(`coros_api.py:410-427`).

### 8.2 `GET /dashboard/detail/query` `[verified-in-source]`

`Ericyuanxiang/coros_api.py:392-424`, `shenmiguo/coros.js:132-136`. Returns
`detailList[]` (per-day `happenDay, ati, cti, t7d, t28d, tiredRate, performance, staminaLevel,
lthr, ltsp`), `summaryInfo{ati, cti, tiredRate, tiredRateNew, tiredRateNewPercentInState,
trainingLoadRatio}`, `record.distanceRecord.detailList[{happenDay,value,count}]`, `currentWeekRecord`.

### 8.3 `GET /analyse/dayDetail/query?startDay=&endDay=` `[verified-in-source]`

Up to **24 weeks** (`cygnusb/coros_api.py:47,503-558`). `data.dayList[]` fields:

```
happenDay, avgSleepHrv, sleepHrvBase, sleepHrvIntervalList[],
rhr, trainingLoad, trainingLoadRatio, tiredRateNew, ati, cti, performance,
distance (m), duration (s), vo2max, lthr, ltsp, staminaLevel, staminaLevel7d
```

### 8.4 `GET /analyse/query` `[verified-in-source]`

No params; fixed rolling window (~28 days per `cygnusb:47`, "84-day / 9 sections" per
`Ericyuanxiang:598`). Returns `data.t7dayList[]` carrying `vo2max, lthr, ltsp, staminaLevel,
staminaLevel7d` which cygnusb merges into the dayDetail records (`coros_api.py:541-556`).

### 8.5 `GET /account/query` — profile + zones `[verified-in-source]`

`Ericyuanxiang/coros_api.py:2036-2092`. `data` fields:

```
userId, nickname, maxHr, rhr, hrZoneType (1=MaxHR,2=%HRR,3=%LTHR),
stature (cm), weight (kg), birthday (YYYYMMDD), countryCode, unit (0=metric,1=imperial), sex,
sportDataSummary{count},
userProfile{language, gender},
zoneData{ lthr, ltsp, ftp,
          maxHrZone[{index,hr,ratio}], rhrZone[…], lthrZone[…],
          ltspZone[{pace,index,ratio}], cyclePowerZone[{power,index,ratio}] }
```
Zone `ratio` is in **integer permille-of-percent**: `59000 = 59%`
(`Ericyuanxiang/coros_api.py:1201-1209`). Also `GET /profile/private/query`
(`shenmiguo/coros.js:150`).

### 8.6 Sleep / steps / stress — mobile API only `[verified-in-source]`

```
POST https://apieu.coros.com/coros/data/statistic/daily?accessToken=<mobileToken>
Headers: Content-Type: application/json, accesstoken: <mobileToken>     (token sent BOTH ways)

{ "allDeviceSleep": 1,
  "dataType": [5],            // 1=calories, 3=steps, 5=sleep, 22=stress
  "dataVersion": 0,
  "startTime": 20260701,      // INT YYYYMMDD
  "endTime":   20260731,
  "statisticType": 1 }
```
`cygnusb/coros_api.py:1933-2003`; multi-type variant `Ericyuanxiang/coros_api.py:2215-2266`.

Response path: `data.statisticData.dayDataList[]`, each item `[verified-in-source]`:

```
happenDay, performance (sleep quality; -1 = none),
sleepData{ totalSleepTime, deepTime, lightTime, eyeTime (REM), wakeTime, shortSleepTime (nap),
           avgHeartRate, minHeartRate, maxHeartRate },
step,                         # dataType 3
calorie,                      # dataType 1
avgStress, avgStressOrdinary, stressDuration, stressDurationOrdinary   # dataType 22
```
Sleep times are in **minutes** `[inferred]` (models call them `*_minutes`, `cygnusb/models.py:15`).
⚠️ the token is passed as a **query param**, so it leaks into proxy logs
(`coros_api.py:1962-1965`).

---

## 9. Public (unauthenticated) training library `[verified-in-source]`

`Ericyuanxiang/coros_api.py:2369-2519`:

1. `GET https://{cn|eu|""}.coros.com/training` → scrape `__INITIAL_STATE__` JSON for `csrf`, `country`; collect cookies.
2. `GET {base}/api/training/get-more-workouts?category_type={workout|plan}&locale=zh-CN&offset=&limit=50`
   with headers `x-csrf-token`, `x-country`, `Referer`, `Origin`.
3. Items: `_id, linked_id, title, title_i18n_key, content, category, sport_type[], workout_target[]/plan_target[],
   difficulty[], author, author_i18n, download_count, iconType, region, createdAt, updatedAt`.
4. Import into the account: `GET /training/{plan|program}/detail?id=<linked_id>&region=<1|2|3>[&supportRestExercise=1]`
   then `POST /training/{plan|program}/copy?id=<detailId>&region=<n>` with the detail JSON as body
   (optionally overriding `name`). Response `data`: `{id, name, exerciseNum, estimatedTime, exercises[]}`.

Region map here: `1=CN, 2=US, 3=EU` (`:2540`).

---

## 10. Complete endpoint index

Base = regional Training Hub host unless noted.

| Method | Path | Purpose | Best source |
|---|---|---|---|
| POST | `/account/login` | login → accessToken, userId | cygnusb:35, xballoy login.request.ts:57 |
| GET | `/account/query` | profile, zones, maxHr, rhr, ftp, lthr, ltsp | Ericyuanxiang:60,2036 |
| POST | `/account/logout` | logout | Ericyuanxiang:71 |
| POST | `/account/update` | update profile fields | Ericyuanxiang:72,2108 |
| GET | `/profile/private/query` | display prefs / sport-mode config | shenmiguo:150 |
| GET | `/dashboard/query` | 7-day summary + `sleepHrvData` | cygnusb:36,434 |
| GET | `/dashboard/detail/query` | ATI/CTI/load/fatigue detail list | Ericyuanxiang:61,392 |
| GET | `/dashboard/team/query`, `/dashboard/detail/team/query` | team dashboards | Ericyuanxiang:69,70 |
| GET | `/analyse/query` | ~28/84-day analysis, `t7dayList` w/ VO2max | cygnusb:37 |
| GET | `/analyse/dayDetail/query?startDay&endDay` | daily metrics up to 24 weeks | cygnusb:38,503 |
| GET | `/activity/query` | activity list (paged) | xballoy:111 |
| POST | `/activity/detail/query` | activity detail + laps + streams | cygnusb:643, shenmiguo:393 |
| POST/GET | `/activity/detail/download` | signed `fileUrl` for FIT/TCX/GPX/KML/CSV | xballoy:59, dlenski:154 |
| POST | `/activity/update` | rename / annotate activity | Ericyuanxiang:62 |
| POST/GET | `/activity/delete` | delete activity | Ericyuanxiang:63, dlenski:212 |
| POST | `/activity/fit/import` | multipart FIT upload | dlenski:169 |
| POST | `/activity/fit/deleteSportImport` | remove FIT import | Ericyuanxiang:66 |
| GET | `/activity/fit/getImportSportList` | supported import sports | cygnusb:51 |
| GET | `/activity/team/query` | team activity feed | Ericyuanxiang:64 |
| GET | `/openapi/oss/sts` | S3/OSS upload creds | NYT87:295 |
| POST | `/training/program/query` | workout library (array) | cygnusb:52 |
| GET | `/training/program/detail` | single workout detail | Ericyuanxiang:47 |
| POST | `/training/program/calculate` | **estimate duration/distance/TL** | cygnusb:55, rowlando:457 |
| POST | `/training/program/add` | create workout | cygnusb:54 |
| POST | `/training/program/update` | update workout | Ericyuanxiang:48 |
| POST | `/training/program/delete` | delete workouts (`["id"]`) | cygnusb:56 |
| POST | `/training/program/copy` | copy public workout | Ericyuanxiang:50 |
| POST | `/training/plan/query` | library plans only | cygnusb:53 |
| GET | `/training/plan/detail?id=` | plan detail | open-coros-training client.py:144 |
| POST | `/training/plan/add` | create plan (⚠ 1031 reported) | shenmiguo:286 |
| POST | `/training/plan/update` | *declared, untested* | Ericyuanxiang:53 |
| POST | `/training/plan/delete` | *declared, untested* | Ericyuanxiang:56 |
| POST | `/training/plan/copy` | copy public plan | Ericyuanxiang:55 |
| — | `/training/plan/sync` | watch push — **errors** | open-coros-training API.md:80 |
| GET | `/training/schedule/query?startDate&endDate&supportRestExercise` | **active plan + calendar** | cygnusb:58, xballoy:84 |
| GET | `/training/schedule/querysum` | *declared, unused* | cygnusb:57 |
| POST | `/training/schedule/update` | **create / update / delete scheduled workout** | cygnusb:59, open-coros-training |
| GET | `/training/exercise/query?userId&sportType` | exercise catalog | cygnusb:60, rowlando:143 |
| GET | `/team/user/teamlist`, `/team/info` | teams | Ericyuanxiang:67,68 |
| POST | `{mobileBase}/coros/user/login` | mobile login (AES) | cygnusb:38 |
| POST | `{mobileBase}/coros/data/statistic/daily` | sleep/steps/stress | cygnusb:48 |
| GET | `https://static.coros.com/locale/coros-traininghub-v2/en-US.prod.js` | T-code → English | rowlando:152 |

---

## 11. Official COROS MCP (context)

`github.com/coroslab/COROS-MCP` — official, launched ~2026-05-05. **No local HTTP client to
reverse-engineer**: it is a hosted OAuth MCP at `https://mcp.coros.com/mcp`
(regional: `mcpcn/mcpeu/mcpus.coros.com/mcp`), plus an npm skill `coros-mcp`. No license file.
COROS's PM opened polite "please mark yours unofficial" issues on both cygnusb (#43) and rowlando (#4).

Relevant to a schedule bridge `[verified-in-source]` (README tool table + CHANGELOG):
- `queryTrainingSchedule` — **available** (read).
- `queryTrainingPlanDetail`, `generateTrainingPlan`, `updateTrainingPlan` — all marked
  **`coming soon`** as of the 2026-06-24 changelog.

⇒ **Schedule WRITE is not yet available on the official API.** The reverse-engineered
`/training/schedule/update` is currently the only path. `[verified-in-source]`

---

## 12. Maintenance / risk register

| Repo | Last commit | Open issues relevant to API drift |
|---|---|---|
| cygnusb/coros-mcp | 2026-07-24 (`c23c8c0`) | **#48 open** — hardcoded Android fingerprint will break mobile login when COROS version-gates clients. #47/#49 closed 2026-07-24 (region string bug; local-only token validity). |
| xballoy/coros-api | 2026-07-27 (`9355902`) | Only Renovate dependency PRs — no API-breakage issues. Most actively maintained. |
| rowlando/coros-workout-mcp | 2026-07-08 (`2a59548`) | #1, #3 open (feature requests). Last commit adds the "unofficial" notice + link to official MCP. |
| laurenceomfoisy/open-coros-training | 2026-05-31 (`73cc588`) | 0 issues. Single-commit repo; README: *"Tested with running + gym; other sports are untested."* |
| Ericyuanxiang/coros-ai-coach | 2026-05-30 (`765df96`) | **#1 open** — mobile API logs the phone app out. |
| NYT87/coros-connect | 2026-05-12 | — |
| shenmiguo/coros-data-skill | 2026-07-22 | — (CN region only) |
| dlenski/corostc | 2025-11-07 | — |
| gandroz/coros_data_extractor | 2025-12-19 | — |
| coroslab/COROS-MCP (official) | 2026-06-26 | no license file |

Known open gaps across all repos `[verified-in-source]`:
- `POST /training/plan/add` shape is only known from a CN capture; the EU attempt returned `1031`.
- No server-side watch push (`/training/plan/sync` errors); delivery depends on the phone app.
- Bike/swim structured-workout templates for the schedule path are **uncaptured**
  (`open-coros-training/docs/API.md:83-84`).
- `schedule/querysum`, `plan/update`, `plan/delete` are declared but exercised by nobody.
- `/training/program/calculate` response field naming is inconsistent between the two sources (§6.1).
