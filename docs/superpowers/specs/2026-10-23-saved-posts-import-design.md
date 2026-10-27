# Saved posts → moves: importing workout content from the owner's saved Instagram posts (design, 2026-10-23)

**Status:** draft for the owner's review.

**The ask (2026-10-22/23, the owner's words):**
- "a new system for periodically ingesting saved instagram posts, classifying them and pulling out workout videos, and putting them in my workout library and potentially workouts."
- "they have workouts I would like added to my workouts somewhere as supplemental diversity or potentially important ones to work on as long term goals."
- "the coach should come to me, and it should say that it saved X workouts in my library from my saved posts, and allow me to view and edit them or ask it to clarify anything. Then those will be saved, and it will open a dialog about how I want to integrate them, potentially asking a few questions before proposing a recommended approach that's logical and intentional towards improving my workouts holistically."
- "please include a link to the original instagram post too" … "tagged with their source and make that a permanently clickable link, but a big distinction otherwise is not important."
- "only saved in the future, but backfill it since the last ones we imported. And yeah we should include those … we need to think of a clean way to get the system up and running with great diverse workouts. You can set it up to begin with if necessary."
- "ensure the new ig import system dedupes too. Generally these should not be workouts themselves they should be integrated into existing workouts up to the coaches discretion."
- "Make sure I can have some diagnostic observability into how its working, maybe in the extension. Also, if there's a cheap way to filter out non-workout content, that would be ideal to save cost."
- On the Mac: "usually my mac is open but sometimes there can be gaps of a week or more."

- (2026-10-25, during the build) "can we ensure that it uses actually good judgment for when to recommend certain exercises and when to skip? Or basically avoid always adding every exercise." … "I would like to add a 'notes/context' section, both global and for specific workouts, where if it learns anything from these posts it can record it there for the coach to learn from in the future, for example stuff in a reel that is describing when to do certain workouts or for what purpose." → §17.

**Research behind this design:** a map of the code this plugs into, and a survey of every current way to get saved posts out of Instagram and to read a reel (both 2026-10-23; notes in the private ledger). Their findings are summarised in §2 and §4.

---

## 1. What it does, in one paragraph

A small private Chrome extension on the owner's Mac checks their Instagram saved list a few times a day, from inside their own logged-in browser, and catches up after any gap. Each new post is first sorted by a cheap filter: most saves (recipes, music, events) stop there. Posts that look like training are read whole by a video-capable model, which hears the spoken instructions, reads the on-screen text and caption, and watches the movement. Each move found is matched against the app's library. A move the library already has gains a permanent link to the post. A move it doesn't have becomes **one of the owner's own moves**, stored in their account, with its steps, cues, dose, condition ratings and the link. Nothing is imported twice. The coach then brings it up ("From your saves: 4 new moves, 3 you already had"). The owner can look through, edit, or ask about each move, and say "fit these in". The coach asks a few questions and proposes one plan of changes to the sessions and rotation the owner already has. Imported posts are not workouts of their own. The extension and the app both show what the pipeline did, step by step.

## 2. What exists today (and why that shapes the design)

- **The first manual capture (2026-09-29).** The owner's most recent saves were read in a logged-in browser tab from Instagram's own saved-posts feed (`/api/v1/feed/saved/posts/`), fetched with Apify, transcribed, and analysed by Claude Code agents. This produced posts, categories and extracted exercises, in a private local folder. On 2026-10-08, links from library moves to those posts were imported into production (`exercise_provenance`, via Settings → Import → "Saved-post links…", `provenance-import.ts`). **No whole workouts were imported.** Known gaps: carousel slides after the first were not read, some on-screen text was missed, and signed media links expired within days.
- **Links from a move to a post are already used.** They drive the Studio's "from your saves" label (`library-view.ts:317,485`), the engine's selection bonus (`engine-inputs.ts:670`) and the coach's "saved" marker (`read-library.ts:107`). Matching an imported move to an existing library move is therefore useful on day one.
- **The exercise library is static, public, curated code** (`packages/exercise-library/src/exercises/*.ts`). The UI bundles it, and about 100 files across the UI, Worker, engine and workout packages read it. There are no user-defined moves. An unknown `libraryId` is a validation error (`packages/workout/src/validate.ts:858-862`). An unrated move fails closed (`conditions/tmj.ts:46-54`). The principles say "Growth is curated, never bulk-imported" and "No personal provenance in the repository" (`docs/principles/workout-system-principles.md:213-219`).
- **`free_exercise` items skip every condition check**, and the coach refuses to write them (`act-common.ts:587-608`). They are not a safe home for imported moves.
- **The coach cannot start a turn.** A proactive notice is the computed opening line (`coach-opening-line.ts`, `readCoachOpening` in `coach-nudges.ts`), with chips whose `request` starts a run.
- **The coach has no proposal op for a move's rotation**, and none for a saved workout. `exercise_prefs.pinned` (the Studio's "Pin — keep it in my rotation") is set only by the owner.
- **No multimodal model calls exist.** The gateway client sends text only (`llm-messages.ts:147-211`; `studio-llm.ts` sends string content).
- **The Worker runs on Cloudflare's Workers Free plan.** That means about 10 ms of CPU per invocation and about 45–50 D1 statements per request (`cron-limits.ts`, `REQUEST_BUDGET`). There are no Queues and no R2 binding. The Worker can't decode or re-encode video.
- **There is one inbound machine route** (`/api/lifeos/plan`, bearer token checked against a SHA-256 secret), which this design can copy. There are no webhooks.
- **The repository is public.** No saved-post URLs, creator handles, captions or screenshots may enter code, fixtures or docs (rule D5; `no-provenance*.test.ts`).

## 3. Goals, non-goals, anti-goals

**Goals**
1. New saves are picked up automatically, and a week or more with the Mac closed loses nothing.
2. Only training content costs money to read. Everything else is skipped by a cheap filter, and the owner can override any skip.
3. Every move in a training post lands in the owner's library: as a link on an existing move, or as a new move of their own. Each one carries a permanent, clickable link to its post.
4. Dedupe at every level: post, move, and the same move across posts.
5. The coach brings each batch to the owner, answers questions about it, and proposes how to fit it into what they already do. It decides where, and the owner approves.
6. The owner can see what the pipeline did, and why, in the extension and in the app.
7. A clean start: the posts already analysed in the first capture, plus everything saved since, become a varied, curated starter set. They are introduced in themed batches, not all at once.

**Non-goals**
- Imported posts as standalone workouts. A full-routine post is kept as a reference the coach can draw on; it is not added to the workout list.
- Non-training saves (recipes, mindset, places). They are filtered out, recorded, and nothing more for now.
- Posting to or interacting with Instagram in any way.
- An iPhone share-sheet path (v1). A gap is covered by catching up (§5.1). The server endpoint takes a post key, so a share-sheet Shortcut could be added later.
- Keeping videos. Text, structure and the link are kept; media is dropped after extraction (§12).
- Adding imported moves to the public curated library. Promoting a personal move into the library is a later, curated step.

**Anti-goals (a failure even if it works)**
- Imports pausing or starving the coach. This is exactly what rehearsal spend did on 2026-10-16. Imports have their own budget.
- Duplicates in the library or the review list.
- A move reaching a workout without condition ratings. Personal moves pass the same rules as library moves and fail closed.
- A flood: 60 moves dumped on the owner at once, or a notice every hour.
- Anything from the saves entering the public repository.
- Silent failure: the pipeline stops and nobody can tell.
- Risk to the owner's Instagram account beyond normal browsing.

## 4. Decisions

**The owner's:**
1. Saves become moves in the owner's library, never workouts of their own. The coach integrates them into existing workouts and rotation at its discretion, through a proposal the owner approves.
2. The coach brings each batch to the owner: what was saved, then view, edit and ask, then a short conversation and one recommended proposal.
3. Each move carries a source tag and a permanent link to the original post. Otherwise imported moves are not set apart.
4. Scope: future saves, plus a backfill of everything saved since the first capture, plus the posts the first capture already analysed.
5. A clean, curated start with diverse content, which the lead (Claude Code) may run by hand (§9).
6. Dedupe. Observability, ideally in the extension. A cheap filter for non-training posts.
7. The Chrome extension approach. Apify is acceptable where useful.

**The lead's calls (vetoable):**
1. **New moves live in the account, as "your moves".** They use the library's record shape and pass the same validation and condition ratings, but are stored per account. The public library stays curated. This adds an entry to the principles' decision log; "growth is curated" continues to hold for the public library.
2. **The extension does the media work on the Mac.** The Worker is the coordinator: ledger, budget, dedupe, matching and the coach. This follows from the Free plan's CPU limit.
3. **The AI call goes through the Worker as a relay when probe R1 passes, and from the extension with its own key when it fails** (§14).
4. **The extraction model is a video-native Gemini model through the existing Vercel AI Gateway.** The starting point is `google/gemini-3.6-flash`; probe R3 picks the model and resolution. The filter uses the cheapest capable model.
5. **Imports get their own budget: $5 per rolling 30 days.** It is recorded in `llm_usage` under `import_*` kinds and excluded from the coach's $20 a week. The coach conversation about fitting moves in is a normal coach run and counts as coach spend.
6. **Checks run every 6 hours with jitter, plus "Check now".** A check stops at the first post already known.
7. **No video is kept.** At most a small cover image per post, and only if R2 is enabled; text plus link otherwise.
8. **The coach announces at most one saves batch per day.** The starter set is released in 3–5 themed batches over about two weeks.
9. **Nothing from a batch is used until the owner has saved it.** This follows the owner's "allow me to view and edit them … Then those will be saved".
   - A batch's new moves and new links are held as *pending*. Nothing reads them: not the engine, not the coach's search, not the "from your saves" bonus.
   - In review, the owner edits or removes moves, then taps **Save these**. Only then do the moves become usable and the links get written.
   - The bootstrap's batches stay pending until the lead's curation and their release (§9).
10. **The engine uses a personal move only when it is pinned.** A move is pinned through an approved "Fit these in" proposal (`pin_moves`) or by the owner's own Pin. Otherwise only the coach places personal moves, inside proposals the owner approves. So the engine never brings a new move into a session on its own ("up to the coach's discretion"). Saved library moves keep today's behaviour, including the "from your saves" bonus, once their links are written.
11. **Model-made ratings are used as given, shown and editable.** The model also sets plyometric/contraction, load and difficulty, and each comes with its note and a confidence.
    - Low-confidence ratings carry "check this" in review.
    - The lead checks every bootstrap move's ratings by hand.
    - A missing rating still fails closed.
    - Because a personal move enters the engine only by an approved pin, a wrong rating is seen by the owner or the coach before it can matter.
12. **The import work starts after the 2026-10-23 audit fix wave has merged.** Import spend is kept out of the coach's budget by the mechanism that wave's stream C adds (excluding spend by `llm_usage` kind). The import build reuses that mechanism rather than editing the same cutoff in parallel.

## 5. The pipeline

### 5.1 The extension (on the Mac)
- **Form.** A Manifest V3 Chrome extension, loaded unpacked from the repository (e.g. `apps/saves-extension`, built with the monorepo's tooling). Its settings hold the app's URL and an import token. It has no Instagram credentials of its own; it uses the browser's existing session.
- **Checking the list.**
  - A `chrome.alarms` timer fires every 6 hours with jitter; missed alarms fire on wake. "Check now" is in the popup.
  - On each check it uses or opens a background `instagram.com` tab and calls the saved-posts feed from that page's context. It pages newest-first until it reaches a post the app already knows, then asks the app which of the keys are new (`POST /api/saves/known`).
  - After a long gap this simply reads more pages. There is a page cap per check (e.g. 20 pages); a longer backlog continues on the next check.
- **What it reads per post:** the shortcode (the permanent key), URL, creator, caption, hashtags, media type, the carousel's slides, the video variants and the cover image. The feed already carries all of these, so no separate fetch or Apify call is needed for the owner's own saves. Collections are not used.
- **Rate.** At most 4 scheduled checks a day, sequential requests, and a stop at the first known post. To Instagram this looks like opening the Saved tab.
- **Media.** Only for posts the filter passes. The extension fetches the smallest video variant whose resolution keeps on-screen text legible (probe R4) and every carousel image, straight away, while the signed links are fresh.
- **Posts below the stop point.** A post the app already knows but has not extracted cannot be reached by the feed's stop rule. This covers the bootstrap's seeded posts, a retry, and a "process anyway". The app hands these to the extension as a work list (`GET /api/saves/work`).
  - The extension fetches each one individually in the logged-in session, through the same post-details request the post's own page makes when opened (probe R5 confirms it), which returns fresh media links.
  - Rate: at most 20 a check, sequential, with jitter. To Instagram this looks like opening a few posts.
  - The feed's stop rule is unchanged, and there is no deep re-read of old pages.
  - Apify is not needed for the owner's own saves. It stays a fallback only if R5 fails, and then its cost counts against the import budget.
- **Local resilience.** A small persistent queue (`chrome.storage.local`) holds work not yet accepted by the app, so a closed laptop, an offline moment or an app outage loses nothing.

### 5.2 The server (Worker + D1)
- **Endpoints** (bearer token, compared in constant time with a `SAVES_TOKEN_SHA256` secret, as `/api/lifeos/plan` does; absent secret means 404):
  - `POST /api/saves/known`: which of these keys are new.
  - `POST /api/saves/posts`: submit post metadata. Idempotent by key.
  - `POST /api/saves/posts/:key/filter`: submit or request the filter verdict.
  - `POST /api/saves/posts/:key/extract`: the extraction relay (§14), or results when the extension calls the model itself.
  - `GET /api/saves/status`: what the popup shows.
  - `POST /api/saves/posts/:key/override`: "process anyway" or "skip".
  - `POST /api/saves/checks`: the start and end of each extension check, with counts and errors.
- **The owner's own UI** reads and edits the same data with the session cookie, through separate cookie-auth routes.
- **Tables** (a new migration; follow the new-table checklist: migration `0029`+, `SCHEMA_VERSION`, `account-tables.ts`, `schema/index.ts`):
  - `saved_posts`: one row per (user, source, key).
    - Status: `seen → filtered_out | queued → extracting → extracted → matched | failed | skipped_by_owner | reference_only`.
    - Filter verdict and reason, extraction result (JSON, schema-validated), cost in micros, attempts, last error.
    - First-seen time (Instagram exposes no save date), and the batch it was announced in.
    - Caption and transcript are capped, stored as untrusted text, and never shown to the coach unmarked.
  - `save_checks`: one row per extension check (started, finished, found, new, filtered, extracted, failed, error words).
  - `personal_moves` (§5.6).
  - Move ↔ post links reuse `exercise_provenance` (`source_type`, `source_key`, url, creator), extended so a link can point to a personal move.
- **Statement budget.** Every route stays within the ~45 statements per request. Batches are chunked as `applyStructuralChunk` does.

### 5.3 The cheap filter
- **Stage 0, free.**
  - A creator whose earlier posts were all training, or all not, decides the verdict. Ties go to stage 1.
  - A short keyword screen on caption and hashtags (sets, reps, mobility, stretch, workout, drill, …) only promotes a post to stage 1; it never rejects one.
- **Stage 1, cheap model.** Caption, hashtags, creator name and the cover image go to the cheapest capable model.
  - Verdict: `training | maybe | not`, with a one-line reason.
  - Target: well under $0.001 per post.
  - `maybe` proceeds to extraction; `not` stops.
- **The owner's override.** Any `filtered_out` post shows its reason and a "process anyway" action in the popup and the app. An override teaches stage 0 about that creator.
- **The first capture's posts** come pre-classified by their 2026-09-29 analysis, so seeding them costs nothing (§9).

### 5.4 Extraction
- **One model call per training post.** It gets the whole video, every carousel image, and the caption, all marked as data, never instructions. It returns a strict JSON schema, validated server-side:
  - `kind`: `routine | single_move | tips | not_training`
  - `moves[]`, each with:
    - name and aliases; steps, cues, common mistakes; purpose; dose exactly as given;
    - movement pattern, body regions, equipment, position, laterality, plyometric yes/no;
    - condition attributes for every active profile (TMJ: clench, neckLoad, faceDown), each with a short note;
    - per field, whether it was **stated** (spoken, on screen, caption) or **inferred** from the movement; and a confidence.
  - `routine` (order, rounds, rest) when the post is a sequence.
  - a short summary and the training theme(s).
- **Untrusted content.** Captions and speech can contain instructions aimed at a model. The prompt treats all post content as data, the output schema forbids free instructions, and every text field is length-capped.
- **Failure handling.**
  - A schema failure is retried once with the validation error.
  - A second failure marks the post `failed`, with words the popup can show, and a Retry.
- **Cost guard.** The budget is checked before every model call (§11). An over-budget call is not made: the post waits, and the popup says "Paused — import budget".

### 5.5 Matching and dedupe
- **Post level.**
  - Unique on (user, source, shortcode). A re-save or unsave/resave is a no-op.
  - The first capture's posts are seeded into `saved_posts` so they are never re-read as new (§9).
- **Move level, for each extracted move in order:**
  1. **The public library.** A deterministic name/alias match first, then a cheap judge over the top candidates (library names, aliases, patterns, regions) for fuzzy cases. A confident match becomes a pending link on that library move, written to `exercise_provenance` when the batch is saved (§4 call 9).
  2. **The owner's personal moves.** The same steps. A match links to the existing personal move: one move, many links.
  3. **Otherwise,** a new personal move.
- **Uncertain matches** are written with a flag ("check this"). The review screen offers "Not this move" (re-match or make it its own) and "Same as …" (merge). A merge keeps both links and repoints references.
- **Within one batch,** two posts showing the same new move become one personal move.

### 5.6 Personal moves ("your moves")
- **Storage.** `personal_moves(id, user_id, record JSON, status active|archived|merged, merged_into, created_at, updated_at, edited_by_owner)`.
  - The record uses the library's `ExerciseRecord` shape, or the subset the engine, validator, player and coach read.
  - The id is namespaced so it can never collide with a library id (e.g. `my-<slug>-<short>`).
- **Validation.** On write, the library's validation (`validateLibrary`'s record checks) runs, minus the public-repo provenance rule. Condition ratings are required.
- **One catalog seam.** Everything that resolves a move id resolves it against "library + this account's personal moves". That covers the validator, eligibility, engine, player, Studio, coach tools and COROS mapping.
  - **Worker side:** a per-request catalog loaded once.
  - **UI side:** the personal moves come from the API (React Query) and merge with the bundled library through one resolver.
  - Today's direct `EXERCISES` reads are routed through it where they resolve ids. Where they enumerate the library, they keep enumerating only the public one unless the reader should see personal moves (the Studio, the coach's search, the engine pool).
- **Engine.** A personal move enters the engine's candidate pool only when it is saved and pinned (§4 call 10). It then obeys every rule a library move obeys, conditions included, and is preferred as a pinned library move is.
- **Watch (COROS).** A strength session pushed to the watch needs a COROS exercise for each move. A personal move carries a nearest COROS mapping from extraction, which the owner can edit, or falls back to a generic exercise labelled with the move's name. The builder confirms against `coros-exercise-map.ts` and the strength-set wire.
- **Editing.** The owner can edit name, summary, steps, cues, dose, and the condition ratings (with their notes). An edited move is never overwritten by a later import; later posts only add links.

## 6. The owner's experience

> Superseded in part (2026-10-26): the notice, the review screen and "Fitting them in" are now 2026-10-26-saves-flow-redesign-design.md (§3) — the Today card, the coach's saves card and the one-decision batch page.

- **The notice.** The coach's opening line gets a new source, `saves`. When an unannounced batch exists:
  - The line reads "From your saves: 4 new moves (2 hip, 1 neck, 1 jump), 3 you already had."
  - Chips: **See them** opens the review screen (a link, not a coach request), and **Fit these in** starts a coach run.
  - Rules: at most one saves notice a day. It never stacks on the Monday review, and the review takes precedence that day. It is "seen" per device like other openings (`SEEN_ID`).
- **The review screen: "From your saves."** It is reachable from the notice, from the Studio, and from Settings → Saves.
  - One row per move in the batch: name, one-line summary, **New** or **Linked to <move>**, the post link (opens Instagram), and "check this" when uncertain.
  - Tapping a row opens the move: steps, cues, the dose seen in the post, its ratings and its link.
  - Actions: **Edit**, **Not this move**, **Same as…**, **Remove**, and **Ask the coach**, which opens the coach focused on this move (focus kind `move` already exists).
  - **Save these** at the foot of the batch makes its moves and links usable (§4 call 9). "Fit these in" saves first.
  - Density rule: data, names and links only; no explainer captions.
- **Fitting them in.** "Fit these in" starts an ordinary coach run, with the batch in its context.
  - The coach may ask a few questions (`waiting_athlete`), e.g. "variety, or something to build toward?".
  - Then it proposes one set of changes using:
    - **existing ops:** revise upcoming workouts (`doc_workout` revise), add a new workout when that is the sensible home (`doc_workout` new), `programme_change`;
    - **new ops:** keep moves in rotation (`pin_moves`) and drop them from rotation (`unpin_moves`).
  - It may tie a move to an objective by revising a workout's `intent.objectiveIds`, or adding a key-result test item.
  - The owner approves or declines as with any proposal. Nothing changes without approval.
- **After a gap.** A week's saves arrive as one batch with one notice.

## 7. Coach changes
- **Context.**
  - The unannounced batch, or the focused move, appears in the run's context: the moves, their match status, summaries, and the post's summary.
  - Post text and transcript are marked `{untrusted: true}`, per the tool contract (`types.ts:21-22`).
- **Tools.**
  - `search_library` and `get_exercise` include personal moves, labelled as yours and from your saves.
  - A new read tool, `read_saves`, returns a batch or a post: its moves, links and the routine, if any.
  - Each new tool declares `statementCost` and `cpuWeight` measured on owner-shaped data (the CPU bench must use realistic inputs), is added to `PROMPT_TOOL_NAMES`, and is pinned by the registry test.
- **Ops.**
  - `pin_moves` / `unpin_moves` become a proposal kind applied through `approveDesignOps` within the statement budget.
  - `revise` uses the existing path: every moved-in item is re-judged for its day, so condition rules apply.
- **Prompt.**
  - The coach integrates rather than stacks: it fits moves into existing sessions and rotation, respects the week's load and the athlete's objectives, explains each placement in one line, and keeps to the owner's voice (brisk, one next step, no apologies).
  - Every principle in `workout-system-principles.md` still applies.

## 8. What the owner can see working (observability)
- **The extension popup.**
  - Status: OK / Instagram wants you to log in again / Paused (import budget) / App unreachable / Error, in plain words.
  - Last check, next check, and **Check now**.
  - The last 10 checks, with counts: found, new, filtered, extracted, failed.
  - Recent posts, each with its status, reason, link, and **Process anyway** / **Retry**.
  - The month's import spend against its budget.
  - The app connection: whether the token works.
- **The app.** Settings → **Saves**: one line ("Last import 2 h ago · 37 moves from 21 posts"). One tap down are the same post list and statuses, and the review screen.
- **Staleness.** If no check has arrived in 7 days, that Settings line says so plainly. There is no alarm and no nag; the garden asks, never accuses.
- **Server logs.** Every check and every model call is a row (`save_checks`, `llm_usage`), so the lead can answer "what happened to post X" from the database.

## 9. Getting started (the bootstrap)
1. **Seed.** The first capture's private post file holds every captured post's key, URL, creator and its category, non-training posts included. The lead runs a local seed script that reads it (writing nothing inside the repo, as `build-provenance.mjs` does) and inserts every post key into `saved_posts`:
   - training categories (strength, mobility/stretching, jaw/neck, posture/desk, general fitness) as `queued`, flagged for the bootstrap;
   - everything else as `filtered_out`, with reason "not training (first capture)".
   - The seeded posts are fetched one at a time through the work list (§5.1). A post the owner has since unsaved is still imported, since it was saved then; one that no longer exists is marked `failed: gone`.
   - The 2026-10-08 provenance links stay as they are.
2. **Catch up.** The extension's first check reads newest-first until it reaches the newest key from the first capture. Everything saved since then goes through the normal filter.
3. **Extract.** All bootstrap and catch-up training posts run through extraction, at roughly $0.02–0.03 each. This also closes the first capture's gaps (later carousel slides, on-screen text).
4. **Curate (the lead, by hand, in a Claude Code session).**
   - Merge duplicates, fix or flag low-confidence extractions, and mark thin posts `reference_only`.
   - Check that the starter set covers strength, mobility, posture and neck, conditioning and jumps.
   - Record what was done in the private notes.
   - No new moves enter the public library in this step.
5. **Release.** Release in 3–5 themed batches over about two weeks (e.g. hips and mobility, posture and neck, strength, conditioning and jumps). Each batch gets its notice, review and "Fit these in".

## 10. Privacy, security and terms
- **Personal data stays out of the repository.** Captions, transcripts, links and creators live in D1 under the owner's account. Code, fixtures and tests are synthetic and site-neutral wherever they don't need to name the site. The extension necessarily names the site's endpoints, which is not provenance.
- **Media.** Video is held only in the extension's memory for the call. If R2 is enabled, a small cover image may be kept per post.
- **Auth.** The extension uses a bearer token, hashed in a Worker secret. Its routes are separate from the cookie routes, rate-limited, size-capped and idempotent.
- **Untrusted content** is handled throughout as in §5.4 and §7.
- **Instagram's terms.** They forbid automated collection, even logged in. The owner accepts this for their own saves. The design keeps the footprint to that of normal use: their browser and session, a few reads a day, stopping at the first known post.

## 11. Cost and budget
- **Per post:**
  - filter: well under $0.001;
  - extraction: about $0.02–0.03, at Gemini Flash-class pricing at the time of writing.
  - Google has announced that Flash prices double on 2027-01-01.
- **Per month,** at 20–60 saves (most filtered out): about $0.50–2, under a cap of $5 per rolling 30 days.
- **Enforcement.** The Worker reserves the worst case before each call and settles afterwards, using `llm_usage` with `import_filter` / `import_extract` kinds. Over the cap, calls stop and the popup and Settings say so. This spend is excluded from the coach's budget and from the auto-read reserve, using the same mechanism as the rehearsal-spend fix from the 2026-10-23 audit (stream C).
- **Bootstrap.** The one-off cost is at most about $3, within the cap.

## 12. Failure modes
| What fails | What the owner sees | What happens |
|---|---|---|
| The Instagram session expired | Popup: "Instagram wants you to log in again" | Checks pause and resume after login |
| The feed's shape changed | Popup: "Instagram changed something — the extension needs an update" | The feed response is schema-checked; nothing partial is written |
| A media link expired | Nothing | Re-fetched as a single post on the next check (§5.1) |
| The model's response is too large or refused | Post "failed: too large" | A smaller variant is tried, then frames (§14) |
| The extraction is malformed | Post "failed", with Retry | One retry with the validation error |
| The budget is hit | "Paused — import budget" | Resumes as spend rolls off |
| The app is down or the laptop is offline | "App unreachable" | The local queue holds the work |
| The Mac is off for a week | Settings: "Last check 8 days ago" | Catch-up on wake |
| A duplicate submit | Nothing | Idempotent by key |

## 13. Phases
- **A. The pipeline.**
  - Extension: list, catch-up, filter, media, extraction, popup.
  - Server: ledger, routes, budget, Settings → Saves.
  - Matching to library moves, producing provenance links.
  - Ships value: matched moves gain "from your saves" and the engine's bonus.
- **B. Personal moves.** Table, catalog seam, validator, Studio and player, the review and edit screen, coach `search_library`/`get_exercise`, engine pool, COROS mapping.
- **C. The coach.** The `saves` notice, `read_saves`, `pin_moves`/`unpin_moves`, and the integration prompt.
- **D. The bootstrap** (§9): seed, catch up, extract, curate, release in batches.
- **E. Audit.** Code review of every phase before it ships. A final audit against the owner's words above, verbatim, with separate reviewers. A check of the coach's context for a "fit these in" run against agent-design principles.

## 14. Early probes (each with its decision rule)
- **R1: the relay's CPU cost on the Free plan.** Relay a 3, 6 and 12 MB request body to the gateway by streaming it through without parsing; the model is checked from the body's leading bytes, which the extension writes first.
  - **Pass** (within the CPU limit at 6 MB): the Worker relays, and the gateway key never leaves the Worker.
  - **Fail:** the extension calls the gateway with a dedicated key the owner pastes into its settings, and reserves and settles spend through the Worker before and after each call.
- **R2: the gateway's request-size limit for video input.** A 413 at about 4.5 MB of base64 has been reported. Find the real limit. If typical reels at the chosen variant exceed it, fall back to frames plus audio: keyframes sampled in the extension, and a transcript from a gateway speech model or an Apify transcript.
- **R3: extraction quality and model choice.** Use about 15 posts from the first capture, whose analysis serves as the answer key, weighted toward the known gaps (on-screen text, carousels, no speech).
  - Compare Gemini 3.6 Flash at default and high resolution, against a cheaper and a stronger model.
  - Confirm the model hears the audio (quote the first spoken line) and reads on-screen text.
  - Pick the cheapest model that matches or beats the first capture on moves, doses and cues.
  - Also confirm the model ids and prices from the gateway's live model list.
- **R4: the smallest legible video variant.** Find which of the feed's video variants keeps on-screen text readable to the chosen model, and how large it is.
- **R5: do the feed and the single-post read work from the extension?**
  - Run one manual page of the saved feed through the extension's code path.
  - Fetch one known post individually, through the request its own page makes.
  - Both must return fresh media links. If the single-post read fails, the work list falls back to Apify for public posts (§5.1).

## 15. Left to the builder
- Table and column names, the id scheme, and route names, consistent with the codebase.
- How the catalog seam is threaded through each reader, as long as every id resolution goes through it and enumerations are deliberate.
- The prompt wording for the filter, extraction, matching judge and coach. Every rule the code enforces must be stated by the code that enforces it, as `describeRules` does.
- The extension's build, its popup layout (density rule), and its local queue.
- Batch sizes and themes for the bootstrap release.
- Whether cover images are kept (needs R2 enabled; skip otherwise).

## 16. Open questions for the owner
None. A builder check (2026-10-23) raised three questions, and each is settled above:
- **When a move becomes usable:** §4 calls 9–11, from the owner's own words.
- **Reaching posts below the feed's stop point:** §5.1's work list.
- **The budget mechanism:** §4 call 12, by sequencing after the audit fix wave.

## 17. Addendum (2026-10-25): notes from the saves, and selective fitting

**The ask.** Two things the owner added once Phases A–B were built: the coach must not fit in every saved move, and anything a post teaches about *when* or *why* to do something should be kept where the coach can learn from it later — globally, and against the specific move or workout it concerns.

**Decisions.**
1. **Selective fitting is prompt guidance, not a new op.** The `pin_moves` proposal and the revised workouts already carry `lines`; the integration guidance (§7, Task 18) says to take only the moves that serve the athlete's objectives, conditions and the week's load, to leave the rest in the library, and to say in one line each why a move was left. `fitted_at` is still set on approval: the batch was considered, not necessarily used.
2. **Global notes live in the coach's memory** (`coach_memory`, the single long-term knowledge store). The extraction gains `insights`: standalone guidance a post states beyond any one move's steps — when to do it, for what, how often, who it suits. On **Save** (nothing from a batch is used before), each insight of a post with at least one kept link becomes a memory row: kind `observation`, confidence `inferred`, provenance `saved post`, evidence the post's link. It is the athlete's memory like any other: it shows in Settings' memory list, can be pinned or removed there, is found by `recall_memory`, and is never in the pinned core unless the owner pins it. Identical bodies are not written twice.
3. **Per-move notes live on the link.** `exercise_provenance` gains `note`: what the post says this move is for or when to do it (the extraction's `purpose`). Written only on Save. Shown under the link in move detail; carried by `get_exercise` and `read_saves` as untrusted text.
4. **Per-workout notes already exist.** A workout document has `notes`; when the coach fits a saved move into a session it carries the post's guidance into that workout's notes, so the reason travels with the session. No schema change.
5. **The review screen shows the insights** read-only (`Notes`, under the batch's rows) so the owner sees what the coach will learn before saving. Removal is per memory item afterwards, in Settings.
6. **Untrusted throughout.** Insights, purposes and creators are model-written text: marked for the coach, rendered as text in the UI.
