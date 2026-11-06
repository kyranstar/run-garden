import { ApiError } from "@rg/api-client";
import { LINK_REFUSED } from "@rg/saves";

/**
 * Why a link couldn't be added, in plain words, by the app's answer — wherever a link is pasted in the app (Settings →
 * Saves, the coach's box). Only the app's refusal says what it takes (in its own words: a playlist's are its own); a
 * failure says what happened, and the link stays to add again (final audit G17).
 */
export function addFailureWords(e: unknown): string {
  const status = e instanceof ApiError ? e.status : 0;
  if (status === 400) {
    const said = e instanceof ApiError ? (e.body as { message?: unknown } | null)?.message : null;
    return typeof said === "string" && said.trim() ? said : LINK_REFUSED;
  }
  if (status === 401) return "Sign in again to add a link.";
  if (status === 423) return "A restore is running — try again when it's done.";
  if (status === 0) return "You're offline — the link is still here to add.";
  return "The app couldn't take it just now — try again in a moment.";
}
