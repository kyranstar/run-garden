/**
 * THE COACH'S CONVERSATION, PURE (the new shape §5, 2026-10-17). One conversation per athlete, its turns read from the
 * server (`GET /api/coach/conversation`), each turn one run. What the sheet decides that needs no React and no network:
 *
 *   openingLine        the opening screen's one coach line, from the day's own data (no model call)
 *   starterChips       two to four starter chips: general ones, or ones for what the coach sees
 *   turnsShown         the read's turns (none for a conversation the athlete left), and the turns a send started that
 *                      the read hasn't caught up with
 *   conversationToSend which conversation a send continues
 *   cardIsOpen / …     a card open (its full card), or closed (one line of what came of it)
 *   turnStopLine       a turn over that the server gave no words
 *
 * Every text the athlete or the coach wrote is data: the view renders it as text.
 */
import type { CoachConversationCardDto, CoachConversationDto, CoachConversationTurnDto, CoachRunStatus, TodayResponse } from "@rg/api-client";
import type { CoachFocus } from "./coach-focus.js";
import { failureOf, isLive } from "./run-model.js";

/** The conversation's read (the sheet and the run keeper's ending read it again). */
export const CONVERSATION_QUERY = ["coach-conversation"] as const;

/** The box, with nothing shown yet, and inside a conversation. */
export const BOX_PLACEHOLDER_NEW = "Ask anything";
export const BOX_PLACEHOLDER_REPLY = "Reply";
export const boxPlaceholder = (turns: number): string => (turns > 0 ? BOX_PLACEHOLDER_REPLY : BOX_PLACEHOLDER_NEW);

/** The opening line when the day says nothing. */
export const OPENING_FALLBACK = "What would help today?";

const VERDICT_LINE: Record<string, string> = {
  poor: "Recovery is low this morning — a gentle day would suit you.",
  caution: "A middling morning — steady suits today.",
  good: "You're well recovered this morning — today can take its full effort.",
};

/** The first sentence of the coach's own words, its first letter lowered to follow "This week:". */
function firstSentence(text: string): string {
  const t = text.trim();
  const end = t.search(/[.!?](\s|$)/);
  const one = end >= 0 ? t.slice(0, end + 1) : t;
  return one.length > 0 ? one.charAt(0).toLowerCase() + one.slice(1) : one;
}

/**
 * One coach line about the day: the morning's readiness first (it is about the day); else the week's focus, said as
 * the week's (it was written about the week, never about this morning); else today's session still to do; else a plain
 * question. No model call.
 */
export function openingLine(today: Pick<TodayResponse, "readiness" | "focus" | "todaySessions"> | null | undefined): string {
  const level = today?.readiness?.verdict?.level;
  if (level && VERDICT_LINE[level]) return VERDICT_LINE[level]!;
  const focus = today?.focus?.text?.trim();
  if (focus) return `This week: ${firstSentence(focus)}`;
  const session = (today?.todaySessions ?? []).find((s) => s.workout.category !== "rest" && s.workout.completionState === "scheduled");
  if (session) return `Today: ${session.workout.title}.`;
  return OPENING_FALLBACK;
}

/** The general starter chips (nothing seen). */
export const GENERAL_CHIPS = ["Something for right now", "Plan my week", "I'm sore"] as const;

/** An objective's title short enough to sit in a chip. */
const OBJECTIVE_CHIP_MAX = 32;

/**
 * Two to four starter chips; a tap sends one as the athlete's words. With nothing seen, the general ones (and a question
 * about an objective whose title fits a chip); with something seen, its own.
 */
export function starterChips(seeing: Pick<CoachFocus, "kind" | "category"> | null, o: { objective?: string | null } = {}): string[] {
  switch (seeing?.kind) {
    case "workout":
      return ["Shorten it", "Move it", seeing.category === "run" ? "Why this run?" : "Why this session?"];
    case "day":
      return ["Plan this day", "Make it lighter", "I'm short on time"];
    case "move":
      return ["Build a workout around it", "How do I do it well?", "Something like it"];
    case "objective":
      return ["How is it going?", "Plan toward it", "A test for it"];
    case "session":
    case "activity":
      return ["How did it go?", "What should come next?"];
    case "proposal":
      return ["Make it shorter", "Make it easier"];
    default: {
      const title = o.objective?.trim();
      if (!title || title.length > OBJECTIVE_CHIP_MAX) return [...GENERAL_CHIPS];
      return [GENERAL_CHIPS[0], GENERAL_CHIPS[1], `How is “${title}” going?`, GENERAL_CHIPS[2]];
    }
  }
}

/** A turn a send started, until the read has it: its run, the athlete's words, its status as the loop knows it. */
export interface ProvisionalTurn {
  runId: string;
  words: string | null;
  at: string;
  status: CoachRunStatus;
}

/**
 * The turns to show: the read's (none for the conversation the athlete left with "New conversation"), then each turn a
 * send started that the read hasn't caught up with — once, the read's own taking its place as it arrives.
 */
export function turnsShown(read: CoachConversationDto | undefined, left: string | null, sent: readonly ProvisionalTurn[]): CoachConversationTurnDto[] {
  const turns = read && (read.id === null || read.id !== left) ? read.turns : [];
  const have = new Set(turns.map((t) => t.runId));
  const extra = sent
    .filter((s) => !have.has(s.runId))
    .map((s): CoachConversationTurnDto => ({ runId: s.runId, at: s.at, words: s.words, status: s.status, line: null, cards: [], question: null }));
  return [...turns, ...extra];
}

/**
 * The conversation a send continues: the one the server last named, else the one read — never one the athlete left
 * (null: a new one); none read, null too; the read failed with nothing known, left out (the server continues a recent
 * one or starts anew).
 */
export function conversationToSend(o: {
  read: CoachConversationDto | undefined;
  readFailed: boolean;
  created: string | null;
  left: string | null;
}): string | null | undefined {
  const known = o.created ?? o.read?.id ?? null;
  if (known && known !== o.left) return known;
  if (known === null && o.read === undefined && o.readFailed && o.left === null) return undefined;
  return null;
}

/** The suggestion is still the athlete's to decide: its full card shows. */
const OPEN_STATUSES = new Set(["pending", "partially_approved"]);
export const cardIsOpen = (card: Pick<CoachConversationCardDto, "status">): boolean => OPEN_STATUSES.has(card.status);

/** What came of a card's suggestion, in plain words — a change said as a change. */
export function cardOutcome(card: Pick<CoachConversationCardDto, "kind" | "status">): string {
  const change = card.kind === "plan_changes";
  switch (card.status) {
    case "approved":
      return change ? "Done" : "Added to your plan";
    case "declined":
      return change ? "Left as planned" : "Not added";
    case "superseded":
      return "Replaced";
    case "expired":
      return "Its day passed";
    case "rejected":
      return "Couldn't be made";
    default:
      return card.status.replace(/[_-]+/g, " ").trim().toLowerCase() || "Closed";
  }
}

/** A closed card's one line: "Hips, gently · Sun 12 PM · 10 min · Recover — Replaced". */
export function closedCardLine(card: Pick<CoachConversationCardDto, "kind" | "status" | "title" | "summary">): string {
  return `${[card.title, card.summary.trim() || null].filter(Boolean).join(" · ")} — ${cardOutcome(card)}`;
}

/** A turn over that the server gave no words (an older server, a stop with none): what happened, plainly. */
export function turnStopLine(status: CoachRunStatus, error: string | null = null): string | null {
  if (isLive(status)) return null;
  switch (status) {
    case "finished":
      return "Done.";
    case "cancelled":
      return "Cancelled.";
    case "expired":
      return "This ran out of time.";
    case "failed":
    case "stopped_cap": {
      const f = error ? failureOf({ status, error }) : null;
      return f ? [f.what, f.next].filter(Boolean).join(" ") : "The coach stopped before it finished.";
    }
    default:
      return String(status).replace(/[_-]+/g, " ").trim() || null;
  }
}

/** Where the conversation the athlete left is kept on this device (a convenience: the sheet works without it). */
export const LEFT_CONVERSATION_KEY = "rg.coach.leftConversation";

export function readLeftConversation(): string | null {
  try {
    return globalThis.localStorage?.getItem(LEFT_CONVERSATION_KEY) ?? null;
  } catch {
    return null;
  }
}

export function writeLeftConversation(id: string | null): void {
  try {
    if (id === null) globalThis.localStorage?.removeItem(LEFT_CONVERSATION_KEY);
    else globalThis.localStorage?.setItem(LEFT_CONVERSATION_KEY, id);
  } catch {
    // Storage unavailable: "New conversation" holds until the app reloads.
  }
}
