/**
 * App Settings -> Coach & AI -> Saves: one row that says what the saved-posts import did ("Last import 2 days ago · 12
 * moves from 5 posts", "Last check 8 days ago" once a week has passed, "Paused — import budget"), opening a sheet: first
 * the import's health row (its lights, design 2026-11-05 §3.2), then a row to the review screen ("From your saves",
 * /studio/saves), then the posts: who, where each stands and why, the link, How it came in (the post's trail, §3.4), and
 * Process anyway / Retry where they apply. While any light is red — or yellow (audit 2026-11-06, I2) — the row's line is
 * the worst light's: it never reads as all is well (audit 2026-11-05, bug 7).
 *
 * The section shows nothing unless the status read answers 200: the feature off is a 404, and no error is shown. A
 * health read that fails leaves the lights out. Self-contained: the screen places it with one line.
 */
import { useState } from "react";
import { Link } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api, SAVES_HEALTH_QUERY, SAVES_LINKS_QUERY, SAVES_STATUS_QUERY } from "@rg/api-client";
import { ADDED_LINE, alreadyInLine, linkRefusal, normalizeLinks, pastedLine, severalAddedLine, worstLight } from "@rg/saves";
import type { ImportHealthDto, LinkDto, PostRowDto, SavePostStatus, SavesStatusDto } from "@rg/saves";
import { Card, Sheet } from "../../components.js";
import { postHref } from "../../post-link.js";
import { HealthRow, healthOf, redLine } from "../saves/health-row.js";
import { addFailureWords } from "../saves/link-words.js";
import { TrailSheet, TRAIL_OPEN_LABEL } from "../saves/trail-sheet.js";
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

/**
 * The row's one line. "Last import" is dated by the newest batch, never by the check that found nothing new. While a
 * health light is red, the worst light's line takes the place of the lines that would read as all is well.
 */
export function savesLine(s: SavesStatusDto, now: Date, health: ImportHealthDto | null = null): string {
  if (s.state === "paused_budget") return "Paused — import budget";
  if (!s.lastCheckAt) return "No checks yet";
  const days = Math.floor((now.getTime() - Date.parse(s.lastCheckAt)) / DAY_MS);
  if (days >= STALE_DAYS) return `Last check ${days} days ago`;
  if (s.state === "login_needed") return "Needs a new login";
  if (s.state === "feed_changed") return "Needs an extension update";
  if (s.state === "error") return `Last check failed ${ageText(s.lastCheckAt, now)}`;
  const red = redLine(health);
  if (red) return red;
  // A yellow light's line too: the row never reads as all is well while one needs a look (audit 2026-11-06, I2).
  const needsALook = worstLight(health);
  if (needsALook && health?.worst) return health.worst;
  if (!s.lastImportAt) return `Last check ${ageText(s.lastCheckAt, now)}`;
  return `Last import ${ageText(s.lastImportAt, now)} · ${count(s.totals.moves, "move")} from ${count(s.totals.posts, "post")}`;
}

const creatorOf = (p: PostRowDto) => p.creator.name || p.creator.handle || "Unknown";

function PostRow({ post, busy, onProcess, onTrail }: { post: PostRowDto; busy: boolean; onProcess: (id: string) => void; onTrail: (id: string) => void }) {
  const action = post.status === "filtered_out" ? "Process anyway" : post.status === "failed" ? "Retry" : null;
  // A web page's address only (the shared check); the link a fingertip's target (`.stu-saved-link`: min-height --tap).
  const href = postHref(post.url);
  return (
    <div className="setting-row">
      <span className="place-row-main">
        <b>{creatorOf(post)}</b>
        <small>
          {STATUS_WORD[post.status]}
          {/* A failed post says why it failed, never the screening's reason for keeping it (audit 2026-11-05, bug 2). */}
          {(() => {
            const why = post.status === "failed" ? (post.error ?? post.reason) : post.reason;
            return why ? ` · ${why}` : "";
          })()}
        </small>
        <span className="stu-saved-links">
          {href ? (
            <a className="stu-saved-link" href={href} target="_blank" rel="noopener noreferrer">
              Open post
              <span className="visually-hidden">{` by ${creatorOf(post)}`}</span>
            </a>
          ) : null}
          <button type="button" className="linklike stu-saved-link" aria-haspopup="dialog" onClick={() => onTrail(post.id)}>
            {TRAIL_OPEN_LABEL}
            <span className="visually-hidden">{`: ${creatorOf(post)}`}</span>
          </button>
        </span>
      </span>
      {action ? (
        <button type="button" className="btn btn-small" disabled={busy} onClick={() => onProcess(post.id)}>
          {action}
        </button>
      ) : null}
    </div>
  );
}

/**
 * A link pasted on the phone (design 2026-11-05 §15.2): the app keeps it and the computer's extension reads it within
 * about 15 minutes. The answer in a line: added, already in (when), or what it takes.
 */
function LinkField() {
  const qc = useQueryClient();
  const [url, setUrl] = useState("");
  const [said, setSaid] = useState<string | null>(null);
  // Every link pasted the app takes, one call each (at most five; audit 2026-11-06, I4). Only the app's refusal says what
  // it takes; anything else says what happened, and the text stays (final audit G17).
  const add = useMutation({
    mutationFn: async (text: string) => {
      const pasted = normalizeLinks(text);
      const answers: Array<{ ok: true; known: string | null } | { ok: false; why: string }> = [];
      for (const link of pasted.links) {
        try {
          const a = await api.savesAddLink(link.url);
          answers.push({ ok: true, known: a.state === "known" ? a.firstSeenAt : null });
        } catch (e) {
          answers.push({ ok: false, why: addFailureWords(e) });
        }
      }
      return { pasted, answers };
    },
    onSuccess: ({ pasted, answers }) => {
      const only = answers.length === 1 ? answers[0]! : null;
      const said = only
        ? only.ok ? (only.known ? alreadyInLine(only.known) : ADDED_LINE) : only.why
        : severalAddedLine({
            added: answers.filter((a) => a.ok && !a.known).length,
            known: answers.filter((a) => a.ok && a.known).length,
            refused: answers.flatMap((a) => (a.ok ? [] : [a.why])),
          });
      setSaid([said, pastedLine(pasted)].filter(Boolean).join(" "));
      if (answers.every((a) => a.ok)) setUrl("");
    },
    onSettled: () => qc.invalidateQueries({ queryKey: SAVES_LINKS_QUERY }),
  });
  return (
    <form
      className="saves-link-field"
      noValidate
      onSubmit={(e) => {
        e.preventDefault();
        if (!url.trim()) return; // an empty Add does nothing (final audit G18)
        if (!normalizeLinks(url).links.length) return setSaid(linkRefusal(url));
        add.mutate(url.trim());
      }}
    >
      <span className="saves-link-row">
        <input
          type="url"
          className="input"
          value={url}
          placeholder="Paste a YouTube or Instagram link"
          aria-label="Paste a YouTube or Instagram link"
          onChange={(e) => setUrl(e.target.value)}
        />
        <button type="submit" className="btn btn-small" disabled={add.isPending}>
          Add
        </button>
      </span>
      {said ? (
        <small className="faint" role="status">
          {said}
        </small>
      ) : null}
    </form>
  );
}

/** The recent pasted links: each title (a stranger's words: text), where it stands, its trail, and Retry / Import anyway. */
function RecentLinks({ links, busy, onProcess, onTrail }: { links: LinkDto[]; busy: boolean; onProcess: (id: string) => void; onTrail: (id: string) => void }) {
  const qc = useQueryClient();
  const again = useMutation({ mutationFn: (u: string) => api.savesAddLink(u), onSettled: () => qc.invalidateQueries({ queryKey: SAVES_LINKS_QUERY }) });
  if (!links.length) return null;
  return (
    <>
      <h3 className="saves-links-title">Recent links</h3>
      {links.map((l) => {
        const label = l.action === "import_anyway" ? "Import anyway" : l.action === "retry" ? "Retry" : null;
        return (
          <div key={l.id} className="setting-row">
            <span className="place-row-main">
              {/* A title may be the link itself, one long word: it wraps anywhere (audit 2026-11-06, I12). */}
              <b className="saves-link-title">{l.title || l.url}</b>
              <small>{l.words}</small>
              {l.postId ? (
                <span className="stu-saved-links">
                  <button type="button" className="linklike stu-saved-link" aria-haspopup="dialog" onClick={() => onTrail(l.postId!)}>
                    {TRAIL_OPEN_LABEL}
                  </button>
                </span>
              ) : null}
            </span>
            {label ? (
              <button
                type="button"
                className="btn btn-small"
                disabled={busy || again.isPending}
                onClick={() => (l.postId ? onProcess(l.postId) : again.mutate(l.url))}
              >
                {label}
              </button>
            ) : null}
          </div>
        );
      })}
    </>
  );
}

export function SavesSection() {
  const qc = useQueryClient();
  const [open, setOpen] = useState(false);
  const [trail, setTrail] = useState<string | null>(null);
  const status = useQuery({ queryKey: SAVES_STATUS_QUERY, queryFn: api.savesStatus, retry: false });
  const healthRead = useQuery({ queryKey: SAVES_HEALTH_QUERY, queryFn: api.savesHealth, retry: false });
  const health = healthOf(healthRead.data);
  const links = useQuery({ queryKey: SAVES_LINKS_QUERY, queryFn: api.savesLinks, retry: false, enabled: open });
  const process = useMutation({
    mutationFn: (id: string) => api.savesOverride(id, "process"),
    onSettled: () => {
      void qc.invalidateQueries({ queryKey: SAVES_STATUS_QUERY });
      void qc.invalidateQueries({ queryKey: SAVES_LINKS_QUERY });
    },
  });
  // Anything but an answer (the feature is off: 404) hides the section.
  if (!status.data) return null;
  return (
    <Card title="Saves">
      <button type="button" className="place-row" aria-haspopup="dialog" onClick={() => setOpen(true)}>
        <span className="place-row-main">
          <b>Saves</b>
          <small>{savesLine(status.data, new Date(), health)}</small>
        </span>
        <span className="faint" aria-hidden>
          ›
        </span>
      </button>
      {open ? (
        <Sheet open onClose={() => setOpen(false)} title="Saves">
          <LinkField />
          {health ? <HealthRow health={health} /> : null}
          {/* The review screen next (spec §8): the batches, and each batch's moves. */}
          <Link className="place-row" to="/studio/saves">
            <span className="place-row-main">
              <b>From your saves</b>
            </span>
            <span className="faint" aria-hidden>
              ›
            </span>
          </Link>
          <RecentLinks links={links.data?.links ?? []} busy={process.isPending} onProcess={(id) => process.mutate(id)} onTrail={setTrail} />
          {status.data.posts.map((p) => (
            <PostRow key={p.id} post={p} busy={process.isPending} onProcess={(id) => process.mutate(id)} onTrail={setTrail} />
          ))}
        </Sheet>
      ) : null}
      {trail ? <TrailSheet postId={trail} onClose={() => setTrail(null)} /> : null}
    </Card>
  );
}
