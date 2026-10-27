import { useEffect, useState, type ReactNode } from "react";
import { Link, NavLink, useLocation, useNavigate } from "react-router-dom";
import { PRODUCT_NAME } from "@rg/domain";
import type { RestoreStatus } from "@rg/api-client";
import { IconGrowth, IconPlan, IconSettings, IconSprout, IconStudio, IconToday } from "./icons.js";
import { CoachBoundary } from "./screens/studio/coach-boundary.js";
import { useCoach } from "./screens/studio/coach-ask.js";
import { CoachNavMark } from "./screens/studio/run-keeper.js";
import { useCorosReadNow } from "./screens/use-coros-read.js";
import { RestorePendingNotice } from "./screens/restore-notice.js";
import { MusicDock, useMusicOn } from "./music/dock.js";
import { SceneMarkContext } from "./scene-mark.js";

/**
 * THE NAV (2026-10-17 design §3, Studio made a tab 2026-10-26): four places — Today, Plan, Studio, Growth — and one
 * coach among them. The phone's bar is Today · Plan · Coach · Studio · Growth, five equal controls; the rail from lg is
 * the same five with Settings at its foot. Settings on a phone is the athlete's mark at the top right of each place.
 * The Studio's pages keep their routes under `/studio`, and its tab is lit on all of them.
 */
export const NAV = [
  { to: "/", label: "Today", icon: <IconToday /> },
  { to: "/plan", label: "Plan", icon: <IconPlan /> },
  { to: "/studio", label: "Studio", icon: <IconStudio /> },
  { to: "/growth", label: "Growth", icon: <IconGrowth /> },
];

/** The places: each carries the athlete's mark (Settings, on a phone) at its top right. The Studio, a tab, is not one:
 * its pages carry their own headers, and the mark stays off them as before. */
const PLACES = new Set(NAV.map((n) => n.to).filter((to) => to !== "/studio"));

/** The routes that take the wide treatment at lg: the plan's week grid, the Studio's columns. */
const isWide = (pathname: string): boolean =>
  ["/plan", "/studio"].some((root) => pathname === root || pathname.startsWith(`${root}/`));

/**
 * The coach, in the middle of the nav: a filled sprout pill, a real button. It opens the app's one coach sheet with
 * nothing written — what the screen shows, the sheet picks up itself (`useCoachSeeing`). Its quiet ● says a run is going
 * on any screen (the run keeper's). Not drawn without the sheet (the coach off): the places alone.
 */
function CoachButton() {
  const coach = useCoach();
  if (!coach) return null;
  return (
    <button type="button" className="nav-coach" onClick={() => coach.open()}>
      <span className="nav-coach-pill">
        <IconSprout />
        {/* The run keeper's ● at the pill's corner: an ink dot ringed in the bar's surface, seen on the green in both
            themes. A mark that fails to draw just isn't there. */}
        <CoachBoundary quiet>
          <CoachNavMark />
        </CoachBoundary>
      </span>
      Coach
    </button>
  );
}

/** The nav's five, in order: the places, the coach between Plan and Studio. */
function NavItems() {
  return (
    <>
      {NAV.map((item) => (
        <PlaceLink key={item.to} item={item} />
      ))}
    </>
  );
}

function PlaceLink({ item }: { item: (typeof NAV)[number] }) {
  return (
    <>
      {item.to === "/studio" ? <CoachButton /> : null}
      <NavLink to={item.to} end={item.to === "/"}>
        {item.icon}
        {item.label}
      </NavLink>
    </>
  );
}

/**
 * Settings, on a phone: the athlete's mark at the top right of each place — their address's first letter in a round
 * 44 px target, or the settings glyph while no address is known — on a row of its own above the page, so it never sits
 * over a banner or a place's own title row (Plan's COROS check, Growth's Month / Season). On Today the page wears it
 * (handed over through `SceneMarkContext`): on the picture's top-right corner, so the card gains the row's room, or on
 * a row while there is no picture yet. From lg the rail's foot holds Settings instead.
 */
function AthleteMark({ who }: { who: string | null | undefined }) {
  const initial = who?.trim().charAt(0).toUpperCase() ?? "";
  return (
    <Link className="athlete-mark" to="/settings" aria-label="Settings">
      {initial ? <span aria-hidden="true">{initial}</span> : <IconSettings />}
    </Link>
  );
}

export function AppShell({
  children,
  fixtureMode,
  footer,
  restore,
  who,
}: {
  children: ReactNode;
  fixtureMode?: boolean;
  footer?: ReactNode;
  /** An unfinished restore (`/api/auth/me`): every screen says so. */
  restore?: RestoreStatus | null;
  /** Who is signed in (their address): the athlete's mark shows its first letter. */
  who?: string | null;
}) {
  const navigate = useNavigate();
  // Today escapes the reading column on desktop — the scene is a stage, not a card (see .garden-stage). The plan
  // route gets the milder wide treatment (rework spec §6): the week grid needs more than the 880px reading column —
  // and so does the Studio, whose filters · list · detail are three columns at lg (Stage 2 spec §2). Every other route
  // keeps it.
  const { pathname } = useLocation();
  const [staging, setStaging] = useState(false);
  useEffect(() => {
    void fetch("/api/health")
      .then((r) => r.json())
      .then((h: { staging?: boolean }) => setStaging(!!h.staging))
      .catch(() => undefined);
  }, []);
  // The app-open COROS pull fires from the shell so EVERY entry route pulls —
  // opening the PWA to the garden used to trigger nothing (audit finding 11).
  // Headless here: the visible outcome chip lives on Plan (same query cache,
  // so that chip reflects this pull).
  useCorosReadNow();
  const immersive = pathname === "/";
  const wide = isWide(pathname);
  // The athlete's mark: a row of its own above each place — on Today, the picture's to wear (scene-mark.ts).
  const mark = PLACES.has(pathname) ? <AthleteMark who={who} /> : null;
  // The music dock (Spotify): on only once the owner's Client ID is set (the server answers it); off, no room is kept.
  const music = useMusicOn();
  return (
    <div className={`shell${music ? " shell--music" : ""}`}>
      <nav className="side-nav" aria-label="Main">
        <div className="brand">{PRODUCT_NAME}</div>
        <NavItems />
        <div className="nav-footer">
          <NavLink to="/settings">
            <IconSettings />
            Settings
          </NavLink>
          {footer}
        </div>
      </nav>

      <main
        className={`shell-main${immersive ? " shell-main--immersive" : ""}${wide ? " shell-main--wide" : ""}`}
      >
        {immersive || !mark ? null : <div className="athlete-row">{mark}</div>}
        {staging ? (
          <div className="banner banner-info" style={{ marginBottom: "var(--space-6)" }} role="status">
            Staging
          </div>
        ) : null}
        {fixtureMode ? (
          <div className="banner banner-info" style={{ marginBottom: "var(--space-6)" }} role="status">
            Fixture mode — showing sample data, no real providers connected.
          </div>
        ) : null}
        {/* Settings carries the same notice on its Data card, beside the file
            picker "Restore again" needs. */}
        {pathname !== "/settings" && restore ? (
          <div style={{ marginBottom: "var(--space-6)" }}>
            <RestorePendingNotice restore={restore} onRestoreAgain={() => navigate("/settings#your-data")} />
          </div>
        ) : null}
        <SceneMarkContext.Provider value={immersive ? mark : null}>{children}</SceneMarkContext.Provider>
        {/* Room under the page's last control for the dock's pill, below lg (at lg it sits in the rail's corner). */}
        {music ? <div className="music-dock-room" aria-hidden="true" /> : null}
      </main>

      {music ? <MusicDock variant="shell" /> : null}

      <nav className="bottom-nav" aria-label="Main">
        <NavItems />
      </nav>
    </div>
  );
}
