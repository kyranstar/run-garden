/**
 * Reversible live write spike (product spec §"Initial live write test").
 *
 * Moves ONE user-chosen, low-risk workout one day later on the real COROS
 * account, verifies, then moves it back and verifies again. Writes a
 * sanitized JSON report to docs/reports/coros-write-spike-<date>.json
 * (userId redacted to 4 chars; no tokens, no email, no userId fields in the
 * raw snapshots).
 *
 * Run with: pnpm coros:spike
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { loginWithPassword } from "./coros-login.js";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { addDays } from "@rg/domain";
import { normalizeCorosSchedule, type SourcePlannedWorkout } from "@rg/providers";
import { CorosClient, type CorosRegion } from "@rg/coros";
import { createPrompter } from "./prompt.js";
import { redactUserId, stripUserIds } from "./sanitize.js";
import { loadNameResolver } from "./snapshot.js";
import { executeMoveJob, type MoveJobResult } from "@rg/coros";

interface SpikeReport {
  kind: "coros-write-spike";
  date: string;
  region: CorosRegion;
  userIdRedacted?: string;
  workout?: {
    title: string;
    sourceIdInPlan?: string;
    originalDate: string;
    destinationDate: string;
    nativeDurationSeconds?: number;
    contentFingerprint: string;
    rawEntity?: unknown;
    rawProgram?: unknown;
  };
  moveOut?: MoveJobResult;
  moveBack?: MoveJobResult;
  rollbackAttempted?: boolean;
  succeeded: boolean;
  failure?: string;
}

function fmtDuration(seconds: number | undefined): string {
  if (!seconds || seconds <= 0) return "no native estimate";
  const m = Math.round(seconds / 60);
  return `${m} min (native)`;
}

function reportPath(date: string): string {
  const here = dirname(fileURLToPath(import.meta.url));
  const dir = join(here, "..", "..", "..", "docs", "reports");
  mkdirSync(dir, { recursive: true });
  return join(dir, `coros-write-spike-${date}.json`);
}

async function main(): Promise<void> {
  const today = new Date().toISOString().slice(0, 10);
  const prompter = createPrompter();
  const rl = prompter.rl;
  const report: SpikeReport = { kind: "coros-write-spike", date: today, region: "us", succeeded: false };
  let client: CorosClient | null = null;
  let movedOut = false;
  let chosen: SourcePlannedWorkout | null = null;

  console.log("──────────────────────────────────────────────────────────────");
  console.log(" COROS WRITE SPIKE — THIS TOUCHES YOUR REAL COROS ACCOUNT");
  console.log("");
  console.log(" It will move ONE workout you pick one day later, verify the");
  console.log(" change on COROS, then move it back and verify again. If any");
  console.log(" step fails it attempts a rollback and tells you exactly what");
  console.log(" state your calendar is in.");
  console.log("──────────────────────────────────────────────────────────────");

  try {
    const email = (await prompter.ask("COROS email: ")).trim();
    const password = await prompter.askHidden("COROS password: ");
    const regionInput =
      (await prompter.ask("Region [us/eu/cn] (default us): ")).trim() || "us";
    if (!["us", "eu", "cn"].includes(regionInput)) throw new Error("invalid region");
    const region = regionInput as CorosRegion;
    report.region = region;

    client = new CorosClient({ region });
    const { userId } = await loginWithPassword(client, email, password);
    report.userIdRedacted = redactUserId(userId);
    console.log("Logged in.");

    const raw = await client.getRawSchedule(addDays(today, -30), addDays(today, 30));
    const resolver = await loadNameResolver(client.fetchImpl);
    const normalized = normalizeCorosSchedule(raw, resolver);
    if (!normalized.planId || normalized.workouts.length === 0) {
      throw new Error("no active plan / scheduled workouts found in ±30 days");
    }

    const minDate = addDays(today, 3);
    const candidates = normalized.workouts
      .filter((w) => !w.isRestDay && w.date >= minDate && !/race/i.test(w.title))
      .sort((a, b) => (a.date < b.date ? -1 : 1));
    if (candidates.length === 0) {
      throw new Error("no non-race workouts >= 3 days out to test with");
    }

    console.log(`\nPlan: ${normalized.planName}`);
    console.log("Upcoming workouts eligible for the test:");
    candidates.forEach((w, i) => {
      console.log(
        `  [${i + 1}] ${w.date}  ${w.title}  — ${fmtDuration(w.estimatedDurationSeconds)}`,
      );
    });

    const pick = Number((await rl.question("\nPick a workout number: ")).trim());
    const picked = candidates[pick - 1];
    if (!picked || !picked.sourceIdInPlan) throw new Error("invalid selection");
    chosen = picked;
    const destination = addDays(picked.date, 1);

    const confirm = await rl.question(
      `Type MOVE to move "${picked.title}" from ${picked.date} to ${destination}: `,
    );
    if (confirm.trim() !== "MOVE") throw new Error("aborted by user (no writes performed)");

    const rawPair = (picked.raw ?? {}) as { entity?: unknown; program?: unknown };
    report.workout = {
      title: picked.title,
      sourceIdInPlan: picked.sourceIdInPlan,
      originalDate: picked.date,
      destinationDate: destination,
      nativeDurationSeconds: picked.estimatedDurationSeconds,
      contentFingerprint: picked.contentFingerprint,
      rawEntity: stripUserIds(rawPair.entity),
      rawProgram: stripUserIds(rawPair.program),
    };

    const jobBase = {
      expectedContentFingerprint: picked.contentFingerprint,
      workout: {
        sourceIdInPlan: picked.sourceIdInPlan,
        sourcePlanId: picked.sourcePlanId,
        sourceProgramId: picked.sourceProgramId,
      },
    };

    console.log("\nMoving out (+1 day)…");
    const moveOut = await executeMoveJob(client, {
      id: `spike-out-${Date.now()}`,
      originalDate: picked.date,
      destinationDate: destination,
      ...jobBase,
    });
    report.moveOut = moveOut;
    console.log(
      `  outcome=${moveOut.outcome} path=${moveOut.pathUsed ?? "-"} observedDate=${moveOut.observedDate ?? "-"}`,
    );
    if (moveOut.outcome !== "verified") {
      throw new Error(`move-out not verified (${moveOut.outcome}); nothing further attempted`);
    }
    movedOut = true;

    await rl.question("\nVerified on COROS. Press Enter to move it back: ");
    console.log("Moving back…");
    const moveBack = await executeMoveJob(client, {
      id: `spike-back-${Date.now()}`,
      originalDate: destination,
      destinationDate: picked.date,
      ...jobBase,
    });
    report.moveBack = moveBack;
    console.log(
      `  outcome=${moveBack.outcome} path=${moveBack.pathUsed ?? "-"} observedDate=${moveBack.observedDate ?? "-"}`,
    );
    if (moveBack.outcome !== "verified") {
      throw new Error(
        `move-back not verified (${moveBack.outcome}) — the workout may still be on ${destination}`,
      );
    }
    movedOut = false;

    report.succeeded = true;
    console.log("\nSPIKE PASSED: moved out, verified, moved back, verified.");
  } catch (e) {
    const message = e instanceof Error ? e.message : "unknown failure";
    report.failure = message;
    console.error(`\nSPIKE FAILED: ${message}`);
    // Attempt rollback if the workout is stranded at the +1 date.
    if (movedOut && client && chosen?.sourceIdInPlan) {
      console.error("Attempting rollback to the original date…");
      report.rollbackAttempted = true;
      try {
        const rollback = await executeMoveJob(client, {
          id: `spike-rollback-${Date.now()}`,
          originalDate: addDays(chosen.date, 1),
          destinationDate: chosen.date,
          workout: {
            sourceIdInPlan: chosen.sourceIdInPlan,
            sourcePlanId: chosen.sourcePlanId,
            sourceProgramId: chosen.sourceProgramId,
          },
        });
        report.moveBack = rollback;
        console.error(`Rollback outcome: ${rollback.outcome}`);
        if (rollback.outcome !== "verified") {
          console.error(
            `CHECK YOUR COROS CALENDAR: "${chosen.title}" may still be on ${addDays(chosen.date, 1)}.`,
          );
        }
      } catch {
        console.error(
          `Rollback failed. CHECK YOUR COROS CALENDAR: "${chosen.title}" may be on ${addDays(chosen.date, 1)}.`,
        );
      }
    }
    process.exitCode = 1;
  } finally {
    rl.close();
    if (client) await client.logout().catch(() => undefined);
    const path = reportPath(today);
    writeFileSync(path, `${JSON.stringify(report, null, 2)}\n`);
    console.log(`\nSanitized report written to ${path}`);
  }
}

void main();
