import { CONTRACTIONS, EQUIPMENT_IDS, PATTERNS, REGIONS } from "@rg/exercise-library";

// A reading's list fields are the library's vocabularies. One word the library doesn't have (a region, a pattern)
// threw a whole paid reply away (live finding, 2026-11-05): the word goes instead, and the move says so. Single-valued
// fields (position, laterality, load) are not touched: a reply whose required word is unusable is still refused.

export const LIST_FIELDS = ["regions", "patterns", "equipment", "equipmentOneOf", "contraction"] as const;
export type ListField = (typeof LIST_FIELDS)[number];
/** extract-6's optional lists, mended or left out item by item (final review F4): never a reason to refuse a reading. */
export const OPTIONAL_FIELDS = ["quotes", "useWhen", "skipWhen"] as const;
export const DROPPED_FIELDS = [...LIST_FIELDS, ...OPTIONAL_FIELDS] as const;
export type DroppedField = (typeof DROPPED_FIELDS)[number];
export interface DroppedValues {
  move: number;
  field: DroppedField;
  values: string[];
}
/** The fields a quote may support (schemas.ts `quoteSchema`). */
export const QUOTE_FIELDS = ["name", "dose", "purpose", "useWhen", "skipWhen", "steps", "why"] as const;
const QUOTE_FROM = new Set(["caption", "transcript", "speech", "screen"]);
/** The post's own words by another name: a title, a description or a chapter is the caption's kind of source. */
const CAPTION_LIKE = new Set(["title", "description", "chapter", "chapters"]);
const QUOTES_MAX = 8;
const QUOTE_CHARS = 200;
const CASES_MAX = 4;
const CASE_CHARS = 160;
const WHY_CHARS = 200;
const SPEECH_CHARS = 4_000;
const SCOPES = new Set(["general", "this_routine", "creator_programme"]);

const VOCAB: Readonly<Record<ListField, ReadonlySet<string>>> = {
  regions: new Set(REGIONS),
  patterns: new Set(PATTERNS),
  equipment: new Set(EQUIPMENT_IDS),
  equipmentOneOf: new Set(EQUIPMENT_IDS),
  contraction: new Set(CONTRACTIONS),
};
/** How much of a dropped word the note keeps: it is the model's, shown as text. */
const NOTE_CHARS = 40;

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
/** What a left-out item said, for its note: its words, else what it held. */
const note = (v: unknown): string =>
  (isObj(v) ? (v.text !== undefined && v.text !== null ? String(v.text) : "an item it couldn't read") : String(v)).slice(0, NOTE_CHARS);

/** A quote's time: seconds, or "1:05" / "1:02:05" as the transcript shows it; undefined when it is neither. */
function seconds(v: unknown): number | undefined {
  if (typeof v === "number") return Number.isFinite(v) && v >= 0 ? v : undefined;
  if (typeof v !== "string") return undefined;
  if (/^\d+(\.\d+)?$/.test(v.trim())) return Number(v.trim());
  const m = /^\[?(?:(\d{1,2}):)?(\d{1,2}):(\d{2})\]?$/.exec(v.trim());
  return m ? Number(m[1] ?? 0) * 3600 + Number(m[2]) * 60 + Number(m[3]) : undefined;
}

/** One quote as the schema takes it, or null when it can't be one (a field it can't support, no words). */
function mendQuote(q: unknown): Record<string, unknown> | null {
  if (!isObj(q) || typeof q.text !== "string" || !q.text.trim()) return null;
  if (typeof q.field !== "string" || !(QUOTE_FIELDS as readonly string[]).includes(q.field)) return null;
  const from = typeof q.from === "string" ? (CAPTION_LIKE.has(q.from) ? "caption" : q.from) : "caption";
  if (!QUOTE_FROM.has(from)) return null;
  const at = seconds(q.at);
  return { field: q.field, text: q.text.slice(0, QUOTE_CHARS), from, ...(at !== undefined ? { at } : {}) };
}

/** One use-when / skip-when item: words alone read as the reader's guess. */
function mendCase(c: unknown): { text: string; evidence: "stated" | "inferred" } | null {
  if (typeof c === "string") return c.trim() ? { text: c.slice(0, CASE_CHARS), evidence: "inferred" } : null;
  if (!isObj(c) || typeof c.text !== "string" || !c.text.trim()) return null;
  return { text: c.text.slice(0, CASE_CHARS), evidence: c.evidence === "stated" ? "stated" : "inferred" };
}

/** A list mended item by item, kept to `max`; what couldn't be kept is noted. */
function mendList<T>(list: unknown, mend: (x: unknown) => T | null, max: number): { kept: T[] | undefined; lost: string[] } {
  if (list === undefined) return { kept: undefined, lost: [] };
  if (!Array.isArray(list)) return { kept: undefined, lost: [note(list)] };
  const kept: T[] = [];
  const lost: string[] = [];
  for (const x of list) {
    const m = mend(x);
    if (m && kept.length < max) kept.push(m);
    else lost.push(note(x));
  }
  return { kept, lost };
}

/**
 * The reply with each move's unknown list values left out, and what went. A list every value of which is unknown is
 * left as it is: the schema refuses it, and its retry names the options (an empty list would say nothing). extract-6's
 * optional fields (quotes, use-when, skip-when, why, speech, an insight's scope) are mended or left out the same way.
 */
export function dropUnknownEnums(raw: unknown): { value: unknown; dropped: DroppedValues[] } {
  if (!isObj(raw) || !Array.isArray(raw.moves)) return { value: raw, dropped: [] };
  const dropped: DroppedValues[] = [];
  let changed = false;
  const moves = raw.moves.map((m, move) => {
    if (!isObj(m)) return m;
    let out = m;
    for (const field of LIST_FIELDS) {
      const list = m[field];
      if (!Array.isArray(list)) continue;
      const known = list.filter((v): v is string => typeof v === "string" && VOCAB[field].has(v));
      if (known.length === list.length || known.length === 0) continue;
      dropped.push({ move, field, values: list.filter((v) => !known.includes(v as string)).map((v) => String(v).slice(0, NOTE_CHARS)) });
      out = { ...out, [field]: known };
    }
    // extract-6's optional fields: mended where the fix is plain, left out item by item where it isn't (final review F4).
    for (const [field, mend, max] of [
      ["quotes", mendQuote, QUOTES_MAX],
      ["useWhen", mendCase, CASES_MAX],
      ["skipWhen", mendCase, CASES_MAX],
    ] as const) {
      if (!(field in m)) continue;
      const { kept, lost } = mendList<unknown>(m[field], mend as (x: unknown) => unknown, max);
      if (lost.length) dropped.push({ move, field, values: lost });
      const { [field]: _old, ...rest } = out;
      out = kept === undefined ? rest : { ...rest, [field]: kept };
      changed = true;
    }
    if ("why" in m) {
      const { why: _why, ...rest } = out;
      out = typeof m.why === "string" ? { ...rest, why: m.why.slice(0, WHY_CHARS) } : rest;
      changed = true;
    }
    return out;
  });
  let value: Record<string, unknown> = dropped.length || changed ? { ...raw, moves } : raw;
  if (typeof raw.speech === "string" && raw.speech.length > SPEECH_CHARS) value = { ...value, speech: raw.speech.slice(0, SPEECH_CHARS) };
  else if (raw.speech !== undefined && typeof raw.speech !== "string") {
    const { speech: _s, ...rest } = value;
    value = rest;
  }
  if (Array.isArray(raw.insights) && raw.insights.some((i) => isObj(i) && !SCOPES.has(String(i.scope)))) {
    // An insight whose scope isn't one of the three stays with its post: never sent to the coach's memory unasked.
    value = { ...value, insights: raw.insights.map((i) => (isObj(i) && !SCOPES.has(String(i.scope)) ? { ...i, scope: "this_routine" } : i)) };
  }
  return { value, dropped };
}
