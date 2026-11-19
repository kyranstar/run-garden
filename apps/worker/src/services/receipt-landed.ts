/**
 * A TAKE-BACK RECEIPT THAT FOUND NO WRITE TO RECORD (R1; services/take-back.ts `receiptInsert`): its `post_state` is read
 * from the row as the write in the same batch left it — the row at the write's own instant — and is NULL when that write
 * didn't land (its guard refused it, or it matched no row), so the NOT NULL column fails the batch and nothing of it stands:
 * no write without its receipt, and no receipt without its write. A leaf, so the writers (plan-mutations.ts, doc-workouts.ts)
 * can tell that refusal apart without importing the take-back service.
 */
const NOT_LANDED = /NOT NULL constraint failed: take_back_receipts\.post_state/;

/** The error a batch answers when its receipt found the write it records not landed (D1 may wrap it, as `cause`). */
export function receiptNotLanded(e: unknown): boolean {
  for (let x: unknown = e, i = 0; x && i < 4; i++, x = (x as { cause?: unknown }).cause) {
    if (x instanceof Error && NOT_LANDED.test(x.message)) return true;
  }
  return false;
}
