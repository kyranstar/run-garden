/**
 * Coach panel presentational suite: ONE timeline (messages, receipts and
 * proposals in the order they happened), the manifest every proposal card
 * now renders, the trade-off frame that replaced "breaks a rule", the
 * bottom-anchored scroll, and the pendingByDate ghost derivation (Task B3).
 */
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router-dom";
import { describe, expect, it } from "vitest";
import type { CoachMessageDto, CoachProposalDto } from "@rg/api-client";
import type { PlannedRef } from "@rg/domain";
import {
  buildThread,
  CoachPanel,
  CoachThread,
  opDayLabel,
  pendingByDate,
  ProposalCard,
  proposalDiscipline,
  proposalLines,
  SettledProposalCard,
  settledFromReceipt,
} from "../src/screens/coach-panel.js";

const noop = () => undefined;

function prop(id: string, over: Partial<CoachProposalDto> = {}): CoachProposalDto {
  return {
    id,
    title: `Proposal ${id}`,
    evidence: "slept 5h avg",
    rationale: "Because rest beats a junk tempo.",
    flags: [],
    ops: [{ kind: "skip", workoutId: "w1", reason: "rest" }],
    status: "pending",
    createdAt: "2026-08-06T10:00:00Z",
    expiresAt: "2026-08-08",
    ...over,
  };
}

/** A pending proposal card on its own, the way the thread renders one. */
function card(p: CoachProposalDto, over: Record<string, unknown> = {}): string {
  return render(
    createElement(ProposalCard, { proposal: p, onApprove: noop, onDecline: noop, ...over } as never),
  );
}

function render(el: React.ReactElement): string {
  return renderToStaticMarkup(createElement(MemoryRouter, null, el));
}

const msg = (id: string, over: Partial<CoachMessageDto> = {}): CoachMessageDto => ({
  id,
  role: "coach",
  body: `body ${id}`,
  refs: {},
  at: "2026-08-06T10:00:00Z",
  ...over,
});

// ── 1. What the proposal DOES ──────────────────────────────────────────────

describe("the proposal card renders the manifest, not one word", () => {
  const skiOps = [
    {
      kind: "add",
      date: "2026-08-18",
      dates: ["2026-08-18", "2026-08-21"],
      session: {
        category: "strength",
        title: "Ski legs — holds and eccentrics",
        durationMinutes: 45,
        lift: {
          exercises: [
            { name: "Wall sit", sets: 3, holdSeconds: 45, restSeconds: 90, weight: { type: "bodyweight" } },
          ],
        },
      },
    },
  ];

  it("a one-op skip is one line and offers nothing more to open", () => {
    const planned = new Map<string, PlannedRef>([
      ["w1", { date: "2026-08-23", summary: "Recovery Run" }],
    ]);
    const html = card(prop("a"), { planned });
    expect(html).toContain("Sun 23");
    expect(html).toContain("Recovery Run — skipped");
    // Nothing behind a Sheet: one line, no sessions. The control that would
    // open an empty dialog is not rendered at all.
    expect(html).not.toContain("coach-ops-all");
  });

  it("a multi-date add expands to one line per day, and the whole thing is one tap away", () => {
    const html = card(prop("b", { ops: skiOps }));
    expect(html).toContain("Tue 18");
    expect(html).toContain("Fri 21");
    expect(html).toContain("Ski legs — holds and eccentrics · 45 min");
    // The Sheet trigger appears because there are sessions to show.
    expect(html).toContain("Session by session");
    // …and the exercise list is NOT on the card — it lives in the Sheet.
    expect(html).not.toContain("Wall sit 3×45s");
  });

  it("a long manifest shows a glance and says how much more there is", () => {
    const days = ["2026-08-17", "2026-08-18", "2026-08-19", "2026-08-20", "2026-08-21", "2026-08-22"];
    const ops = days.map((date) => ({
      kind: "add",
      date,
      session: { category: "easy", title: `Run ${date.slice(8)}`, durationMinutes: 30 },
    }));
    const html = card(prop("c", { ops }));
    expect(html).toContain("All 6 changes");
    // Three lines at a glance, not six: a twelve-op plan must not turn one
    // message into a page.
    expect((html.match(/coach-op-summary/g) ?? []).length).toBe(3);
    expect(html).toContain("Run 17");
    expect(html).not.toContain("Run 22");
  });

  it("an ease says what it replaces, on the day it replaces it", () => {
    const planned = new Map<string, PlannedRef>([
      ["w9", { date: "2026-08-18", summary: "6×600m at 10K pace" }],
    ]);
    const lines = proposalLines(
      prop("d", {
        ops: [
          {
            kind: "ease",
            workoutId: "w9",
            session: { category: "easy", title: "Easy 35", durationMinutes: 35 },
          },
        ],
      }),
      planned,
    );
    expect(lines).toHaveLength(1);
    expect(lines[0]!.date).toBe("2026-08-18");
    expect(lines[0]!.change).toBe("6×600m at 10K pace → Easy 35");
  });

  it("never throws on ops it cannot describe — the buttons still render", () => {
    const html = card(prop("e", { ops: [{ kind: "somethingNewNobodyShipped" }] }));
    expect(html).toContain("Make it so");
    expect(html).not.toContain("coach-op-summary");
  });

  it("names the weekday off the ISO string, not through a timezone", () => {
    expect(opDayLabel("2026-08-17")).toBe("Mon 17");
    expect(opDayLabel("2026-08-22")).toBe("Sat 22");
  });
});

// ── 2. The trade-off frame ─────────────────────────────────────────────────

describe("flags read as a trade-off the coach made, never as an accusation", () => {
  it("one flag is one sentence with the coach owning the choice", () => {
    const html = card(prop("a", { flags: ["eases Tuesday's 10K-pace intervals in a build week"] }));
    expect(html).toContain("The trade-off");
    expect(html).toContain("eases Tuesday&#x27;s 10K-pace intervals in a build week");
    // The word the athlete objected to, and the frame that carried it.
    expect(html).not.toContain("breaks a rule");
    expect(html).not.toMatch(/\brule\b/);
  });

  it("several flags are a list under one lede, still no severity vocabulary", () => {
    const html = card(prop("b", { flags: ["moves your Saturday long run", "two hard days back to back"] }));
    expect(html).toContain("The trade-offs");
    expect(html).toContain("moves your Saturday long run");
    expect(html).toContain("two hard days back to back");
    for (const word of ["breaks", "violation", "warning", "severity", "critical"]) {
      expect(html.toLowerCase(), word).not.toContain(word);
    }
  });

  it("no flags, no note", () => {
    expect(card(prop("c"))).not.toContain("coach-prop-tradeoff");
  });
});

// ── 3. Proposals live in the conversation ──────────────────────────────────

describe("buildThread merges messages and proposals into one timeline", () => {
  it("a pending proposal sits at its createdAt, between the messages it belongs to", () => {
    const items = buildThread(
      [
        msg("m1", { at: "2026-08-06T09:00:00Z" }),
        msg("m2", { at: "2026-08-06T11:00:00Z" }),
      ],
      [prop("p1", { createdAt: "2026-08-06T10:00:00Z" })],
    );
    expect(items.map((i) => i.id)).toEqual(["m1", "p1", "m2"]);
    expect(items[1]!.kind).toBe("pending");
  });

  it("a resolved proposal's receipt BECOMES the settled card — never both", () => {
    const items = buildThread(
      [
        msg("r1", {
          role: "receipt",
          body: "✓ approved — Move Saturday's long run",
          refs: { proposalId: "p1" },
          at: "2026-08-06T12:00:00Z",
        }),
      ],
      [],
    );
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({
      kind: "settled",
      mark: { status: "approved", word: "Approved", title: "Move Saturday's long run" },
    });
  });

  it("keeps the manifest — and the real title — of a proposal that resolved while the reader watched", () => {
    const p = prop("p1", {
      title: "Ski-prep leg block",
      ops: [{ kind: "add", date: "2026-08-20", session: { category: "easy", title: "Shakeout", durationMinutes: 20 } }],
    });
    const items = buildThread(
      [msg("r1", { role: "receipt", body: "✓ approved — Proposal p1", refs: { proposalId: "p1" }, at: "2026-08-06T12:00:00Z" })],
      [],
      new Map([["p1", p]]),
    );
    const it0 = items[0]!;
    expect(it0.kind === "settled" && it0.proposal).toBe(p);
    // The proposal's own title beats the one parsed out of the receipt.
    expect(it0.kind === "settled" && it0.mark.title).toBe("Ski-prep leg block");
  });

  it("the receipt wins over a stale pending copy of the same proposal", () => {
    const items = buildThread(
      [msg("r1", { role: "receipt", body: "Expired — the moment passed: Proposal p1", refs: { proposalId: "p1" }, at: "2026-08-07T00:00:00Z" })],
      [prop("p1")],
    );
    expect(items).toHaveLength(1);
    expect(items[0]!.kind === "settled" && items[0]!.mark.status).toBe("expired");
  });

  // The structural fact is `refs.proposalId`, which the worker attaches to
  // those four receipts and to nothing else. Keying the CARD on the regex
  // instead meant a copy edit in another package would silently revert every
  // settled proposal in the thread to a one-line receipt.
  it("still renders a card when the worker's wording is one this build has never seen", () => {
    const body = "Rolled back — the Tuesday reshuffle";
    const items = buildThread(
      [msg("r1", { role: "receipt", body, refs: { proposalId: "p1" }, at: "2026-08-07T00:00:00Z" })],
      [],
    );
    expect(items[0]!.kind).toBe("settled");
    // No word is invented; the worker's own sentence is the line.
    expect(items[0]!.kind === "settled" && items[0]!.mark).toEqual({ title: body });
    const html = render(
      createElement(SettledProposalCard, { mark: { title: body }, proposal: null, domId: "r1" }),
    );
    expect(html).toContain("coach-prop--settled");
    expect(html).toContain(body);
    expect(html).not.toContain("pill");
  });

  it("an ordinary receipt — no proposal ref — is still an ordinary receipt line", () => {
    const items = buildThread(
      [msg("r1", { role: "receipt", body: "Synced to your watch", refs: {}, at: "2026-08-07T00:00:00Z" })],
      [],
    );
    expect(items[0]!.kind).toBe("message");
  });

  it("reads all four outcomes the worker writes, in the DTO's own vocabulary", () => {
    expect(settledFromReceipt("✓ approved — X")).toMatchObject({ status: "approved", title: "X" });
    expect(settledFromReceipt("Left as planned — X")).toMatchObject({ status: "declined", title: "X" });
    expect(settledFromReceipt("Expired — the moment passed: X")).toMatchObject({ status: "expired", title: "X" });
    expect(settledFromReceipt("Superseded: X")).toMatchObject({ status: "superseded", title: "X" });
  });

  it("a settled card is inert: no approve, no decline, no Why?", () => {
    const html = render(
      createElement(SettledProposalCard, {
        mark: { status: "approved", word: "Approved", title: "Move Saturday's long run" },
        proposal: null,
        domId: "r1",
      }),
    );
    expect(html).toContain("coach-prop--settled");
    expect(html).toContain("Approved");
    expect(html).not.toContain("Make it so");
    expect(html).not.toContain("Leave it");
    expect(html).not.toContain("Why?");
  });
});

describe("ProposalCard", () => {
  it("disables Make it so / Leave it while acting, but never Why?", () => {
    const html = card(prop("a"), { acting: true });
    expect(html).toMatch(/Make it so<\/button>/);
    const approveBtn = html.match(/<button[^>]*>Make it so/)![0];
    expect(approveBtn).toContain("disabled");
    // The default fixture's op is a skip, so decline reads "Keep it planned".
    const declineBtn = html.match(/<button[^>]*>Keep it planned/)![0];
    expect(declineBtn).toContain("disabled");
    const whyBtn = html.match(/<button[^>]*>Why\?/)![0];
    expect(whyBtn).not.toContain("disabled");
  });

  it("the actions row grants the clearance its 24px 'Why?' pad needs", () => {
    // "Why?" is a 24px link between two 44px buttons, so its hit pad reaches
    // 10px past its box; the row's 8px gap put that pad on a neighbour. The
    // container is what licenses a pad, so the row wears `.tap-clear`.
    const html = card(prop("a"));
    expect(html).toMatch(/class="row proposal-actions tap-clear"/);
    // …and it may not re-declare a narrower gap inline, which would win over
    // the class and silently take the clearance back.
    const row = html.match(/<div class="row proposal-actions tap-clear"[^>]*>/)![0];
    expect(row).not.toContain("gap:");
  });

  it("shows why the last approve/decline failed instead of silently vanishing", () => {
    const html = card(prop("a"), { error: "This already resolved elsewhere — nothing changed here." });
    expect(html).toContain("coach-prop-error");
    expect(html).toContain("This already resolved elsewhere");
  });

  // Rework 2026-08-11: ONE CoachPanel mount (window on desktop, sheet on
  // mobile — never both), so proposal ids are plain and ghost taps always
  // resolve to the visible card. The old idPrefix threading (audit C27)
  // retired with the dual mount.
  it("renders a plain, unprefixed DOM id for ghost-tap targeting", () => {
    expect(card(prop("a"))).toContain('id="proposal-a"');
  });
});

// ── 4. The thread itself ───────────────────────────────────────────────────

const thread = (messages: CoachMessageDto[], proposals: CoachProposalDto[] = []) =>
  render(createElement(CoachThread, { items: buildThread(messages, proposals) }));

describe("CoachPanel thread", () => {
  it("receipts are centered inert text — no buttons — and memory chips link out", () => {
    const messages: CoachMessageDto[] = [
      { id: "1", role: "coach", body: "Noted.", refs: { memoryIds: ["m1"] }, at: "2026-08-06T10:00:00Z" },
      { id: "2", role: "receipt", body: "the coach is resting", refs: {}, at: "2026-08-06T10:01:00Z" },
      { id: "3", role: "user", body: "thanks", refs: {}, at: "2026-08-06T10:02:00Z" },
    ];
    const html = render(
      createElement(CoachPanel, {
        messages,
        proposals: [],
        question: { id: "q1", body: "Race goal?", chips: ["Finish strong"], askedAt: "" },
        onSend: noop,
        onApprove: noop,
        onDecline: noop,
        onAnswer: noop,
        onDismiss: noop,
      }),
    );
    const receipt = html.match(/<div class="coach-receipt faint">([^<]*)<\/div>/);
    expect(receipt?.[1]).toContain("resting");
    expect(html).toContain("coach-msg-user");
    expect(html).toContain('href="/settings#coach-memory"');
    expect(html).toContain("Race goal?");
    expect(html).toContain("Finish strong");
  });

  // Audit C4/C14: every failed coach wake used to append an identical
  // "couldn't think" receipt forever. The server now dedupes its own
  // writes, but this also heals any duplicate rows a thread already
  // accumulated before that fix shipped.
  it("collapses runs of identical consecutive wake-failure receipts into one line", () => {
    const fail = "The coach couldn't think just now — try again in a moment.";
    const html = thread([
      { id: "1", role: "receipt", body: fail, refs: { wakeFailure: true }, at: "2026-08-06T10:00:00Z" },
      { id: "2", role: "receipt", body: fail, refs: { wakeFailure: true }, at: "2026-08-06T10:05:00Z" },
      { id: "3", role: "receipt", body: fail, refs: { wakeFailure: true }, at: "2026-08-06T10:10:00Z" },
      { id: "4", role: "receipt", body: "Expired — the moment passed: Ease Thursday", refs: {}, at: "2026-08-06T10:15:00Z" },
    ]);
    expect((html.match(/coach-receipt/g) ?? []).length).toBe(2); // one "couldn't think", one "Expired"
    expect(html).toContain("Expired");
  });

  // Audit C4/C14 followup: the collapse is scoped to `refs.wakeFailure`
  // specifically — an ordinary receipt that happens to share body text with
  // another is a real, distinct event and must never be merged away. (Two
  // "✓ approved" lines now become two settled CARDS, so this checks the
  // shape that is left over: an unparsed receipt with no proposal ref.)
  it("does not collapse identical-looking receipts that aren't wake failures", () => {
    const html = thread([
      { id: "1", role: "receipt", body: "Synced to your watch", refs: {}, at: "2026-08-06T10:00:00Z" },
      { id: "2", role: "receipt", body: "Synced to your watch", refs: {}, at: "2026-08-06T10:05:00Z" },
    ]);
    expect((html.match(/coach-receipt/g) ?? []).length).toBe(2);
  });

  // Audit C4/C14 followup: dedupe must survive an unrelated receipt landing
  // BETWEEN two identical failures (e.g. an expiry sweep firing mid-outage)
  // — comparing only immediate neighbors let that break the chain.
  it("collapses identical wake-failure receipts even when a different receipt sits between them", () => {
    const fail = "The coach couldn't think just now — try again in a moment.";
    const html = thread([
      { id: "1", role: "receipt", body: fail, refs: { wakeFailure: true }, at: "2026-08-06T10:00:00Z" },
      { id: "2", role: "receipt", body: "Expired — the moment passed: Ease Thursday", refs: {}, at: "2026-08-06T10:05:00Z" },
      { id: "3", role: "receipt", body: fail, refs: { wakeFailure: true }, at: "2026-08-06T10:10:00Z" },
    ]);
    expect((html.match(/coach-receipt/g) ?? []).length).toBe(2); // one failure (deduped), one Expired
    expect(html).toContain("Expired");
  });

  // Audit C16: a network-failed send used to clear the draft and vanish
  // once the settle-time refetch landed — no error, no way to recover the
  // text. A failed optimistic echo now stays, marked, with a retry.
  it("marks a failed optimistic message and offers a retry instead of erasing it", () => {
    const html = thread([
      { id: "local-1", role: "user", body: "long run felt awful today", refs: {}, at: "2026-08-06T10:00:00Z", failed: true },
    ]);
    expect(html).toContain("coach-msg-failed");
    expect(html).toContain("tap to retry");
    expect(html).toContain("long run felt awful today");
  });

  // The complaint this rework exists for: "'Needs you' section forces scroll
  // to the top". There is no separate region left to scroll to.
  it("has no tray: a proposal is a message in the thread", () => {
    const html = render(
      createElement(CoachPanel, {
        messages: [msg("m1", { at: "2026-08-06T09:00:00Z" })],
        proposals: [prop("p1", { createdAt: "2026-08-06T10:00:00Z" })],
        question: null,
        onSend: noop,
        onApprove: noop,
        onDecline: noop,
        onAnswer: noop,
        onDismiss: noop,
      }),
    );
    expect(html).not.toContain("coach-tray");
    expect(html).not.toContain("Needs you ·");
    // …and the card is INSIDE the thread, after the message that precedes it.
    expect(html.indexOf("coach-thread")).toBeLessThan(html.indexOf("coach-prop"));
    expect(html.indexOf("body m1")).toBeLessThan(html.indexOf("coach-prop"));
  });
});

describe("proposalDiscipline + pendingByDate", () => {
  it("derives discipline from ops' sessions", () => {
    const lift = prop("a", {
      ops: [
        {
          kind: "add",
          date: "2026-08-08",
          session: { category: "strength", title: "Pull", durationMinutes: 45, lift: { exercises: [] } },
        },
      ],
    });
    expect(proposalDiscipline(lift)).toBe("lift");
    expect(proposalDiscipline(prop("b"))).toBeNull(); // a bare skip names no discipline
  });

  it("maps ease/move/add/skip onto the right calendar days", () => {
    const dates = new Map([["w1", { date: "2026-08-07", summary: "Steady 40" }]]);
    const ghosts = pendingByDate(
      [
        prop("a", {
          ops: [
            {
              kind: "ease",
              workoutId: "w1",
              session: { category: "easy", title: "Steady 40", durationMinutes: 40, run: { blocks: [] } },
            },
            { kind: "move", workoutId: "w1", toDate: "2026-08-09" },
            { kind: "add", date: "2026-08-10", session: { category: "easy", title: "Shakeout", durationMinutes: 25 } },
          ],
        }),
      ],
      dates,
    );
    expect(ghosts.get("2026-08-07")!.map((g) => g.kind)).toEqual(["rewrite", "outgoing"]);
    expect(ghosts.get("2026-08-09")![0]!.kind).toBe("incoming");
    expect(ghosts.get("2026-08-10")![0]!.label).toBe("Shakeout");
  });
});
