import { PROFILES } from "./conditions/index.js";
import type { ConditionProfile } from "./conditions/types.js";
import { coreFamilyOf, eligible, flareSafe } from "./eligibility.js";
import type { EngineData } from "./engine-data.js";
import { LOCATION_PRESETS, type LocationPreset } from "./equipment.js";
import {
  DOSE_TYPES, EQUIPMENT_IDS, LATERALITY, LOAD_IMPLEMENTS, LOADS, MODE_IDS, PATTERNS, POSITIONS, REGIONS, ROLES, type Mode,
} from "./vocab.js";

// Every problem in the library, themes, formats and coverage as "<id>: <message>". Empty means valid.
// Ports the standalone Lib.validate, plus: every known condition profile rates every record and has a note
// on it, no record carries provenance, and every block a mode uses has real choices at every preset.

const TEXT_STRINGS = ["summary", "breathing", "why"] as const;
const TEXT_LISTS = ["setup", "steps", "focus", "mistakes"] as const;
// Assembled from parts so the repository-wide privacy grep doesn't match this guard itself.
const PROVENANCE = new RegExp(["http", "www\\.", ["insta", "gram"].join(""), "@"].join("|"), "i");

const inList = (list: readonly string[], value: unknown): boolean => typeof value === "string" && list.includes(value);

export interface ValidateOptions {
  /** Location presets to check coverage at (default: the library's presets; `[]` skips coverage). */
  presets?: readonly LocationPreset[];
  /** Profiles every record must be rated for (default: every profile the library knows). */
  profiles?: readonly ConditionProfile[];
}

export function validateLibrary(data: EngineData, options: ValidateOptions = {}): string[] {
  const errors: string[] = [];
  const err = (id: string, msg: string) => errors.push(`${id}: ${msg}`);
  const inVocab = (id: string, field: string, value: unknown, list: readonly string[]) => {
    if (!inList(list, value)) err(id, `${field} "${String(value)}" is not in the vocabulary`);
  };
  const profiles = options.profiles ?? Object.values(PROFILES);
  const ids = new Set<string>();

  for (const ex of data.exercises) {
    const id = ex.id || "(missing id)";
    if (!/^[a-z][A-Za-z0-9]*$/.test(ex.id || "")) err(id, "id must be camelCase");
    if (ids.has(ex.id)) err(id, "duplicate id");
    ids.add(ex.id);
    if (!ex.name) err(id, "missing name");
    if (!ex.family) err(id, "missing family");
    const lists: Array<[string, unknown, readonly string[]]> = [["pattern", ex.patterns, PATTERNS], ["region", ex.regions, REGIONS], ["role", ex.roles, ROLES]];
    for (const [field, list, vocab] of lists) {
      if (!Array.isArray(list) || !list.length) err(id, `needs at least one ${field}`);
      else for (const v of list) inVocab(id, field, v, vocab);
    }
    inVocab(id, "position", ex.position, POSITIONS);
    inVocab(id, "laterality", ex.laterality, LATERALITY);
    inVocab(id, "load", ex.load, LOADS);
    const gear: string[] = [...(ex.equipment?.all ?? []), ...(ex.equipment?.oneOf ?? [])];
    for (const i of gear) inVocab(id, "equipment", i, EQUIPMENT_IDS);

    const d = (ex.dose ?? {}) as { type?: unknown; range?: unknown; sets?: unknown };
    inVocab(id, "dose.type", d.type, DOSE_TYPES);
    const range = d.range as number[] | undefined;
    if (!Array.isArray(range) || range.length !== 2 || !((range[0] ?? 0) > 0) || (range[0] ?? 0) > (range[1] ?? 0)) err(id, "dose.range must be [low, high] with 0 < low ≤ high");
    const sets = d.sets as number[] | undefined;
    if (sets && (!Array.isArray(sets) || sets.length !== 2 || (sets[0] ?? 0) < 1 || (sets[0] ?? 0) > (sets[1] ?? 0))) err(id, "dose.sets must be [min, max] with 1 ≤ min ≤ max");
    if (ex.load === "external") {
      if (d.type !== "reps" && d.type !== "carry") err(id, "external load needs reps or carry dosing");
      if (!gear.some(i => inList(LOAD_IMPLEMENTS, i))) err(id, "external load needs a loadable implement");
    }
    if ((ex.roles || []).includes("core") && ex.load === "none") err(id, "core lifts must be logged (load external or bodyweight)");

    // Every known profile rates every record, on each attribute's own scale.
    const conditions = (ex.conditions ?? {}) as Record<string, unknown>;
    for (const p of profiles) {
      const a = conditions[p.id];
      if (!a || typeof a !== "object") { err(id, `conditions.${p.id} is missing`); continue; }
      const attrs = a as Record<string, unknown>;
      for (const [k, spec] of Object.entries(p.attributes)) {
        const v = attrs[k];
        if (spec.kind === "scale") {
          if (typeof v !== "number" || !Number.isInteger(v) || v < spec.min || v > spec.max) err(id, `conditions.${p.id}.${k} must be ${spec.min}–${spec.max}`);
        } else if (typeof v !== "boolean") err(id, `conditions.${p.id}.${k} must be true or false`);
      }
      for (const k of Object.keys(attrs)) if (!(k in p.attributes)) err(id, `conditions.${p.id}.${k} is not an attribute of "${p.id}"`);
    }
    for (const k of Object.keys(conditions)) if (!profiles.some(p => p.id === k)) err(id, `conditions.${k} is not a known condition profile`);
    if (![1, 2, 3, 4, 5].includes(ex.difficulty)) err(id, "difficulty must be 1–5");

    const t = (ex.text ?? {}) as unknown as Record<string, unknown>;
    for (const f of TEXT_STRINGS) {
      const s = t[f];
      if (typeof s !== "string" || !s.trim()) err(id, `text.${f} is required`);
    }
    for (const f of TEXT_LISTS) {
      const l = t[f];
      if (!Array.isArray(l) || !l.length || l.some(s => typeof s !== "string" || !s.trim())) err(id, `text.${f} needs at least one line`);
    }
    const notes = (t.conditions ?? {}) as Record<string, unknown>;
    for (const p of profiles) {
      const note = notes[p.id];
      if (typeof note !== "string" || !note.trim()) err(id, `text.conditions.${p.id} is required`);
    }

    // A COROS mapping names a catalog T-code, never a per-account catalog id or a name (Phase 3, spec §2).
    const coros = ex.providers?.coros;
    if (coros && !/^T\d{4}$/.test(String(coros.key))) err(id, `providers.coros.key "${String(coros.key)}" is not a COROS T-code`);

    // Provenance is private (spec §3.1): never a sources field, a link, or a creator handle.
    if ("sources" in ex) err(id, "sources are private and never part of the library");
    if (PROVENANCE.test(JSON.stringify(ex))) err(id, "carries a link or a handle (provenance stays private)");
  }

  for (const ex of data.exercises) {
    for (const [kind, list] of [["easier", ex.easier], ["harder", ex.harder]] as const) {
      for (const n of list ?? []) {
        if (n === ex.id) err(ex.id, "links to itself");
        else if (!ids.has(n)) err(ex.id, `${kind} link "${n}" does not exist`);
      }
    }
  }

  const formatIds = data.formats.map(f => f.id as string);
  for (const f of data.formats) {
    for (const r of f.roles) if (!inList(ROLES, r)) errors.push(`format ${f.id}: role "${r}" is not in the vocabulary`);
    for (const l of f.loads) if (!inList(LOADS, l)) errors.push(`format ${f.id}: load "${l}" is not in the vocabulary`);
    for (const d of f.doseTypes) if (!inList(DOSE_TYPES, d)) errors.push(`format ${f.id}: dose type "${d}" is not in the vocabulary`);
  }
  for (const th of data.themes) {
    const tid = `theme ${th.id}`;
    for (const m of th.modes) if (!inList(MODE_IDS, m)) errors.push(`${tid}: mode "${m}" is not in the vocabulary`);
    for (const p of Object.keys(th.emphasis.patterns ?? {})) if (!inList(PATTERNS, p)) errors.push(`${tid}: pattern "${p}" is not in the vocabulary`);
    for (const r of Object.keys(th.emphasis.regions ?? {})) if (!inList(REGIONS, r)) errors.push(`${tid}: region "${r}" is not in the vocabulary`);
    for (const f of th.formats) if (!formatIds.includes(f)) errors.push(`${tid}: unknown format "${f}"`);
    for (const c of th.coreBias ?? []) if (!data.coreFamilies.some(x => x.id === c)) errors.push(`${tid}: unknown core family "${c}"`);
    if (th.profile && !(th.profile in PROFILES)) errors.push(`${tid}: unknown condition profile "${th.profile}"`);
  }

  for (const loc of options.presets ?? LOCATION_PRESETS) {
    for (const mode of MODE_IDS) for (const problem of coverageProblems(data, loc, mode)) errors.push(`coverage ${loc.id} ${mode}: ${problem}`);
  }
  return errors;
}

/**
 * Every block a mode uses has real choices at this location: at least 3 candidates per timed block, an
 * option for every core family when the mode has core lifts, and nothing unsafe on a flare day in recovery.
 */
export function coverageProblems(data: EngineData, loc: Pick<LocationPreset, "equipment">, mode: Mode): string[] {
  const problems: string[] = [];
  const ok = data.exercises.filter(ex => eligible(data, ex, { equipment: loc.equipment, mode }));
  for (const [block, share] of Object.entries(data.skeleton.shares[mode])) {
    if (!share || block === "core") continue;
    const roles: readonly string[] = data.skeleton.blocks[block as keyof typeof data.skeleton.blocks]?.roles ?? [];
    const n = ok.filter(ex => ex.roles.some(r => roles.includes(r))).length;
    if (n < 3) problems.push(`${block} has ${n} candidates`);
  }
  if (data.modes[mode].coreCount[1]) {
    for (const fam of data.coreFamilies) {
      if (!ok.some(ex => coreFamilyOf(data, ex) === fam.id)) problems.push(`core family ${fam.id} has no option`);
    }
  }
  if (mode === "recovery") for (const ex of ok) if (!flareSafe(data, ex)) problems.push(`${ex.id} is not flare-safe`);
  return problems;
}
