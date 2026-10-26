import type { SavePostStatus, SavesStatusDto } from "@rg/saves";

// The popup's view of the import, as plain data: pure, so it is tested without a browser. The headline is the
// pipeline's health (the app's state); one post's trouble shows on that post's row, never in the headline.

export type PopupAction = "check_now" | "process_anyway" | "retry" | "options";

/** What the background reports while the app URL or token is not saved: the popup then points to Options. */
export const NOT_CONFIGURED = "Set the app URL and token in Options";

/** A link only to an https page; anything else (javascript:, data:, http:) is plain text. */
export function safeHref(url: string): string | null {
  return url.startsWith("https://") ? url : null;
}

/** A post key as the app's routes take it: 1 to 64 characters of the shortcode alphabet. */
export function isPostKey(key: unknown): key is string {
  return typeof key === "string" && /^[A-Za-z0-9_-]{1,64}$/.test(key);
}

export interface PopupPost {
  id: string;
  key: string;
  url: string;
  creator: string;
  status: string;
  reason: string | null;
  actions: PopupAction[];
}

export interface PopupCheck {
  when: string;
  counts: string;
  error: string | null;
}

export interface PopupModel {
  headline: string;
  /** A check is running: the headline says so, Check now waits, and the popup re-reads the status while it lasts. */
  checking: boolean;
  /** Why the status could not be read (the app error), else "". */
  detail: string;
  lastCheck: string;
  nextCheck: string;
  /** "3 waiting" while calls to the app wait in the local queue, else "". */
  queue: string;
  totals: string;
  checks: PopupCheck[];
  posts: PopupPost[];
  spend: string;
  actions: PopupAction[];
}

export interface PopupInput {
  status: SavesStatusDto | null;
  appError: string | null;
  queueSize: number;
  nextCheckAt: number | null;
  now: number;
  /** The background's word that a check is running in it right now (absent from an older background). */
  checking?: boolean;
}

/** A check that started but has not finished is running — for this long; after it, it died with its worker. */
const CHECK_RUNNING_MAX_MS = 2 * 3_600_000;

/** Is a check in progress — by the background's word, or the newest check row still open and recent enough? */
export function isChecking(input: PopupInput): boolean {
  if (input.checking) return true;
  const newest = input.status?.checks[0];
  if (!newest || newest.finishedAt !== null) return false;
  const started = Date.parse(newest.startedAt);
  return !Number.isNaN(started) && input.now - started < CHECK_RUNNING_MAX_MS;
}

export const CHECKING = "Checking…";

const HEADLINES: Record<Exclude<SavesStatusDto["state"], "error">, string> = {
  ok: "Up to date",
  // Before any check has run: nothing is up to date yet (verbatim audit gap 10; an added state — the six keep their copy).
  idle: "No check yet",
  login_needed: "Instagram wants you to log in again",
  feed_changed: "Instagram changed something — the extension needs an update",
  paused_budget: "Paused — import budget",
};

/** The checks the popup lists (spec §8: the last 10, each with its filtered count). */
const MAX_CHECKS = 10;
const MAX_POSTS = 8;
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

function span(ms: number): string {
  if (ms < HOUR) return `${Math.max(1, Math.round(ms / MINUTE))} min`;
  if (ms < DAY) return `${Math.round(ms / HOUR)} h`;
  return `${Math.round(ms / DAY)} d`;
}

/** "2 h ago", or "just now" within a minute. */
export function ago(iso: string | null, now: number): string {
  if (!iso) return "never";
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return "never";
  const d = now - t;
  return d < MINUTE ? "just now" : `${span(d)} ago`;
}

function until(at: number | null, now: number): string {
  if (at === null) return "—";
  const d = at - now;
  return d < MINUTE ? "soon" : `in ${span(d)}`;
}

const dollars = (micros: number): string => `$${(micros / 1_000_000).toFixed(2)}`;

function postActions(status: SavePostStatus): PopupAction[] {
  return status === "filtered_out" ? ["process_anyway"] : status === "failed" ? ["retry"] : [];
}

function headlineOf(input: PopupInput): string {
  const { status } = input;
  if (!status) return "App unreachable";
  if (isChecking(input)) return CHECKING;
  if (status.state !== "error") return HEADLINES[status.state];
  return `Error: ${input.appError ?? status.checks[0]?.errorCode ?? "the last check failed"}`;
}

export function popupModel(input: PopupInput): PopupModel {
  const { status, now } = input;
  const checking = isChecking(input);
  const posts: PopupPost[] = (status?.posts ?? [])
    .map((p) => ({
      id: p.id,
      key: p.key,
      url: p.url,
      creator: p.creator.name ?? p.creator.handle,
      status: p.status.replace(/_/g, " "),
      reason: p.reason,
      actions: postActions(p.status),
    }))
    // Posts that want a hand first; the rest keep the app's order (newest first).
    .sort((a, b) => Number(b.actions.length > 0) - Number(a.actions.length > 0))
    .slice(0, MAX_POSTS);

  const offered = new Set(posts.flatMap((p) => p.actions));
  const actions: PopupAction[] = status ? ["check_now"] : [input.appError === NOT_CONFIGURED ? "options" : "retry"];
  for (const a of ["process_anyway", "retry"] as const) if (offered.has(a) && !actions.includes(a)) actions.push(a);

  return {
    headline: headlineOf(input),
    detail: status ? "" : (input.appError ?? ""),
    lastCheck: ago(status?.lastCheckAt ?? null, now),
    nextCheck: until(input.nextCheckAt, now),
    queue: input.queueSize > 0 ? `${input.queueSize} waiting` : "",
    totals: status ? `${status.totals.moves} moves from ${status.totals.posts} posts` : "",
    checking,
    checks: (status?.checks ?? []).slice(0, MAX_CHECKS).map((c, i) => ({
      when: ago(c.startedAt, now),
      counts:
        c.finishedAt !== null
          ? `${c.found} found · ${c.fresh} new · ${c.filtered} filtered · ${c.extracted} extracted · ${c.failed} failed`
          : i === 0 && checking
            ? "in progress"
            : "did not finish",
      error: c.errorCode,
    })),
    posts,
    spend: status ? `${dollars(status.spend.spentMicros)} of ${dollars(status.spend.capMicros)} this month` : "",
    actions,
  };
}
