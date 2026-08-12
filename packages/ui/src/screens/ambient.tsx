/**
 * Ambient garden — a full-bleed, chrome-free, look-only garden for the desktop
 * app's screensaver window. It renders the same GardenScene the website uses,
 * with the sun/moon tracking the local wall clock, and refreshes itself quietly.
 *
 * Data is injected via `fetchGarden` (the desktop wires this to the device's
 * signed cloud read) so this component stays free of any transport concern. It
 * never shows an error state: a failed refresh keeps the last-good garden on
 * screen, because an ambient display that flashes an error is worse than a
 * slightly stale one.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  GARDEN_CONDITION_LABELS,
  type GardenConditionWord,
  type GardenWeatherState,
} from "@rg/domain";
import type { GardenSnapshot } from "@rg/garden-engine";
import { GardenScene } from "@rg/garden-renderer";

export interface AmbientGardenView {
  snapshot: GardenSnapshot;
  condition: GardenConditionWord | string;
  species: Array<{
    speciesId: string;
    name: string;
    category?: string;
    rarity?: string;
    unlockedOn: string;
    livingCount: number;
  }>;
}

export interface AmbientGardenProps {
  /** Fetch the current garden (desktop: the device's signed cloud read). */
  fetchGarden: () => Promise<AmbientGardenView>;
  /** Close the ambient window (Esc or a click anywhere). */
  onExit: () => void;
}

const WEATHER_WORD: Record<GardenWeatherState, string> = {
  fresh_rain: "fresh rain",
  recovery_rain: "recovery rain",
  soft_sun: "soft sun",
  clear_sun: "clear sun",
  seasonal_breeze: "a seasonal breeze",
  light_clouds: "light clouds",
  dry_spell: "a dry spell",
  mild_drought: "drought",
};

const REFRESH_MS = 5 * 60_000;
const RETRY_MS = 15_000;
const CURSOR_IDLE_MS = 2500;

function currentHour(): number {
  const now = new Date();
  return now.getHours() + now.getMinutes() / 60;
}

function clockLabel(): string {
  return new Date().toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
}

export function AmbientGarden({ fetchGarden, onExit }: AmbientGardenProps) {
  const [view, setView] = useState<AmbientGardenView | null>(null);
  const [everLoaded, setEverLoaded] = useState(false);
  const [hour, setHour] = useState(currentHour);
  const [clock, setClock] = useState(clockLabel);
  const [cursorHidden, setCursorHidden] = useState(false);
  const lastGood = useRef<AmbientGardenView | null>(null);

  const reducedMotion = useMemo(
    () =>
      typeof window !== "undefined" &&
      window.matchMedia("(prefers-reduced-motion: reduce)").matches,
    [],
  );

  // Refresh loop: fetch now, then settle to every 5 minutes. While we've never
  // succeeded (e.g. cloud sync still starting), retry quickly instead.
  useEffect(() => {
    let alive = true;
    let timer: ReturnType<typeof setTimeout>;
    const tick = async () => {
      try {
        const next = await fetchGarden();
        if (!alive) return;
        lastGood.current = next;
        setView(next);
        setEverLoaded(true);
        timer = setTimeout(tick, REFRESH_MS);
      } catch {
        if (!alive) return;
        // Keep whatever we last showed; just try again.
        timer = setTimeout(tick, lastGood.current ? REFRESH_MS : RETRY_MS);
      }
    };
    void tick();
    return () => {
      alive = false;
      clearTimeout(timer);
    };
  }, [fetchGarden]);

  // Track the wall clock so the sun/moon and the corner time stay current.
  useEffect(() => {
    const id = setInterval(() => {
      setHour(currentHour());
      setClock(clockLabel());
    }, 30_000);
    return () => clearInterval(id);
  }, []);

  // Esc exits.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onExit();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onExit]);

  // Screensaver semantics: moving the mouse exits. A short grace period and a
  // small distance threshold keep the synthetic move event that macOS fires
  // when the window appears — or a nudged desk — from bouncing it instantly.
  useEffect(() => {
    const armedAt = Date.now() + 1500;
    let origin: { x: number; y: number } | null = null;
    const onMove = (e: MouseEvent) => {
      if (Date.now() < armedAt) return;
      if (!origin) {
        origin = { x: e.screenX, y: e.screenY };
        return;
      }
      if (Math.hypot(e.screenX - origin.x, e.screenY - origin.y) > 24) onExit();
    };
    window.addEventListener("mousemove", onMove);
    return () => window.removeEventListener("mousemove", onMove);
  }, [onExit]);

  // Hide the cursor when the pointer goes still; reveal it on movement.
  useEffect(() => {
    let idle: ReturnType<typeof setTimeout>;
    const arm = () => {
      clearTimeout(idle);
      idle = setTimeout(() => setCursorHidden(true), CURSOR_IDLE_MS);
    };
    const onMove = () => {
      setCursorHidden(false);
      arm();
    };
    window.addEventListener("mousemove", onMove);
    arm();
    return () => {
      window.removeEventListener("mousemove", onMove);
      clearTimeout(idle);
    };
  }, []);

  const shown = view ?? lastGood.current;
  const rootClass = `ambient-root${cursorHidden ? " ambient-hide-cursor" : ""}`;

  return (
    <div
      className={rootClass}
      onClick={onExit}
      role="button"
      tabIndex={0}
      aria-label="Ambient garden — click or press Escape to exit"
    >
      {shown ? (
        <>
          <GardenScene
            snapshot={shown.snapshot}
            timeOfDay={hour}
            reducedMotion={reducedMotion}
            idPrefix="rg-ambient"
            className="ambient-scene"
            preserveAspectRatio="xMidYMax slice"
            atmosphere
          />
          <AmbientCaption view={shown} />
          <div className="ambient-clock">{clock}</div>
        </>
      ) : (
        <div className="ambient-waiting">
          <span className="ambient-mark" aria-hidden>
            🌿
          </span>
          <p>{everLoaded ? "Refreshing your garden…" : "Growing your garden…"}</p>
          <p className="ambient-waiting-hint">
            Needs COROS connected in Settings · Esc to close
          </p>
        </div>
      )}
    </div>
  );
}

function AmbientCaption({ view }: { view: AmbientGardenView }) {
  const { snapshot } = view;
  const living = snapshot.plants.filter((p) => p.state !== "dead").length;
  const speciesCount = view.species.length;
  const weather = snapshot.state.weatherState;
  const conditionLabel =
    GARDEN_CONDITION_LABELS[view.condition as GardenConditionWord] ?? String(view.condition);
  const bits = [
    WEATHER_WORD[weather] ?? "calm",
    `${living} plant${living === 1 ? "" : "s"}`,
    `${speciesCount} species`,
  ];
  return (
    <div className="ambient-caption">
      <div className="ambient-condition">{conditionLabel}</div>
      <div className="ambient-sub">{bits.join(" · ")}</div>
    </div>
  );
}
