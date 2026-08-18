/**
 * WHAT TO DO ABOUT IT — the rule set, stated as the athlete would ask it.
 *
 * Two properties carry this file, and neither is about copy:
 *
 *  1. NO INVENTED CONTROL. `control` is what makes a surface render a button,
 *     and this app has already shipped a "Retry" that enqueued nothing and left
 *     an unclearable badge. So `control: "retry"` may only appear where the
 *     retry route really does enqueue work — a DATE divergence — and never on a
 *     content divergence, where it would queue a move to the day the session is
 *     already on.
 *  2. SILENCE IS A STATE. A synced session, and a session whose day has gone,
 *     produce `null` — the DTO omits the field and every surface renders what it
 *     rendered before any of this existed.
 */
import { describe, expect, it } from "vitest";
import { syncAction, type SyncActionCode, type SyncSituation } from "../src/sync-action.js";
import type { WatchCoverageView } from "../src/watch-coverage.js";

const ok: SyncSituation = {
  view: "synced",
  connected: true,
  writesEnabled: true,
  write: "none",
  settled: false,
};

const coverage = (v: Partial<WatchCoverageView>): WatchCoverageView => ({
  coverage: "none",
  discipline: "run",
  gaps: [],
  ...v,
});

describe("a session with nothing wrong asks nothing of anyone", () => {
  it("is silent when COROS has it, on the day, as written", () => {
    expect(syncAction(ok)).toBeNull();
  });

  it("is silent about a session whose day has gone, whatever else is true", () => {
    // Its watch copy is history — the same rule the convergence backfill uses
    // when it picks rows. Nothing is going to be sent, so nothing is asked.
    for (const view of ["content_stale", "calendar_only", "sync_issue"] as const) {
      expect(syncAction({ ...ok, view, settled: true, write: "failed" })).toBeNull();
    }
  });
});

describe("the app is doing it — a receipt, not a warning", () => {
  it("says it is sending while a write is in flight", () => {
    expect(syncAction({ ...ok, view: "syncing", write: "sending" })).toEqual({
      agent: "app",
      code: "sending",
    });
  });

  it("tells the truth when the watch is LOSING a session, not gaining one", () => {
    // An ease into something the wire cannot hold queues a delete. "Sending" is
    // the reassuring lie here: the session is coming off the watch.
    expect(syncAction({ ...ok, view: "syncing", write: "unpushing" })).toEqual({
      agent: "app",
      code: "removing_from_watch",
    });
  });

  it("owns the pace targets it has not learned yet", () => {
    expect(
      syncAction({
        ...ok,
        coverage: coverage({
          coverage: "partial",
          gaps: [{ code: "pace_targets_owed", count: 3 }],
        }),
      }),
    ).toEqual({ agent: "app", code: "pace_targets_pending", count: 3 });
  });

  it("says nothing at all about the gaps that cross anyway", () => {
    // A mobility session filed under Strength, and per-side cues that ride as
    // text: both real, both disclosed by the coverage note, and neither is
    // anybody's to fix. A second "nothing to do about it" underneath is the
    // duplicate telling this layer exists to remove.
    for (const code of ["filed_as_strength", "cues_ride_as_text"] as const) {
      expect(
        syncAction({ ...ok, coverage: coverage({ coverage: "partial", gaps: [{ code }] }) }),
      ).toBeNull();
    }
  });
});

describe("the athlete has to do one thing", () => {
  it("asks for the connection back when something is waiting on it", () => {
    expect(syncAction({ ...ok, view: "waiting_for_device", write: "sending", connected: false })).toEqual({
      agent: "athlete",
      code: "connect_coros",
      control: "settings",
    });
  });

  it("does NOT ask for the connection when nothing is waiting to cross", () => {
    // Synced, with pace targets still owed: the session is on the watch. An
    // action about the connection here is noise about a session that is fine.
    expect(
      syncAction({
        ...ok,
        connected: false,
        coverage: coverage({ coverage: "partial", gaps: [{ code: "pace_targets_owed", count: 1 }] }),
      }),
    ).toEqual({ agent: "app", code: "pace_targets_pending", count: 1 });
  });

  it("asks for writes to be turned on, without promising this session goes", () => {
    expect(syncAction({ ...ok, view: "calendar_only", writesEnabled: false })).toEqual({
      agent: "athlete",
      code: "enable_coros_writes",
      control: "settings",
    });
  });

  it("offers the retry control on a DATE divergence, which is what it acts on", () => {
    for (const view of ["calendar_only", "sync_issue"] as const) {
      expect(syncAction({ ...ok, view })).toEqual({
        agent: "athlete",
        code: "retry_write",
        control: "retry",
      });
    }
  });

  it("NEVER offers it on a content divergence — that retry enqueues nothing", () => {
    // The route re-arms the MOVE lane for the row. A content-stale session is
    // already on the day it belongs on, so the press would queue a move to
    // where it already is: a button whose press does nothing, which is the bug
    // that left an unclearable badge the last time.
    for (const write of ["none", "failed"] as const) {
      const a = syncAction({ ...ok, view: "content_stale", write });
      expect(a).toEqual({ agent: "nobody", code: "watch_keeps_old_copy" });
      expect(a?.control).toBeUndefined();
    }
  });

  it("hands a date disagreement back to the person who knows", () => {
    expect(syncAction({ ...ok, view: "needs_attention" })).toEqual({
      agent: "athlete",
      code: "choose_a_date",
    });
  });

  it("names the movements the COROS library lacks — the one thing that changes it", () => {
    expect(
      syncAction({
        ...ok,
        view: "calendar_only",
        coverage: coverage({ discipline: "lift", gaps: [{ code: "off_catalog", names: ["Nordic curl"] }] }),
      }),
    ).toEqual({ agent: "athlete", code: "name_it_on_the_watch", names: ["Nordic curl"] });
  });

  it("asks for timed steps when the session is measured in distance", () => {
    expect(
      syncAction({ ...ok, view: "calendar_only", coverage: coverage({ gaps: [{ code: "distance_target" }] }) }),
    ).toEqual({ agent: "athlete", code: "make_it_measurable" });
  });
});

describe("nothing can be done, and that is the answer", () => {
  it("says so plainly when there is no structure to send", () => {
    expect(
      syncAction({ ...ok, view: "calendar_only", coverage: coverage({ gaps: [{ code: "empty_body" }] }) }),
    ).toEqual({ agent: "nobody", code: "lives_here" });
  });

  it("puts the wire's own limit ahead of every control that cannot change it", () => {
    // Disconnected, writes off, a failed job — none of it matters for a session
    // the wire will not carry, and offering Settings here would send someone to
    // fix something that fixes nothing.
    expect(
      syncAction({
        ...ok,
        view: "sync_issue",
        connected: false,
        writesEnabled: false,
        write: "failed",
        coverage: coverage({ gaps: [{ code: "distance_target" }] }),
      }),
    ).toEqual({ agent: "athlete", code: "make_it_measurable" });
  });
});

describe("the agents partition the vocabulary", () => {
  it("gives every code exactly one agent, and a control only to the athlete", () => {
    const situations: SyncSituation[] = [
      { ...ok, view: "syncing", write: "sending" },
      { ...ok, view: "syncing", write: "unpushing" },
      { ...ok, coverage: coverage({ coverage: "partial", gaps: [{ code: "pace_targets_owed", count: 1 }] }) },
      { ...ok, view: "waiting_for_device", write: "sending", connected: false },
      { ...ok, view: "calendar_only", writesEnabled: false },
      { ...ok, view: "calendar_only" },
      { ...ok, view: "needs_attention" },
      { ...ok, view: "calendar_only", coverage: coverage({ gaps: [{ code: "distance_target" }] }) },
      {
        ...ok,
        view: "calendar_only",
        coverage: coverage({ discipline: "lift", gaps: [{ code: "off_catalog", names: ["X"] }] }),
      },
      { ...ok, view: "calendar_only", coverage: coverage({ gaps: [{ code: "empty_body" }] }) },
      { ...ok, view: "content_stale" },
    ];
    const seen = new Map<SyncActionCode, string>();
    for (const s of situations) {
      const a = syncAction(s);
      expect(a, `no action for ${JSON.stringify(s.view)}`).not.toBeNull();
      const prior = seen.get(a!.code);
      if (prior) expect(prior, `${a!.code} has two agents`).toBe(a!.agent);
      seen.set(a!.code, a!.agent);
      if (a!.control) expect(a!.agent, `${a!.code} offers a control to nobody`).toBe("athlete");
    }
    // Every code the type advertises is produced by a real situation — a code
    // nothing can reach is copy for a state that does not exist.
    const CODES: SyncActionCode[] = [
      "sending",
      "removing_from_watch",
      "pace_targets_pending",
      "connect_coros",
      "enable_coros_writes",
      "retry_write",
      "choose_a_date",
      "make_it_measurable",
      "name_it_on_the_watch",
      "lives_here",
      "watch_keeps_old_copy",
    ];
    expect([...seen.keys()].sort()).toEqual([...CODES].sort());
  });
});
