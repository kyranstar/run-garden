// A VIDEO'S TRANSCRIPT as the extension sends it and the Worker keeps it (design 2026-11-05 §5.2–5.3): one text, a
// segment a line — "<start seconds>\t<words>" — so a long transcript is one string to check and one blob to store (a
// list of thousands of pairs costs a Worker milliseconds of CPU to validate).

/** The most of a transcript sent and kept: a longer one is cut at a segment boundary and says so. */
export const TRANSCRIPT_MAX = 400_000;
/** What screening reads of a transcript (§5.4). */
export const SCREEN_TRANSCRIPT_WORDS = 1_500;

export type Segment = [number, string];
export interface Chapter {
  start: number;
  title: string;
}

const oneLine = (s: string): string => s.replace(/\s+/g, " ").trim();
const seconds = (n: number): string => String(Math.round(n * 10) / 10);

/** Segments as the transcript's text, cut before the segment that would pass TRANSCRIPT_MAX. Empty segments go. */
export function transcriptText(segments: readonly Segment[]): { text: string; cut: boolean } {
  const lines: string[] = [];
  let length = 0;
  for (const [start, words] of segments) {
    const text = oneLine(words);
    if (!text || !Number.isFinite(start) || start < 0) continue;
    const line = `${seconds(start)}\t${text}`;
    const add = (lines.length ? 1 : 0) + line.length;
    if (length + add > TRANSCRIPT_MAX) return { text: lines.join("\n"), cut: true };
    lines.push(line);
    length += add;
  }
  return { text: lines.join("\n"), cut: false };
}

/** The transcript's text back as segments; a line that isn't one is skipped. */
export function transcriptSegments(text: string): Segment[] {
  const out: Segment[] = [];
  for (const line of text.split("\n")) {
    const tab = line.indexOf("\t");
    if (tab <= 0) continue;
    const start = Number(line.slice(0, tab));
    const words = line.slice(tab + 1).trim();
    if (Number.isFinite(start) && start >= 0 && words) out.push([start, words]);
  }
  return out;
}

/** "m:ss", or "h:mm:ss" from an hour. */
export function clock(totalSeconds: number): string {
  const s = Math.max(0, Math.floor(totalSeconds));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const ss = String(s % 60).padStart(2, "0");
  return h ? `${h}:${String(m).padStart(2, "0")}:${ss}` : `${m}:${ss}`;
}

/** The first `n` words of a text, on one line. */
export function firstWords(text: string, n: number): string {
  return text.split(/\s+/).filter(Boolean).slice(0, n).join(" ");
}
