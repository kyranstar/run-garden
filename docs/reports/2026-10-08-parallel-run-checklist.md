# The parallel run: the standalone tool beside Run Garden (decision D8)

Decision D8 (programme spec §2): the standalone tool is retired after about two weeks of parallel use with matching
data. This checklist is how the owner runs those two weeks: importing the tool's backup, comparing the numbers, and
reporting a mismatch. It is generic — it names no person, account, file, or value.

## 0. Before the window opens

- [ ] The import is switched on: `features.import` (the client) and `IMPORT_ENABLED = "1"` (the Worker) — one
      owner-visible change, after the garden gate (Phase 2d) is in production.
- [ ] The player is on (`features.player`), so program sessions can be played and saved in the app.
- [ ] Read §1's "What the first import changes" before importing: it is the only import that touches anything but
      sessions, and there is no un-import.

## 1. Import (day 0)

1. In the standalone tool, export a backup (its own export). The file is private: keep it out of any repository,
   chat or shared folder, and delete it once the import is done.
2. In Run Garden: **Settings → Import → From the standalone tool…**, and choose the file.
3. Read the summary sheet. Choosing the file runs a **dry run**: nothing has been written yet. It lists only what the
   import will write:
   - *N sessions*, and the first and last day (with the year) — the sessions this import adds.
   - The program — one of three (see below): *Makes the program …*, *… takes block N · week W*, or
     *Your program … stays as it is*.
   - *N places · N ratings* — only places and ratings that are new here (none if you already have places of your own).
   - *Weights …* — whether the weight unit switches to the tool's or yours stays.
   - *History stays out of the garden* — imported sessions show in Activity and records, and never change the
     garden, past or present.
   - *N sessions skipped* (only if any) — sessions the import could not read; every number below leaves them out.
   - If anything looks wrong, close the sheet: nothing has been written. Report it (§4) before importing.
4. Press **Import**. The sheet then says what happened to the program (on a first import) and shows the tool's own
   numbers (§2). Keep it open, or re-open it later: choosing the same file again writes nothing ("Nothing new to
   import") and shows the same numbers.

### What the first import changes — and what it never does

- **The program.** The import never makes a second program. The summary sheet says which of these happens:
  - no program in Run Garden yet → it makes one from the tool's settings, with the tool's current block, and places
    its sessions on the plan (and the calendar) from today;
  - one program that has not started (no block yet, no session done) → the tool's block (its core lifts, number and
    week) goes into that program; the program's own settings (days, goal, length, place) and its planned sessions
    stay as they are;
  - anything else (a program already under way, more than one, or only a retired one) → the program stays exactly as
    it is, and the tool's block is not used.

  A program with no place of its own will use the imported default place: when the import brings the tool's places
  (only when you have none), that program's next sessions are built at the tool's default place.
- **The weight unit.** It becomes the tool's only if Weights in Settings → Units was never changed from the default
  AND none of your places has a weight list typed without a unit (such a list means the unit in force, so switching
  would change what it means). Otherwise yours stays. The summary sheet says which; check Settings → Units after.
- **The program's next sessions change.** Imported sessions join the history every session is built from: the next
  build may move a core lift to another variant ("no progress in 3 sessions", judged on the tool's sessions), pick a
  calmer mode after recent before-session check-ins, or rotate the care and warm-up moves. This is expected; the
  session sheet says why.
- **Never changed:** the past garden; places you already have; a move preference you already set; the health
  condition setting once set; the wishlist (the tool's new gear is added to it, never removed from it). Later imports
  bring only new sessions.

## 2. Compare with the tool's Progress tab

Open the standalone tool's **Progress** tab beside the result sheet. The sheet lays the numbers out in the tool's own
unit (its settings), computed by the tool's own rules over the file's sessions. Compare only these — they are the
numbers that tab shows:

| Result sheet | Where on the tool's Progress tab | Expect |
|---|---|---|
| Per week → **Sessions** (last 8 weeks, by Monday) | the sessions-per-week chart (last 12 weeks); hover a week: "N sessions · M min" | equal, week by week |
| Per week → **lb** or **kg** | the volume chart ("weight × reps on loaded lifts"); hover a week | equal, week by week |
| Lifts → **Latest** | that lift's tile: its big number, the last session's top set | equal, in the tool's unit |

The other rows have no number to compare with on that tab, so they are for reference only:

- Progress → **Sessions**, **Records**, **Before and after** and **Block in the tool**: the tab shows no total of
  sessions, lists at most the 12 most recent records (never a count), plots before/after for the last 30 sessions
  (never a count of pairs), and does not show the block.
- Lifts → **Best**: the tile shows the latest top set and its change since the first, not a best.
- Per week → **kg** beside pounds (pounds tools only): the same week's whole kilos.

Run Garden's own Activity tiles (weekly volume, lift lines, the condition trend) are Run Garden's numbers — a tenth
of a kilo, its own windows — and are not the comparison; the result sheet is.

## 3. During the two weeks

- [ ] Day 0: import and compare (§1–2).
- [ ] Train in Run Garden: play the program's sessions in the app.
- [ ] A session done in the standalone tool instead comes in with the next backup, as history: it never grows the
      garden, and it is never matched to that day's program session in Run Garden. So on such a day, open the day's
      program session in Run Garden and press **Skip** — left unanswered, it is marked missed and the garden counts it
      as any missed session.
- [ ] Mid-window (about day 7): export a fresh backup and import it. Only the new sessions are added (the summary says
      "N new sessions" and "Nothing else changes"); nothing changed in Run Garden since (places, ratings, units, the
      program) is overwritten. Compare again (§2).
- [ ] Day 14: export, import, compare once more.
- [ ] Watch for: a session missing from Activity, a double session, sets with the wrong unit, a garden that moved on
      a day with only imported history, a program session marked missed on a day trained in the tool.

**Done when** the last comparison matches (or every difference is explained and accepted), nothing was lost, and
the app's own sessions saved without trouble. Then the standalone tool retires (D8): stop logging there, keep its
final backup offline and private, and delete any other copies. If the window ends with an open mismatch, the tool
keeps running and the window extends after the fix.

## 4. Reporting a mismatch

Write down, with numbers only:

1. Which number (the row of the table in §2) and, for a week, its Monday; for a lift, its name.
2. Run Garden's value and the tool's value.
3. The tool's unit setting, and the date the backup was exported.
4. Whether the summary said any sessions were skipped, and how many.

Report it in the project's private notes. Never attach or paste the backup file, session notes, or any health
numbers anywhere public: the repository is public.
