/**
 * READ-ONLY telemetry probe (effort-analysis feature, 2026-08-06): fetch the
 * most recent activities' detail payloads and print every field key with a
 * numeric sample, so we learn which telemetry (temperature, cadence, power,
 * stride…) COROS actually sends before mapping columns. Zero writes.
 *
 * Run from a terminal: `pnpm coros:probe` (prompts for COROS login like the
 * census; or COROS_EMAIL/COROS_PASSWORD/COROS_REGION in the environment).
 */

import { CorosClient, type CorosRegion } from "./coros-client.js";
import { createPrompter } from "./prompt.js";

async function credentials(): Promise<{ email: string; password: string; region: CorosRegion }> {
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
        "Run this from a terminal, or set COROS_EMAIL and COROS_PASSWORD.",
    );
  }
  const prompter = createPrompter();
  try {
    const email = (await prompter.ask("COROS email: ")).trim();
    const password = await prompter.askHidden("COROS password: ");
    const regionInput = (await prompter.ask("Region [us/eu/cn] (default us): ")).trim() || "us";
    if (!["us", "eu", "cn"].includes(regionInput)) throw new Error("invalid region");
    return { email, password, region: regionInput as CorosRegion };
  } finally {
    prompter.close();
  }
}

function describe(v: unknown): string {
  if (v == null) return "null";
  if (typeof v === "number") return `num ${v}`;
  if (typeof v === "string") return v.length > 24 ? `str(${v.length})` : `str "${v}"`;
  if (Array.isArray(v)) return `array(${v.length})`;
  if (typeof v === "object") return `object{${Object.keys(v as object).slice(0, 8).join(",")}}`;
  return typeof v;
}

async function main(): Promise<void> {
  const { email, password, region } = await credentials();
  const client = new CorosClient({ region });
  await client.login(email, password);

  const end = new Date().toISOString().slice(0, 10);
  const start = new Date(Date.now() - 30 * 86_400_000).toISOString().slice(0, 10);
  const items = await client.getActivities(start, end);
  console.error(`[probe] ${items.length} activities in ${start}..${end}`);

  // One run + one strength session if available — telemetry differs by sport.
  const bySport = new Map<number, (typeof items)[number]>();
  for (const item of items) {
    if (!bySport.has(item.sportType)) bySport.set(item.sportType, item);
  }
  for (const item of [...bySport.values()].slice(0, 4)) {
    console.log(`\n=== sportType ${item.sportType} · "${item.name ?? "?"}" · ${item.date} ===`);
    console.log("— list-item keys —");
    for (const [k, v] of Object.entries(item as Record<string, unknown>).sort()) {
      console.log(`  ${k}: ${describe(v)}`);
    }
    const detail = await client.getActivityDetail(String(item.labelId), item.sportType);
    const summary = (detail as { summary?: Record<string, unknown> }).summary ?? {};
    console.log("— detail.summary keys —");
    for (const [k, v] of Object.entries(summary).sort()) {
      console.log(`  ${k}: ${describe(v)}`);
    }
    const lapList = (detail as { lapList?: Array<{ lapItemList?: Array<Record<string, unknown>> }> }).lapList ?? [];
    const firstLap = lapList[0]?.lapItemList?.[0];
    if (firstLap) {
      console.log("— first lap-item keys —");
      for (const [k, v] of Object.entries(firstLap).sort()) {
        console.log(`  ${k}: ${describe(v)}`);
      }
    }
    const extraTop = Object.keys(detail as object).filter((k) => !["summary", "lapList"].includes(k));
    if (extraTop.length) console.log(`— other detail top-level keys — ${extraTop.join(", ")}`);
  }
  console.log("\n[probe] done — zero writes were made.");
}

main().catch((err) => {
  console.error(`[probe] failed: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
