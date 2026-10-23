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

/**
 * OUR OWN DATABASE FAILING IS NOT A REMOTE SERVICE FAILING EITHER (audit C3). At 2026-10-18 12:30Z "D1_ERROR: Network
 * connection lost" — the Worker losing D1, mid-read — was stamped `api_error` on the COROS connection and recorded as
 * `coros_unreachable`. D1's own failures carry its mark (`D1_ERROR`, `D1_…_ERROR`, "D1 DB is overloaded", "D1 DB
 * storage operation …"); a wrapper's `cause` is read too. A statement of ours that D1 refused (a missing column, a
 * constraint, too many variables, a syntax error) is not the database failing: it is a bug every retry meets, and it is
 * left to the caller's own handling.
 */
const D1_MARK = /\bD1_[A-Z_]*ERROR\b|\bD1 DB\b/;
const OUR_STATEMENT = /SQLITE_(ERROR|CONSTRAINT|MISMATCH|RANGE|TOOBIG)|constraint failed|no such (table|column)|has no column|syntax error|too many SQL variables/i;
export function isStorageError(error: unknown): boolean {
  for (let e: unknown = error, depth = 0; e != null && depth < 4; depth++) {
    const message = typeof e === "string" ? e : e instanceof Error ? e.message : "";
    if (D1_MARK.test(message) && !OUR_STATEMENT.test(message)) return true;
    e = e instanceof Error ? e.cause : null;
  }
  return false;
}
