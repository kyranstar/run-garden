/**
 * TEMPLATES AND QUICK STARTS, PURE (Stage 2 spec §9). What the templates list and the home's quick starts decide that
 * needs no React:
 *
 *   sortTemplates   the list's order: pinned first, then the most recently used, then by name — the server's own
 *                   order, kept by the page as a pin or a rename changes a row in place.
 *   templateFacts   a row's line: minutes, the kind of workout, when last used — the minutes and kind the server's
 *                   (`templateShape`), as the home's tile says them.
 *   quickTiles      the home's quick starts: the built-in ones on offer (condition care only while a profile with care
 *                   content is on), then the athlete's pinned templates — each a link to the builder, pre-filled.
 *   quickStartFor   a quick start for the day, built on the device (no network, no AI) with everything the builder
 *                   judges with, seeded by the date: the same tile gives the same workout all day, another the next.
 */
import { deriveDoc, quickStartDoc, type QuickStart, type QuickStartKind } from "@rg/workout";
import { EXERCISES, type CheckReading } from "@rg/exercise-library";
import type { TemplateDto } from "@rg/api-client";
import { CATEGORY_LABELS, formatShortDate, localTodayGuess } from "../../components.js";
import { addTargetHref } from "./add-model.js";
import { buildCtxOf, suggestCtxOf } from "./build-model.js";
import { quickStarts, type StudioCtx } from "./model.js";

/** The templates list (spec §2). */
export const TEMPLATES_HREF = "/studio/templates";

/** The builder, pre-filled with a quick start. */
export const quickHref = (kind: QuickStartKind): string => `/studio/build/quick/${kind}`;

/** The builder on a template. */
export const templateHref = (id: string): string => addTargetHref({ kind: "template", id });

/** What the templates list asks the builder to do once it is open: its Start, or its Schedule… */
export interface BuilderArrival {
  /**
   * Where the builder was opened from, so its way back goes there: the templates list, Plan or Today (a planned
   * workout's Edit in Studio), or a Studio search or move (`href`: Add → Open on the line it left).
   */
  from?: "templates" | "plan" | "today" | { href: string };
  then?: "start" | "schedule";
}

/** The builder's way back: to where it was opened from, else the Studio. */
export function builderBack(from: BuilderArrival["from"]): { href: string; label: string } {
  if (from === "templates") return { href: TEMPLATES_HREF, label: "Templates" };
  if (from === "plan") return { href: "/plan", label: "Plan" };
  if (from === "today") return { href: "/", label: "Today" };
  // Only a Studio address is a way back from the Studio (the history state is the page's own, but never trusted far).
  if (typeof from === "object" && from && /^\/studio(?:[/?]|$)/.test(from.href)) return { href: from.href, label: "Studio" };
  return { href: "/studio", label: "Studio" };
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

/**
 * A template's minutes and kind: the server's (derived from its document there), so the list and the home's tile say
 * the same. Worked out here only for a row the server said nothing of but whose document reads; with no document,
 * nothing.
 */
export function templateShape(t: TemplateDto): { minutes: number | null; discipline: string | null } {
  if (t.minutes !== null && t.discipline !== null) return { minutes: t.minutes, discipline: t.discipline };
  const d = t.doc ? deriveDoc(t.doc, EXERCISES) : null;
  return { minutes: t.minutes ?? d?.estimatedMinutes ?? null, discipline: t.discipline ?? d?.discipline ?? null };
}

/** A row's facts: "34 min", "Strength", "Used 3 days ago". A template whose document no longer reads says so. */
export function templateFacts(t: TemplateDto, today: string): string[] {
  if (!t.doc) return ["Can't be opened"];
  const { minutes, discipline } = templateShape(t);
  // The app's one word for a kind — the builder's summary says the same (`CATEGORY_LABELS`).
  const kind = discipline ? (CATEGORY_LABELS[discipline] ?? null) : null;
  return [minutes !== null ? `${minutes} min` : null, kind, lastUsedText(t.lastUsedAt, today)].filter((x): x is string => !!x);
}

// ── Quick starts ────────────────────────────────────────────────────────────

export interface QuickTile {
  key: string;
  title: string;
  /** Null when it is not known (a template whose document no longer reads is never a tile). */
  minutes: number | null;
  href: string;
}

/**
 * The home's quick starts: the built-in ones on offer, then the athlete's pinned templates that can be opened. A
 * built-in tile says the minutes of the very workout it opens today (`quickStartFor`) — what the builder, then Today and
 * Plan, say of it — never a nominal length.
 */
export function quickTiles(ctx: StudioCtx, templates: readonly TemplateDto[] = []): QuickTile[] {
  const own = sortTemplates(templates.filter((t) => t.pinned && t.doc !== null));
  const minutesOf = (kind: QuickStartKind): number | null => {
    const made = quickStartFor(kind, ctx, ctx.today ?? localTodayGuess());
    return "doc" in made ? deriveDoc(made.doc, EXERCISES).estimatedMinutes : null;
  };
  return [
    ...quickStarts(ctx).map((q) => ({ key: q.kind, title: q.title, minutes: minutesOf(q.kind), href: quickHref(q.kind) })),
    ...own.map((t) => ({ key: `template:${t.id}`, title: t.name, minutes: templateShape(t).minutes, href: templateHref(t.id) })),
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
