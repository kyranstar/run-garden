import { api, ApiError } from "@rg/api-client";

/**
 * "MAKE IT SO", AND NEVER CALL AN APPLIED PROPOSAL A FAILURE (2026-10-10).
 *
 * The owner tapped it, the approve applied and committed, and the card said it had failed; the second tap then read
 * "This already resolved elsewhere — nothing changed here", which was false twice over. Two rules:
 *
 *  · a 409 `not_pending` whose `status` is `approved` IS the answer to this tap — the first one landed. It resolves as
 *    applied, never as an error;
 *  · when the answer never came back (the connection dropped, the request timed out, a 5xx), the proposal is read
 *    before anything is said: approved means applied. Only a proposal still pending — or one that cannot be read —
 *    leaves the error standing, and the card says to try again.
 *
 * Every other refusal (declined, expired, superseded, not found) rejects with the original error, for the card's own
 * wording. `already` says the tap found the work done rather than doing it.
 */
export async function approveProposal(id: string): Promise<{ applied: true; already?: true }> {
  try {
    await api.coachApprove(id);
    return { applied: true };
  } catch (err) {
    if (err instanceof ApiError && err.status === 409) {
      if ((err.body as { status?: string } | null)?.status === "approved") return { applied: true, already: true };
      throw err;
    }
    if (!(err instanceof ApiError) || err.status >= 500) {
      const now = await api.coachProposal(id).catch(() => null);
      if (now?.status === "approved") return { applied: true, already: true };
    }
    throw err;
  }
}
