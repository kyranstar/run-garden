/**
 * Read-only sport census: which COROS sportType codes does this account
 * actually have, over its whole history, and what does the sport registry
 * call each one?
 *
 * Every code is admitted into the import now — nothing is dropped. Codes the
 * registry can't name resolve to "other" and are tallied here so they stay
 * visible and worth naming. Before adding a code to the registry, this proves
 * what actually shows up in the wild — in particular whether historical yoga
 * sits under 403/904 as assumed, or somewhere else entirely.
 *
 * Writes docs/reports/coros-sport-census-<date>.json. No ingest, no writes,
 * no per-activity detail fetches.
 *
 * Run with: pnpm coros:census
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { sportIdForCorosCode } from "@rg/domain";
import { CorosClient, type CorosRegion } from "../src/index.js";
import { createPrompter } from "./prompt.js";
import { redactUserId } from "./sanitize.js";
import { loginWithPassword } from "./coros-login.js";

/**
 * How far back to sweep. COROS did not exist before this, so it is a ceiling
 * rather than a guess about the account.
 */
const CENSUS_START = "2010-01-01";

interface CodeRow {
  sportType: number;
  /** Registry id (e.g. "run", "hike", "other") — see @rg/domain sportIdForCorosCode. */
  sport: string;
  /** True when the registry could not name this code ("other") — worth adding. */
  unnamed: boolean;
  count: number;
  earliest: string;
  latest: string;
  sampleNames: string[];
}

/** "20260804" | 20260804 → "2026-08-04" */
function isoDay(day: string | number): string {
  const s = String(day).padStart(8, "0");
  return `${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6, 8)}`;
}

/**
 * Credentials from the environment when present, prompting only for what is
 * missing. Without this the census can only run from a real terminal — an
 * agent shell or any piped runner has no TTY, and the first prompt fails with
 * "stdin ended before answering".
 */
async function credentials(): Promise<{
  email: string;
  password: string;
  region: CorosRegion;
}> {
  const envEmail = process.env.COROS_EMAIL?.trim();
  const envPassword = process.env.COROS_PASSWORD;
  const envRegion = process.env.COROS_REGION?.trim();

  if (envEmail && envPassword) {
    const region = (envRegion || "us") as CorosRegion;
    if (!["us", "eu", "cn"].includes(region)) throw new Error(`invalid COROS_REGION: ${region}`);
    return { email: envEmail, password: envPassword, region };
  }

  if (!process.stdin.isTTY) {
    throw new Error(
      "No TTY and no credentials in the environment.\n" +
        "Run this from a terminal, or set COROS_EMAIL and COROS_PASSWORD\n" +
        "(optionally COROS_REGION=us|eu|cn) and re-run.",
    );
  }

  const prompter = createPrompter();
  try {
    const email = envEmail ?? (await prompter.ask("COROS email: ")).trim();
    const password = envPassword ?? (await prompter.askHidden("COROS password: "));
    const regionInput = envRegion || (await prompter.ask("Region [us/eu/cn] (default us): ")).trim() || "us";
    if (!["us", "eu", "cn"].includes(regionInput)) throw new Error("invalid region");
    return { email, password, region: regionInput as CorosRegion };
  } finally {
    prompter.close();
  }
}

async function main(): Promise<void> {
  const { email, password, region } = await credentials();
  const client = new CorosClient({ region });
  const { userId } = await loginWithPassword(client, email, password);

  const today = new Date().toISOString().slice(0, 10);
  console.error(`[census] sweeping ${CENSUS_START}..${today}`);
  const items = await client.getActivities(CENSUS_START, today);

  const byCode = new Map<number, CodeRow>();
  for (const item of items) {
    const iso = isoDay(item.date);
    const existing = byCode.get(item.sportType);
    if (existing) {
      existing.count += 1;
      if (iso < existing.earliest) existing.earliest = iso;
      if (iso > existing.latest) existing.latest = iso;
      if (existing.sampleNames.length < 3 && item.name && !existing.sampleNames.includes(item.name)) {
        existing.sampleNames.push(item.name);
      }
    } else {
      const sport = sportIdForCorosCode(item.sportType);
      byCode.set(item.sportType, {
        sportType: item.sportType,
        sport,
        unnamed: sport === "other",
        count: 1,
        earliest: iso,
        latest: iso,
        sampleNames: item.name ? [item.name] : [],
      });
    }
  }

  const codes = [...byCode.values()].sort((a, b) => b.count - a.count);
  const days = items.map((i) => isoDay(i.date)).sort();

  const report = {
    kind: "coros-sport-census" as const,
    date: today,
    userIdRedacted: redactUserId(userId),
    spanStart: days[0] ?? null,
    spanEnd: days[days.length - 1] ?? null,
    totalActivities: items.length,
    unnamedActivities: codes.filter((c) => c.unnamed).reduce((s, c) => s + c.count, 0),
    codes,
  };

  const outDir = join(dirname(fileURLToPath(import.meta.url)), "../../../docs/reports");
  mkdirSync(outDir, { recursive: true });
  const outPath = join(outDir, `coros-sport-census-${today}.json`);
  writeFileSync(outPath, `${JSON.stringify(report, null, 2)}\n`);

  console.log(
    `\n${items.length} activities, ${codes.length} distinct sport types, ${report.spanStart ?? "—"}..${report.spanEnd ?? "—"}\n`,
  );
  console.log("  code  sport          count  span                     registry");
  for (const c of codes) {
    const mark = c.unnamed ? "✗ unnamed — add to registry" : `✓ ${c.sport}`;
    console.log(
      `  ${String(c.sportType).padEnd(5)} ${c.sport.padEnd(14)} ${String(c.count).padStart(5)}  ${c.earliest}..${c.latest}  ${mark}`,
    );
    if (c.unnamed && c.sampleNames.length > 0) {
      console.log(`        e.g. ${c.sampleNames.join(" · ")}`);
    }
  }
  if (report.unnamedActivities > 0) {
    console.log(
      `\n${report.unnamedActivities} activities are admitted but unnamed ("other"). Any code above worth naming should be added to the sport registry (packages/domain/src/sport.ts).`,
    );
  }
  console.log(`\nwrote ${outPath}`);
}

main().catch((e: unknown) => {
  console.error(e instanceof Error ? e.message : "census failed");
  process.exit(1);
});
