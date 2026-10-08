# The parallel run: the standalone tool beside Run Garden (decision D8)

Decision D8 (programme spec §2): the standalone tool is retired after about two weeks of parallel use with matching
data. This checklist is how the owner runs those two weeks: importing the tool's backup, comparing the numbers, and
reporting a mismatch. It is generic — it names no person, account, file, or value.

## 0. Before the window opens

- [ ] The import is switched on: `features.import` (the client) and `IMPORT_ENABLED = "1"` (the Worker) — one
      owner-visible change, after the garden gate (Phase 2d) is in production.
- [ ] The player is on (`features.player`), so program sessions can be played and saved in the app.
- [ ] Settings → Units → Weights reads the unit you use (the first import keeps a unit you chose here; it only takes
      the tool's when yours is still the default).

## 1. Import (day 0)

1. In the standalone tool, export a backup (its own export). The file is private: keep it out of any repository,
   chat or shared folder, and delete it once the import is done.
2. In Run Garden: **Settings → Import → From the standalone tool…**, and choose the file.
3. Read the summary sheet. Choosing the file runs a **dry run**: nothing has been written yet.
   - *N sessions*, and the first and last day — should match the tool's history.
   - *Block N · week W* and the number of core lifts — should match the tool's current block.
   - *N places · N ratings* and the place names.
   - *History stays out of the garden* — imported sessions show in Activity and records, and never change the
     garden, past or present.
   - *N sessions skipped* (only if any) — sessions the import could not read; every number below leaves them out.
   - If anything looks wrong, close the sheet: nothing has been written. Report it (§4) before importing.
4. Press **Import**. The sheet then shows the tool's own numbers (§2). Keep it open, or re-open it later: choosing
   the same file again writes nothing ("Nothing new to import") and shows the same numbers.

## 2. Compare with the tool's Progress tab

Open the standalone tool's **Progress** tab beside the result sheet. The sheet lays the numbers out the way that tab
reads them, in the tool's own unit (its settings), computed by the tool's own rules over the file's sessions.

| Result sheet | Where in the standalone tool | Expect |
|---|---|---|
| Progress → **Sessions** | the number of sessions in its history | equal, less any skipped |
| Progress → **Records** | Progress → the records card: new bests and milestones (first times are not listed) | equal; the card lists only the 12 most recent, so above 12 compare those 12 |
| Progress → **Before and after** | Progress → the before/after chart: sessions with both numbers (the chart shows the last 30) | equal |
| Progress → **Block** | the tool's current block and week | equal |
| Per week → **Sessions** (last 8 weeks, by Monday) | Progress → the sessions-per-week chart; hover a week | equal, week by week |
| Per week → **lb** or **kg** | Progress → the volume chart ("weight × reps on loaded lifts"); hover a week | equal, week by week; in pounds a week may differ by 1 (the pound conversion rounds) |
| Per week → **kg** (pounds tools only) | the same week's whole kilos | for reference |
| Lifts → **Latest** | Progress → that lift's tile: the last session's top set | equal, in the tool's unit |
| Lifts → **Best** | the lift's most recent "New best" record, or the highest point of its tile's line | equal |

Run Garden's own Activity tiles (weekly volume, lift lines, the condition trend) are Run Garden's numbers — a tenth
of a kilo, its own windows — and are not the comparison; the result sheet is.

## 3. During the two weeks

- [ ] Day 0: import and compare (§1–2).
- [ ] Train in Run Garden: play the program's sessions in the app. A session done in the standalone tool instead
      comes in with the next backup, as history (it never grows the garden).
- [ ] Mid-window (about day 7): export a fresh backup and import it. Only the new sessions are added; nothing changed
      in Run Garden since (places, ratings, units, the program) is overwritten. Compare again (§2).
- [ ] Day 14: export, import, compare once more.
- [ ] Watch for: a session missing from Activity, a double session, sets with the wrong unit, a garden that moved on
      a day with only imported history.

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
