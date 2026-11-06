/**
 * THE TRAIL OF ONE IMPORT (design 2026-11-05 §3.4): one sheet, reachable from Settings → Saves' post rows, the batch
 * page's move sheet, the health row's failures, the popup's recent posts (`/studio/saves/posts/:postId`).
 *
 *   From maker · Instagram · Tue 3 Nov                 ← the account (level 1), always open
 *   A routine: three slow hip moves…
 *   Zorbex hip lift — new                           ›  ← a move opens its own section
 *     Opens the hips after a run.
 *   No coach decision on its trail yet
 *   ✓ Read cleanly
 *   ✓ Reading            Read from your saved list  ›  ← a stage (level 2), folded under its result
 *   ! Reading the moves  2 attempts — the first…    ›
 *       Kind  a routine · Issues  … Show all          ← its steps' facts, a long value whole one tap on
 *       The call  Model … · Tokens … · Cost … · Time …
 *       The raw reply · 12,345 characters           ›  ← raw (level 3): read when opened, monospace, Copy
 *
 * The coach trail's visual language (its ✓ lines, fold buttons and key: value rows), with the most important content
 * first and nothing cut without "Show all". Every word on it came from a stage, a model or a stranger's post: text,
 * never markup. The sheet sits on top of whatever opened it (a portal: a sheet's own scroller can't clip it).
 */
import { useId, useMemo, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { useQuery } from "@tanstack/react-query";
import { api, ApiError, saveBlobQuery, saveTrailQuery } from "@rg/api-client";
import type { ImportStage, ImportTrailDto, TrailStatus } from "@rg/saves";
import { EmptyState, Sheet, Spinner } from "../../components.js";
import { IconChevron } from "../../icons.js";
import { postHref } from "../../post-link.js";
import {
  detailBlobRows,
  moveDetail,
  STATUS_MARK,
  trailAccount,
  trailSections,
  type AccountLine,
  type StageSection,
  type TrailBlob,
  type TrailDetail,
  type TrailRow,
  type TrailStep,
} from "./trail-model.js";

/** The sheet's title before the trail is read. */
export const TRAIL_TITLE = "Saved post";
/** What opens a post's trail, wherever a post is drawn. */
export const TRAIL_OPEN_LABEL = "How it came in";

const isGone = (e: unknown): boolean => e instanceof ApiError && e.status === 404;
const retry = (n: number, e: unknown): boolean => !(e instanceof ApiError && (e.status === 404 || e.status === 401)) && n < 2;

/** The coach trail's glyph classes, by a step's status. */
const GLYPH_CLASS: Record<TrailStatus, string> = { ok: "done", warn: "error", fail: "error", info: "neutral", skip: "neutral" };

export function TrailSheet({ postId, onClose }: { postId: string; onClose: () => void }) {
  const q = useQuery({ queryKey: saveTrailQuery(postId), queryFn: () => api.saveTrail(postId), retry });
  const dto = q.data;
  const creator = dto ? dto.post.creator.name?.trim() || dto.post.creator.handle.trim() : "";
  const title = dto ? dto.post.title?.trim() || creator || TRAIL_TITLE : TRAIL_TITLE;
  let body;
  if (dto) body = <Trail dto={dto} />;
  else if (q.isPending) body = <Spinner label="Reading the trail" />;
  else if (isGone(q.error)) body = <EmptyState title="That post isn't there." />;
  else
    body = (
      <EmptyState title="Couldn't load this.">
        <button type="button" className="btn" onClick={() => void q.refetch()}>
          Try again
        </button>
      </EmptyState>
    );
  return createPortal(
    <Sheet open onClose={onClose} title={title}>
      {body}
    </Sheet>,
    document.body,
  );
}

function Trail({ dto }: { dto: ImportTrailDto }) {
  const account = useMemo(() => trailAccount(dto), [dto]);
  const sections = useMemo(() => trailSections(dto), [dto]);
  const href = postHref(dto.post.url);
  return (
    <div className="trail">
      <Account dto={dto} lines={account} href={href} />
      {sections.length ? (
        <ol className="coach-run-lines trail-stages" aria-label="Step by step">
          {sections.map((s) => (
            <Section key={s.stage} section={s} dto={dto} />
          ))}
        </ol>
      ) : null}
    </div>
  );
}

// ── Level 1 ──────────────────────────────────────────────────────────────────

function Account({ dto, lines, href }: { dto: ImportTrailDto; lines: AccountLine[]; href: string | null }) {
  const moves = lines.filter((l) => l.kind === "move");
  const rest = (kind: AccountLine["kind"]) => lines.filter((l) => l.kind === kind);
  return (
    <section className="trail-account" aria-label="The account">
      {rest("from").map((l) => (
        <p key={l.key} className="trail-from">
          {l.text}
          {href ? (
            <>
              {" "}
              <a className="stu-saved-link trail-post-link" href={href} target="_blank" rel="noopener noreferrer">
                Open post
              </a>
            </>
          ) : null}
        </p>
      ))}
      {rest("what").map((l) => (
        <p key={l.key} className="trail-what">
          {l.text}
        </p>
      ))}
      {moves.length ? (
        <ul className="coach-run-lines trail-moves" aria-label="The moves">
          {moves.map((l) => (
            <MoveLine key={l.key} line={l} dto={dto} />
          ))}
        </ul>
      ) : null}
      {[...rest("coach"), ...rest("correction")].map((l) => (
        <p key={l.key} className="trail-note">
          {l.text}
        </p>
      ))}
      <ol className="coach-run-lines">
        {[...rest("health")].map((l) => (
          <Mark key={l.key} status={l.status ?? "info"}>
            <span className="coach-line-text">{l.text}</span>
          </Mark>
        ))}
      </ol>
      {rest("rebuilt").map((l) => (
        <p key={l.key} className="coach-run-note trail-rebuilt">
          {l.text}
        </p>
      ))}
    </section>
  );
}

/** A line with its status mark (a glyph, and its word for a reader: never colour alone). */
function Mark({ status, children }: { status: TrailStatus; children: ReactNode }) {
  const m = STATUS_MARK[status];
  return (
    <li className={`coach-line coach-line--${GLYPH_CLASS[status]} trail-line--${status}`}>
      <span className="coach-line-mark" aria-hidden="true">
        {m.mark}
      </span>
      {m.word ? <span className="visually-hidden">{m.word}</span> : null}
      {children}
    </li>
  );
}

/** A move's line: its words and what it's for; a tap opens what the trail says of it (its check, match, choices). */
function MoveLine({ line, dto }: { line: AccountLine; dto: ImportTrailDto }) {
  const [open, setOpen] = useState(false);
  const id = useId();
  const detail = useMemo(() => (line.position === undefined ? [] : moveDetail(dto, line.position)), [dto, line.position]);
  return (
    <li className="trail-move">
      {detail.length ? (
        <button type="button" className="coach-line-open trail-open" aria-expanded={open} aria-controls={id} onClick={() => setOpen((v) => !v)}>
          <span className="trail-move-name">{line.text}</span>
          <span className="coach-run-fold-chev trail-chev" aria-hidden="true">
            <IconChevron size={14} />
          </span>
        </button>
      ) : (
        <span className="trail-move-name">{line.text}</span>
      )}
      {line.sub ? <span className="trail-move-sub">{line.sub}</span> : null}
      {detail.length ? (
        <div id={id} className="coach-line-detail trail-move-detail" hidden={!open}>
          <Details details={detail} />
        </div>
      ) : null}
    </li>
  );
}

// ── Level 2 ──────────────────────────────────────────────────────────────────

function Section({ section, dto }: { section: StageSection; dto: ImportTrailDto }) {
  const [open, setOpen] = useState(false);
  const id = useId();
  const one = section.steps.length === 1;
  return (
    <Mark status={section.status}>
      <button type="button" className="coach-line-text coach-line-open trail-open trail-stage" aria-expanded={open} aria-controls={id} onClick={() => setOpen((v) => !v)}>
        <span className="trail-stage-title">{section.title}</span>
        <span className="trail-stage-result">{section.result}</span>
      </button>
      <span className="coach-run-fold-chev trail-chev" aria-hidden="true">
        <IconChevron size={14} />
      </span>
      <div id={id} className="coach-line-detail trail-stage-detail" hidden={!open}>
        {section.steps.map((step) => (
          <Step key={step.id} step={step} stage={section.stage} dto={dto} lead={!one} />
        ))}
      </div>
    </Mark>
  );
}

/** One step: its line when the stage has several (a section of one has said it already), when, its facts, its raw. */
function Step({ step, stage, dto, lead }: { step: TrailStep; stage: ImportStage; dto: ImportTrailDto; lead: boolean }) {
  const m = STATUS_MARK[step.status];
  return (
    <div className="trail-step">
      {lead ? (
        <p className="trail-step-line">
          <span className={`coach-line-mark trail-mark--${step.status}`} aria-hidden="true">
            {m.mark}
          </span>
          {m.word ? <span className="visually-hidden">{m.word}</span> : null}
          <span>{step.summary}</span>
        </p>
      ) : null}
      {step.when ? <p className="trail-step-when">{step.when}</p> : null}
      <Details details={step.details} />
      {step.blobs.map((b) => (
        <Raw key={b.id} blob={b} stage={stage} dto={dto} />
      ))}
    </div>
  );
}

function Details({ details }: { details: readonly TrailDetail[] }) {
  return (
    <>
      {details.map((d, i) => (
        <div key={i} className="coach-detail">
          {d.title ? <h4 className="coach-detail-title">{d.title}</h4> : null}
          <dl className="coach-detail-rows">
            {d.rows.map((r, j) => (
              <Row key={j} row={r} />
            ))}
          </dl>
        </div>
      ))}
    </>
  );
}

/** A key: value row; a long value shows its preview, and "Show all" its whole — nothing is cut. */
function Row({ row }: { row: TrailRow }) {
  const [all, setAll] = useState(false);
  return (
    <div className="coach-detail-row">
      <dt>{row.key}</dt>
      <dd className="trail-value">
        <span className="trail-value-text">{all && row.full ? row.full : row.value}</span>
        {row.full ? (
          <button type="button" className="linklike tap-pad trail-show-all" aria-expanded={all} onClick={() => setAll((v) => !v)}>
            {all ? "Show less" : "Show all"}
          </button>
        ) : null}
      </dd>
    </div>
  );
}

// ── Level 3 ──────────────────────────────────────────────────────────────────

/** A raw piece: its label and size; opened, read once and shown whole — monospace, copyable. A cut detail reads back
 * as rows, never as its JSON. */
function Raw({ blob, stage, dto }: { blob: TrailBlob; stage: ImportStage; dto: ImportTrailDto }) {
  const [open, setOpen] = useState(false);
  const [copied, setCopied] = useState<"yes" | "no" | null>(null);
  const id = useId();
  const q = useQuery({ queryKey: saveBlobQuery(blob.id), queryFn: () => api.saveBlob(blob.id), enabled: open, retry, staleTime: Infinity });
  const rows = useMemo(() => (q.data && blob.kind === "detail" ? detailBlobRows(q.data.text, stage, dto) : null), [q.data, blob.kind, stage, dto]);
  const copy = async (text: string) => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied("yes");
    } catch {
      setCopied("no");
    }
  };
  return (
    <div className="trail-raw">
      <button type="button" className="linklike coach-run-fold tap-pad trail-raw-open" aria-expanded={open} aria-controls={id} onClick={() => setOpen((v) => !v)}>
        {`${blob.label} · ${blob.size}`}
        <span className="coach-run-fold-chev" aria-hidden="true">
          <IconChevron size={14} />
        </span>
      </button>
      <div id={id} className="trail-raw-body" hidden={!open}>
        {open && q.isPending ? <p className="coach-run-note">Reading…</p> : null}
        {open && q.isError ? (
          <p className="coach-run-note" role="status">
            {isGone(q.error) ? "That isn't kept any more." : "Couldn't read this — try again later."}
          </p>
        ) : null}
        {q.data && rows ? <Details details={rows} /> : null}
        {q.data && !rows ? (
          <>
            <pre className="trail-raw-text" tabIndex={0} aria-label={blob.label}>
              {q.data.text}
            </pre>
            {q.data.cut ? <p className="coach-run-note">Cut at a million characters: the rest wasn't kept.</p> : null}
            <div className="trail-raw-foot">
              <button type="button" className="btn btn-small" onClick={() => void copy(q.data!.text)}>
                Copy
              </button>
              <span className="coach-run-note" role="status">
                {copied === "yes" ? "Copied" : copied === "no" ? "Couldn't copy — select it instead" : ""}
              </span>
            </div>
          </>
        ) : null}
      </div>
    </div>
  );
}
