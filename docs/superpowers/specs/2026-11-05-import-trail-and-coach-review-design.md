# Import trail, pasted links, and a coach that shows its work (design, 2026-11-05)

Builds on `2026-10-23-saved-posts-import-design.md` and `2026-10-26-saves-flow-redesign-design.md`; where this one
disagrees with them, this one wins. Judged against `docs/principles/workout-system-principles.md`, amended by the
owner's decision in §2.4. The audit behind it is `docs/reports/2026-11-05-import-trail-audit.md`.

## 1. Why

The owner, 2026-11-05, on what happens to an import today:

> "every time - there's no end to end audit trace. I kind of just read the exercises, which are the only
> interpretable part, and just click go and hope that the coach does something good, but i really have no confidence
> or understanding."

What they asked for, in their words:

- Paste "a youtube link into that extension, and it should import the video and process it (meaning it should
  contextually understand from the transcript what is important about the exercise and in what cases you would add
  it in or not and why)".
- "the UX history should be expandable so I can get observability into the entire processing of each video and what
  the inputs, thought process, and final outputs were … I need observability into how these are considered and
  processed by the coach such that they are effectively implemented according to the actual information in the posts".
- "it should expose the most important content, and allow me to dig deeper for any of it, all presented in a
  intuitive and readable way." They like the coach's look and feel; it needs to be expandable.
- "put posts in async, and then later check on them probably mostly in the coach … with the coaches recommendation
  that is logical and easy to follow and scannable in the clearest way - as if a human was writing a direct concise
  explanation of the entire thing, which I can investigate deeper into to understand each part better or possibly
  challenge them."
- On a challenge: "please not be sycophantic, but be a true coach, and understand both sides before making a new
  proposal. If I am adamant, just do what I say. It should always have humility around information that may be
  garbled or missing context, and always be skeptical of the information it recieves, but also always seek to improve
  information so the data store is left more correct, when relevant."
- "the coach always needs to be aware of my overall goals, my current plan, and my historical progress as much as
  possible. It should be able to manage all of these to help me reach my goals as optimally as possible. This is also
  something it should always be proactive about. If I'm missing a lot of things, it should diagnose with me, and it
  should decide what's best to help me achieve my goals."
- "The youtube videos and imported saved instagram posts may be anything, including irrelevant garbage. We should
  also have visual observability on the import quality, if there were failures for any specific vendor, through
  extremely concise status reports (red/yellow/green) for each relevant part".

The owner agreed the order (audit → trail and health → YouTube → the coach's review and challenge → the coach's
goal management) and asked for the rest to be built autonomously, asking only real questions.

## 2. Goals, non-goals, anti-goals, owner decisions

### 2.1 Goals
1. **One trail per import**, from the link to the plan: for every stage, what went in, what was decided and why, what
   came out, the model, prompt version, tokens, cost, time and attempts — written when it happened, linked to the post.
2. **Every claim is openable to its evidence**: a quote from the caption or transcript (with its time), whether the
   post stated it or the reader inferred it, and how matching treated the move.
3. **Paste a link** (YouTube, or an Instagram post) in the extension; it is imported in the background and is
   waiting in the coach later.
4. **A red/yellow/green row** per stage and source, in the popup and the coach, one tap from the failures behind it.
5. **The coach's review of a batch** reads like a human coach's concise account: what came in, what's new, the
   creator's own reasons, and per move a recommendation (in, where, at what dose, why; or out, why), each claim
   cited.
6. **Challenges get a coach, not a mirror**: both sides weighed on the evidence, a new proposal it can defend; the
   owner's insistence wins.
7. **The store gets more correct**: a correction (a dose, a purpose, a bad match, a junk insight) is proposed with its
   evidence, applied on approval, and logged with before, after, why and basis.
8. **The coach always knows where the athlete stands** (objectives and progress, the plan, planned vs done, readiness)
   and raises drift itself, diagnosing with the athlete before deciding.

### 2.2 Non-goals
- A general web clipper. This round takes YouTube videos and Instagram posts only.
- Downloading YouTube video bytes (not viable: SABR streaming and PO tokens; audit §7).
- Push notifications, or coach runs that start without the athlete. Proactive means the coach raises it on Today and
  in the coach, and starts nothing on its own (principles §11: "nothing changes without the athlete's tap").
- Changing COROS sync, the garden, the player, or how the engine places moves.

### 2.3 Anti-goals (a failure even if it technically works)
- **Raw JSON as observability.** Raw is the last layer, never the first; every level above it is plain sentences.
- **A trail rebuilt after the fact that disagrees with what happened.** Trail rows are written by the stage that did
  the work, in the same D1 batch as the state change. The only rebuilt rows are the backfill's (§6.6), labelled so.
- **A value cut with no way to see the rest.** Every clipped line has "Show all".
- **A sycophantic coach**: a recommendation changed because the athlete pushed, with no new evidence named.
- **A model's guess presented as the creator's words.**
- **A silent rewrite of the athlete's data.** Every correction is a logged, approved change.
- **A surprise bill.** A video's cost is reserved from its length before the call, and long videos are not watched
  unless the athlete asks (§5.4).
- **Busywork for the athlete.** The default path stays one tap: Fit them in. Everything else is optional depth.

### 2.4 Owner decisions (2026-11-05)
1. **The coach's opening context carries where the athlete stands** (§7.1), amending principles §6.3 ("tools first;
   inject only what the agent must know"). The owner's words: "the coach always needs to be aware of my overall goals,
   my current plan, and my historical progress as much as possible." The block is computed, bounded and cheap; the
   detail stays behind tools. Recorded in principles §12.
2. **The order of work** in §1, and autonomous building.
3. **Challenge behaviour** as in §1, verbatim.

## 3. The owner's experience

### 3.1 Putting links in

**In the extension popup**, a field at the top: "Paste a YouTube or Instagram link". Paste and press Enter (or Add):
"Added — it'll be waiting in the coach." The popup can close; the background does the work, one link at a time.

- When the popup opens on a YouTube video page, the field is filled with that video and the button reads "Import this
  video". (My call: the common case is "I'm watching this, keep it".)
- Accepted: `youtube.com/watch?v=…`, `youtu.be/…`, `youtube.com/shorts/…`, `instagram.com/p/…`, `/reel/…`. Anything
  else: "Only YouTube and Instagram links for now."
- A link already imported: "Already in — imported Tue 3 Nov." with **Open** (the trail in the app).
- **Recent links** in the popup: one row each — title, then the status in a word or two: *reading*, *screening*,
  *reading the moves*, *3 moves*, *not training*, *failed: no captions and the video can't be watched*. A failed or
  filtered row has **Retry** / **Import anyway**.

### 3.2 The health row

A row of small labelled lights: **Instagram · YouTube · Screening · Video reader · Matching · Coach · Budget**. Green,
yellow, red, or grey (nothing to judge in the window). When all are green the row is the only thing shown. Otherwise
one line under it names the worst, e.g. "YouTube: 2 of 3 transcripts failed today". Tapping a light opens its
failures: each the post's title, when, the reason in plain words, and Retry.

It appears in the popup (under the headline) and on the coach's saves card. The rules are in §6.5.

### 3.3 Reviewing in the coach

The Today card, the coach chip and the saves card stay as the redesign built them (Fit them in / Choose first / not
now). Pasted links join the same batches. What changes is what the coach gives back and how deep it goes.

**The review is the fit-in proposal**, redesigned. Nothing changes until Approve, so the proposal is the
recommendation the owner weighs. The card:

> **Nine moves from four posts. I'd add five, leave four.**
> Two fill the hip work your plan has been short of; three slot into the week's post-run mobility. Two of the four
> repeat what you already do, one needs a cable stack, one post's claims don't hold up.
>
> **In**
> **Zorbex hip lift** · Thu post-run mobility · 2×6 per side — the creator pitches it for runners whose hips stiffen
> after easy runs ⟨said 1:12⟩; it serves *hip mobility*.
> …
> **Left out**
> **Zorbex long-lunge stretch** — you already do a stronger version.
> …
> [Approve] [Decline]   · How the coach made this

- Each line: the move's **name** (from its id, as now), where it goes, the dose, one sentence of why, and the goal or
  gap it serves. Evidence chips sit inline: ⟨said 1:12⟩ (a verified quote), ⟨in the caption⟩, ⟨reader's guess⟩ (the
  extraction inferred it), ⟨your history⟩. A claim about what a creator says with no quote behind it is not allowed
  (§8.3).
- Tapping a move's name opens **that import's trail** (§3.4) at the move. Tapping a chip opens the evidence itself:
  the quote in its transcript context, or the inference marked as such.
- Lines are grouped In / Left out, In first. The headline is the coach's own, two sentences at most.
- The card's lines and `why` are carried into later turns of the conversation, so "why did you leave X out?" reaches
  a coach that has its own reason (audit §5).

### 3.4 The trail of one import

One sheet, reachable from: a line on the review card, the batch page's rows, Settings → Saves post rows, the popup's
recent links (opens the app), and the health row's failures. It reads top to bottom as an account, each level one tap
deeper than the last. Same visual language as the coach's trail (✓ lines, fold buttons, key/value rows), with two
rules the coach trail doesn't keep today: the most important content first, and nothing cut without "Show all".

**Level 1 — the account** (always open):
1. *Where it came from*: title, creator, source and length, when it was saved or pasted.
2. *What it is*: the reader's summary of the post, and its kind (routine, single move, tips, not training).
3. *The moves*, one line each: name, new or "same as your X", and the reader's line on what it's for.
4. *What the coach did*: per move, the decision and its line, or "not reviewed yet".
5. *Corrections*, if any: "Dose fixed Wed 4 Nov: 2×30 s (was 8–12 reps) — the transcript says so at 3:12."
6. A health word for the import: "Read cleanly", or what went wrong ("the reader couldn't watch the video; it read the
   transcript only").

**Level 2 — one section per stage**, folded, each with a one-line result: Reading (the extension), Screening,
Reading the moves, Checking the reading (repairs and flags), Matching, Batch, Your choices, The coach, Corrections.
Opened, a stage shows its inputs (caption, transcript with the quoted passages marked, chapters, metadata), its
decision and reason, its outputs (for the reading: each move's fields, each with stated/inferred and its quotes), and
the call's facts: model, prompt version, tokens, cost, time, attempts and why each retry happened.

**Level 3 — raw**: the exact prompt (system text from the prompt registry, user text as sent, minus media), the raw
reply of every attempt, the HTTP status and finish reason. Monospace, copyable, never cut.

Each move's own section (from the account's move line) gathers that move's fields, quotes, match, flags, the coach's
decisions about it across runs, and its corrections.

### 3.5 Challenging the coach

The owner replies in the conversation, or taps **Challenge** on a review line (it fills the reply box with "About
<move>: "). The coach answers in this order, briefly:

1. **The athlete's point, stated fairly**, and what speaks for it.
2. **The evidence**: the quote and its time, or "the post never says — that was the reader's guess", and what the
   athlete's history and goals say.
3. **Its call now**, and what moved it, or why it holds. It never changes a call without naming the reason, and never
   holds one out of stubbornness.
4. If the athlete insists (they repeat their position after the coach's answer, or say so plainly), it does what they
   say, without arguing further, and says what it changed.

When the challenge or the evidence shows the stored data is wrong, the new proposal carries the **correction** too
(§8.4). A correction made only because the athlete insisted, with the evidence against it or silent, is recorded with
`basis: owner`, so a later reader knows where it came from.

The coach is skeptical throughout: a transcript can be garbled, a caption can lack context, a reader can invent; a
quote it cannot find in the source is not evidence; "the reader's guess" is weaker than "said"; what the post doesn't
say, it doesn't claim.

### 3.6 The coach raising things itself

With where-you-stand in every context (§7.1) the coach weighs imports against the athlete's actual position ("serves
hip mobility; your plan has had none for three weeks"). Drift (§7.2) shows as a "needs you" chip on Today and in the
coach, e.g. "2 of 6 planned lifts in three weeks — talk it through?". Tapping it opens a conversation in which the
coach diagnoses first (one question at a time, tappable options), then decides and proposes, then remembers what it
concluded.

## 4. The pipeline, stage by stage (what each records)

Every stage writes one or more trail events (§6.1). The table says what each event holds; "full" means not clipped.

| Stage | Where | Event holds |
|---|---|---|
| Read | extension | source, key, how it came (saved list / pasted), what was fetched (video variant, bytes, by link, cover; for YouTube: metadata, captions kind and language, transcript length, chapters), extension version, time taken; a failure's code and the site's words |
| Submit | Worker | the post row created or found; a duplicate's original |
| Screening | Worker | verdict, reason, the stage (rules or model), the raw reply (blob), model, prompt version, cost; a reply that doesn't parse is a failure, never a paid `maybe` |
| Reading the moves | Worker relay | every attempt: raw reply (blob), finish reason, tokens, cost, time, issues that forced a retry, whether the video was seen (§5.4) |
| Checking the reading | Worker | each repair (field, before, after, rule), each `moveProblems` finding, each dose's origin (post / default), quote verification results |
| Matching | Worker | per move: name rule hits, candidates and scores, whether the judge ran and its answer, the near-duplicate rule that fired, the final link and confidence |
| Batch | Worker | which batch, why this one (oldest first, cap) |
| Choices | Worker | the owner's Include / Skip / Coach, Process anyway, Same as…, edits (with a diff) |
| Coach | Worker | per move, per run: proposed (decision, line, cited evidence), then approved / declined / superseded |
| Corrections | Worker | target, field, before, after, why, basis, evidence, who, the proposal |

## 5. Pasted links and YouTube

### 5.1 The extension's link queue
- The popup sends `{type: "add-link", url}` to the background, which normalizes it (§3.1), stores it in a persistent
  link queue in `chrome.storage.local`, and answers at once. The background processes the queue one link at a time,
  on add and at each alarm, after the saved-list check (never concurrently with it: the existing single-flight lock
  covers both).
- An Instagram link: read with the existing single-post reader (`readPost` by shortcode), then the existing submit and
  extract path with `origin: "pasted"`.
- A YouTube link: §5.2.
- Each link's state lives in the queue until the app has it, then the app's status is the truth (the popup's recent
  links come from the app, merged with what's still local).

### 5.2 Reading a YouTube video in the owner's session
1. Open the watch page in a background tab (`active: false`), wait for the player.
2. A MAIN-world script reads `#movie_player.getPlayerResponse()` (not `ytInitialPlayerResponse`, which goes stale):
   `videoDetails` (title, channel, id, length, description, live), `microformat` (publish date, category, unlisted),
   `playabilityStatus`, `captions.captionTracks`.
3. Chapters from the player bar's markers when present, else YouTube's description-timestamp rule (starts at 0:00, at
   least three ascending, each ≥ 10 s).
4. The transcript: pick the creator-uploaded track in the video's language, else the auto-generated one. Turn
   captions on through the player so it fetches the track itself (with its PO token), capture that request's URL from
   the page's resource timing, and fetch it as `fmt=json3`. Fallback: open the transcript panel and read the page's own
   `get_transcript` answer or its segments. Segments are kept as `[start seconds, text]`.
5. Close the tab. A whole read is capped at 60 s; a failure says which step failed in plain words ("YouTube asked to
   sign in", "age-restricted", "live now — try after it ends", "no captions").
6. No captions is not fatal by itself: the video reader may still watch the video (§5.4). It is fatal only when the
   video can't be watched either.

Builder's call: the exact selectors and the captions trigger. The read must be verified live against a real public
video before the plan's YouTube tasks are called done (the research could not prove the captions trigger works in a
background tab).

As built (phase 2, 2026-11-06; the live spike of 2026-11-05): fetching a track's link — or the player's own timedtext
request again — returns an empty body, so step 4 instead wraps the page's XMLHttpRequest and fetch in the MAIN world
before the player is asked for captions (the module, the track, the subtitles button off and on, a muted moment of
play) and keeps the player's own answer (json3; the XML formats parse too). Every parser is a pure function
(`apps/saves-extension/src/youtube.ts`); the page scripts are in `youtube-reader.ts`. The transcript travels as one
text, a segment a line (`<seconds>\t<words>`), cheap for the Worker to check.

### 5.3 What the app receives (additive to `postSubmitSchema`)
`source: "youtube"`, `key` = video id, `url` = canonical watch URL, `creator` = channel, `caption` = description
(≤ 5,000; YouTube's own cap), `mediaType: "video"`, `postedAt` = publish date, plus optional: `origin`
(`saved` | `pasted`), `title`, `durationSec`, `chapters[] {start, title}`, `transcript {lang, kind: uploaded|auto,
segments}` (≤ 400 KB; a longer one is cut at a segment boundary and says so), `live` flag. The transcript is stored
as a blob (§6.2), never in the post row.

### 5.4 Screening and reading the moves
- **Screening** sees the title, description, chapters and the transcript's first ~1,500 words. A pasted link is still
  screened (the owner: links "may be anything, including irrelevant garbage"); "not" waits as filtered with Import
  anyway, as saved posts do.
- **Reading the moves** gets the caption/description, title, chapters and the full transcript with times, inside the
  untrusted data block. The video is attached by its URL when it is **20 minutes or shorter** (my call: a 20-minute
  video costs ~$0.10 watched at today's prices, an hour ~$0.30, and prices double on 2027-01-01). A longer video is
  read from the transcript and chapters only; its trail says so and the batch row and trail offer **Watch it too**
  (with the estimated cost), which re-reads it with the video.
- **As built (phase 2):** a YouTube reading carries no media bytes, so the Worker builds its body itself from the
  stored words (`POST /api/saves/posts/:key/extract-video`, the extension's request holding the call open): the prompt
  is "as sent" by construction; claim, reservation, settle, finish and matching are the relay's.
- **Was the video seen?** The gateway's Chat Completions passing a YouTube URL to Gemini is undocumented. After each
  call the Worker compares the billed prompt tokens with the text alone; a watched video adds ~100 tokens a second.
  Under half that, the reading is marked `videoSeen: false`, the trail says "the reader couldn't watch the video; it
  read the transcript only", and the Video reader light goes yellow. With no transcript and no video seen, the
  reading fails ("nothing to read: no captions, and the video couldn't be watched").
- **Budget**: the reservation for a URL body comes from the duration (≈100 tokens a second watched, plus the text),
  not the body's bytes; a reading that can't fit the remaining budget waits as `budget_paused` without being retried
  each check (audit bug 6).
- **Limits**: output tokens sized for the longest reasonable reading (a 30-move follow-along) with headroom (32,000);
  the Worker's call timeout grows with the video's length (120 s plus 2 s per minute watched, at most 600 s), and the
  extension waits that plus 60 s. A reading cut at the output limit is a failure that says so, never silently
  retried shorter. (The owner's standing rule elsewhere: never truncate a reasonable model call.)

### 5.5 The reading's new fields (prompt `extract-6` — `extract-5` went to the alternating-moves fix on main, 2026-11-05 — additive to `extractionSchema`)
- Moves cap raised from 12 to 30 (follow-alongs).
- Per move:
  - `useWhen[]`, `skipWhen[]` (≤ 4 each, ≤ 160 chars): when the post says to use it or not — the "in what cases you
    would add it in or not" the owner asked for. Each item `{text, evidence: stated|inferred}`.
  - `why` (≤ 200): why the post says to do it.
  - `quotes[]` (≤ 8): `{field, text (≤ 200, verbatim), at? (seconds), from: caption|transcript|speech|screen}`, the
    passages that support name, dose, purpose, useWhen, skipWhen and steps.
  - `evidence` gains `purpose`, `useWhen`, `skipWhen` (stated/inferred), beside name, dose, steps.
- For an Instagram video, the reader also returns `speech` (≤ 4,000 chars): what is said, transcribed, so quotes from
  speech can be checked and the owner can read it. It is labelled "transcribed by the reader", never "the transcript".
- Insights gain `{text, scope: general|this_routine|creator_programme, quote?}`. Only `general` ones go to the coach's
  memory on save; the others stay with their post (the owner saw a creator's own 3-day split saved as a rule).

### 5.6 Quote verification (Worker, deterministic)
Each quote is checked against its source (caption, description, title, transcript, or the reader's `speech`):
normalized (case, punctuation, whitespace, ASCII-folded) substring, else ≥ 0.8 token overlap within a window of the
quote's length near `at`. Results: `verified` (found in a source the reader didn't write), `in_speech` (found only in
the reader's own transcription), `not_found`. A `not_found` quote is shown struck through in the trail as "the reader
quoted words that aren't in the post", and the field it supports counts as inferred. Builder's call on thresholds.

## 6. The trail: data and routes

### 6.1 Tables (migration 0034, additive)
- **`import_events`**: `id`, `user_id`, `post_id`, `batch_id` (null), `move_id` (null), `stage`, `source` (instagram,
  youtube, gateway, worker, coach, owner), `status` (`ok` | `warn` | `fail` | `skip` | `info`), `summary` (one plain
  line, written by the stage), `detail` (JSON, ≤ 64 KB; bigger pieces go to blobs), `usage_id` (the `llm_usage` row),
  `model`, `prompt_version`, `cost_micros`, `latency_ms`, `attempt`, `run_id`, `proposal_id`, `rebuilt` (0/1), `at`.
  Indexed by post, by batch, by (user, stage, at).
- **`import_blobs`**: `id`, `user_id`, `post_id`, `kind` (`raw_reply`, `transcript`, `speech`, `prompt_user`),
  `event_id`, `text` (≤ 1 MB), `at`.
- **`prompt_versions`**: `version` (pk), `kind`, `system_text`, `first_used_at` — written insert-or-ignore on a
  version's first call, so every trail can show the exact system prompt it ran under. Prompt versions are finally sent
  and stored (audit: they were used only in tests).
- **`import_corrections`**: `id`, `user_id`, `target` (`move` | `link` | `insight` | `reading`), `target_id`, `field`,
  `before`, `after`, `why`, `basis` (`evidence` | `owner`), `evidence` (JSON refs), `by` (`coach` | `owner`),
  `proposal_id`, `at`. The owner's own edits on the move sheet write rows too (`by: owner`), so the record's history is
  never just an overwrite.
- `saved_posts` gains `origin`, `title`, `duration_sec`, `video_seen` (null/0/1). (`llm_usage` needs nothing: the
  reservation's id is known before the call, and the event carries it as `usage_id`.)
- **The prompt as sent**: the relay streams the extension's body to the gateway unread (a 20 MB video costs the Worker
  no memory), so the Worker can't copy the prompt from it. At call time it rebuilds the user text (minus media) from the
  stored post with the same `@rg/saves` builder, stores it as a `prompt_user` blob, and compares its hash with the
  `x-saves-prompt-sha` header the extension sends; the trail says "as sent" or "the extension's prompt differed (older
  extension)".
- Retention: kept with the account; the account's delete-all and export include the new tables. (D1 free storage is
  ample: a post's blobs are tens of KB; a long transcript a few hundred.)

### 6.2 Writing
- Each stage writes its events in the same `db.batch` as its state change, so the trail can never disagree with the
  state. Statement budgets stay within Workers Free (≤ 45 per request): a stage adds one insert for its events (multi-
  row) and one per blob. Every route whose count changes updates its pin.
- The extension's read facts travel with the submit (`readFacts`, additive), and the Worker writes them as the read
  event. A read that failed before any submit is told to the app by `POST /api/saves/read-failed` (source, key or URL,
  code, message), so YouTube failures reach the health row.

### 6.3 Reading (owner routes, bearer session)
- `GET /api/my-saves/posts/:id/trail` → the account (§3.4 level 1) and the stage sections with their events, blobs
  listed by id and size. ≤ 6 statements.
- `GET /api/my-saves/blobs/:id` → one blob's text.
- `GET /api/my-saves/health` and the token route `GET /api/saves/health` → §6.5.
- `GET /api/my-saves/links` → recent pasted links with their status (for the popup and Settings).
- Token routes for the extension: `POST /api/saves/links` (add a link the popup took when the app is reachable, so a
  phone's view shows it at once), `POST /api/saves/read-failed`.

### 6.4 The coach's trail, fixed
The coach's run trail is part of the same observability and is fixed in this round:
- A `tool_result` event keeps the result's data (bounded at 16 KB; past that, a structured digest the tool writes:
  for `read_saves`, each move's id, name and which fields came back), so "Read 6 moves from your saves" opens to the
  six moves.
- No `{truncated, head}` JSON is ever rendered: a tool's input renders through its own words (a pins card's lines as
  lines; a draft as its parts), and a payload too big for the event keeps its words in a blob linked from the event.
- "In full" shows the full text. Detail values keep a one-line preview with "Show all".
- Personal move ids render as their names in trail notes (audit §5).
- The pins card's `why` is shown at the card's foot, and its lines and why are carried into later turns' context.

### 6.5 Health rules (computed on read, deterministic)
Per light, over the last 7 days (and the last 20 events of that stage, whichever is fewer):
- **Red**: the stage's last attempt failed with a stage-wide cause (Instagram login or feed change; the gateway's auth,
  out-of-credits or 5xx on every call; budget exhausted; the coach's fit-in run failing), or ≥ 50% of at least 4
  attempts failed.
- **Yellow**: any failure since the last success; a retry was needed; budget past 80%; a video read from its
  transcript only; Instagram not checked for 2 days while the extension is installed.
- **Green**: otherwise. **Grey**: nothing in the window.
- The line under the row names the worst light and its count in plain words. Builder's call on exact thresholds and
  copy, within these.
- The popup headline stops reading "Up to date" while any light is red (audit bug 7).

### 6.6 Backfill
Posts imported before the trail have no events. A one-off script (dry run first, run by the lead after deploy, with
the owner's go-ahead for a production write) writes `rebuilt` events from what is stored (screening verdict and
reason, the parsed reading, links and flags, batch, choices, provenance), each labelled in the trail "rebuilt from
what was kept; the raw replies weren't kept then". Each old post's trail offers **Read it again** (re-extract under
`extract-5`, at its cost); nothing is re-read automatically.

## 7. The coach knows where the athlete stands

### 7.1 Where you stand (every main run's opening context)
A computed block, ≤ ~1,500 characters, from data the app already has:
- **Objectives**: each active one's title, its key results' current vs target vs due, and pace (ahead / on track /
  behind / no data) — `checkin` and `test` key results get their measures fixed (audit §6).
- **Planned vs done**, per discipline (runs, strength, mobility and care, yoga): last 14 days and last 4 weeks, with
  missed, skipped (the athlete's own), unresolved (not known) counted apart.
- **The next 14 days**: each day's sessions in one short line (not a count).
- **Readiness**: the latest verdict and the 7-day trend of HRV, resting HR and sleep (values, not just dates).
- **The last weekly review's first line**, and any activity read flagged in the last 7 days, one line each.
- **Memory**: the count of items beyond the core, by kind, so the coach knows to look.

### 7.2 Drift and diagnosis
Deterministic rules (builder's call on exact numbers): a discipline under half its planned sessions over the last 3
weeks (≥ 3 planned); 3 or more missed or unresolved sessions in 14 days; a key result behind pace by more than a
quarter with under half its time left; none of a planned discipline in 21 days. A hit becomes a "needs you" chip on
Today and in the coach, worded as an observation and a question, never an accusation, and never asserting "I missed
it" for a session the app only knows is unresolved. The chip's run gets a diagnose-first instruction: ask what's in the
way (one question, tappable options, free text), then decide (change the plan, the objective, or the approach) and
propose, then `remember` the conclusion as pinned memory with a check-back date, which the next drift read honours.

### 7.3 The nudge bugs (audit §6), fixed in this round
The missed-session chip's window matches reconcile's timing; "needs you" chips are never crowded out by the opening's
own; the missed chip's words match what the app knows; the comeback chip ignores activities under 5 minutes.

### 7.4 As built (phase 4, 2026-11-06)
Plan: `docs/superpowers/plans/2026-11-06-coach-where-you-stand.md`. The block and the drift rules live in
`apps/worker/src/services/where-you-stand.ts` (one statement and the key results' measures); the chip in
`coach-nudges.ts` and `packages/ui/src/components/needs-you-today.tsx`; the diagnose run as `nudge` → `settings.diagnose`
→ `DIAGNOSE_LINES`; the conclusion as `remember` with `drift` and `checkBack` (pinned within the cap, in provenance: no
schema change). The builder's numbers (§12): drift over the 21 days before today — a discipline with ≥ 3 planned and
under half done, or 2 planned (the first a week back) and none done on or off the plan; ≥ 3 sessions missed or not
logged in 14 days; a key result behind by more than a quarter with under half its time left; a session still within
the sync's grace is no part of a drift. Pace: ahead / on track within ±10 % of the time gone / behind. The block reads
about 1,500 characters (1,580 for the synthetic athlete in its test), ≤ 2,000 on a rich account. Check-in and test key
results read the athlete's numeric answers (90 days; a test's under its id).

## 8. The coach's review, challenge and corrections

### 8.1 What the coach reads about an import
`read_saves` gives, per move, beyond today's fields: the extraction's confidence; per field stated/inferred; the
quotes with ids (`q1`, `q2` …, scoped to the read) and their verification; `useWhen`, `skipWhen`, `why`; the post's
dose words and whether the record's dose came from the post or a default; the match (new, or same as X, by name or by
the judge, with confidence) and any check reasons; corrections already made. Per batch, insights keep their post and
scope. The opening context's 40/60-character skim stays, but `pin_moves` refuses a line about a move whose evidence the
run has not read (one `read_saves` page covering it), naming the move.

### 8.2 The prompt
The "Integrating saved moves" rules gain, briefly: weigh each move against where the athlete stands (§7.1) and name
the goal or gap it serves; treat a post as a stranger's claim — a verified quote is the creator's word, a reader's
guess is a guess, a missing quote means the post doesn't say; never present a guess as the creator's; when the
reading looks garbled or wrong, say so and propose the correction; the challenge order of §3.5; the athlete's
insistence wins, recorded as `basis: owner`.

### 8.3 `pin_moves` lines and citations
A line is `{moveId, decision: in|out, where?, dose?, text, cites[]}` where `cites` are quote ids or `history` /
`goal:<id>` / `inferred:<field>`. The tool refuses (as a fixable tool error) a line whose text attributes a claim to
the post or creator ("she says", "the post recommends", "according to") with no quote cited, and a cite id the run
never read. The card renders cites as the chips of §3.3. On approval the Worker writes one coach event per move to
each of its posts' trails (decision, line, cites, run, proposal); proposals declined or superseded write that too.

### 8.4 Corrections
A new proposal op, **`correct_import`**: `{target, targetId, field, after, why, basis, cites[]}`; the Worker reads
`before` itself. Targets: a personal move's name, summary, purpose, dose, laterality, load, equipment, steps, cues; a
link's match (same as another move, or not the same); an insight (drop, reword, change scope, attach to a move); the
reading's `useWhen` / `skipWhen` / `why`. It rides in the same proposal as the pins (the athlete approves once) or
alone. On approval it applies, writes `import_corrections` and a trail event. The validator refuses a correction to an
archived or library move, or one whose `before` changed since the run read it.

### 8.5 The reviewer
The independent reviewer's rubric gains **faithfulness to the evidence**: a revised workout's item dose, why and notes
for a saved move must match the move's record and cited quotes or say why they differ. A mismatch with no reason is
must-fix.

### 8.6 As built (phase 3, 2026-11-06)
Plan: `docs/superpowers/plans/2026-11-06-coach-review-phase-3.md` (its rulings, and the ledger's, are the builder's).
- **The evidence** (`apps/worker/src/services/saves-evidence.ts`, `design-tools/read-saves.ts`): quote ids are
  `q<n>.<k>` — the move's place in its batch and the quote's across the move's links — stable across pages. Each move
  carries its record's dose and where it came from (post, reading, default, library, edited, an earlier post) and its
  corrections; each link its post and position, the match (new, yours, library; by name, the judge or new), and the
  reading as evidence (stated, inferred — a field whose quotes were all not found reads as inferred — why, use and skip
  when, quotes as said / in the caption / heard / on screen / not in the post). Insights keep their post (`ref`) and
  scope. One statement more (3); the page's byte budget holds fewer moves now.
- **What the run read** travels as read_saves' receipt in its trail event (never the model's); `pin_moves` and
  `correct_import` read it back inside their own statement (`design-tools/saves-reads.ts`).
- **A line** (`pin_moves`): its decision is the card's own (pinned here, in a workout of the suggestion, or in rotation
  already → in), a contradicting one refused; its dose the tool's (the revised item's, a dose correction's, else the
  record's), a coach dose with other numbers refused; refused too a line about an unread batch move, an unknown cite,
  and a claim about what the post says with no quote. Cites are stored as chips.
- **Corrections** (`design-tools/correct-import.ts`, `import-corrections.ts`): the four targets, `before` read by the
  Worker; applied at Approve before the pins, each in one atomic batch (its row and trail events gated on the value still
  being `before`, the state change last), refused `stale` when it moved, recorded applied when already so. A dropped
  insight is kept with `dropped: true` and read by nothing; an insight's memory row follows its text and scope. "Same as"
  archives a clean duplicate (no sets, plans from today on, pin or other link), else marks it like the move.
- **The trail** (`coach-trail.ts`): suggested (and the posts read, at the read's time) when the card is shown — written
  only when it holds a pins card or a correction — then approved, declined or replaced, each in the write that decides
  it.
- **The prompt**: the saves paragraph's evidence rules and the main block's challenge order (§3.5); insistence never
  overrides a condition's never or a sore area (§15 Q1's default). **The reviewer**: `faithfulness`, scored only when the
  draft holds a saved move; a saved item in the packet carries its record's dose and purpose.
- **Costs**: read_saves 3 statements (CPU 1.4), pin_moves 2 (0.7), correct_import 2 (0.4); MOVE_PINS_FIXED 4,
  DECLINE_COST 8, CORRECTIONS_FIXED 3 (the library read again once) + 3 a correction (+2 same as, +1 not the same or an insight's memory); finish 4,
  a stop's reserve and a tree's expiry one more each.
- **The card** (`packages/ui/src/screens/studio/review-lines.tsx`): In, then Left out, the corrections, the why; a
  name opens the post's trail at the move, a quote's chip at the quote (the trail sheet's `focus`); Challenge fills the
  reply box. A card stored before draws as it did.

## 9. Bugs folded in (audit §4, §5)
All ten of audit §4, and from §5: tool results kept in the trail; no raw JSON rendered; "In full" uncut; personal ids
named; the pins `why` shown and carried; insights limited after filtering, not before, and keeping their post. Each
gets a failing test first.

## 10. Constraints
- **Workers Free**: ≤ 45 D1 statements and external fetches per request, 10 ms CPU; long work in resumable steps.
- **D1**: ≤ 100 bound parameters a statement; a row ≤ 2 MB (blobs are capped at 1 MB).
- **Public repository**: no real links, handles, captions, transcripts or move names in code, fixtures, tests or docs.
  Synthetic `Zorbex …` names and made-up creators, as the earlier plans do. Links assembled so the privacy grep never
  sees a literal one.
- **Untrusted text**: transcripts, descriptions, titles, chapter names and the reader's speech are a stranger's words:
  inside the data block, defanged, marked untrusted to every model, drawn as text by the UI.
- **The owner's voice**: brisk, one next step, no apologies, no explainers on the page; explanation lives one tap
  down (principles §7).
- **Never truncate a reasonable model call**: limits sized from worst cases with headroom (§5.4).
- **Schema**: migration 0034 is additive. The owner's go-ahead for autonomous building is taken as the OK for it
  (principles §8 asks for the owner's OK on schema changes); the backfill's production write waits for an explicit
  yes.
- **Landing**: small merges to `main` (every push deploys), CI and Deploy green, suites in local time and UTC.
- **Another session** is working on the exercise library and the saves prompt on `main`; rebase before each merge and
  keep its `extract-4` rules in `extract-5`.

## 11. Phases (each: plan → test-first build → independent audits → fix wave → merge → deploy → live check)
1. **The trail and health**: tables, every stage's events and blobs, prompt registry, failure reasons, the bugs of §9
   in the pipeline, the trail sheet, the health row (popup and coach), the coach trail fixes (§6.4).
2. **Pasted links and YouTube**: the popup field and queue, the YouTube reader, the schema and `extract-5` fields,
   quote verification, the video-seen check, duration budgets, Watch it too.
3. **The review, challenge and corrections**: §8 and the review card (§3.3), challenge behaviour, `correct_import`,
   the reviewer's faithfulness dimension.
4. **Where you stand and drift**: §7.
5. **Backfill** (with the owner's yes) and the end-of-programme audits (principles §10).

## 12. Left to the builder
Exact copy within the voice; thresholds in §5.6, §6.5, §7.2; the YouTube selectors and captions trigger; blob and
digest shapes; component placement within the existing sheets; statement-count pins.

## 13. My calls (cost if wrong)
1. **Pasted links are screened like saves** (cost: an intentional link filtered; Import anyway is one tap).
2. **Watch the video only up to 20 minutes** by default (cost: a long follow-along read from words alone until the
   owner taps Watch it too).
3. **The review is the fit-in proposal**, not a separate pre-review step (cost: if the owner wants to read before any
   proposal exists, Choose first still opens the batch page, now with each move's trail).
4. **Corrections are proposals**, approved with the rest (cost: one more line to read; nothing changes unseen, per
   principles §11).
5. **Proactive means chips, not pushes** (cost: a drift waits until the owner opens the app).
6. **"Import this video" pre-fill** on a YouTube page (cost: none if unused).

## 14. Decisions after the builder check (my calls, 2026-11-05)

A reviewer read this document as the builder would and asked six questions. Four are settled here; two are the
owner's (§15).

1. **A review line says only what Approve does.** A pin makes a move eligible; the engine places it. So a line's
   `where` is either a workout this same proposal revises ("in Thursday's mobility, revised here") or the rotation it
   joins ("joins your mobility rotation"). A line's `dose` is the dose the move will run with: the record's for a
   personal move, the library's for a library move, the item's in a revised workout. When a personal move's record dose
   differs from what the post stated (an invented default, a misread), the proposal must carry the `correct_import`
   dose fix, and `pin_moves` refuses a line whose dose the move won't have after the proposal applies. A library move
   keeps the library's dose (no per-athlete override this round); when the post states another, the line says so ("the
   post does 2×30 s; the library's 3×20 s stays"). §8.5's faithfulness check covers the revised workouts.
2. **A quote found only in the reader's own transcription** (`in_speech`) is cited as ⟨heard 0:12⟩: "what the reader
   heard in the video". It may support a line about what the video says ("in the video she says…"), never be shown as
   ⟨said⟩, and the coach is told it is near the creator's words, not proof. ⟨said⟩ is kept for text the reader didn't
   write (a caption, a YouTube transcript).
3. **A "same as X" correction after the batch is saved** repoints the post's links to X. The duplicate is archived
   (`merged_into` X) only when it has no logged sets, no planned workouts and no pins; otherwise it stays, is marked
   `like` X, and the line says why. No history moves between moves this round. **"Not the same"** on a library-linked
   move creates the personal move from the post's reading, active on approval (the approval is the owner's review),
   pinned only if the same proposal pins it.
4. **Reads started in the app** (Watch it too, Read it again, Retry, and phone-added links if the owner wants them)
   go through the extension's work list, as extraction does now: the extension asks the app "anything waiting?" every
   15 minutes (one small request; it doesn't touch Instagram), so a tap on the phone runs within about 15 minutes while
   the computer is awake. Until then the trail says "waiting for your computer's extension".
5. **A long follow-along stays whole.** A post's moves are never split across batches: a post with more new moves than
   the 12-move cap is a batch of its own (up to 30), and `pin_moves`' caps rise to 30 lines and pins.

## 15. Questions for the owner (asked 2026-11-05; the build goes on with the default until answered)

1. **Does "if I'm adamant, just do what I say" override the hard safety checks** (a condition's "never", loading a
   sore area — both must-fix since 2026-11-04)? Default: insistence overrides the coach's judgement (what's in, where,
   the dose, a correction), not those checks; there the coach says plainly it won't, why, and offers the closest safe
   option, and the owner can still add the move themselves in the Studio. Phase 3.
2. **Links from the phone**: a "paste a link" field in the app, read by the computer's extension within ~15 minutes.
   Default: yes (cheap given §14.4). Phase 2.
3. **A follow-along as a workout you can play**: when a post is a routine, offer it as a saved workout in the Studio,
   in the creator's order and doses, beside the moves joining the library. Default: not this round. Phase 2.
