import type { PostSubmit, FilterVerdict, SavePostStatus } from "@rg/saves";
import type { SavedPostRow } from "@rg/database";

export interface FilterOutcome {
  status: SavePostStatus;
  verdict?: FilterVerdict["verdict"];
  reason?: string;
}

/**
 * The seam Task 6 replaces: decides whether a fresh (`seen`) post is training. Until then every post is kept and waits
 * `queued` for extraction. Only ever called on a post the ledger just made.
 */
export async function runFilter(_post: SavedPostRow, _submit: PostSubmit): Promise<FilterOutcome> {
  return { status: "queued" };
}
