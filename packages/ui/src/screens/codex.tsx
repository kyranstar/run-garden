/**
 * Species codex: the collection shelf. Every species in the game appears as a
 * little living sprite card — unlocked ones sway in full color with their
 * counts; locked ones are dark silhouettes with the exact requirement and real
 * progress underneath (the same numbers the engine uses to award them, so a
 * nudge can never lie). This is the garden's gamified heart: always one more
 * reachable thing to grow.
 */

import { useLayoutEffect, useMemo, useRef, useState } from "react";
import type { GardenPlant } from "@rg/domain";
import { SPECIES_BY_ID } from "@rg/garden-engine";
import { PlantSprite } from "@rg/garden-renderer";

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
