/**
 * THE HEALTH ROW (design 2026-11-05 §3.2, §6.5): one light per stage and source, computed on read from the trail, the
 * extension's checks and the import budget. Deterministic.
 *
 * Per light, over the last 7 days and at most its last 20 steps (`info`/`skip` steps don't count):
 *  - red: its last step failed for the whole stage (a login, a changed site, the gateway refusing the key or credits),
 *    or at least half of at least four steps failed;
 *  - yellow: a failure or a warning among its last 5 steps;
 *  - green otherwise; grey with no steps at all — a source never used is never green.
 * Budget: red at the cap, yellow past 80%, else green. Instagram also goes yellow when checks have run but none in 48 h.
 *
 * D1 statements: the window's steps 1, the latest check 1, the spend 1 — 3.
 */
import { and, desc, eq, gte, inArray, sql } from "drizzle-orm";
import { schema } from "@rg/database";
import { HEALTH_LIGHTS } from "@rg/saves";
import type { HealthColor, HealthLight, HealthLightDto, ImportHealthDto } from "@rg/saves";
import type { Db } from "./db.js";
import { importSpend } from "./saves-budget.js";

const { importEvents, saveChecks, savedPosts } = schema;

const WINDOW_MS = 7 * 86_400_000;
const PER_LIGHT = 20;
const RECENT = 5;
const STALE_CHECK_MS = 48 * 3_600_000;
const FAILURES_SHOWN = 10;

const LABEL: Record<HealthLight, string> = {
  instagram: "Instagram", youtube: "YouTube", screening: "Screening", reader: "Reader", matching: "Matching", coach: "Coach", budget: "Budget",
};

/** Which steps a light is made of. */
function lightOf(stage: string, source: string): HealthLight | null {
  if (stage === "read") return source === "youtube" ? "youtube" : source === "instagram" ? "instagram" : null;
  if (stage === "screen") return "screening";
  if (stage === "extract") return "reader";
  if (stage === "match") return "matching";
  if (stage === "coach") return "coach";
  return null;
}

/** A failure the whole stage shares, not one post's: a login, a changed site, the gateway refusing the key or credits. */
function stageWide(detail: unknown, summary: string): boolean {
  const d = (detail ?? {}) as { code?: unknown; failure?: unknown };
  if (d.code === "login_needed" || d.code === "feed_changed") return true;
  if (typeof d.failure === "string" && /^gateway_(401|402|403)$/.test(d.failure)) return true;
  return /answered (401|402|403)\b/.test(summary);
}

const dollars = (micros: number): string => `$${(micros / 1_000_000).toFixed(2)}`;

export async function importHealth(db: Db, userId: string, now: Date): Promise<ImportHealthDto> {
  const since = new Date(now.getTime() - WINDOW_MS).toISOString();
  const steps = await db
    .select({
      stage: importEvents.stage, source: importEvents.source, status: importEvents.status, summary: importEvents.summary,
      detail: importEvents.detail, postId: importEvents.postId, at: importEvents.at,
      title: sql<string | null>`coalesce(${savedPosts.title}, nullif(${savedPosts.creatorName}, ''), nullif(${savedPosts.creatorHandle}, ''))`,
    })
    .from(importEvents)
    .leftJoin(savedPosts, and(eq(savedPosts.id, importEvents.postId), eq(savedPosts.userId, userId)))
    .where(and(
      eq(importEvents.userId, userId),
      gte(importEvents.at, since),
      inArray(importEvents.stage, ["read", "screen", "extract", "match", "coach"]),
      inArray(importEvents.status, ["ok", "warn", "fail"]),
    ))
    .orderBy(desc(importEvents.at), sql`${importEvents}.rowid desc`)
    .limit(PER_LIGHT * 6);
  const [lastCheck] = await db
    .select({ startedAt: saveChecks.startedAt })
    .from(saveChecks)
    .where(eq(saveChecks.userId, userId))
    .orderBy(desc(saveChecks.startedAt))
    .limit(1);
  const spend = await importSpend(db, userId, now);

  const byLight = new Map<HealthLight, typeof steps>();
  for (const s of steps) {
    const light = lightOf(s.stage, s.source);
    if (!light) continue;
    const list = byLight.get(light) ?? [];
    if (list.length < PER_LIGHT) list.push(s);
    byLight.set(light, list);
  }

  const lights: HealthLightDto[] = HEALTH_LIGHTS.map((light) => {
    if (light === "budget") {
      const color: HealthColor = spend.spentMicros >= spend.capMicros ? "red" : spend.spentMicros > spend.capMicros * 0.8 ? "yellow" : "green";
      return {
        light, color, failures: [],
        line: color === "green" ? null : `Budget: ${dollars(spend.spentMicros)} of ${dollars(spend.capMicros)} this month`,
      };
    }
    const list = byLight.get(light) ?? [];
    const failures = list
      .filter((s) => s.status === "fail")
      .slice(0, FAILURES_SHOWN)
      .map((s) => ({ postId: s.postId.startsWith("ext:") ? null : s.postId, title: s.title ?? LABEL[light], at: s.at, why: s.summary }));
    const staleChecks = light === "instagram" && lastCheck && now.getTime() - Date.parse(lastCheck.startedAt) > STALE_CHECK_MS;
    if (list.length === 0) {
      return staleChecks
        ? { light, color: "yellow", line: "Instagram: no check in 2 days", failures }
        : { light, color: "grey", line: null, failures };
    }
    const newest = list[0]!;
    const failed = list.filter((s) => s.status === "fail").length;
    if (newest.status === "fail" && stageWide(newest.detail, newest.summary)) return { light, color: "red", line: newest.summary, failures };
    if (list.length >= 4 && failed * 2 >= list.length) return { light, color: "red", line: `${LABEL[light]}: ${failed} of ${list.length} failed`, failures };
    const troubled = list.slice(0, RECENT).find((s) => s.status === "fail" || s.status === "warn");
    if (troubled) return { light, color: "yellow", line: troubled.summary, failures };
    if (staleChecks) return { light, color: "yellow", line: "Instagram: no check in 2 days", failures };
    return { light, color: "green", line: null, failures };
  });

  const rank: Record<HealthColor, number> = { red: 2, yellow: 1, green: 0, grey: 0 };
  const worst = lights.reduce<HealthLightDto | null>((w, l) => (rank[l.color] > (w ? rank[w.color] : 0) ? l : w), null);
  return { lights, worst: worst?.line ?? null };
}
