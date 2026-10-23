/**
 * App Settings -> Coach & AI -> Saves: one row that says what the saved-posts import did ("Last import 2 days ago · 12
 * moves from 5 posts", "Last check 8 days ago" once a week has passed, "Paused — import budget"), opening a sheet of the posts: who, where
 * each stands and why, the link, and Process anyway / Retry where they apply.
 *
 * The section shows nothing unless the status read answers 200: the feature off is a 404, and no error is shown.
 * Self-contained: the screen places it with one line.
 */
import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api, SAVES_STATUS_QUERY } from "@rg/api-client";
import type { PostRowDto, SavePostStatus, SavesStatusDto } from "@rg/saves";
import { Card, Sheet } from "../../components.js";
import { ageText } from "./age.js";

const STALE_DAYS = 7;
const DAY_MS = 86_400_000;

const STATUS_WORD: Record<SavePostStatus, string> = {
  seen: "Seen",
  filtered_out: "Filtered out",
  queued: "Queued",
  extracting: "Reading",
  extracted: "Read",
  matched: "Matched",
  failed: "Failed",
  skipped_by_owner: "Skipped",
  reference_only: "Reference only",
};

const count = (n: number, one: string) => `${n.toLocaleString()} ${n === 1 ? one : `${one}s`}`;

/** The row's one line. "Last import" is dated by the newest batch, never by the check that found nothing new. */
export function savesLine(s: SavesStatusDto, now: Date): string {
  if (s.state === "paused_budget") return "Paused — import budget";
  if (!s.lastCheckAt) return "No checks yet";
  const days = Math.floor((now.getTime() - Date.parse(s.lastCheckAt)) / DAY_MS);
  if (days >= STALE_DAYS) return `Last check ${days} days ago`;
  if (s.state === "login_needed") return "Needs a new login";
  if (s.state === "feed_changed") return "Needs an extension update";
  if (s.state === "error") return `Last check failed ${ageText(s.lastCheckAt, now)}`;
  if (!s.lastImportAt) return `Last check ${ageText(s.lastCheckAt, now)}`;
  return `Last import ${ageText(s.lastImportAt, now)} · ${count(s.totals.moves, "move")} from ${count(s.totals.posts, "post")}`;
}

const creatorOf = (p: PostRowDto) => p.creator.name || p.creator.handle || "Unknown";

function PostRow({ post, busy, onProcess }: { post: PostRowDto; busy: boolean; onProcess: (id: string) => void }) {
  const action = post.status === "filtered_out" ? "Process anyway" : post.status === "failed" ? "Retry" : null;
  return (
    <div className="setting-row">
      <span className="place-row-main">
        <b>{creatorOf(post)}</b>
        <small>
          {STATUS_WORD[post.status]}
          {post.reason ? ` · ${post.reason}` : ""}
        </small>
        <small>
          <a href={post.url} target="_blank" rel="noopener noreferrer">
            Open post
          </a>
        </small>
      </span>
      {action ? (
        <button type="button" className="btn btn-small" disabled={busy} onClick={() => onProcess(post.id)}>
          {action}
        </button>
      ) : null}
    </div>
  );
}

export function SavesSection() {
  const qc = useQueryClient();
  const [open, setOpen] = useState(false);
  const status = useQuery({ queryKey: SAVES_STATUS_QUERY, queryFn: api.savesStatus, retry: false });
  const process = useMutation({
    mutationFn: (id: string) => api.savesOverride(id, "process"),
    onSettled: () => qc.invalidateQueries({ queryKey: SAVES_STATUS_QUERY }),
  });
  // Anything but an answer (the feature is off: 404) hides the section.
  if (!status.data) return null;
  return (
    <Card title="Saves">
      <button type="button" className="place-row" aria-haspopup="dialog" onClick={() => setOpen(true)}>
        <span className="place-row-main">
          <b>Saves</b>
          <small>{savesLine(status.data, new Date())}</small>
        </span>
        <span className="faint" aria-hidden>
          ›
        </span>
      </button>
      {open ? (
        <Sheet open onClose={() => setOpen(false)} title="Saves">
          {status.data.posts.map((p) => (
            <PostRow key={p.id} post={p} busy={process.isPending} onProcess={(id) => process.mutate(id)} />
          ))}
        </Sheet>
      ) : null}
    </Card>
  );
}
