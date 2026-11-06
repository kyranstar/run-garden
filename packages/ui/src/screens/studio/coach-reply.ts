/**
 * THE CONVERSATION'S REPLY BOX, FROM A CARD IN IT (import trail phase 3; design 2026-11-05 §3.5). A review line's
 * Challenge fills the box with "About <move>: " and puts the focus there — the card and its evidence stay in view above
 * it. Provided by the conversation (coach-conversation.tsx); a card drawn elsewhere has none, and shows no Challenge.
 */
import { createContext } from "react";

export interface CoachReply {
  /** Put `words` in the reply box (in place of what is there) and focus it. */
  challenge(words: string): void;
}

export const CoachReplyContext = createContext<CoachReply | null>(null);
