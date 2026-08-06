/**
 * Coach panel presentational suite (Plan B Task B1) + the pendingByDate ghost
 * derivation (Task B3): proposals render ONLY from the tray, receipts are
 * inert, the tray caps, and ghosts land on the right calendar days.
 */
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router-dom";
import { describe, expect, it } from "vitest";
import type { CoachMessageDto, CoachProposalDto } from "@rg/api-client";
import {
  CoachPanel,
  pendingByDate,
  PendingTray,
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
