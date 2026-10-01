/**
 * The parity harness (Phase 0 Task 12; spec §13.3): what a staging rehearsal
 * compares before and after a migration — per-table hashes, the garden after
 * a resimulation, the calendar's fingerprints and suppressions, and watch
 * write-job counts.
 *
 * Every answer is a hash, a count or a date — never a row. A rehearsal's
 * output ends up in notes and chats; a title, a note, an email or a token
 * must never ride along. Rows are ordered by primary key and hashed over
 * canonical JSON (Ruling R2), with the registry's own helpers, so a hash
 * taken here and one taken by the copier agree on the same rows.
 */
import { and, count, eq, gte } from "drizzle-orm";
import { calendarEventLinks, calendarEventSuppressions, corosWriteJobs, gardenEvents, gardenState } from "@rg/database";
import type { LocalDate, UserPreferences } from "@rg/domain";
import { sha256Hex } from "../auth/crypto.js";
import { ACCOUNT_TABLES, canonicalJson, hashRows, hashTable, orderedRows, secretColumns } from "./account-tables.js";
import { isRestoring, loadAccountState } from "./account-state.js";
import { loadGarden, resimulateFrom } from "./garden-sync.js";
import type { Db } from "./db.js";

/** A request the harness will not carry out (the route answers 409). */
export class ParityRefused extends Error {
  constructor(readonly code: "restore_in_progress" | "garden_catch_up_pending") {
    super(code);
    this.name = "ParityRefused";
  }
}

export interface TableHash {
  rows: number;
  sha256: string;
}

/**
 * Write stamps that a garden walk rewrites without changing what the row
 * says. A resimulation (the runbook's `resim: true`) re-derives every day
 * input, event, checkpoint and the state row, stamping each with the moment
 * it ran — so two recordings of one unchanged garden differed in exactly
 * these columns (Audit 2 I1). They are hashed as null, as `gardenHash`
 * already did for events. Only write stamps belong here, never content.
 */
export const PARITY_VOLATILE_COLUMNS: Readonly<Record<string, readonly string[]>> = {
  garden_state: ["updated_at"],
  garden_events: ["created_at"],
  garden_snapshots: ["created_at"],
  garden_day_inputs: ["updated_at"],
};

/**
 * One hash per table this account owns (every registry table but the
 * excluded ones), over the account's rows in primary-key order. Credential
 * columns are hashed as null: a staging copy never carries them, and a
 * production hash must match a scrubbed copy of the same rows. So are the
 * garden's write stamps (`PARITY_VOLATILE_COLUMNS`).
 */
export async function tableHashes(db: Db, userId: string): Promise<Record<string, TableHash>> {
  const out: Record<string, TableHash> = {};
  for (const t of ACCOUNT_TABLES) {
    if (t.scope.kind === "excluded") continue;
    const mask = [...secretColumns(t.name), ...(PARITY_VOLATILE_COLUMNS[t.name] ?? [])];
    out[t.name] = await hashTable(db, t.table, { userId, mask });
  }
  return out;
}

export interface GardenHash {
  /** sha-256 of the stored garden snapshot's canonical JSON. */
  snapshot: string;
  /** sha-256 of the event stream, in key order, without write stamps. */
  events: string;
  eventRows: number;
  lastSimulatedDate: string | null;
  /** True when the resim stopped early (a pending version upgrade walks in
   * capped steps): hash again once it has caught up. */
  resimPending: boolean;
}

/**
 * The garden's hashes, optionally after a resimulation from `from` (default:
 * the garden's genesis, i.e. a full replay).
 *
 * The resim goes through the ORDINARY path (`resimulateFrom`): restart from
 * the checkpoint before `from`, re-derive day inputs from the live tables,
 * walk to today, persist. It never takes the post-restore catch-up path —
 * a garden a restore is replacing, or still catching up, is refused. The
 * route only lets staging resimulate; production can only hash what it has.
 *
 * Event write stamps (`created_at`) are hashed as null: they record when a
 * walk wrote the row, which every resim changes, not what the garden is.
 */
export async function gardenHash(
  db: Db,
  userId: string,
  prefs: UserPreferences,
  opts: { resim: boolean; from?: LocalDate; now?: Date },
): Promise<GardenHash> {
  let resimPending = false;
  if (opts.resim) {
    const account = await loadAccountState(db, userId);
    if (isRestoring(account)) throw new ParityRefused("restore_in_progress");
    if (account?.gardenCatchUpPending) throw new ParityRefused("garden_catch_up_pending");
    const garden = await loadGarden(db, userId);
    if (garden) {
      const result = await resimulateFrom(db, userId, opts.from ?? garden.state.createdDate, prefs, opts.now ?? new Date());
      resimPending = result.resimPending === true;
    }
  }
  const [state] = await db
    .select({ snapshot: gardenState.snapshot, lastSimulatedDate: gardenState.lastSimulatedDate })
    .from(gardenState)
    .where(eq(gardenState.userId, userId))
    .limit(1);
  const events = await hashTable(db, gardenEvents, { userId, mask: PARITY_VOLATILE_COLUMNS.garden_events });
  return {
    snapshot: await sha256Hex(canonicalJson(state?.snapshot ?? null)),
    events: events.sha256,
    eventRows: events.rows,
    lastSimulatedDate: state?.lastSimulatedDate ?? null,
    resimPending,
  };
}

export interface CalendarHash {
  /** Every link's identity, state, fingerprint and preserved notes. */
  links: string;
  suppressions: string;
  linkRows: number;
  suppressionRows: number;
}

/**
 * The calendar as this account's links and suppressions say it is. Links are
 * hashed on what they assert — which event, its state, the fingerprint last
 * written, the athlete's preserved notes — not on when a sync last touched
 * them; suppressions are immutable rows and are hashed whole.
 */
export async function calendarHash(db: Db, userId: string): Promise<CalendarHash> {
  const links = (await orderedRows(db, calendarEventLinks, { userId })).map((r) => ({
    id: r.id,
    workoutId: r.workoutId,
    calendarId: r.calendarId,
    eventId: r.eventId,
    state: r.state,
    lastWrittenFingerprint: r.lastWrittenFingerprint,
    userNotes: r.userNotes,
  }));
  const suppressions = await orderedRows(db, calendarEventSuppressions, { userId });
  return {
    links: await hashRows(links),
    suppressions: await hashRows(suppressions),
    linkRows: links.length,
    suppressionRows: suppressions.length,
  };
}

/** This account's watch write jobs requested at or after `sinceIso`, counted
 * by `"<kind>:<status>"` (keys sorted). */
export async function jobCounts(db: Db, userId: string, sinceIso: string): Promise<Record<string, number>> {
  const rows = await db
    .select({ kind: corosWriteJobs.kind, status: corosWriteJobs.status, n: count() })
    .from(corosWriteJobs)
    .where(and(eq(corosWriteJobs.userId, userId), gte(corosWriteJobs.requestedAt, sinceIso)))
    .groupBy(corosWriteJobs.kind, corosWriteJobs.status);
  const entries = rows.map((r) => [`${r.kind}:${r.status}`, Number(r.n)] as const);
  entries.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return Object.fromEntries(entries);
}
