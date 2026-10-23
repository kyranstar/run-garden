import type { SavePostStatus, SavesStatusDto } from "@rg/saves";

// The popup's view of the import, as plain data: pure, so it is tested without a browser. The headline is the
// pipeline's health (the app's state); one post's trouble shows on that post's row, never in the headline.

export type PopupAction = "check_now" | "process_anyway" | "retry";

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
}

const HEADLINES: Record<Exclude<SavesStatusDto["state"], "error">, string> = {
  ok: "Up to date",
  idle: "Up to date",
  login_needed: "Instagram wants you to log in again",
  feed_changed: "Instagram changed something — the extension needs an update",
  paused_budget: "Paused — import budget",
};

const MAX_CHECKS = 3;
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
  if (status.state !== "error") return HEADLINES[status.state];
  return `Error: ${input.appError ?? status.checks[0]?.errorCode ?? "the last check failed"}`;
}

export function popupModel(input: PopupInput): PopupModel {
  const { status, now } = input;
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
  const actions: PopupAction[] = status ? ["check_now"] : ["retry"];
  for (const a of ["process_anyway", "retry"] as const) if (offered.has(a) && !actions.includes(a)) actions.push(a);

  return {
    headline: headlineOf(input),
    lastCheck: ago(status?.lastCheckAt ?? null, now),
    nextCheck: until(input.nextCheckAt, now),
    queue: input.queueSize > 0 ? `${input.queueSize} waiting` : "",
    totals: status ? `${status.totals.moves} moves from ${status.totals.posts} posts` : "",
    checks: (status?.checks ?? []).slice(0, MAX_CHECKS).map((c) => ({
      when: ago(c.startedAt, now),
      counts: `${c.found} found · ${c.fresh} new · ${c.extracted} extracted · ${c.failed} failed`,
      error: c.errorCode,
    })),
    posts,
    spend: status ? `${dollars(status.spend.spentMicros)} of ${dollars(status.spend.capMicros)} this month` : "",
    actions,
  };
}
