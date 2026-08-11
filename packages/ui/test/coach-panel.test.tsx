/**
 * Coach panel presentational suite (Plan B Task B1) + the pendingByDate ghost
 * derivation (Task B3): proposals render ONLY from the tray, receipts are
 * inert, the tray caps, and ghosts land on the right calendar days.
 */
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router-dom";
import { describe, expect, it } from "vitest";
import type { CoachMessageDto, CoachPlanDto, CoachProposalDto } from "@rg/api-client";
import {
  CoachPanel,
  CoachThread,
  pendingByDate,
  PendingTray,
  ProposalCard,
  proposalDiscipline,
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

function render(el: React.ReactElement): string {
  return renderToStaticMarkup(createElement(MemoryRouter, null, el));
}

describe("PendingTray", () => {
  it("caps at four with an overflow link and hides entirely when empty", () => {
    const six = ["a", "b", "c", "d", "e", "f"].map((id) => prop(id));
    const html = render(
      createElement(PendingTray, { proposals: six, onApprove: noop, onDecline: noop }),
    );
    expect(html).toContain("Needs you · 6");
    expect((html.match(/coach-prop-title/g) ?? []).length).toBe(4);
    expect(html).toContain("and 2 more");

    const empty = render(
      createElement(PendingTray, { proposals: [], onApprove: noop, onDecline: noop }),
    );
    expect(empty).toBe("");
  });

  it("renders evidence, rule flags, and a skip-contextual decline label", () => {
    const html = render(
      createElement(PendingTray, {
        proposals: [prop("a", { flags: ["Long runs stay on Saturdays"] })],
        onApprove: noop,
        onDecline: noop,
      }),
    );
    expect(html).toContain("slept 5h avg");
    expect(html).toContain("breaks a rule: Long runs stay on Saturdays");
    expect(html).toContain("Make it so");
    expect(html).toContain("Keep it planned");
  });

  // Audit C17: approve/decline used to have no in-flight state at all (the
  // computed `acting` boolean existed but was never wired to the buttons)
  // and a failed 409 was indistinguishable from success.
  it("disables Make it so / Leave it while acting, but never Why?", () => {
    const html = render(
      createElement(ProposalCard, { proposal: prop("a"), onApprove: noop, onDecline: noop, acting: true }),
    );
    expect(html).toMatch(/Make it so<\/button>/);
    const approveBtn = html.match(/<button[^>]*>Make it so/)![0];
    expect(approveBtn).toContain("disabled");
    // The default fixture's op is a skip, so decline reads "Keep it planned".
    const declineBtn = html.match(/<button[^>]*>Keep it planned/)![0];
    expect(declineBtn).toContain("disabled");
    const whyBtn = html.match(/<button[^>]*>Why\?/)![0];
    expect(whyBtn).not.toContain("disabled");
  });

  it("shows why the last approve/decline failed instead of silently vanishing", () => {
    const html = render(
      createElement(ProposalCard, {
        proposal: prop("a"),
        onApprove: noop,
        onDecline: noop,
        error: "This already resolved elsewhere — nothing changed here.",
      }),
    );
    expect(html).toContain("coach-prop-error");
    expect(html).toContain("This already resolved elsewhere");
  });

  // Rework 2026-08-11: ONE CoachPanel mount (window on desktop, sheet on
  // mobile — never both), so proposal ids are plain and ghost taps always
  // resolve to the visible card. The old idPrefix threading (audit C27)
  // retired with the dual mount.
  it("renders a plain, unprefixed DOM id for ghost-tap targeting", () => {
    const html = render(createElement(ProposalCard, { proposal: prop("a"), onApprove: noop, onDecline: noop }));
    expect(html).toContain('id="proposal-a"');
  });
});

describe("CoachPanel thread", () => {
  it("receipts are centered inert text — no buttons — and memory chips link out", () => {
    const messages: CoachMessageDto[] = [
      { id: "1", role: "coach", body: "Noted.", refs: { memoryIds: ["m1"] }, at: "2026-08-06T10:00:00Z" },
      { id: "2", role: "receipt", body: "✓ approved — eased Thursday", refs: { proposalId: "p" }, at: "2026-08-06T10:01:00Z" },
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
      }),
    );
    const receipt = html.match(/<div class="coach-receipt faint">([^<]*)<\/div>/);
    expect(receipt?.[1]).toContain("approved");
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
    const messages: CoachMessageDto[] = [
      { id: "1", role: "receipt", body: fail, refs: { wakeFailure: true }, at: "2026-08-06T10:00:00Z" },
      { id: "2", role: "receipt", body: fail, refs: { wakeFailure: true }, at: "2026-08-06T10:05:00Z" },
      { id: "3", role: "receipt", body: fail, refs: { wakeFailure: true }, at: "2026-08-06T10:10:00Z" },
      { id: "4", role: "receipt", body: "Expired — the moment passed: Ease Thursday", refs: {}, at: "2026-08-06T10:15:00Z" },
    ];
    const html = render(
      createElement(CoachThread, { messages }),
    );
    expect((html.match(/coach-receipt/g) ?? []).length).toBe(2); // one "couldn't think", one "Expired"
    expect(html).toContain("Expired");
  });

  // Audit C4/C14 followup: the collapse is scoped to `refs.wakeFailure`
  // specifically — an ordinary receipt that happens to share body text with
  // another (e.g. two "✓ approved — Ease Thursday" lines for two different
  // proposals) is a real, distinct event and must never be merged away.
  it("does not collapse identical-looking receipts that aren't wake failures", () => {
    const messages: CoachMessageDto[] = [
      { id: "1", role: "receipt", body: "✓ approved — Ease Thursday", refs: { proposalId: "p1" }, at: "2026-08-06T10:00:00Z" },
      { id: "2", role: "receipt", body: "✓ approved — Ease Thursday", refs: { proposalId: "p2" }, at: "2026-08-06T10:05:00Z" },
    ];
    const html = render(createElement(CoachThread, { messages }));
    expect((html.match(/coach-receipt/g) ?? []).length).toBe(2);
  });

  // Audit C4/C14 followup: dedupe must survive an unrelated receipt landing
  // BETWEEN two identical failures (e.g. an expiry sweep firing mid-outage)
  // — comparing only immediate neighbors let that break the chain.
  it("collapses identical wake-failure receipts even when a different receipt sits between them", () => {
    const fail = "The coach couldn't think just now — try again in a moment.";
    const messages: CoachMessageDto[] = [
      { id: "1", role: "receipt", body: fail, refs: { wakeFailure: true }, at: "2026-08-06T10:00:00Z" },
      { id: "2", role: "receipt", body: "Expired — the moment passed: Ease Thursday", refs: {}, at: "2026-08-06T10:05:00Z" },
      { id: "3", role: "receipt", body: fail, refs: { wakeFailure: true }, at: "2026-08-06T10:10:00Z" },
    ];
    const html = render(createElement(CoachThread, { messages }));
    expect((html.match(/coach-receipt/g) ?? []).length).toBe(2); // one failure (deduped), one Expired
    expect(html).toContain("Expired");
  });

  // Audit C16: a network-failed send used to clear the draft and vanish
  // once the settle-time refetch landed — no error, no way to recover the
  // text. A failed optimistic echo now stays, marked, with a retry.
  it("marks a failed optimistic message and offers a retry instead of erasing it", () => {
    const messages: CoachMessageDto[] = [
      { id: "local-1", role: "user", body: "long run felt awful today", refs: {}, at: "2026-08-06T10:00:00Z", failed: true },
    ];
    const html = render(createElement(CoachThread, { messages }));
    expect(html).toContain("coach-msg-failed");
    expect(html).toContain("tap to retry");
    expect(html).toContain("long run felt awful today");
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
    const dates = new Map([["w1", "2026-08-07"]]);
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
