/**
 * Species codex: the collection shelf. Every species in the game appears as a
 * little living sprite card — unlocked ones sway in full color with their
 * counts; locked ones are dark silhouettes with the exact requirement and real
 * progress underneath (the same numbers the engine uses to award them, so a
 * nudge can never lie). This is the garden's gamified heart: always one more
 * reachable thing to grow.
 */

import { useMemo, useState } from "react";
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

export function SpeciesSpriteCard({ speciesId, locked }: { speciesId: string; locked?: boolean }) {
  const plant = useMemo(() => displayPlant(speciesId), [speciesId]);
  if (!plant) return null;
  const sp = SPECIES_BY_ID.get(speciesId)!;
  // Trees are tall, flowers small — one grounded viewBox fits everything.
  const tall = sp.category === "tree";
  return (
    <svg
      viewBox={tall ? "-18 -46 36 50" : "-12 -26 24 29"}
      className={`codex-sprite${locked ? " codex-sprite-locked" : ""}`}
      aria-hidden
      preserveAspectRatio="xMidYMax meet"
    >
      <PlantSprite plant={plant} animate={!locked} idPrefix={`codex-${speciesId}`} />
    </svg>
  );
}

const RARITY_LABEL = { common: "Common", uncommon: "Uncommon", rare: "Rare" } as const;

function ProgressBar({ current, target }: { current: number; target: number }) {
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
function progressText(p: { current: number; target: number }): string {
  if (p.target >= 1000) {
    return `${(p.current / 1000).toFixed(1)} of ${(p.target / 1000).toFixed(1)} km`;
  }
  return `${Math.min(p.current, p.target)} of ${p.target}`;
}

export function SpeciesCodex({ codex }: { codex: CodexEntry[] }) {
  const [showLocked, setShowLocked] = useState(true);
  const unlocked = codex.filter((c) => c.unlocked);
  const locked = codex.filter((c) => !c.unlocked);
  // Locked entries sorted nearest-first so the shelf pulls you forward.
  const lockedSorted = [...locked].sort((a, b) => {
    const ra = a.progress ? 1 - Math.min(1, a.progress.current / a.progress.target) : 2;
    const rb = b.progress ? 1 - Math.min(1, b.progress.current / b.progress.target) : 2;
    return ra - rb;
  });

  return (
    <div className="codex">
      <div className="codex-grid">
        {unlocked.map((c) => (
          <div className="codex-card" key={c.speciesId} title={`${c.name} — ${c.hint}`}>
            <SpeciesSpriteCard speciesId={c.speciesId} />
            <div className="codex-name">{c.name}</div>
            <div className="codex-sub">
              {c.livingCount > 0 ? `${c.livingCount} living` : "collected"}
              {c.rarity !== "common" ? ` · ${RARITY_LABEL[c.rarity]}` : ""}
            </div>
          </div>
        ))}
      </div>
      {locked.length > 0 ? (
        <>
          <button
            type="button"
            className="linklike codex-toggle"
            onClick={() => setShowLocked((v) => !v)}
          >
            {showLocked ? "Hide" : "Show"} {locked.length} still to discover
          </button>
          {showLocked ? (
            <div className="codex-grid">
              {lockedSorted.map((c) => (
                <div className="codex-card codex-locked" key={c.speciesId} title={c.hint}>
                  <SpeciesSpriteCard speciesId={c.speciesId} locked />
                  <div className="codex-name">{c.name}</div>
                  <div className="codex-sub">{c.hint}</div>
                  {c.progress ? (
                    <>
                      <ProgressBar current={c.progress.current} target={c.progress.target} />
                      <div className="codex-sub faint">{progressText(c.progress)}</div>
                    </>
                  ) : null}
                </div>
              ))}
            </div>
          ) : null}
        </>
      ) : null}
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
  if (wildlife.length === 0) return null;
  const here = wildlife.filter((w) => w.present);
  return (
    <div className="wildlife-shelf">
      <div className="codex-sub" style={{ marginBottom: "0.35rem" }}>
        Wildlife — {here.length === 0 ? "none visiting yet" : `${here.length} visiting`}
      </div>
      <div className="wildlife-row">
        {wildlife.map((w) => (
          <span
            key={w.kind}
            className={`wildlife-chip${w.present ? "" : " wildlife-away"}`}
            title={w.present ? `${w.kind} are here` : w.hint}
          >
            <span aria-hidden>{WILDLIFE_EMOJI[w.kind] ?? "•"}</span> {w.kind}
          </span>
        ))}
      </div>
    </div>
  );
}
