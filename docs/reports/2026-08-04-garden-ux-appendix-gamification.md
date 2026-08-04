# Appendix — Gamification & Biome Design Review (raw agent report)

Grounding: `docs/GARDEN_ENGINE.md`, `packages/garden-engine/src/{species,unlocks,condition,balance,simulate}.ts`, `packages/ui/src/screens/{garden,codex}.tsx`.

---

## 1. Gamification principles audit

Headline finding: **the engine is already one of the best-designed "gentle loss" systems around — the UI under-sells it.** Most gaps below are surfacing problems, not mechanics problems.

### 1.1 Appointment / return triggers
- **Today:** Weather is a daily-changing metaphor (`condition.ts:14–31`), the "today" chip shows same-day happenings (`garden.tsx:423–428`), mount triggers a COROS read (`garden.tsx:291–293`). But nothing *marks the return itself* — the page renders the same whether you were here 5 minutes or 5 days ago.
- **Prior art:** Animal Crossing's "we missed you!"; Pokémon GO's buddy greeting; Finch's bird waking up.
- **Gap:** Growth is continuous and slow (`simulate.ts:307–315`), so day-to-day change is nearly imperceptible on arrival. The most emotionally valuable data — *what happened while you were gone* — is buried in a 12-item log.
- **Opportunity:** An "overnight beat" (§5.1). Events are already sentence-ready (`eventSentence`, `garden.tsx:53–105`); this is a diff-since-last-visit presentation problem, not new simulation.

### 1.2 Loss aversion — and its dark side
- **Today:** The product's crown jewel. Decay is loss aversion with the fangs filed down: dryness at 4 days, drought at 14, dormancy at 30, deaths only from day 60 at max one per 4 days, extinction impossible before ~150 days. "Death is not deletion" — dead plants become perches/nurse logs that later *enable* fungi (`species.ts:126–127`) — a genuinely novel guilt-mitigation mechanic. Forest keeps dead trees as shame; Run Garden composts them into future content.
- **Prior art contrast:** Tamagotchi (death guilt → abandonment → churn), Habitica (HP damage reads as homework), Duolingo (loss aversion so effective it became anxiety).
- **Gap:** Loss is felt only after it happens. Nothing on day 3 says dryness arrives tomorrow; the bars shrink (`balance.ts:27–29`) with no marked threshold, so the player can't tell decoration from consequence. That's what the countdown fixes — §2.
- **Tone flag:** "The garden misses your runs" (`garden.tsx:185–189`) is exactly right. The risk is *stacking*: bars + condition word + weather line + countdown + banner can become five simultaneous sad signals in a bad week. Rule: **at most one loss-flavored element speaks at a time**; the rest stay visual.

### 1.3 Streaks with forgiveness
- **Today:** The engine tracks `consecutiveConsistentWeeks` (≥75% adherence weeks) and gates all four vines on it (`species.ts:100–103`), plus `balancedWeekCount` → Harmony willow (`species.ts:140`). Grace is everywhere: 2–3 grace days per discipline (`balance.ts:4–8`), rest days and plan gaps don't advance the run clock (`simulate.ts:268–278`). But **no streak is ever shown as a streak.**
- **Prior art:** Duolingo's streak is its most effective and most criticized mechanic — daily granularity plus the visible "0" moment creates dread.
- **Opportunity:** Surface the *weekly* chain, never a daily one (daily would be dishonest — the engine forgives days). "4 consistent weeks — the ivy climbs" ties the number to a visible consequence. Show "longest chain" alongside current (precedent: `bestComebackStreak`, `unlocks.ts:50`). Never render a zero; render "a new chain starts with this week."

### 1.4 Collection & completion
- **Today:** The codex is strong: live sprite cards, locked silhouettes with the *exact* engine-true requirement and progress (guaranteed honest — UI and award share `gateProgress`, `unlocks.ts:1–7`), nearest-first sorting, rarity tiers, wildlife shelf with earn-hints, "Growing next" nudges.
- **Gap (a):** Unlocks have no *moment*. `species_unlocked` is one log line. Pokémon GO's dex-entry animation exists because the reveal IS the reward.
- **Gap (b):** No set structure. 8 families, but completing all ferns means nothing. Animal Crossing's museum wings work because partial sets ache pleasantly.
- **Opportunity:** A short unlock ceremony on next visit (fold into the overnight beat: the new species literally sprouts during the reveal), and family-completion accents in the codex. No new engine work.

### 1.5 Visible incremental progress
- **Today:** Maturity/bloom are continuous; the README GIF proves the arc reads beautifully at time-lapse speed.
- **Gap:** At 1× speed the arc is invisible. The timeline scrubber (`garden.tsx:379–416`) contains the solution but presents it as a raw range input.
- **Opportunity:** §5.4 — chapter markers and a "watch this week" auto-play.

### 1.6 Variable reward
- **Today:** All randomness is seeded (`prng.ts` keys like `species:quality:{workoutId}`) — the *right* kind of variable reward: unpredictable to the player, fair and replayable to the system. Which species a quality run plants, 60% fungi on recovery runs, weather coin-flips — the slot machine exists.
- **Gap:** The player never learns the pull happened. "A Coneflower took root" reads identically for common and rare. Wildlife — the biggest variable payoff — is binary present/absent chips.
- **Opportunity:** Weight the presentation, not the odds: rare plantings get a distinct log verb and a sparkle in the overnight beat; wildlife gets occasional deterministic rare *visitations* (§5.3). Never add loot boxes or true randomness — determinism is a feature.

### 1.7 Investment & customization
- **Today:** Zero player expression — correct, since customization inside the sim would break determinism.
- **Opportunity (all outside the sim):** name the garden; pin a "favorite" plant; choose the ambient vantage. The deepest lever is **provenance**: `sourceWorkoutId` exists on every plant but the sheet says only "planted by one of your workouts" (`garden.tsx:535–537`). "Planted by your Tuesday 10k, March 3" makes every plant a trophy of a specific morning. Cheapest high-value fix in this document.

### 1.8 Narrative
- **Today:** Invitation-voiced copy throughout (`describeGate`, `unlocks.ts:61–98`), weather-as-story, event sentences. Zombies, Run! puts narrative *inside* the workout; Run Garden's lives entirely after it.
- **Gap:** No pre-run pull — the garden never gives a reason to lace up *today* specifically.
- **Opportunity:** One diegetic line near `NextWorkout`: "Tomorrow's long run would be your 8th — the Creek willow arrives." Data is `nextUnlocks` joined with the plan. Converts the codex from museum to quest log without adding a system.

---

## 2. The shrinking bars + countdown

**Ground truth.** The bars already shrink: linear to zero over 14 days after 2–3 grace days, overall = min (`balance.ts:10–11, 27–29, 55`). But bar-zero and garden-damage are *different clocks*: consequences land at day 4 (dryness) and day 14 (drought) for runs (`types.ts:37–38`), day 7 for strength/yoga soil-and-life decay (`simulate.ts:294–300`). A countdown must count to the *consequence*, not to bar-zero, or it's a lie.

### Framing A — "The forecast" (whole-garden, weather-native) ✅ ship this
One line under the condition word, in forecast voice:

> *Growing · light clouds — **rain needed by Thursday**, or the soil starts to dry.*
> *A little dry · **drought in 5 days** — your next run turns it around.*

- **Threshold semantics:** counts to the next *visible weather transition* — exactly when the scene actually changes. Honest by construction.
- **Urgency without anxiety:** a weather forecast is a genre humans read as "plan around this," not "you failed." Amber, never red; name the *garden's need*, never the player's deficit. Weekday phrasing over raw "N days left" — deadlines feel like appointments; countdowns feel like bombs.
- **Bars:** add a threshold notch on each track at the damage day (day 4 run, day 7 lift/yoga, mapped onto the 14-day track). Shrinking fill approaching a visible notch delivers "shrinking toward damage" silently.
- **Recovery framing:** the same slot flips positive on comeback days: "Recovery rain — 2 more runs and the blooms reopen." A forecast that is sometimes good news is what keeps it from being a nag.

### Framing B — per-discipline countdowns ❌ don't ship
Three simultaneous deadlines is a wall of nags; Monday-after-a-rest-weekend would open on three amber warnings. Keep one sentence for the weakest axis (existing `WEAKEST_COPY`), optionally with its notch-relative day. The notches carry the rest visually.

### Framing C — per-plant stakes ("the ferns wilt first") ⚠️ drought-only
The engine deterministically picks the next victim. Naming it — "If the dry spell holds, the sword fern goes dormant this week" — is the strongest loss-aversion lever available (the player grew that fern) and also the strongest guilt lever. Rules:
- Only **inside drought** (day 14+), replacing — not joining — the forecast line.
- Only count down to **dormancy** (fully recoverable), never to death (deaths start day 60; a death countdown would be dishonest at typical timescales and pure Tamagotchi dread).
- Always paired with the exit: "…one run brings it back."

### Edge cases (where the design wins or loses trust)
- **Rest mode:** hide forecast and notches entirely; the existing banner owns this state. Countdown during sanctioned rest = broken promise.
- **Taper / planned rest:** planned rest days arrive as `restObserved` → run clock doesn't advance, soil *improves* (`simulate.ts:270–272`) — a COROS taper already can't trigger the countdown. Belt-and-braces: if the plan shows no run due before the threshold date (plan data is on the page), suppress the forecast: "Taper week — the garden holds its water."
- **Plan gap:** run decay pauses — but note a **pre-existing honesty bug the countdown would inherit**: strength/yoga clocks still tick during plan gaps (`simulate.ts:287, 292`) while their neglect damage is gated off (`simulate.ts:295`), so those bars shrink toward a consequence that never fires. Freeze the fill (or caption "plan paused") before shipping notches.
- **Injury/vacation:** at drought-eve with rest mode off, the line grows a one-tap off-ramp: "Going to be away? Rest mode pauses everything." The threat moment becomes the compassion moment.

**Verdict: ship A + notches, with C as the drought-stage escalation. Skip B.**

---

## 3. Metric system

Rule applied ruthlessly: **a metric earns a slot only if pointing at the garden can prove it.**

| Metric | Question | Display | Visible consequence (the proof) |
|---|---|---|---|
| **Condition** | "How is it doing?" | The condition word (`condition.ts:34–43`) — *not* a 0–100 score | The entire scene |
| **Forecast** | "What happens next?" | §2's one line | The next weather transition, on schedule |
| **Weekly rhythm** | "Am I consistent?" | Chain of consistent weeks (growth rings / vine segments) + "longest: N" | Vines exist *only* because of this counter; ring count = vine reach |
| **Collection** | "What have I earned?" | "23 of 42 species" + families bar | Every entry is a plant in the scene |

Balance bars stay as a *diagnostic instrument* (with notches), not a headline metric.

**Killed, with cause:** garden vitality 0–100 (the condition word IS the vitality metric; a number invites optimizing the number and re-abstracts what the garden de-abstracts); adherence % (Insights' job); daily streak (dishonest — the engine forgives days — and the genre's #1 anxiety mechanic); distance/pace anything (COROS's job); plant count as goal (caps make it a plateau).

Optional flourish: render moisture as a diegetic **rain barrel** in the scene — tap it for the number. Metaphor-first, numbers second, literally.

---

## 4. Biome brainstorm

Existing hooks: regions already expand (max 6 × 14, unlock at 75% capacity) with a mute event; species are already discipline-themed (stonecrop/ironwood/terrace fern = strength, `species.ts:130–132`; moon lotus/meditation moss = yoga, `species.ts:135–137`); placement is seeded and banded (`depthBand`).

### (a) BASIC — micro-habitats within the one garden ✅ ship now
Name 3–4 zones inside the existing scene — **the damp corner** (ferns, mosses, frogs), **the sunny bank** (flowers, thyme, bees), **the rocky edge** (stonecrop, ironwood — lifting literally builds the garden's stonework), **the old log** (the existing dead-wood habitat, formalized). Species gain a zone preference biasing the already-seeded placement; plant sheets and the diversity strip speak zone language.
- **Unlocks:** 3–5 new zone-flavored species at most; mainly *legibility* of what exists.
- **Determinism:** trivial — placement bias is one more input to the same seeded roll.
- **Metaphor risk:** none. It *strengthens* "one place you tend" by giving the place anatomy.

### (b) MEDIUM — earned terrain expansion ✅ the destination
Re-theme the existing region system: when the capacity trigger fires, the *kind* of new ground is chosen deterministically from the dominant training counters since the last expansion — long-run dominance carves **the stream** (willow, wisteria, dragonflies), strength builds **the stone terrace**, yoga clears **the still glade**, balanced weeks open **the meadow**. Each ground: 2–4 exclusive species + one wildlife affinity, and a named ceremony — *"Eight weeks of long runs carved the stream."*
- **Unlocks:** real new species slots with a causal story the player can retell — the strongest answer to "clarify the garden's composition."
- **Determinism:** a pure function of counters already in `EngineGardenState`; version-gate (`SIMULATION_VERSION` bump) since replay output changes.
- **Cost:** terrain art per ground (the real cost), a "grounds" shelf in the codex, ceremony in the overnight beat.
- **Metaphor risk:** low-moderate — the garden growing *outward at its own edges* is what the scene already does; cap at the existing 6 regions.

### (c) LARGE — full biome progression / seasons-as-mechanics / multiple gardens ❌ don't
- **Why not:** splits the emotional investment that makes a solo product work (Animal Crossing is *one* island; Finch is *one* bird); fights the timeline scrubber's promise (whole history, one place, one replay); multiplies renderer art combinatorially. Seasons already exist ambiently — making them mechanical would add FOMO, the one dark pattern the product has avoided.
- **Verdict:** (a) now, (b) next major version, (c) never — better to make one garden feel infinitely deep than three gardens feel shallow.

---

## 5. Immersion levers, ranked

1. **The overnight beat (arrival moment).** Highest ROI. On open after ≥1 simulated day: a 3-second beat — sky settles into today's weather, then 2–3 lines: *"Since Tuesday: rain fell twice · the cherry opened · bees returned."* All data exists. Converts determinism's weakness (nothing "happens" while watching) into its strength (things *provably happened* while away). Unlock ceremonies live here.
2. **Provenance depth.** "Planted by your Tuesday 10k" on the plant sheet. One join, permanent investment. An afternoon of work.
3. **Wildlife as variable reward.** Wildlife are the scene's only agents. Deterministic rare visitations (seeded per date, `visitor:{date}` following the `wx:{date}` pattern — a deer at dawn after a long-run week) and micro-behaviors (birds landing on the Milestone oak). "Was it there when you looked?" is what daily visits are made of.
4. **Timeline scrubber as story replay.** Add chapter ticks (unlocks, comebacks, droughts survived, expansions) and a "replay this week" auto-play. The README's growth GIF is the product's best marketing asset — put that feeling *in* the product.
5. **Seasonal drift, legible.** Push existing renderer seasons to readability (maple turning in October, winter light). Ambient only — no mechanics.
6. **Camera/parallax.** Subtle depth parallax on scroll/tilt. Pure polish; after 1–4.
7. **Sound.** Lowest for the PWA (short check-ins, muted phones) — but *high* for the desktop screensaver, where dwell time is long: rain on run days, evening crickets when fireflies are out. Opt-in, and only there.

---

### If only three things get built
1. **The forecast line + bar notches** (§2 Framing A) — the countdown, shipped honestly.
2. **The overnight beat with unlock ceremonies** (§5.1) — makes visiting daily feel earned.
3. **Micro-habitat naming** (§4a) as the biome down-payment, with earned-terrain (§4b) as the roadmap headline.

The tone bar for all of them: the garden asks, it never accuses — *"rain needed by Thursday"* is a garden with needs; *"3 days left"* is a game with threats. The engine already knows the difference; the page just has to say it out loud.
