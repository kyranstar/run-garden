/**
 * The re-cut's SQL (saves-flow redesign, Task 15): dissolve `held` batches so the assembler cuts them afresh (at most 12
 * new moves a batch, oldest first, near-duplicates flagged at the cut). Pure: it makes strings and runs nothing. Every
 * statement guards on `status = 'held'`, so a released, saved or fitted batch named by mistake is never touched.
 */

/** A batch id: lower-case hex and dashes. Anything else is refused before any SQL is made. */
export const BATCH_ID_RE = /^[0-9a-f-]{8,36}$/;

function idList(batchIds) {
  if (!Array.isArray(batchIds) || batchIds.length === 0) throw new Error("name at least one batch id");
  for (const id of batchIds) {
    if (typeof id !== "string" || !BATCH_ID_RE.test(id)) throw new Error(`not a batch id: ${String(id).slice(0, 40)}`);
  }
  return batchIds.map((id) => `'${id}'`).join(", ");
}

/** The four UPDATEs, in order: moves, links, posts unbatched; then the batches superseded. */
export function recutStatements(batchIds) {
  const ids = idList(batchIds);
  const held = `SELECT id FROM save_batches WHERE status = 'held' AND id IN (${ids})`;
  return [
    `UPDATE personal_moves SET batch_id = NULL WHERE status = 'pending' AND batch_id IN (${held})`,
    `UPDATE saved_post_moves SET batch_id = NULL WHERE status = 'pending' AND batch_id IN (${held})`,
    `UPDATE saved_posts SET batch_id = NULL WHERE batch_id IN (${held})`,
    `UPDATE save_batches SET status = 'superseded' WHERE status = 'held' AND id IN (${ids})`,
  ];
}

/** Read-only twins of the four UPDATEs: how many rows each would touch. */
export function checkStatements(batchIds) {
  const ids = idList(batchIds);
  const held = `SELECT id FROM save_batches WHERE status = 'held' AND id IN (${ids})`;
  return [
    `SELECT count(*) AS n FROM personal_moves WHERE status = 'pending' AND batch_id IN (${held})`,
    `SELECT count(*) AS n FROM saved_post_moves WHERE status = 'pending' AND batch_id IN (${held})`,
    `SELECT count(*) AS n FROM saved_posts WHERE batch_id IN (${held})`,
    `SELECT count(*) AS n FROM save_batches WHERE status = 'held' AND id IN (${ids})`,
  ];
}
