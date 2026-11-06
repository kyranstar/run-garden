/**
 * THE HEALTH ROW (design 2026-11-05 §3.2, §6.5): one light per stage and source, computed on read from the trail, the
 * extension's checks and the import budget. Deterministic.
 *
 * Per light, over the last 7 days and at most its last 20 steps (`info`/`skip` steps don't count; the Reader's are its
 * calls and the check of each reading — its attempts, for the ratio and the recent five, are the readings alone):
 *  - red: its last step failed for the whole stage (a login, a changed site, the gateway refusing the key or credits),
 *    or at least half of at least four steps failed;
 *  - yellow: a failure or a warning among its last 5 steps;
 *  - green otherwise; grey with no steps at all — a source never used is never green.
 * Budget: red at the cap, yellow past 80%, else green. Instagram also goes yellow when checks have run but none in 48 h.
 *
 * D1 statements: the window's steps 1, the latest check 1, the spend 1 — 3.
 */
import { desc, eq, sql } from "drizzle-orm";
import { schema } from "@rg/database";
import { HEALTH_LIGHTS, normalizeLink } from "@rg/saves";
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
  // The reader's light: its calls, and the check of what it read — quotes not in the post, moves it was unsure of
  // (audit 2026-11-06, I8).
  if (stage === "extract" || stage === "check") return "reader";
  if (stage === "match") return "matching";
  if (stage === "coach") return "coach";
  return null;
}

/**
 * A failure the whole stage shares, not one post's: a login (Instagram's, or YouTube asking to sign in), a changed site,
 * the gateway refusing the key or credits, the coach's fit-in run failing (§6.5; audit 2026-11-06, I2).
 */
function stageWide(s: { code: string | null; failure: string | null; summary: string }): boolean {
  if (s.code === "login_needed" || s.code === "feed_changed" || s.code === "youtube_login" || s.code === "fit_failed") return true;
  if (typeof s.failure === "string" && /^gateway_(401|402|403)$/.test(s.failure)) return true;
  return /answered (401|402|403)\b/.test(s.summary);
}

const dollars = (micros: number): string => `$${(micros / 1_000_000).toFixed(2)}`;

/**
 * A read that failed before its post: its link — the pasted link's row, else, for a video, the link its key makes (one
 * the app handed out) — checked as any pasted link is (`normalizeLink`); null for anything else (a post's failure, a
 * login, a saved-list post's read: pasting it would make it a pasted post; review, 2026-11-06).
 */
function linkOf(s: { postId: string; linkUrl: string | null; linkKey: unknown }): string | null {
  if (!s.postId.startsWith("ext:")) return null;
  const source = s.postId.slice(4);
  const fromRow = s.linkUrl ? normalizeLink(s.linkUrl) : null;
  if (fromRow) return fromRow.url;
  if (typeof s.linkKey !== "string") return null;
  const made = source === "youtube" ? normalizeLink(`youtu.be/${s.linkKey}`) : null;
  return made && made.key === s.linkKey ? made.url : null;
}

export async function importHealth(db: Db, userId: string, now: Date): Promise<ImportHealthDto> {
  const since = new Date(now.getTime() - WINDOW_MS).toISOString();
  // Each stage and source's own last PER_LIGHT steps — one window per light, so a busy light never pushes another's
  // history out (final review, 2026-11-05) — and of each detail only what health reads, never the whole of it.
  // A read that failed before its post (`ext:<source>`) is named by its pasted link (audit 2026-11-06, I3): the link
  // row its key names, joined in the same statement.
  const steps = (await db.all(sql`SELECT stage, source, status, summary, code, failure, postId, at, title, linkUrl, linkKey FROM (
      SELECT e.stage AS stage, e.source AS source, e.status AS status, e.summary AS summary,
        json_extract(e.detail, '$.code') AS code, json_extract(e.detail, '$.failure') AS failure,
        e.post_id AS postId, e.at AS at,
        coalesce(p.title, nullif(p.creator_name, ''), nullif(p.creator_handle, '')) AS title,
        l.url AS linkUrl, CASE WHEN e.post_id LIKE 'ext:%' THEN json_extract(e.detail, '$.key') END AS linkKey,
        row_number() OVER (PARTITION BY e.stage, e.source ORDER BY e.at DESC, e.rowid DESC) AS n
      FROM ${importEvents} e LEFT JOIN ${savedPosts} p ON p.id = e.post_id AND p.user_id = e.user_id
        LEFT JOIN saved_links l ON e.post_id LIKE 'ext:%' AND l.user_id = e.user_id AND l.source = substr(e.post_id, 5)
          AND l.source_key = json_extract(e.detail, '$.key')
      WHERE e.user_id = ${userId} AND e.at >= ${since}
        AND e.stage IN ('read', 'screen', 'extract', 'check', 'match', 'coach') AND e.status IN ('ok', 'warn', 'fail'))
    WHERE n <= ${PER_LIGHT} ORDER BY at DESC`)) as Array<{
    stage: string; source: string; status: string; summary: string; code: string | null; failure: string | null;
    postId: string; at: string; title: string | null; linkUrl: string | null; linkKey: unknown;
  }>;
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
      .map((s) => {
        const link = linkOf(s);
        return { postId: s.postId.startsWith("ext:") ? null : s.postId, title: s.title ?? link ?? LABEL[light], at: s.at, why: s.summary, retryLink: link };
      });
    const staleChecks = light === "instagram" && lastCheck && now.getTime() - Date.parse(lastCheck.startedAt) > STALE_CHECK_MS;
    if (list.length === 0) {
      return staleChecks
        ? { light, color: "yellow", line: "Instagram: no check in 2 days", failures }
        : { light, color: "grey", line: null, failures };
    }
    // The Reader's attempts are its readings (extract steps); each reading's check rides along — warns and fails in the
    // recent window, but never a second attempt in the ratio (review, 2026-11-06: two steps a reading halved it).
    const isAttempt = (s: (typeof list)[number]) => light !== "reader" || s.stage === "extract";
    const attempts = list.filter(isAttempt);
    const newest = attempts[0] ?? list[0]!;
    const failed = Math.min(list.filter((s) => s.status === "fail").length, Math.max(attempts.length, 1));
    if (newest.status === "fail" && stageWide(newest)) return { light, color: "red", line: newest.summary, failures };
    if (attempts.length >= 4 && failed * 2 >= attempts.length) return { light, color: "red", line: `${LABEL[light]}: ${failed} of ${attempts.length} failed`, failures };
    const recent: typeof list = [];
    let seen = 0;
    // Newest first, a reading's check before its call: up to and including the fifth attempt.
    for (const s of list) {
      recent.push(s);
      if (isAttempt(s) && ++seen === RECENT) break;
    }
    const troubled = recent.find((s) => s.status === "fail" || s.status === "warn");
    if (troubled) return { light, color: "yellow", line: troubled.summary, failures };
    if (staleChecks) return { light, color: "yellow", line: "Instagram: no check in 2 days", failures };
    return { light, color: "green", line: null, failures };
  });

  const rank: Record<HealthColor, number> = { red: 2, yellow: 1, green: 0, grey: 0 };
  const worst = lights.reduce<HealthLightDto | null>((w, l) => (rank[l.color] > (w ? rank[w.color] : 0) ? l : w), null);
  return { lights, worst: worst?.line ?? null };
}
