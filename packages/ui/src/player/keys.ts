/**
 * THE PLAYER'S KEYS (spec §2b "Player"; mocks §4, desktop): Space = the primary action, only when no control has focus
 * (a focused button presses itself on Space — acting on it too would act twice); Enter = confirm the log card; Esc =
 * close a panel and carry on; ←/→ = previous / next step; S = swap; I = how-to; ? = the player's settings (the key list
 * and "Move on when a timer ends"; the header's Settings button opens the same sheet at every width). Typing in a field
 * types; while a panel is open only Esc (and Enter, for the log) act. A key with Ctrl, ⌘ or Alt is the browser's.
 */
export type PlayerCommand = "primary" | "confirm" | "close" | "prev" | "next" | "swap" | "howto" | "keys";

export interface KeyContext {
  /** The how-to, the swap list, the key list or the leave question is open. */
  panelOpen: boolean;
  /** The log card is open. */
  logOpen: boolean;
}

export interface KeyLike {
  key: string;
  target: EventTarget | null;
  ctrlKey: boolean;
  metaKey: boolean;
  altKey: boolean;
}

function isTyping(el: Element | null): boolean {
  if (!el) return false;
  const tag = el.tagName;
  return tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || (el as HTMLElement).isContentEditable === true;
}

/** A control that answers Space and Enter itself. */
function isControl(el: Element | null): boolean {
  if (!el) return false;
  if (el.tagName === "BUTTON" || el.tagName === "A" || el.tagName === "SUMMARY") return true;
  const role = el.getAttribute("role");
  return role === "button" || role === "radio" || role === "switch" || role === "checkbox" || role === "link";
}

export function commandFor(e: KeyLike, ctx: KeyContext): PlayerCommand | null {
  if (e.ctrlKey || e.metaKey || e.altKey) return null;
  const el = e.target instanceof Element ? e.target : null;
  if (e.key === "Escape" || e.key === "Esc") return "close";
  if (e.key === "Enter") return ctx.logOpen && !isControl(el) ? "confirm" : null;
  if (isTyping(el) || ctx.panelOpen) return null;
  switch (e.key) {
    case " ":
    case "Spacebar":
      return isControl(el) ? null : "primary";
    case "ArrowLeft":
      return el?.getAttribute("role") === "radio" ? null : "prev";
    case "ArrowRight":
      return el?.getAttribute("role") === "radio" ? null : "next";
    case "s":
    case "S":
      return "swap";
    case "i":
    case "I":
      return "howto";
    case "?":
      return "keys";
    default:
      return null;
  }
}
