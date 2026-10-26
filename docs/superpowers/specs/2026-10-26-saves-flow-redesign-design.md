# Saves flow, redesigned: one path, one decision per move (design, 2026-10-26)

Extends `2026-10-23-saved-posts-import-design.md` (§6 the owner's experience, §7 coach changes, §17 selective fitting).
Where this document and that one disagree, this one wins. Everything else in that design stands.

## 1. Why

The import went live on 2026-10-26 and the pipeline works end to end: 70 posts extracted, 186 moves matched, the first
batch released, saved and fitted in by the coach with sound reasoning (8 of 9 pinned, one left out with a reason). The
owner's walk-through of that first batch found the owner's side of it wanting, in their words: "the initial UX was not
very visible at all", the review page "was all of the moves, the UX altogether was not great", and "I want to be able to
(only if desired) specify which I want included or not, or just defer to the AI. Or, include this one, your judgement
for the rest. UX should be dead simple."

What was wrong, concretely:

1. **Nothing told the owner a batch existed.** The only notice was the coach's opening line, which draws only on a new
   conversation; the Coach sheet reopens into the last conversation, so the notice sat behind "… → New conversation".
   The review page had no entry in the navigation (Settings → Saves, the coach's chip, or the URL).
2. **The review page listed every move of the batch as a row**, the four moves the owner already owned (Pigeon with
   T-arms, Thread the needle, Cat-cow, 90-90 breathing) looking exactly like the nine new ones apart from a small
   "Linked to …" line. The owner read them as duplicates. Every row carried the creator's handle and a dose.
3. **The only choices were all or nothing**: Save these, then Fit these in. No way to say "this one, not that one, the
   rest is yours".
4. **The coach's card after fitting** read "Kneeling thoracic extension with head cradle (Kneeling thoracic extension
   with head cradle): …" on every line (the model wrote "Name (id)" and the tool swapped the id for the name after), and
   two lines were cut mid-sentence by the 160-character clip.
5. **Three held batches and 111 unbatched moves wait behind the gate**, the largest held batch 52 moves. A 52-row page
   is not "dead simple" on a phone.

## 2. Goals, non-goals, anti-goals

**Goals**
- A new batch is impossible to miss: an indicator on Today and in the coach, both funnelling to the same coach chat.
- One decision per new move, with a default that needs no decision at all: the coach's call.
- One button. No separate Save step.
- Moves the owner already owns never look like new moves.
- The coach's card after fitting names each move once and is never cut mid-sentence.
- Batches stay small enough to read on a phone.

**Non-goals**
- Changing how posts are read, filtered, extracted or matched (except the near-duplicate rule in §6).
- A new place to browse all saved posts; Settings → Saves and the batch pages stay as the history.
- Changing the coach's judgement about *where* a move goes (the week, the session). That is §17 and it worked.

**Anti-goals** (what would make this a failure even if it technically works)
- A page the owner has to read before anything happens. The coach's-call path must be one tap from Today.
- Per-device "seen" state hiding a batch on the phone because the Mac saw it.
- Explainer text. Names, one line of what a move is for, and the control. Nothing else on a row.

## 3. The owner's experience

### 3.1 Noticing: the Today card and the coach chip

- **Today** shows a card at the top while an *open batch* exists: "9 new moves from your saves" and, under it, "4 more
  were already yours" when the batch linked moves the owner had. One button: **Fit them in**. Tapping the card or the
  button opens the Coach sheet (§3.2).
- **The Coach sheet** shows a chip in its header while an open batch exists: "9 new saved moves". It sits above whatever
  conversation is open. Tapping it scrolls to / shows the saves card (§3.2) in the current sheet without starting a new
  conversation.
- An **open batch** is server state: the newest released batch with `fitted_at` null and not dismissed. It is open on
  every device until it is fitted in or dismissed. There is no per-device seen flag for it. The `saves` source of the
  coach's opening line (§6 of the original design) is removed: the card replaces it, so the two never stack.
- Only one batch is open at a time (§5). When it is fitted in, the next waiting batch opens.

### 3.2 The coach's saves card

At the top of the Coach sheet, above the conversation, while a batch is open:

> **Coach:** Nine new moves came in from your saves: thoracic openers, two breathing drills, a serratus press and a
> rotational kettlebell swing. Want me to fit them into the week, or choose first?
>
> [ Fit them in ]  [ Choose first ]

- The one-line summary is written by the server from the batch's groups (the existing `moveGroup` notice grouping), not
  by a model call: no cost, no waiting.
- **Fit them in** saves the batch with every new move on the coach's call and sends the fit-in request
  (`FIT_SAVES_REQUEST`) in the *current* conversation. The run proceeds as today (§17): one approved `pin_moves`
  proposal, revised workouts, notes carried into the sessions.
- **Choose first** opens the batch page (§3.3). The page's one button comes back to this same sheet and sends the same
  request, with the owner's choices attached to the batch.
- A small **"not now"** text link under the buttons dismisses the batch (owner's decision). Tapping it shows a short
  sheet first: "Put aside. Find it again under Settings → Saves (or the Studio tab), where Fit them in brings it back."
  with one button, OK. Then the card goes away and the next batch can open. What "not now" does to the moves is in §12.

### 3.3 The batch page ("Choose first")

Reached only from the card (and from Settings → Saves for older batches). Title: "9 new moves". One line under it:
"On **Coach**, the coach decides. **Include** is in. **Skip** stays out."

- **One row per new move**: name, one short line of what it is for (the extraction's `purpose`, else the first
  muscle/goal word of its summary), and a three-way control **Skip | Coach | Include**, default Coach. No creator, no
  dose on the row. Tapping the name opens the move sheet as today (steps, cues, dose, ratings, link, Edit, Not this
  move, Same as…, Remove).
- **Already yours** is one folded line: "▸ Already yours · 4". Unfolded, the four names, each a link to the move sheet.
  No control: the coach may still pin an owned move, as it did with Pigeon with T-arms, and says so in its line.
- A sticky foot: a tally ("2 in · 1 out · 6 on the coach's call", or "All nine on the coach's call") and one button
  **Fit these in**. It saves the batch with the choices and returns to the Coach sheet, which sends the request.
- "Check this" moves keep their flag word on the row's second line (as today).
- Removing a move (in its sheet) takes its row away; a removed move is neither included nor skipped.

### 3.4 What the coach does with the choices

- An **included** move is pinned, always. The coach still writes its placement line (where in the week, why), but it
  may not leave it out. Conditions are not checked at pin time today and this does not add that: a condition profile's
  rules apply where they always have, when a workout is placed, so a pinned move a profile refuses is simply never
  placed by the engine. The coach may say so in the move's line.
- A **skipped** move is not pinned and not placed. It stays in the owner's library (status `active`), unpinned, so the
  coach can offer it later if asked. The coach does not write a line for it.
- A **coach's-call** move is judged as today (§17): pinned with a line, or left with a line saying why not.
- The `pin_moves` tool enforces this: a proposal that omits an included move or pins a skipped one is refused as a tool
  error naming the move, so the model corrects it in the same run. The batch's choices come to the coach through
  `read_saves` (each move's `choice`: `include` | `skip` | `coach`) and the opening context.

### 3.5 The coach's card after fitting

- Each line starts with the move's name once, in bold, then the text. The tool produces the name from the move id; the
  model writes `id: text` (or just text for a general line), never the name. Lines are clipped after the name is placed,
  at the end of a sentence where possible, with the cap raised so an ordinary two-sentence line fits (builder's call on
  the number; 160 characters was too short for "it counts as jaw care and works your stiff upper back, so it fits").
- The summary line names how many joined and how many were left out ("Eight join the rotation. Reverse bridge hold
  waits.").

## 4. Data and API

- `save_batches` gains `dismissed_at` (text, null). An open batch: `status = 'saved'`-or-`'released'`, `fitted_at`
  null, `dismissed_at` null, newest first, limit 1.
- `personal_moves` gains `fit_choice` (text, null): `include` | `skip` | null (null = coach's call). Written only by the
  owner's Fit these in; cleared when the move is merged or removed.
- Owner routes (all under `/api/my-saves`, bearer session as today):
  - `GET /open` → the open batch for the indicators and the card: id, counts (new, already yours), the summary line,
    and the groups. 404-shaped answer (`{ open: null }`) when none.
  - `POST /batches/:id/fit` with `{ choices: { [moveId]: "include" | "skip" } }` (empty object for the coach's-call
    path): saves the batch (as `/save` does today, including the §17 memory and provenance writes), stores the choices,
    returns the request text to send. Replaces the two-step save + chip; `/save` stays for the move sheet's needs.
  - `POST /batches/:id/dismiss` → sets `dismissed_at`.
  - `POST /batches/:id/fit/cancel` → clears `fit_started_at` when the run could not start after `/fit` (a run already at
    work, the week's budget, offline), so the card never reads "Fitting in…" for the full hour (§12.1).
- `read_saves` adds `choice` per move. The fit-in request's context (the opening the run reads) carries the batch id,
  as today.
- `pin_moves` validation (§3.4). The op's stored lines keep the `{ moveId?, text }` shape so the card can render the
  name itself; `lines` in the tool's input become that shape too (builder's call on exact schema).

## 5. Batches: one open at a time, small

- **Cap:** a batch holds at most 12 new moves. The assembler takes the oldest waiting moves first and leaves the rest
  for the next batch. Linked (already-yours) moves ride along with their posts and do not count toward the cap.
- **Gate:** a new batch is assembled only when no batch is open (fitted in or dismissed). The 20-hour release gap
  (`BATCH_GAP_MS`) is dropped: the owner's action is the gate now. (My call: a timer that holds batches while the owner
  is waiting for them is the wrong gate; one-at-a-time keeps Today to one card.)
- **The held batches** (7514d1d4, 80bcb380, 90e095ad: 3 + 11 + 52 moves) and the 111 unbatched moves are re-cut: a
  one-off script dissolves the three held batches (their moves' `batch_id` set to null; the batch rows marked
  `superseded`) so the assembler re-cuts everything waiting into batches of ≤12 in the order the posts came in. The
  `SAVES_HOLD_BATCHES` switch is then unset: with one-at-a-time and the cap, holding is no longer needed. Near-duplicate
  curation that the plan assigned to the lead (merge Prone cobra lift/hold, etc.) is replaced by the rule in §6 plus the
  owner's Same as… in the move sheet.
- The already-fitted first batch (e29b8e13) is untouched.

## 6. Near-duplicates at matching

Beyond library matching (§5.5 of the original design), a new extracted move is also compared with the owner's existing
personal moves before it is created: equal normalized names link to the existing move (one more post on it, no new
row); names that differ by a single qualifying word ("Kettlebell rotational swing" / "Kettlebell dynamic rotational
swing", "Prone cobra hold" / "Prone cobra chest lift") create the move but mark the link `check_flag` with a new check
word `near_duplicate`, and the batch page shows "like <existing name>" on the row so the owner can Same as… it in one
tap. Builder's call on the exact rule; it must never auto-merge two moves with different load or dose types.

## 7. The insights the coach learns

The first batch wrote twelve observations to memory, several of them restated doses ("Perform 3 sets of each movement
to build spinal extension…") or one move's description ("Strengthens neck muscles and opens up upper back…"). Tighten:
- The extraction prompt asks only for guidance about *when*, *why*, *how often* or *who it suits*, never a dose or a
  move's own description.
- A post-filter drops an insight that is only a dose (matches a sets/reps/seconds pattern and nothing else) or that
  repeats a move's summary (high token overlap with any of the post's moves' summaries). Builder's call on thresholds.
- The batch page's Notes section shows what survives; nothing else changes in §17.

## 8. The old follow-ups, folded in

These were ledgered during go-live and are part of this round:

1. **Studio in the navigation.** Owner's decision: add it as a tab (Today · Plan · Coach · Studio · Growth · Settings).
2. **14-day saves window** vs Fit these in: a batch the owner explicitly fits is read whatever its age
   (`read_saves` by id already ignores the window; the request path must too).
3. **pin_moves lines**: §3.5 (swap before clipping; name from the id).
4. **The stale bridge poll** on the owner's Mac (POST /api/devices/bridge/jobs/claim errors every poll): find and stop
   the process; the route answers 410 with an empty body.
5. **CI flake** review-basis-summary ("bounded number of rows… 252 ≤ 236", a midnight row boundary): pin the suite's
   clock.
6. **Hour-bomb scan**: the 12 suites that place on the real today get a pinned clock or a yielding `today`.
7. **The extension's link-based video path** is untested in anger; leave as is, note in the ledger.

## 9. Constraints

- Workers Free: ≤45 D1 statements a request, 10 ms CPU. `GET /open` is one statement while a batch is open or nothing
  waits; when nothing is open and new moves wait it assembles the next batch first (the assembler's own budget, ≤10
  statements in all), which is what makes "when it is fitted in, the next waiting batch opens" true without waiting for
  the extension's next check. `/fit` stays within the save route's budget plus two (a fit-check read and the choices).
- Public repository: no real post links, handles, captions or media in code, fixtures, tests or docs. The move names in
  this document are the owner's own extracted names, already in the private database; they do not appear in tests.
- The owner's voice: brisk, one next step, no apologies, no explainers.
- Every principle in `workout-system-principles.md` and the original design's §10 (privacy) still applies.
- Migrations: 0031 (`save_batches.dismissed_at`, `save_batches.fit_started_at`, `personal_moves.fit_choice`,
  `saved_post_moves.like_move_id`), additive.

## 10. The owner's answers (2026-10-26)

1. Studio in the main navigation: yes, as a tab.
2. "Not now": yes, and tapping it shows how to find the batch again if they change their mind (§3.2).

## 11. Left to the builder

- Exact clip length and sentence-boundary rule for lines; the `lines` schema shape.
- The near-duplicate rule and thresholds (§6); the insight filter thresholds (§7).
- Where the summary line's words come from (`moveGroup` names; at most four groups named, then "and N more").
- The re-cut script's shape (a one-off under `apps/worker/scripts/`, dry-run first, run by the lead against prod).
- Component placement: the Today card beside the existing arrival block; the chip in the Coach sheet's header next to
  the "…" menu.

## 12. Decisions after the builder check (my calls, 2026-10-26)

A reviewer read this document as the builder would and asked five questions. None changes what the owner asked for;
each is settled here so the plan has one answer.

1. **Between "Fit them in" and the approval, and after a decline.** `save_batches` gains `fit_started_at` (text,
   null), written by `/fit`. While it is set the batch is still open (so nothing new is assembled) but every surface
   shows "Fitting in… open the coach" instead of the button, and `/fit` answers 409, so a second tap never starts a
   second run. `fitted_at` on approval clears the state as today. A proposal that resolves any other way (declined,
   superseded, expired) or a `fit_started_at` older than one hour clears `fit_started_at`, and the card comes back with
   "Fit them in": a decline means "not like that", not "never". The run is told its batch explicitly: coach-run create
   gains a `savesBatchId` the fit path sets; the opening context and `read_saves` use it when present and fall back to
   the newest saved, unfitted batch when not. The 14-day window does not apply to an explicit id (§8.2).
2. **Include when a condition refuses the move.** No condition check at pin time (§3.4 as amended): an included move
   is always pinned; the engine's placement rules stop it where they always have.
3. **"Not now".** It does not save the batch: its moves stay `pending`, nothing enters the library or the coach's
   memory unseen; `dismissed_at` is set. Pending moves from an earlier batch must never read as "already yours" in a
   later batch or on its page: the notice and the page count only `active` moves as owned (the builder fixes `noticeOf`
   and the page's born-here rule). From Settings → Saves (or the Studio tab), **Fit them in** on a dismissed batch
   clears `dismissed_at`, which makes it the open batch, and goes on as §3.2; it answers 409 ("finish the batch that is
   open first") while another batch is open.
4. **Near-duplicates for moves already waiting.** The rule runs in two places: at matching (new extractions, §6) and in
   the assembler, when a batch is cut: each new move of the batch is compared with the owner's `active` personal moves
   and with the other new moves of the same batch; a hit writes `check_flag` with the word `near_duplicate` and the
   like-name on the link (one update per hit, inside the assembler's budget). So the re-cut (§5) flags the waiting
   pool without a prod data script of its own. `read_saves` carries `like: <name>` per move and the prompt says: never
   pin both of a pair; prefer the one the athlete already has, or the clearer of two new ones; say so in the line. The
   default stays the coach's call; the owner can Same as… from the page before fitting.
5. **Skip beyond pin_moves.** `read_saves` marks skipped moves and the prompt says they are not placed. In addition,
   the fit-in run's workout tools (`doc_workout` new and revise, `plan_set` briefs) refuse a skipped move of the run's
   batch by name ("the athlete skipped X"), the same way they refuse a move the library no longer offers. Scope: that
   run only, one lookup against the batch's skip set carried in the run's context.
