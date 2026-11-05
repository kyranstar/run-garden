import type { SaveErrorCode } from "./schemas.js";

// THE IMPORT TRAIL's shared words and types (design 2026-11-05 §4, §6): what each stage of a saved or pasted post took
// in, decided and gave out, as the Worker stores it and the app and the extension read it.

/**
 * A post's failure in the owner's words, from its code and the stage's own text. The code decides the words, so a
 * failure never reads as an earlier one's (audit 2026-11-05, bugs 2 and 5).
 */
export function failureWords(code: SaveErrorCode | string | null, raw: string | null): string | null {
  if (!code) return null;
  const first = raw?.split(" | ")[0]?.trim() || null;
  switch (code) {
    case "gone":
      return "The post is gone";
    case "media_failed":
      return "The video wouldn't download";
    case "too_large":
      return "Too large to send, at any size";
    case "model_failed":
      return first ? `The reader's reply didn't work: ${first}` : "The reader's reply didn't work";
    case "budget_paused":
      return "Waiting for the import budget";
    case "login_needed":
      return "Instagram wants you to log in again";
    case "feed_changed":
      return "Instagram changed something";
    case "app_unreachable":
      return "The app couldn't be reached";
    default:
      return first ? `Something went wrong: ${first}` : "Something went wrong";
  }
}
