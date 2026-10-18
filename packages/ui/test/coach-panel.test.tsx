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
  opDayLabel,
  pendingByDate,
  ProposalCard,
  proposalDiscipline,
  proposalLines,
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
    expect(lines[0]!.was).toBe("6×600m at 10K pace");
    expect(lines[0]!.change).toBeNull();
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
