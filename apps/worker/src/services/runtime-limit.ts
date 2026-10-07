/**
 * A CLOUDFLARE CEILING IS NOT A REMOTE SERVICE FAILING.
 *
 * Workers cap subrequests and CPU per invocation, and one COROS write costs
 * roughly ten subrequests (a plan-wide read across observation windows,
 * `/program/calculate`, the write, the verify read); a full read costs more
 * again. Hit the ceiling and the exception surfaces exactly where a network
 * failure would — which is how, twice on 2026-08-18, our own budget got
 * reported as somebody else's outage: two mobility sessions burned all three
 * retry attempts and went terminal, and a plan read that had already received
 * `result=0000` from every COROS endpoint was recorded as `coros_unreachable`.
 *
 * The distinction is not cosmetic. A remote failure should be retried and, if
 * it persists, shown to the athlete as "COROS is unreachable". A local ceiling
 * should be retried WITHOUT spending the job's attempts and must never be shown
 * as a COROS problem, because COROS is fine and there is nothing the athlete
 * can do.
 *
 * D1 has a ceiling of its own: a cap on queries per Worker invocation, which
 * throws "Too many API requests by single worker invocation." (the wording the
 * restore tests simulate). Only that full phrase matches — a bare "too many
 * API requests" could be a remote rate limit, which is the remote's answer.
 */
export function isRuntimeLimit(error: unknown): boolean {
  return /too many subrequests|too many api requests by (a )?single worker invocation|exceeded .*(limit|quota)|cpu time limit|script will never generate a response/i.test(
    typeof error === "string" ? error : error instanceof Error ? error.message : String(error ?? ""),
  );
}
