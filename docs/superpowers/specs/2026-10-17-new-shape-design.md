# The new shape and the conversational coach (design, 2026-10-17)

**Status:** approved by the owner from the mocks ("I like the mocks … let's just ship this all … go ahead autonomously").
The mocks: the private Design canvas "Run Garden New Shape" (rows: Today first; the coach, from anywhere; three places;
the session and its music; the coach, a conversation). The report behind it: the private page "Where Run Garden goes
next". Principles: `docs/principles/workout-system-principles.md` (read §2, §6, §7 first).

## 1. What changes, in one paragraph
Run Garden grew by adding: five tabs, two coaches, seven ways a workout arrives, three views of one workout. The new
shape has **three places — Today, Plan, Growth — and one coach in the middle of the nav**. The coach is **one
conversation**: an "Ask anything" box, no time-frame buttons; it answers in words, designs a workout, changes the plan
or plans a week, and asks one tappable question when it is unsure. It sees what the athlete is looking at as a quiet,
dismissible hint, never as the subject. Starting something yourself (quick starts, build, templates, log) lives in the
coach's opening screen, so "+" folds into it. The garden stays as the calm backdrop of Today, with everything else in
one drawer. Settings sits behind the athlete's mark.

## 2. Owner decisions this design rests on
- 2026-10-17: "The coach should be able to do anything from any point" (runs included).
- 2026-10-17: the coach should not be specific to a workout and should not prescribe now / later / plan ahead: "this is a
  general coach that should be able to help with anything".
- 2026-10-17: the conversation mocks approved; the middle nav button is the coach and holds "+".
- 2026-10-17: Studio need not be a tab; its library is reached from the coach and search.
- 2026-10-17: no spoken voice (it stops Spotify on iPhone); the sounds and the music dock are already shipped.

## 3. The navigation
- **Phones:** a bottom bar of four: Today · Plan · **Coach** (a filled sprout button in the middle) · Growth. Settings is
  the athlete's mark at the top right of Today (and the top of each place).
- **Desktop (≥ 1024 px):** the side rail: Today, Plan, Coach, Growth; Settings at the rail's foot. Coach opens as a
  right-hand panel; on phones as a tall bottom sheet.
- **Routes:** `/` Today; `/plan`; `/growth` (the old `/runs` and `/insights` redirect there); `/settings`; the Studio's
  library pages keep their routes (`/studio/move/:id`, `/studio/build/*`, `/studio/templates`) but `/studio` itself is
  no longer a tab: it opens the library browse (search, filters, tags), reached from the coach's opening screen and
  search. `/studio/objectives` redirects into Growth.
- The music pill and the coach button never overlap; the session player stays outside the shell as now.

## 4. Today
- **One card**: the eyebrow "Today · Sat 17 Oct"; the session's title (serif); one line of facts; one coach line (the
  existing focus/verdict text, one sentence); **"How's your body?"** with three chips — Fresh · A bit heavy · Sore
  somewhere (Sore opens a body-area picker); **Start** (primary) and **Ask** (opens the coach, seeing today's session).
  A rest day says so, with one gentle suggestion line.
- **The body check adapts the day, visibly, without AI**: the answer is recorded (the existing answers store, by area),
  and today's session is eased when the answer asks for it — an engine session rebuilt one mode down (build →
  consistent → recovery), a watch-plan run eased by the existing ease op (distance or time × ~0.7, intensity held
  easy) — shown as "Eased to 14 km for heavy legs" with **Undo**. Fresh changes nothing. It never deletes or moves.
  Once answered, the chips show the choice and can be changed until the session starts.
- **Also today**: other sessions today as one quiet row each.
- **The garden**: the scene is the backdrop above the card; the streak band, the "Lately" strip, the collection and the
  timeline move into **one drawer** pulled up from the card's foot ("Your garden": next to bloom, twelve weeks, last
  trained, a link to Growth). The arrival lines and ceremonies stay.
- Gone from the home: the week ribbon (it is Plan's), "How the garden works" (moves into the drawer's foot), the dock's
  extra chips and links. About four parts on the card instead of about twelve.

## 5. The coach, a conversation
**The model.** One conversation per athlete, continuing across screens and visits (a conversation is the athlete's
recent coach turns; a new one starts after a quiet day, or when the athlete taps "New conversation"). Each message the
athlete sends starts one coach run (the existing run engine: stepper, budgets, review, proposals). The run's opening
context carries the conversation's last turns (the athlete's words, marked untrusted; the coach's finish lines; one
line per card and its outcome) so a reply like "make it 10 minutes" or "evening" means what it should.

**No time frame up front (`scope: "auto"`).** A run created without a scope is an auto run:
- It starts as a single-workout run (its ceiling the single ceiling, $1.50 today) with every tool a main run has **plus
  `plan_set`**. The coach decides from the athlete's words whether to answer, design one workout (now or at a time it
  picks — "right now" is `atNow`; otherwise a sensible time the athlete can change at approve), change the plan, or
  plan several workouts. Calling `plan_set` raises the run's ceiling to the set ceiling ($6) — only when the athlete
  asked for more than one workout or a stretch of days; the prompt says so. The weekly cap still bounds everything.
- **Answers in words**: a question ("how's my wall sit going?", "why this run?") finishes with words only — no
  proposal — and the finish line's soft cap for an answer is longer (about 900 characters, clipped at a sentence).
- **Asking**: when the time, the place or the intent is genuinely unclear, `ask_athlete` with two to four tappable
  answers (the existing question tool), never a form.
- **Replacing**: a follow-up that changes an open suggestion from this conversation says so —
  `propose_workout({ …, replaces: proposalId })` — and that suggestion is superseded when the new one is ready (the
  existing focus-supersede rules: only the athlete's own, only while both are pending, never a set's).
- Old clients sending a scope keep working unchanged.

**The coach's reach (plan powers).** `adjust_plan` gains the thread coach's proven single-day ops through their
existing appliers: **ease**, **swap** (a day's planned session for an easier kind), **remove** and **restore**, beside
skip / move / adjust. Each stays a proposed change the athlete approves, op by op. Building or extending a whole plan,
programme edits and designed runs are §8.

**What the sheet shows** (mocks: "Coach, opened from the nav", "Coach, opened from a workout", "A conversation that
does things"):
- **Opening a new conversation:** one coach line about the day (from the existing focus/readiness — no model call), two
  to four starter chips (general: "Something for right now", "Plan my week", an objective question, "I'm sore"; with
  context: "Shorten it", "Move it", "Why this run?"), and **"Or start something yourself"**: the quick starts, Build
  your own, Templates, Log a session. Tapping a chip sends it as the athlete's words.
- **The conversation:** the athlete's words right-aligned; the coach's words left with its mark; while a run works, its
  trail lines (the existing run view, quieter); **cards** inline: a suggested workout (the existing suggestion card),
  plan changes ("3 changes to your week", Approve all / Look closer), a week plan (the existing set card); a question
  with tappable answers.
- **The box:** "Ask anything" (or "Reply" inside a conversation) and a round send button. Above it, when the athlete
  opened the coach from something: a muted **"Seeing: Sun 18 Oct · Long run ×"**. The ✕ drops it. Screens register what
  they show through one hook; the coach button and any Ask pick it up.
- No Now / Later today / Plan ahead buttons anywhere. Studio's inline composer and the Plan's floating thread-coach
  window go; the per-object "Ask" buttons go except Today's card (the nav button sees the screen's object).
- The thread coach's automatic outputs (the focus line, the weekly brief, its proposals on Plan) stay where they are
  for now; its chat box is replaced by the conversation.

## 6. Plan
- Opens on **the week**: "This week" with ‹ ›, one line ("12–18 Oct · Half marathon build, week 10 of 12 · 2 of 6
  done"), then the days (today highlighted; done / skipped marks; rest days dashed).
- **Your plans**: one list (programmes, run and lift plans, one-offs), one row each with its kind and its state; a row
  opens its sheet. Plan actions (extend, wind down, retire) become real buttons in that sheet that open the coach with
  the request written ("Extend my half marathon plan by two weeks"), not canned chat messages.
- The race strip and the weekly brief fold into the one header line; the sync panel shows only when something is wrong.

## 7. Growth
- Replaces Activity (and holds the objectives board). A **Month / Season** switch.
- **The body map**: a front figure, regions tinted by how much they were worked in the period (the coach's own
  `read_balance` exposure, served to the screen); one line naming what carried the work and **what was quiet** ("Hips
  quiet for 6 days"), and a button that opens the coach with the request written ("15 minutes for my hips").
- **Quests**: the objectives, each with its key result's progress bar and a line ("Best ever this week · a willow
  sapling in the garden"); a best-ever key result and a finished objective become garden moments (arrival beats).
- **Records**: runs (as now) and **strength** (the weekly top sets already computed) and holds.
- **Below**: the training chart and the activity feed (today's Activity screen, simplified).

## 8. Later in this programme (not this wave)
- **Designed runs**: the coach designs runs (run items in the workout document; the validator's run rules; review
  dimensions for runs) and the watch gets them (a document-to-COROS run writer; distance and pace targets verified on
  the wire). Its own stream after the conversation lands.
- **Whole plans from the coach**: build / extend / wind down / retire a plan, programme edits, blocks toward events.
- **Retiring the thread coach's engine** once the conversation covers its automatic outputs.

## 9. Constraints (unchanged)
Workers Free (CPU per request, D1 ≤ 45 statements per request as the code pins), the $20 weekly AI cap, no schema
change without the owner's explicit yes (this design needs none: conversations are runs; answers use the existing
store; prefs JSON for settings), no rollback past the Durable Object class (forward fixes only), nothing personal in the
public repo, gentle tone, accessibility (44 px targets, real controls, reduced motion), both themes, phone width first.

## 10. Streams (wave 1) and ownership
| Stream | Owns |
|---|---|
| **A — the coach conversation (server)** | `apps/worker/src/services/coach-runs.ts`, `design-*` services and `design-tools/*`, `routes/coach-runs.ts`, prompt; conversation context; `auto` scope; answers; `replaces`; plan powers |
| **B — the shape (UI)** | `shell.tsx`, `app.tsx` routes, `screens/garden.tsx` (Today), `screens/plan.tsx` + plan components, `screens/settings*`, nav, copy; places E's body check and C's coach button |
| **C — the coach conversation (UI)** | `screens/studio/coach-*`, `composer.tsx`, `run-view.tsx`, `proposal-card.tsx`, `also-waiting.tsx`, the coach sheet and its opening screen, the "seeing" hook, cards for plan changes, removal of Studio's inline composer and the Plan's thread-coach window |
| **D — Growth (UI + read endpoint)** | a new `screens/growth/*`, a body-exposure read route, records, quests, `arrival.ts` beats, Activity's content moved in |
| **E — the body check (UI component + server)** | a `BodyCheck` component, the answer save, the ease endpoint (engine rebuild one mode down; run ease via the existing applier), Undo |

Shared files (`styles.css`, `packages/api-client/src/index.ts`, `app.tsx`, `shell.tsx`) are edited as "HEAD + your
hunks" with compare-and-swap commits. Each stream: test-first, mutation checks, both time zones, typecheck on the
committed tree, e2e on its own fixture-stack ports, screenshots phone and desktop, light and dark. Each is reviewed;
then an integrated review; then deploy when no coach run is live.
