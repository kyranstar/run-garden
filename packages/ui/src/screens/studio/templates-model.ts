/**
 * TEMPLATES AND QUICK STARTS, PURE (Stage 2 spec §9). What the templates list and the home's quick starts decide that
 * needs no React:
 *
 *   sortTemplates   the list's order: pinned first, then the most recently used, then by name — the server's own
 *                   order, kept by the page as a pin or a rename changes a row in place.
 *   templateFacts   a row's line: minutes, the kind of workout (the builder summary's word for it), when last used.
 *   quickTiles      the home's quick starts: the built-in ones on offer (condition care only while a profile with care
 *                   content is on), then the athlete's pinned templates — each a link to the builder, pre-filled.
 *   quickStartFor   a quick start for the day, built on the device (no network, no AI) with everything the builder
 *                   judges with, seeded by the date: the same tile gives the same workout all day, another the next.
 *   quickKindOf     a quick start's address back to its kind.
 */
import { deriveDoc, QUICK_START_KINDS, quickStartDoc, type QuickStart, type QuickStartKind } from "@rg/workout";
import { EXERCISES, type CheckReading } from "@rg/exercise-library";
import type { TemplateDto } from "@rg/api-client";
import { CATEGORY_LABELS, formatShortDate } from "../../components.js";
import { addTargetHref } from "./add-model.js";
import { buildCtxOf, suggestCtxOf } from "./build-model.js";
import { quickStarts, type StudioCtx } from "./model.js";

/** The templates list (spec §2). */
export const TEMPLATES_HREF = "/studio/templates";

/** The builder, pre-filled with a quick start. */
export const quickHref = (kind: QuickStartKind): string => `/studio/build/quick/${kind}`;

/** The builder on a template. */
export const templateHref = (id: string): string => addTargetHref({ kind: "template", id });

/** A quick start's kind from its address; null for anything else. */
export function quickKindOf(s: string): QuickStartKind | null {
  return QUICK_START_KINDS.find((k) => k === s) ?? null;
}

/** What the templates list asks the builder to do once it is open: its Start, or its Schedule… */
export interface BuilderArrival {
  /** Came from the templates list: the builder's way back goes there. */
  from?: "templates";
  then?: "start" | "schedule";
}

// ── The list ────────────────────────────────────────────────────────────────

/** Pinned first, then the most recently used (never used last), then by name. */
export function sortTemplates(list: readonly TemplateDto[]): TemplateDto[] {
  return [...list].sort(
    (a, b) =>
      Number(b.pinned) - Number(a.pinned) ||
      (b.lastUsedAt ?? "").localeCompare(a.lastUsedAt ?? "") ||
      a.name.localeCompare(b.name) ||
      a.id.localeCompare(b.id),
  );
}

/** The device's calendar date of an instant. */
function localDateOf(iso: string): string | null {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

const DAY_MS = 86_400_000;

/** "Used today", "Used yesterday", "Used 3 days ago", "Used Aug 2" — or "Not used yet". */
export function lastUsedText(iso: string | null, today: string): string {
  const day = iso ? localDateOf(iso) : null;
  if (!day) return "Not used yet";
  const days = Math.round((Date.parse(today) - Date.parse(day)) / DAY_MS);
  if (days <= 0) return "Used today";
  if (days === 1) return "Used yesterday";
  if (days < 60) return `Used ${days} days ago`;
  return `Used ${formatShortDate(day)}`;
}

/** A row's facts: "34 min", "Strength", "Used 3 days ago". A template whose document no longer reads says so. */
export function templateFacts(t: TemplateDto, today: string): string[] {
  if (!t.doc) return ["Can't be opened"];
  const d = deriveDoc(t.doc, EXERCISES);
  return [`${d.estimatedMinutes} min`, CATEGORY_LABELS[d.category] ?? null, lastUsedText(t.lastUsedAt, today)].filter((x): x is string => !!x);
}

// ── Quick starts ────────────────────────────────────────────────────────────

export interface QuickTile {
  key: string;
  title: string;
  /** Null when it is not known (a template whose document no longer reads is never a tile). */
  minutes: number | null;
  href: string;
}

/** The home's quick starts: the built-in ones on offer, then the athlete's pinned templates that can be opened. */
export function quickTiles(ctx: StudioCtx, templates: readonly TemplateDto[] = []): QuickTile[] {
  const own = sortTemplates(templates.filter((t) => t.pinned && t.doc !== null));
  return [
    ...quickStarts(ctx).map((q) => ({ key: q.kind, title: q.title, minutes: q.minutes, href: quickHref(q.kind) })),
    ...own.map((t) => ({ key: `template:${t.id}`, title: t.name, minutes: t.minutes, href: templateHref(t.id) })),
  ];
}

/** The day as a seed: one workout per tile a day, another the next. */
export const daySeed = (date: string): number => Number(date.replace(/-/g, "")) || 0;

/**
 * A quick start for the day: `quickStartDoc` with today's readings (and any this page recorded), the place's gear, the
 * athlete's set-aside, pinned and recent moves — what the builder judges with — and the day's seed.
 */
export function quickStartFor(
  kind: QuickStartKind,
  ctx: StudioCtx,
  today: string,
  recorded: Readonly<Record<string, CheckReading>> = {},
): QuickStart {
  return quickStartDoc(kind, EXERCISES, { ...suggestCtxOf(buildCtxOf(ctx, today, recorded), today), seed: daySeed(today) });
}
