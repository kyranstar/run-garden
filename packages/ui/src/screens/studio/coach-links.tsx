/**
 * A LINK PASTED INTO THE COACH (audit 2026-11-06, I5). The owner puts posts in "async, and then later check[s] on them
 * probably mostly in the coach" — but the coach had no way to take a link. A message the owner typed that is ONLY links
 * goes to the link route (`POST /api/my-saves/links`, one call a link, at most five: `normalizeLinks`), and the
 * conversation shows where each stands — read again from the link list while any is on its way — rather than starting a
 * model run. UI-level: nothing of it is kept in the conversation on the server.
 *
 *   https://…/watch?v=…                                      ← what the owner typed, as their message
 *   Links · Waiting for your computer's extension             ← each link, where it stands (the app's words, not the
 *           Already in — imported Tue 3 Nov.                     coach's: no coach mark)
 *
 * Words beside a link are a message for the coach, as ever. Only what the owner typed: the caller never passes the
 * sheet's own words (an action's request) here.
 */
import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { api, SAVES_LINKS_QUERY } from "@rg/api-client";
import { ADDED_LINE, alreadyInLine, linkRefusal, normalizeLinks, pastedLine, type LinkDto } from "@rg/saves";
import { addFailureWords } from "../saves/link-words.js";

/** A word that is a link, or looks like one (the app may refuse it, and says why). */
const LINKISH = /^(?:https?:\/\/|www\.|youtu\.be\/|(?:m\.)?youtube\.com\/|instagram\.com\/)/i;

/** The message is only links — every word one — so it is for the link route, not the coach. */
export function linksOnly(text: string): boolean {
  const words = text.trim().split(/\s+/).filter(Boolean);
  return words.length > 0 && words.every((w) => LINKISH.test(w));
}

interface LinkRow {
  source: string;
  key: string;
  url: string;
  words: string;
  /** Its answer is final (already in, refused): the link list's later words don't replace it. */
  settled: boolean;
}

export interface PastedTurn {
  id: number;
  /** What the owner typed. */
  words: string;
  rows: LinkRow[];
  /** Why some or all weren't taken ("Took 2 of 3 — …"; a playlist's refusal), else null. */
  note: string | null;
}

/** How often the link list is read again while a pasted link is on its way. */
const RECHECK_MS = 30_000;

/** Where a link's path ends: its post matched, not training, failed or skipped. */
const ENDED: ReadonlySet<string> = new Set(["moves", "not_training", "failed", "skipped"]);

/**
 * A pasted link is still on its way: its answer wasn't final (already in, refused) and the link list doesn't yet say it
 * ended — so the list is read again only while one is (review, 2026-11-06: it was read every 30 s for good).
 */
export function stillMoving(turns: readonly PastedTurn[], links: readonly LinkDto[] | undefined): boolean {
  const state = new Map((links ?? []).map((l) => [`${l.source}:${l.key}`, l.state]));
  return turns.some((t) => t.rows.some((r) => !r.settled && !ENDED.has(state.get(`${r.source}:${r.key}`) ?? "")));
}

let seq = 0;

/** The links pasted in this sheet, and the paste itself. */
export function useCoachLinks(): { turns: PastedTurn[]; paste: (text: string) => void } {
  const qc = useQueryClient();
  const [turns, setTurns] = useState<PastedTurn[]>([]);
  const unsettled = turns.some((t) => t.rows.some((r) => !r.settled));
  const live = useQuery({
    queryKey: SAVES_LINKS_QUERY,
    queryFn: api.savesLinks,
    retry: false,
    enabled: unsettled,
    refetchInterval: (q) => (stillMoving(turns, q.state.data?.links) ? RECHECK_MS : false),
  });
  const byKey = new Map((live.data?.links ?? []).map((l: LinkDto) => [`${l.source}:${l.key}`, l.words]));
  const shown = turns.map((t) => ({ ...t, rows: t.rows.map((r) => (r.settled ? r : { ...r, words: byKey.get(`${r.source}:${r.key}`) ?? r.words })) }));

  const setRow = (id: number, at: number, row: Partial<LinkRow>) =>
    setTurns((all) => all.map((t) => (t.id === id ? { ...t, rows: t.rows.map((r, i) => (i === at ? { ...r, ...row } : r)) } : t)));

  const paste = (text: string) => {
    const pasted = normalizeLinks(text);
    const id = ++seq;
    if (pasted.links.length === 0) {
      setTurns((all) => [...all, { id, words: text, rows: [], note: linkRefusal(text) }]);
      return;
    }
    const rows = pasted.links.map((l) => ({ source: l.source, key: l.key, url: l.url, words: "Adding…", settled: false }));
    setTurns((all) => [...all, { id, words: text, rows, note: pastedLine(pasted) }]);
    void (async () => {
      for (const [at, link] of pasted.links.entries()) {
        try {
          const a = await api.savesAddLink(link.url);
          if (a.state === "known") setRow(id, at, { words: alreadyInLine(a.firstSeenAt), settled: true });
          else setRow(id, at, { words: a.link?.words || ADDED_LINE });
        } catch (e) {
          setRow(id, at, { words: addFailureWords(e), settled: true });
        }
      }
      void qc.invalidateQueries({ queryKey: SAVES_LINKS_QUERY });
    })();
  };

  return { turns: shown, paste };
}

/** The links pasted here, each where it stands: the owner's message, then the app's words for each link. */
export function CoachLinkTurns({ turns }: { turns: readonly PastedTurn[] }) {
  if (turns.length === 0) return null;
  return (
    <ol className="coach-turns coach-link-turns">
      {turns.map((t) => (
        <li key={t.id} className="coach-turn">
          <p className="coach-msg coach-msg--athlete">{t.words}</p>
          <div className="coach-links" role="status">
            {t.rows.length ? (
              <ul className="coach-links-list" aria-label="Links">
                {t.rows.map((r) => (
                  <li key={`${r.source}:${r.key}`} className="coach-link">
                    <span className="coach-link-title">{r.url}</span>
                    <small className="coach-link-words">{r.words}</small>
                  </li>
                ))}
              </ul>
            ) : null}
            {t.note ? <p className="coach-links-note">{t.note}</p> : null}
          </div>
        </li>
      ))}
    </ol>
  );
}
