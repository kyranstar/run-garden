# Audit: can the owner trace an import from the post to the plan? (2026-11-05)

Read-only audit of `origin/main` at `f4dcd736`, plus a read of the live app in the owner's browser (no writes, nothing
saved to disk). Four independent reviews: the import pipeline's storage, the coach's use of imports, the coach's
awareness of goals, plan and history, and how a YouTube import would work. This report holds no post links, handles,
captions or move names from the owner's data (the repository is public).

The owner's words, which this audit measures against:

> "there's no end to end audit trace. I kind of just read the exercises, which are the only interpretable part, and
> just click go and hope that the coach does something good, but i really have no confidence or understanding."

## 1. The answer in one paragraph

No. The only things kept for an imported post are the parsed extraction, the filter's verdict and reason, one
overwritten error slot and an attempt count. Each model call gets a row in `llm_usage` that nothing links to the post.
The raw model replies, prompt versions, the judge's matching decisions, the repairs made to a reading, the insights
dropped by the post-filter, and which facts the post stated versus which the model inferred are thrown away or buried
in JSON no screen reads. On the coach's side, the trail records *that* the coach read the saves ("Read 6 moves from your
saves"), never *what* it saw or *what it concluded about each move*. The coach day to day sees counts of activities,
not planned-versus-done or objective progress, so it cannot weigh an import against how the owner is actually doing.

## 2. What the live app showed

- **The batch page** lists new moves with a one-line purpose and a "Check this" flag, and a Notes list of the
  surviving insights, each attributed to a creator but not to a post or a move. Several notes are definitions or one
  creator's programme for their audience, not guidance for this athlete; they went to the coach's memory on save.
- **A fit-in run's trail** opens a "Read 6 moves from your saves" line to: *Came back · Read from your saves · Missing:
  14 more moves — pass offset: 6, 3 more routines not shown for room.* Which moves, what fields, and what the coach made
  of each are not there. The run's final message placed part of the batch and left the rest for "ask again".
- **Failed posts** read `failed · training (first capture)`: the filter's positive verdict shown as the failure's
  reason (§4, bug 2). The real cause is not shown anywhere.
- **The filter works on junk**: recipes, travel vlogs, memes and TV synopses were filtered out with clear reasons.
- **Spend** this month: $2.75 of the $5 cap.

## 3. Stage by stage: kept, thrown away, clipped

| Stage | Kept | Thrown away | Clipped / changed |
|---|---|---|---|
| Feed read (extension) | per check: counts, error code/message; per post: caption, hashtags, creator, media type, url | pages read, video variant sent, bytes, by-link, cover sent | caption 4000; a carousel sends only its first video |
| Filter | verdict, reason (≤160), stage, cost | raw reply; a gateway failure reason (console only) | an unparseable reply becomes a paid `maybe` that looks like a verdict |
| Extraction | the zod-parsed reading, attempts, cost | raw reply, reasoning, `finish_reason`, the first paid reply before a retry, prompt version (never sent or stored) | strict caps fail the whole reply and force a shorter retry |
| Validation / retry | the last issues (≤600 chars, overwritten) | attempt history | — |
| Repair (`repairDraft`) | only `check_flag` | the repair lines and `moveProblems` | load, dose type and laterality rewritten silently |
| Dose | the record's dose | whether a number came from the post or a default | `DEFAULT_RANGE` invents 8–12 reps / 20–40 s, unmarked |
| Record build | the record | aliases, corosHint, themes, evidence, confidence | a move linked to an existing one keeps none of the post's steps, cues or dose |
| Matching | link: move, kind, confidence, check flag | candidates, scores, the judge's per-move verdict, whether the judge ran | — |
| Insights | the raw list inside the extraction | why one was dropped | cap applied before the filter, so fewer survive than qualify |
| Owner choices | `fit_choice`, edits (overwrite, no diff), merges, removals | the original match after a rematch | — |
| Coach run | events with a one-line summary and a bounded payload | what each read returned per move, the model's reasoning text | tool results cut at 8 KB; trail values cut to size |

## 4. Bugs found, ranked (all verified in code)

1. **Plurals break matching.** `normalize.ts` strips `-es` after an `s`, so "raises" → "rais", "releases" → "releas",
   "poses" → "pos". "Calf raises" never exact-matches "Calf raise"; the word overlap then falls under the fuzzy floor,
   the judge never sees it, a duplicate personal move is made, and the near-duplicate rule misses it too.
2. **A failed post shows the filter's reason, not its failure** (`saves-ledger.ts`: `reason: filterReason ?? lastError`).
   `PostRowDto` has no error code.
3. **The dose fallback miscounts.** "1.5 min" and "0.5 min" become 300 s, "2x30s" loses the 30 s, "8/side" gives
   nothing; the invented default is never marked. (Bites only when the model leaves out `dose.range`.)
4. **"Check this" reasons are rebuilt after the fact and are wrong in places**: a judge that never answered reads as
   low confidence; inferred evidence never raises the flag.
5. **Stale `last_error`.** Four paths update the code and leave the old text, so code and text disagree.
6. **A budget pause loops.** A post refused for budget stays `queued`, the work list hands it out every check, and the
   video is downloaded again each time. The filter's own budget or model failure is ignored by the extension.
7. **Health is misread.** Per-post vendor failures never reach the headline: a night where every extraction hit a
   gateway 5xx reads "Up to date". An Instagram interstitial reads as a login problem.
8. **Name matching links to archived personal moves** at high confidence with no flag.
9. **Aliases are dropped from records**, so a later post using an alias doesn't match.
10. **Skip doesn't take a post out of its batch**: its pending links are still written on Save.

## 5. What the coach sees of an import, and what it can show

- **`read_saves`** gives each move its id, name, summary, whether it is new, the owner's choice, a near-duplicate,
  up to three posts with the move's purpose as a note, and the first post's summary; per batch, up to five routines
  and five insights (text only: the insight's post and creator are stripped). It never gives the stated/inferred
  flags, the extraction's confidence, the post's dose text, steps, cues, caption, the match's confidence or its
  check reasons. A judged library match reads as the library's own words. There is no transcript anywhere.
- **The opening context** clips each saved move to a 40-character name and a 60-character summary. `pin_moves` needs
  only that every id is accounted for, so a move can be pinned, with a line about it, on that skim.
- **The prompt** says to take what serves the athlete's objectives and to "weigh it as a tip"; nothing tells the coach
  how to treat inferred information (it never receives the flags) or to cite a post.
- **From pin to workout**: a pin only sets `pinned`. Engine sessions take the dose from the record, which may be the
  invented default; the slot (warm-up, accessory, cool-down) comes from pattern rules, not the post's purpose. In a
  revised workout the coach writes each item's dose, why and cue itself; the validator checks only that an amount is
  there, and the reviewer has no "faithful to the post" dimension.
- **The trail**: a `tool_result` event keeps the tool, a 1,500-character input, provenance and what was missing —
  never the result itself, so what `read_saves` returned is not in the trail. Payloads over 4,000 characters become
  `{truncated, head}`, so an ordinary eight-move pins card's detail renders as "Detail: {"pin":["my…". Detail values
  are cut at 160 characters, including "In full", which is shorter than the 300-character line it expands. The pins
  card's `why` is stored and never shown, and its per-move lines drop out of later turns, so "why did you leave X
  out?" reaches a coach that no longer has its own reason. Personal move ids render garbled in trail notes.
- **Challenging and correcting**: no coach tool edits a personal move, an extraction, a match or an insight; the
  owner's own edit form has no purpose field and works only before or just after saving. There is no correction log.

## 6. The coach's awareness of goals, plan and history

Production runs only the coach designer. The older thread coach, which alone built a rich dossier (90-day history,
planned vs done, adherence, wellness baselines), is switched off, and its dossier is dead code.

What the designer sees without asking: the profile's goals and focus areas; up to 12 objectives by title only (no key
results, targets, due dates or progress); today's sessions in full and the rest of the fortnight as one count line;
nothing before today, so missed and skipped sessions never appear; 30-day activity counts per sport; the dates (not
values) of the last HRV, resting-HR and sleep readings; up to 20 memory items; six earlier turns clipped to 300
characters. Everything else needs a tool call, and the prompt tells it to fetch only what would change the design.

Proactive today: up to two "needs you" chips on the coach's opening screen (a session missed in the last 2 days, back
after a gap, an outline week, a race or a line ending soon). Nothing computes multi-week adherence, a discipline dropping
off, or an objective falling behind; the prompt says only "Notice a stall kindly". The sleep/HRV and notable-read
triggers went with the thread coach and nothing replaced them. Weekly reviews and activity reads are invisible to the
designer.

Bugs: a silently missed session shows its chip on one day only (reconcile marks it after today−1, the chip window is
today−2); the two-chip limit lets the opening's own chips hide every "needs you" chip; the missed chip asserts "I
missed it" for sessions the app only knows are unresolved; key results of kind `checkin` or `test` always read "none".

## 7. YouTube: what's possible

- The gateway is Vercel AI Gateway (Chat Completions). Downloading YouTube video bytes in an extension is not viable
  (SABR streaming, PO tokens). Gemini can watch a YouTube URL natively; whether the gateway's Chat Completions passes
  one through is undocumented, so the import must check at run time (a watched video bills ~100 prompt tokens a second).
- The transcript is fetchable in the owner's session by letting YouTube's own player request it (a background tab, a
  MAIN-world script, the player's timedtext request with its PO token), with the transcript panel as the fallback.
  Fetching caption URLs directly returns empty without a PO token.
- Rough cost at today's prices (they double on 2027-01-01): a short ~$0.01–0.02; a 30-minute explainer by transcript
  ~$0.02–0.04; an hour of follow-along watched ~$0.15–0.35. The budget reservation must come from the video's length,
  not the request body's.

## 8. What this means for the work

The trail is the foundation: every stage writes what it took in, what it decided and why, linked to the post and to
the model call, and the owner reads it in the coach as a plain account with every claim openable to its source. The
bugs in §4 are fixed in the same round because each one is a place where the trail would show the owner a wrong
answer. The coach's import review, its challenge behaviour and its proactive goal management build on that. The design
is `docs/superpowers/specs/2026-11-05-import-trail-and-coach-review-design.md`.
