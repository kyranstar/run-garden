/**
 * Species codex: the collection shelf. Every species in the game appears as a
 * little living sprite card — unlocked ones sway in full color with their
 * counts; locked ones are dark silhouettes with the exact requirement and real
 * progress underneath (the same numbers the engine uses to award them, so a
 * nudge can never lie). This is the garden's gamified heart: always one more
 * reachable thing to grow.
 */

import { useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import type { GardenPlant } from "@rg/domain";
import { SPECIES_BY_ID, type UnlockGate } from "@rg/garden-engine";
import { PlantSprite } from "@rg/garden-renderer";
import { formatDayShort } from "../components.js";

export interface CodexEntry {
  speciesId: string;
  name: string;
  category: string;
  rarity: "common" | "uncommon" | "rare";
  unlocked: boolean;
  hint: string;
  progress: { current: number; target: number } | null;
  unlockedOn: string | null;
  livingCount: number;
}

export interface WildlifeEntry {
  kind: string;
  present: boolean;
  hint: string;
}

/** A synthetic fully-grown plant so the sprite shows the species at its best. */
function displayPlant(speciesId: string): GardenPlant | null {
  const sp = SPECIES_BY_ID.get(speciesId);
  if (!sp) return null;
  return {
    id: `codex-${speciesId}`,
    speciesId,
    category: sp.category,
    plantedAt: "2026-01-01",
    health: 1,
    hydration: 1,
    maturity: 1,
    bloomProgress: sp.flowers ? 1 : 0,
    state: sp.flowers ? "flowering" : "mature",
    position: { x: 0.5, y: 0.5, region: 0 },
  };
}

export function SpeciesSpriteCard({
  speciesId,
  locked,
  plant: livePlant,
}: {
  speciesId: string;
  locked?: boolean;
  /** Render this actual plant (its real state/maturity) instead of the species at its best. */
  plant?: GardenPlant;
}) {
  const plant = useMemo(() => livePlant ?? displayPlant(speciesId), [livePlant, speciesId]);
  const groupRef = useRef<SVGGElement>(null);
  const [viewBox, setViewBox] = useState<string | null>(null);

  // Sprites vary wildly in extent (weeping willows spread, fungi hug the
  // ground), so a fixed viewBox clips some of them. Measure the real bounding
  // box once rendered and fit to it — sprites are deterministic per id, so the
  // measurement is stable.
  useLayoutEffect(() => {
    const g = groupRef.current;
    if (!g) return;
    try {
      const b = g.getBBox();
      if (b.width > 0 && b.height > 0) {
        const pad = Math.max(b.width, b.height) * 0.1 + 1;
        setViewBox(
          `${(b.x - pad).toFixed(1)} ${(b.y - pad).toFixed(1)} ${(b.width + 2 * pad).toFixed(1)} ${(b.height + 2 * pad).toFixed(1)}`,
        );
      }
    } catch {
      // getBBox throws off-DOM (tests) — the fallback viewBox stands.
    }
  }, [speciesId, livePlant?.id, livePlant?.state]);

  if (!plant) return null;
  const sp = SPECIES_BY_ID.get(speciesId)!;
  const fallback = sp.category === "tree" ? "-20 -48 40 54" : "-14 -28 28 32";
  return (
    <svg
      viewBox={viewBox ?? fallback}
      className={`codex-sprite${locked ? " codex-sprite-locked" : ""}`}
      aria-hidden
      preserveAspectRatio="xMidYMid meet"
    >
      <g ref={groupRef}>
        <PlantSprite plant={plant} animate={!locked} idPrefix={`codex-${speciesId}`} />
      </g>
    </svg>
  );
}

export const RARITY_LABEL = { common: "Common", uncommon: "Uncommon", rare: "Rare" } as const;

export function ProgressBar({ current, target }: { current: number; target: number }) {
  const pct = Math.max(0, Math.min(1, target > 0 ? current / target : 0));
  return (
    <div
      className="codex-progress"
      role="progressbar"
      aria-valuenow={current}
      aria-valuemin={0}
      aria-valuemax={target}
    >
      <span style={{ width: `${Math.round(pct * 100)}%` }} />
    </div>
  );
}

/** "2 of 6" for counters; "8.4 of 21.1 km" for distance gates. */
export function progressText(p: { current: number; target: number }): string {
  if (p.target >= 1000) {
    return `${(p.current / 1000).toFixed(1)} of ${(p.target / 1000).toFixed(1)} km`;
  }
  return `${Math.min(p.current, p.target)} of ${p.target}`;
}

/** Plant families in display order, with the diversity-strip colors. */
export const CATEGORY_ORDER: Array<{ key: string; label: string; color: string }> = [
  { key: "tree", label: "Trees", color: "#4e7a5a" },
  { key: "shrub", label: "Shrubs", color: "#6f9a58" },
  { key: "flower", label: "Flowers", color: "#c98bb0" },
  { key: "fern", label: "Ferns", color: "#5f8f6a" },
  { key: "vine", label: "Vines", color: "#7fa173" },
  { key: "grass", label: "Grasses", color: "#9fb26a" },
  { key: "groundcover", label: "Ground", color: "#8aa06a" },
  { key: "fungus", label: "Fungi", color: "#b0895f" },
];

function rarityClass(rarity: CodexEntry["rarity"]): string {
  return rarity === "common" ? "" : ` codex-${rarity}`;
}

export type NudgeDiscipline = "run" | "strength" | "yoga";

/** Which training axis advances a species' unlock gate, if any single one does. */
export function disciplineOfGate(gate: UnlockGate): NudgeDiscipline | null {
  switch (gate.kind) {
    case "strength_sessions":
      return "strength";
    case "yoga_sessions":
      return "yoga";
    case "quality_runs":
    case "easy_runs":
    case "long_runs":
    case "recovery_runs":
    case "consistent_weeks":
    case "early_runs":
    case "distance_run":
    case "total_runs":
    case "comeback_streak":
      return "run";
    default:
      // start / comeback / dead_wood / mature_trees / balanced_weeks —
      // not something one workout type can chase directly.
      return null;
  }
}

/** Gate kinds a specific planned-workout category actually advances. */
const GATE_KINDS_BY_CATEGORY: Record<string, string[]> = {
  quality: ["quality_runs", "total_runs"],
  race: ["distance_run", "total_runs"],
  long: ["long_runs", "distance_run", "total_runs"],
  easy: ["easy_runs", "total_runs"],
  recovery: ["recovery_runs", "total_runs"],
  strength: ["strength_sessions"],
  yoga: ["yoga_sessions"],
};

function remainingFraction(c: CodexEntry): number {
  return c.progress ? 1 - Math.min(1, c.progress.current / c.progress.target) : 2;
}

/** The nearest locked species each discipline could unlock next. */
export function nextUnlocksByDiscipline(
  codex: CodexEntry[],
): Partial<Record<NudgeDiscipline, CodexEntry>> {
  const out: Partial<Record<NudgeDiscipline, CodexEntry>> = {};
  for (const c of codex) {
    if (c.unlocked || !c.progress) continue;
    const gate = SPECIES_BY_ID.get(c.speciesId)?.unlock;
    const d = gate ? disciplineOfGate(gate) : null;
    if (!d) continue;
    if (!out[d] || remainingFraction(c) < remainingFraction(out[d]!)) out[d] = c;
  }
  return out;
}

/** The nearest locked species that THIS planned workout's category advances. */
export function unlockGrownBy(codex: CodexEntry[], category: string): CodexEntry | null {
  const kinds = GATE_KINDS_BY_CATEGORY[category];
  if (!kinds) return null;
  let best: CodexEntry | null = null;
  for (const c of codex) {
    if (c.unlocked || !c.progress) continue;
    const gate = SPECIES_BY_ID.get(c.speciesId)?.unlock;
    if (!gate || !kinds.includes(gate.kind)) continue;
    if (!best || remainingFraction(c) < remainingFraction(best)) best = c;
  }
  return best;
}

export const NUDGE_DISCIPLINE_LABEL: Record<NudgeDiscipline, string> = {
  run: "Run",
  strength: "Lift",
  yoga: "Yoga",
};

/** A planned workout, reduced to what the landing calculation needs. */
export interface PlannedLite {
  effectiveDate: string;
  category: string;
  /** Anything not completed/skipped/missed counts as still-to-do. */
  pending: boolean;
}

export interface LandingUnlock {
  entry: CodexEntry;
  /** The date whose planned workout crosses the gate. */
  date: string;
  category: string;
  /** "your Nth" — the gate's target count. */
  ordinal: number;
}

/**
 * Which upcoming planned workout actually crosses an unlock gate. Walks the
 * pending plan in date order, decrementing each locked count-gate's remaining
 * as matching workouts pass — honest by construction: a day is only marked
 * when completing the plan up to it truly reaches the target. Distance gates
 * are excluded (we can't know a future run's distance).
 */
export function landingUnlock(
  codex: CodexEntry[],
  planned: PlannedLite[],
  today: string,
): LandingUnlock | null {
  const upcoming = planned
    .filter((w) => w.pending && w.effectiveDate >= today)
    .sort((a, b) => a.effectiveDate.localeCompare(b.effectiveDate));
  if (upcoming.length === 0) return null;

  let best: LandingUnlock | null = null;
  for (const c of codex) {
    if (c.unlocked || !c.progress || c.progress.target >= 1000) continue;
    const gate = SPECIES_BY_ID.get(c.speciesId)?.unlock;
    if (!gate) continue;
    let remaining = Math.max(0, c.progress.target - c.progress.current);
    if (remaining === 0) continue;
    for (const w of upcoming) {
      const kinds = GATE_KINDS_BY_CATEGORY[w.category];
      if (!kinds?.includes(gate.kind)) continue;
      remaining -= 1;
      if (remaining === 0) {
        if (!best || w.effectiveDate < best.date) {
          best = { entry: c, date: w.effectiveDate, category: w.category, ordinal: c.progress.target };
        }
        break;
      }
    }
  }
  return best;
}

/**
 * "The best next thing", per axis: one row per discipline showing the species
 * that workout type would unlock soonest. Every row opens the species card.
 */
export function DisciplineNudges({
  codex,
  onOpenSpecies,
}: {
  codex: CodexEntry[];
  onOpenSpecies?: (speciesId: string) => void;
}) {
  const trio = nextUnlocksByDiscipline(codex);
  const rows = (["run", "strength", "yoga"] as const)
    .map((d) => ({ d, c: trio[d] }))
    .filter((r): r is { d: NudgeDiscipline; c: CodexEntry } => !!r.c);
  if (rows.length === 0) return null;
  return (
    <div className="nudges" aria-label="Next unlock per workout type">
      {rows.map(({ d, c }) => {
        const p = c.progress!;
        const remaining = Math.max(0, p.target - p.current);
        const closing =
          p.target >= 1000
            ? c.hint
            : remaining === 1
              ? `1 more — ${c.hint.toLowerCase()}`
              : `${remaining} more to go — ${c.hint.toLowerCase()}`;
        return (
          <button
            type="button"
            className="nudge-row nudge-btn"
            key={c.speciesId}
            onClick={() => onOpenSpecies?.(c.speciesId)}
          >
            <SpeciesSpriteCard speciesId={c.speciesId} locked />
            <div className="nudge-body">
              <div className="nudge-title">
                <span className={`nudge-disc nudge-disc-${d}`}>{NUDGE_DISCIPLINE_LABEL[d]}</span>
                {c.name}
                {c.rarity !== "common" ? (
                  <span className={`rarity rarity-${c.rarity}`}>{RARITY_LABEL[c.rarity]}</span>
                ) : null}
              </div>
              <div className="codex-sub">{closing}</div>
              <ProgressBar current={p.current} target={p.target} />
            </div>
          </button>
        );
      })}
    </div>
  );
}

function isNewUnlock(c: CodexEntry, today?: string): boolean {
  if (!today || !c.unlockedOn || !c.unlocked) return false;
  const days = (Date.parse(today) - Date.parse(c.unlockedOn)) / 86_400_000;
  return days >= 0 && days <= 7;
}

/**
 * The collection, organized as a field guide: one section per family, each
 * holding its unlocked species, the one or two nearest locked ("next up",
 * full card with the earn hint visible), and the distant rest compressed to
 * small silhouettes. Every tile opens the species' botanical card.
 */
export function SpeciesCodex({
  codex,
  today,
  onOpenSpecies,
}: {
  codex: CodexEntry[];
  /** Today's ISO date — powers the "New" ring on recent unlocks. */
  today?: string;
  onOpenSpecies?: (speciesId: string) => void;
}) {
  const nearestFirst = (a: CodexEntry, b: CodexEntry) => {
    const ra = a.progress ? 1 - Math.min(1, a.progress.current / a.progress.target) : 2;
    const rb = b.progress ? 1 - Math.min(1, b.progress.current / b.progress.target) : 2;
    return ra - rb;
  };
  return (
    <div className="codex">
      {CATEGORY_ORDER.map((fam) => {
        const entries = codex.filter((c) => c.category === fam.key);
        if (entries.length === 0) return null;
        const unlocked = entries.filter((c) => c.unlocked);
        const locked = entries.filter((c) => !c.unlocked).sort(nearestFirst);
        const nextUp = locked.slice(0, 2);
        const distant = locked.slice(2);
        return (
          <section key={fam.key} className="codex-fam" aria-label={fam.label}>
            <div className="codex-fam-head">
              <span className="dot" style={{ background: fam.color }} aria-hidden />
              <span className="codex-fam-name">{fam.label}</span>
              <span className="codex-fam-count">
                {unlocked.length} of {entries.length}
              </span>
            </div>
            <div className="codex-grid">
              {unlocked.map((c) => (
                <button
                  type="button"
                  className={`codex-card${rarityClass(c.rarity)}`}
                  key={c.speciesId}
                  onClick={() => onOpenSpecies?.(c.speciesId)}
                >
                  {isNewUnlock(c, today) ? <span className="codex-newring">New</span> : null}
                  <SpeciesSpriteCard speciesId={c.speciesId} />
                  <div className="codex-name">{c.name}</div>
                  <div className="codex-sub">
                    {c.livingCount > 0 ? `${c.livingCount} living` : "collected"}
                    {c.rarity !== "common" ? ` · ${RARITY_LABEL[c.rarity]}` : ""}
                  </div>
                </button>
              ))}
              {nextUp.map((c) => (
                <button
                  type="button"
                  className={`codex-card codex-locked codex-next${rarityClass(c.rarity)}`}
                  key={c.speciesId}
                  onClick={() => onOpenSpecies?.(c.speciesId)}
                >
                  <SpeciesSpriteCard speciesId={c.speciesId} locked />
                  <div className="codex-name">{c.name}</div>
                  <div className="codex-sub">{c.hint}</div>
                  {c.progress ? (
                    <>
                      <ProgressBar current={c.progress.current} target={c.progress.target} />
                      <div className="codex-sub faint">{progressText(c.progress)}</div>
                    </>
                  ) : null}
                </button>
              ))}
            </div>
            {distant.length > 0 ? (
              <div className="codex-minirow">
                {distant.map((c) => (
                  <button
                    type="button"
                    className="codex-mini"
                    key={c.speciesId}
                    onClick={() => onOpenSpecies?.(c.speciesId)}
                  >
                    <SpeciesSpriteCard speciesId={c.speciesId} locked />
                    <span className="codex-mini-name">{c.name}</span>
                  </button>
                ))}
              </div>
            ) : null}
          </section>
        );
      })}
    </div>
  );
}

/** The explicit pull: "1 more long run and the Creek willow arrives." */
export function NextUnlockNudges({ nudges }: { nudges: CodexEntry[] }) {
  if (nudges.length === 0) return null;
  return (
    <div className="nudges" aria-label="Next species to unlock">
      {nudges.map((n) => {
        const p = n.progress!;
        const remaining = Math.max(0, p.target - p.current);
        const closing =
          p.target >= 1000
            ? n.hint
            : remaining === 1
              ? `1 more — ${n.hint.toLowerCase()}`
              : `${remaining} more to go — ${n.hint.toLowerCase()}`;
        return (
          <div className="nudge-row" key={n.speciesId}>
            <SpeciesSpriteCard speciesId={n.speciesId} locked />
            <div className="nudge-body">
              <div className="nudge-title">
                {n.name}
                {n.rarity !== "common" ? (
                  <span className={`rarity rarity-${n.rarity}`}>{RARITY_LABEL[n.rarity]}</span>
                ) : null}
              </div>
              <div className="codex-sub">{closing}</div>
              <ProgressBar current={p.current} target={p.target} />
            </div>
          </div>
        );
      })}
    </div>
  );
}

const WILDLIFE_EMOJI: Record<string, string> = {
  birds: "🐦",
  bees: "🐝",
  butterflies: "🦋",
  fireflies: "✨",
  squirrels: "🐿️",
  rabbits: "🐰",
  frogs: "🐸",
  dragonflies: "💠",
  ladybugs: "🐞",
};

export function WildlifeShelf({ wildlife }: { wildlife: WildlifeEntry[] }) {
  const [openKind, setOpenKind] = useState<string | null>(null);
  if (wildlife.length === 0) return null;
  const here = wildlife.filter((w) => w.present);
  const open = wildlife.find((w) => w.kind === openKind);
  return (
    <div className="wildlife-shelf">
      <div className="codex-sub" style={{ marginBottom: "0.35rem" }}>
        Wildlife — {here.length === 0 ? "none visiting yet" : `${here.length} visiting`}
      </div>
      <div className="wildlife-row">
        {wildlife.map((w) => (
          <button
            type="button"
            key={w.kind}
            className={`wildlife-chip${w.present ? "" : " wildlife-away"}`}
            aria-expanded={openKind === w.kind}
            onClick={() => setOpenKind(openKind === w.kind ? null : w.kind)}
          >
            <span aria-hidden>{WILDLIFE_EMOJI[w.kind] ?? "•"}</span> {w.kind}
          </button>
        ))}
      </div>
      {open ? (
        <p className="codex-sub wildlife-hint">
          {open.present ? `${cap(open.kind)} are visiting right now.` : open.hint}
        </p>
      ) : null}
    </div>
  );
}

function cap(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

/* ── Earned grounds ───────────────────────────────────────────────────── */

export interface GroundEntry {
  region: number;
  kind: string;
  earnedDate: string;
}

export const GROUND_META: Record<string, { name: string; cause: string; icon: ReactNode }> = {
  meadow: {
    name: "New meadow",
    cause: "steady running",
    icon: (
      <svg width="34" height="20" viewBox="0 0 34 20" aria-hidden>
        <path d="M0,12 C10,8 24,9 34,12 L34,20 L0,20 Z" fill="#9dbb7f" />
        <circle cx="10" cy="14" r="1.4" fill="#c98bb0" />
        <circle cx="22" cy="16" r="1.2" fill="#e0b23e" />
        <circle cx="28" cy="14" r="1.2" fill="#c86f5a" />
      </svg>
    ),
  },
  stream: {
    name: "The Stream",
    cause: "carved by long runs",
    icon: (
      <svg width="34" height="20" viewBox="0 0 34 20" aria-hidden>
        <path d="M0,12 C10,8 24,9 34,12 L34,20 L0,20 Z" fill="#9dbb7f" />
        <path d="M18,12 C22,14 24,17 24,20 L31,20 C31,16 28,13 32,12 L34,12 L34,20 L18,20 Z" fill="#8fb7c9" />
      </svg>
    ),
  },
  terrace: {
    name: "The Stone Terrace",
    cause: "built by strength work",
    icon: (
      <svg width="34" height="20" viewBox="0 0 34 20" aria-hidden>
        <path d="M0,12 C10,8 24,9 34,12 L34,20 L0,20 Z" fill="#9dbb7f" />
        <rect x="17" y="10" width="11" height="3.4" rx="1.4" fill="#8a7455" />
        <rect x="20" y="14.4" width="11" height="3.4" rx="1.4" fill="#9a8465" />
      </svg>
    ),
  },
  glade: {
    name: "The Still Glade",
    cause: "cleared by steady yoga",
    icon: (
      <svg width="34" height="20" viewBox="0 0 34 20" aria-hidden>
        <path d="M0,12 C10,8 24,9 34,12 L34,20 L0,20 Z" fill="#9dbb7f" />
        <ellipse cx="24" cy="15" rx="6" ry="3" fill="#b7cf9a" opacity="0.9" />
        <circle cx="24" cy="15" r="1.3" fill="#f2ede0" />
      </svg>
    ),
  },
};

const GROUND_LOCKED_HINTS: Array<{ kind: string; hint: string }> = [
  { kind: "stream", hint: "A long-run-led training block carves it when the garden next expands." },
  { kind: "terrace", hint: "A strength-led block builds it at the next expansion." },
  { kind: "glade", hint: "A yoga-led block clears it at the next expansion." },
];

/**
 * The grounds the garden has grown into — each names its cause and date.
 * Unearned ground kinds show as dashed cards with an honest hint.
 */
export function GroundsShelf({ grounds }: { grounds: GroundEntry[] }) {
  const [openKind, setOpenKind] = useState<string | null>(null);
  const earnedKinds = new Set(grounds.map((g) => g.kind));
  const locked = GROUND_LOCKED_HINTS.filter((l) => !earnedKinds.has(l.kind));
  const open = locked.find((l) => l.kind === openKind);
  return (
    <div className="wildlife-shelf">
      <div className="codex-sub" style={{ marginBottom: "0.35rem" }}>
        Grounds — how the garden grew
      </div>
      <div className="visitor-row">
        <div className="visitor-card" style={{ cursor: "default" }}>
          {GROUND_META.meadow!.icon}
          <span className="visitor-name">First Meadow</span>
          <span className="visitor-sub">from the start</span>
        </div>
        {grounds.map((g) => {
          const meta = GROUND_META[g.kind] ?? GROUND_META.meadow!;
          return (
            <div key={g.region} className="visitor-card" style={{ cursor: "default" }}>
              {meta.icon}
              <span className="visitor-name">{meta.name}</span>
              <span className="visitor-sub">
                {meta.cause} · {formatDayShort(g.earnedDate)}
              </span>
            </div>
          );
        })}
        {locked.map((l) => (
          <button
            type="button"
            key={l.kind}
            className="visitor-card visitor-unseen"
            aria-expanded={openKind === l.kind}
            onClick={() => setOpenKind(openKind === l.kind ? null : l.kind)}
          >
            {GROUND_META[l.kind]!.icon}
            <span className="visitor-name">{GROUND_META[l.kind]!.name}</span>
            <span className="visitor-sub">not yet</span>
          </button>
        ))}
      </div>
      {open ? <p className="codex-sub wildlife-hint">{open.hint}</p> : null}
    </div>
  );
}

/* ── Rare visitors ─────────────────────────────────────────────────────── */

export interface VisitorEntry {
  kind: string;
  count: number;
  lastSeen: string | null;
  hint: string;
}

const VISITOR_ICONS: Record<string, ReactNode> = {
  deer: (
    <svg width="32" height="24" viewBox="0 0 32 24" aria-hidden>
      <g fill="currentColor" transform="translate(13 14)">
        <path d="M-7,-1 C-6.2,-4 -2,-5.2 2,-4.8 C4.6,-4.5 6.2,-3.2 6.6,-1.6 C7,-0.2 6,1.4 4,1.9 L-4,2 C-6,1.6 -7.5,0.6 -7,-1 Z" />
        <path d="M4.8,-3 C6,-4.6 7,-6.6 7.5,-8.6 L9.8,-8 C9.4,-6 8.9,-4 7.9,-2.2 Z" />
        <circle cx={9.4} cy={-9.2} r={1.6} />
        <path d="M10.8,-10.1 L12.8,-9.2 L10.8,-8.2 Z" />
        <path
          d="M8.6,-10.6 C8.4,-12.6 8.9,-14.2 10.2,-15.2 M9.1,-13 L7.8,-14.3 M9.9,-10.4 C10.5,-12.2 11.5,-13.4 12.8,-14 M10.7,-12.4 L12,-13"
          stroke="currentColor"
          strokeWidth={0.8}
          fill="none"
          strokeLinecap="round"
        />
        <path
          d="M-4.6,1.8 L-5.4,8 M-1.8,2 L-2,8 M2.6,2 L2.9,8 M5.2,1.4 L6.3,7.8"
          stroke="currentColor"
          strokeWidth={1.1}
          strokeLinecap="round"
          fill="none"
        />
        <path d="M-7,-1.4 C-8.2,-2 -8.4,-3 -7.6,-3.8 C-7.2,-3 -7,-2.2 -7,-1.4 Z" />
      </g>
    </svg>
  ),
  heron: (
    <svg width="32" height="24" viewBox="0 0 32 24" aria-hidden>
      <g transform="translate(14 15)">
        <path d="M-5,0 C-5,-2.6 -2.6,-4.4 0.6,-4.4 C3.6,-4.4 5.6,-2.6 5.6,-0.6 C5.6,1.8 3.2,3.4 0,3.4 C-2.6,3.4 -5,2.2 -5,0 Z" fill="currentColor" />
        <path
          d="M4.4,-2.6 C6.8,-3.8 7.4,-6.2 6.2,-8 C5.2,-9.6 5.6,-11.2 6.8,-12.4"
          stroke="currentColor"
          strokeWidth={1.6}
          fill="none"
          strokeLinecap="round"
        />
        <circle cx={7.2} cy={-13} r={1.5} fill="currentColor" />
        <path d="M8.5,-13.4 L12.4,-12.5 L8.6,-11.7 Z" fill="currentColor" />
        <path d="M6,-14 L4.7,-15.3" stroke="currentColor" strokeWidth={0.7} strokeLinecap="round" />
        <path
          d="M-0.6,3.4 L-0.6,9.6 M2.2,3.2 L2.9,6.8 L2.7,9.6"
          stroke="currentColor"
          strokeWidth={0.9}
          strokeLinecap="round"
          fill="none"
        />
      </g>
    </svg>
  ),
  owl: (
    <svg width="32" height="24" viewBox="0 0 32 24" aria-hidden>
      <g transform="translate(16 13)">
        <path d="M-6,7.4 L6,7.9" stroke="currentColor" strokeWidth={1.1} strokeLinecap="round" opacity={0.7} />
        <path d="M0,7 C-3.6,7 -5.2,3.6 -4.8,-0.6 C-4.4,-4 -2.4,-6.2 0,-6.2 C2.4,-6.2 4.4,-4 4.8,-0.6 C5.2,3.6 3.6,7 0,7 Z" fill="currentColor" />
        <path d="M-4.4,-3 C-5,-5 -4.6,-6.8 -3.2,-8 L-2.2,-5.4 Z M4.4,-3 C5,-5 4.6,-6.8 3.2,-8 L2.2,-5.4 Z" fill="currentColor" />
        <circle cx={-1.6} cy={-3.4} r={1.5} fill="#fff" opacity={0.9} />
        <circle cx={1.6} cy={-3.4} r={1.5} fill="#fff" opacity={0.9} />
        <circle cx={-1.6} cy={-3.4} r={0.6} fill="currentColor" />
        <circle cx={1.6} cy={-3.4} r={0.6} fill="currentColor" />
      </g>
    </svg>
  ),
  fox: (
    <svg width="32" height="24" viewBox="0 0 32 24" aria-hidden>
      <g fill="currentColor" transform="translate(15 14)">
        <path d="M-6,-2.6 C-9.6,-5 -13.2,-4.4 -14.4,-1.8 C-15.2,0 -13.6,1.8 -11.2,1.5 C-8.8,1.2 -7,0 -6,-1 Z" />
        <path d="M-6,1.2 C-6.6,-1.2 -4,-3.4 0,-3.4 C3.2,-3.4 5.8,-2.2 6.4,-0.4 C7,1.2 5.8,2.6 3.2,2.9 L-3.2,2.9 C-4.8,2.8 -5.8,2.2 -6,1.2 Z" />
        <path d="M5.8,-1.2 C5.8,-3 7,-4.2 8.6,-4.2 C9.6,-4.2 10.4,-3.7 10.9,-3 L13.2,-2 L10.8,-1.1 C10.2,-0.3 9,0 8,-0.3 C6.6,-0.6 5.8,-0.6 5.8,-1.2 Z" />
        <path d="M7,-4 L6.6,-6.4 L8.6,-4.7 Z M9.4,-4.1 L10.5,-6.1 L10.8,-3.9 Z" />
        <path
          d="M-3.2,2.9 L-3.5,6.6 M-0.4,3 L-0.4,6.6 M2.6,2.9 L2.9,6.6 M5,2 L6,6.4"
          stroke="currentColor"
          strokeWidth={1.1}
          strokeLinecap="round"
          fill="none"
        />
      </g>
    </svg>
  ),
};

/**
 * The rare-visitors shelf: a second, smaller collection. Seen visitors show
 * their tally; unseen ones reveal their honest arrival hint on tap.
 */
export function VisitorsShelf({ visitors }: { visitors: VisitorEntry[] }) {
  const [openKind, setOpenKind] = useState<string | null>(null);
  if (visitors.length === 0) return null;
  const seen = visitors.filter((v) => v.count > 0);
  const open = visitors.find((v) => v.kind === openKind);
  return (
    <div className="wildlife-shelf">
      <div className="codex-sub" style={{ marginBottom: "0.35rem" }}>
        Rare visitors — {seen.length === 0 ? "none seen yet" : `${seen.length} of ${visitors.length} seen`}
      </div>
      <div className="visitor-row">
        {visitors.map((v) => (
          <button
            type="button"
            key={v.kind}
            className={`visitor-card${v.count > 0 ? "" : " visitor-unseen"}`}
            aria-expanded={openKind === v.kind}
            onClick={() => setOpenKind(openKind === v.kind ? null : v.kind)}
          >
            {VISITOR_ICONS[v.kind] ?? null}
            <span className="visitor-name">{cap(v.kind)}</span>
            <span className="visitor-sub">
              {v.count > 0
                ? `seen ${v.count}×${v.lastSeen ? ` · ${formatDayShort(v.lastSeen)}` : ""}`
                : "not yet"}
            </span>
          </button>
        ))}
      </div>
      {open ? <p className="codex-sub wildlife-hint">{open.hint}</p> : null}
    </div>
  );
}
