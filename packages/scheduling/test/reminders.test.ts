import { describe, expect, it } from "vitest";
import { DEFAULT_SCHEDULING_PREFERENCES } from "@rg/domain";
import { planReminders } from "../src/reminders.js";
import { computeBlock, zonedInstant } from "../src/windows.js";

const prefs = { ...DEFAULT_SCHEDULING_PREFERENCES, timezone: "America/Los_Angeles" };

describe("planReminders", () => {
  it("adds previous-evening reminder at configured wall-clock time for morning runs", () => {
    // Run Tuesday 2026-08-04 07:00; block starts 06:50 (10 min buffer).
    const block = computeBlock("2026-08-04", "07:00", 3240, prefs);
    const plan = planReminders("2026-08-04", "07:00", block.startInstant, prefs);
    // Reminder must fire Monday 20:30 → 06:50 - 20:30 = 620 minutes before.
    expect(plan.overrideMinutes).toContain(620);
    expect(plan.overrideMinutes).toContain(30);
    expect(plan.sleepReminderInstant).toBe(zonedInstant("2026-08-03", "20:30", prefs.timezone));
    expect(plan.sleepReminderText).toBe("Morning run tomorrow at 7 AM. Protect tonight's sleep.");
  });

  it("is DST-safe across fall-back (real elapsed minutes, wall-clock target)", () => {
    // US DST ends 2026-11-01 02:00 in America/Los_Angeles: that night has 25 hours.
    const block = computeBlock("2026-11-01", "08:00", 3600, prefs);
    const plan = planReminders("2026-11-01", "08:00", block.startInstant, prefs);
    // Wall clock gap 20:30 → 07:50 is 11h20m, plus the extra DST hour = 740 min.
    expect(plan.overrideMinutes).toContain(740);
    expect(plan.sleepReminderInstant).toBe(zonedInstant("2026-10-31", "20:30", prefs.timezone));
  });

  it("is DST-safe across spring-forward", () => {
    // US DST starts 2026-03-08: that night has 23 hours.
    const block = computeBlock("2026-03-08", "08:00", 3600, prefs);
    const plan = planReminders("2026-03-08", "08:00", block.startInstant, prefs);
    // Wall clock gap 20:30 → 07:50 is 11h20m, minus the skipped hour = 620 min.
    expect(plan.overrideMinutes).toContain(620);
  });

  it("gives evening runs a single 60-minute reminder and no sleep reminder", () => {
    const block = computeBlock("2026-08-04", "19:00", 3000, prefs);
    const plan = planReminders("2026-08-04", "19:00", block.startInstant, prefs);
    expect(plan.overrideMinutes).toEqual([60]);
    expect(plan.sleepReminderInstant).toBeUndefined();
  });

  it("formats non-zero minutes in the sleep reminder text", () => {
    const block = computeBlock("2026-08-04", "06:30", 3240, prefs);
    const plan = planReminders("2026-08-04", "06:30", block.startInstant, prefs);
    expect(plan.sleepReminderText).toBe("Morning run tomorrow at 6:30 AM. Protect tonight's sleep.");
  });
});
