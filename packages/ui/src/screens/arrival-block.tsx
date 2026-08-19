/**
 * The ceremony card: the arrival queue's celebratory face. One card at a
 * time — species unlocks (laurel burst, serif name, what earned it, a pull
 * to the living plant) and carved grounds (the ground's icon and its
 * ceremony copy). Presentational only; the queue lives in the screen and
 * the selection logic in arrival.ts (spec §3–§4).
 */

import type { GardenSnapshot } from "@rg/garden-engine";
import { IconClose } from "../icons.js";
import { GROUND_CEREMONY_COPY, type ArrivalCeremony } from "./arrival.js";
import { GROUND_META, RARITY_LABEL, SpeciesSpriteCard, type CodexEntry } from "./codex.js";

export function CeremonyCard({
  ceremony,
  codexEntry,
  queueLeft,
  snapshot,
  onSeePlant,
  onDismiss,
  onHighlight,
  variant,
}: {
  ceremony: ArrivalCeremony;
  /** The species' codex entry — required for species ceremonies. */
  codexEntry?: CodexEntry;
  /** How many more ceremonies wait behind this one. */
  queueLeft: number;
  snapshot: GardenSnapshot;
  onSeePlant: (plantId: string) => void;
  onDismiss: () => void;
  /** Lights the plant up IN the scene (outline glow) without opening its
   * sheet — the "taken root" line is the trigger. Optional so older callers
   * keep a plain eyebrow. */
  onHighlight?: (plantId: string) => void;
  variant?: "hud";
}) {
  const isGround = ceremony.kind === "ground";
  const ground = isGround ? GROUND_META[ceremony.ground ?? ""] : undefined;
  const entry = !isGround ? codexEntry : undefined;
  if (!ground && !entry) return null;

  const livePlant = entry
    ? snapshot.plants.find((p) => p.speciesId === entry.speciesId && p.state !== "dead")
    : undefined;

  return (
    <div className={`ceremony${variant === "hud" ? " ceremony-hud" : ""}`} role="status">
      <div className="ceremony-portrait">
        <svg className="ceremony-burst" viewBox="0 0 100 100" aria-hidden="true">
          {/* laurel burst: long teardrop petals, short ones between, and fine
              seed-dots at the tips — gold fading outward */}
          {Array.from({ length: 8 }, (_, i) => (
            <path
              key={`p${i}`}
              d="M50,44 C46.8,34 47.2,24 50,15 C52.8,24 53.2,34 50,44 Z"
              fill="#e0bd5c"
              opacity="0.5"
              transform={`rotate(${i * 45} 50 50)`}
            />
          ))}
          {Array.from({ length: 8 }, (_, i) => (
            <path
              key={`q${i}`}
              d="M50,44 C48,37 48.2,31 50,26 C51.8,31 52,37 50,44 Z"
              fill="#f0d78a"
              opacity="0.6"
              transform={`rotate(${i * 45 + 22.5} 50 50)`}
            />
          ))}
          {Array.from({ length: 8 }, (_, i) => (
            <circle
              key={`d${i}`}
              cx="50"
              cy="11"
              r="1.3"
              fill="#e8c86a"
              opacity="0.7"
              transform={`rotate(${i * 45} 50 50)`}
            />
          ))}
          <circle cx="50" cy="50" r="21" fill="#f7f2dd" opacity="0.88" />
        </svg>
        <span className="ceremony-mote ceremony-mote-1" aria-hidden="true" />
        <span className="ceremony-mote ceremony-mote-2" aria-hidden="true" />
        <span className="ceremony-mote ceremony-mote-3" aria-hidden="true" />
        {entry ? (
          <SpeciesSpriteCard speciesId={entry.speciesId} />
        ) : (
          <span className="ceremony-ground-icon" aria-hidden="true">
            {ground!.icon}
          </span>
        )}
      </div>
      <div className="ceremony-body">
        {entry && livePlant && onHighlight ? (
          <button
            type="button"
            className="ceremony-eyebrow ceremony-eyebrow-btn"
            onClick={() => onHighlight(livePlant.id)}
            title="Light it up in the garden"
          >
            A new species has taken root
          </button>
        ) : (
          <div className="ceremony-eyebrow">
            {entry ? "A new species has taken root" : "New ground carved"}
          </div>
        )}
        <div className="ceremony-name">
          {entry ? entry.name : ground!.name}
          {entry && entry.rarity !== "common" ? (
            <span className={`rarity rarity-${entry.rarity}`}>{RARITY_LABEL[entry.rarity]}</span>
          ) : null}
          {queueLeft > 0 ? <span className="ceremony-extra">{queueLeft} more to come</span> : null}
        </div>
        <div className="ceremony-earned">
          {entry ? entry.hint : (GROUND_CEREMONY_COPY[ceremony.ground ?? ""] ?? "")}
        </div>
        {livePlant ? (
          <button type="button" className="ceremony-see" onClick={() => onSeePlant(livePlant.id)}>
            See it in the garden →
          </button>
        ) : null}
      </div>
      <button type="button" className="ceremony-close" onClick={onDismiss} aria-label="Dismiss">
        <IconClose size={13} />
      </button>
    </div>
  );
}
