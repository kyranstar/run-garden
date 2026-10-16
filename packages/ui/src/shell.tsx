import { useEffect, useState, type ReactNode } from "react";
import { NavLink, useLocation, useNavigate } from "react-router-dom";
import { PRODUCT_NAME } from "@rg/domain";
import type { RestoreStatus } from "@rg/api-client";
import { coachOn, features } from "./features.js";
import { IconGarden, IconPlan, IconRuns, IconSettings, IconStudio } from "./icons.js";
import { CoachBoundary } from "./screens/studio/coach-boundary.js";
import { CoachNavMark } from "./screens/studio/run-keeper.js";
import { useCorosReadNow } from "./screens/use-coros-read.js";
import { RestorePendingNotice } from "./screens/restore-notice.js";

// Five tabs: Insights merged into Activity (System 2) — /insights redirects; the Studio sits between Plan and
// Activity (Stage 2 spec §2). Labels stay one short word: five equal links share a 320px bar.
export const NAV = [
  { to: "/", label: "Garden", icon: <IconGarden /> },
  { to: "/plan", label: "Plan", icon: <IconPlan /> },
  { to: "/studio", label: "Studio", icon: <IconStudio /> },
  { to: "/runs", label: "Activity", icon: <IconRuns /> },
  { to: "/settings", label: "Settings", icon: <IconSettings /> },
];

/**
 * The Studio tab's quiet ● while the coach has a run going (the run keeper; coach on only). A mark that fails to draw
 * just isn't there.
 */
function StudioMark() {
  if (!coachOn()) return null;
  return (
    <CoachBoundary quiet>
      <CoachNavMark />
    </CoachBoundary>
  );
}

/** The tabs to draw: all five, or the original four while the Studio ships dark (`features.studio`). */
export function navItems(): typeof NAV {
  return features.studio ? NAV : NAV.filter((n) => n.to !== "/studio");
}

/** The routes that take the wide treatment at lg: the plan's week grid and coach, the Studio's columns. */
const isWide = (pathname: string): boolean =>
  ["/plan", "/studio"].some((root) => pathname === root || pathname.startsWith(`${root}/`));

export function AppShell({
  children,
  fixtureMode,
  footer,
  restore,
}: {
  children: ReactNode;
  fixtureMode?: boolean;
  footer?: ReactNode;
  /** An unfinished restore (`/api/auth/me`): every screen says so. */
  restore?: RestoreStatus | null;
}) {
  const navigate = useNavigate();
  // The garden route escapes the reading column on desktop — the scene is a
  // stage, not a card (see .garden-stage). The plan route gets the milder
  // wide treatment (rework spec §6): the week grid and the floating coach
  // both need more than the 880px reading column — and so does the Studio,
  // whose filters · list · detail are three columns at lg (Stage 2 spec §2).
  // Every other route keeps it.
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
  // Headless here: the visible outcome chip lives on Plan/Activity (same
  // query cache, so those chips reflect this pull).
  useCorosReadNow();
  const immersive = pathname === "/" || pathname === "/garden";
  const wide = isWide(pathname);
  return (
    <div className="shell">
      <nav className="side-nav" aria-label="Main">
        <div className="brand">{PRODUCT_NAME}</div>
        {navItems().map((item) => (
          <NavLink key={item.to} to={item.to} end={item.to === "/"}>
            {item.icon}
            {item.label}
            {item.to === "/studio" ? <StudioMark /> : null}
          </NavLink>
        ))}
        <div className="nav-footer">{footer}</div>
      </nav>

      <main
        className={`shell-main${immersive ? " shell-main--immersive" : ""}${wide ? " shell-main--wide" : ""}`}
      >
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
        {pathname !== "/settings" ? (
          <div style={{ marginBottom: "var(--space-6)" }}>
            <RestorePendingNotice restore={restore} onRestoreAgain={() => navigate("/settings#your-data")} />
          </div>
        ) : null}
        {children}
      </main>

      <nav className="bottom-nav" aria-label="Main">
        {navItems().map((item) => (
          <NavLink key={item.to} to={item.to} end={item.to === "/"}>
            {item.icon}
            {item.label}
            {item.to === "/studio" ? <StudioMark /> : null}
          </NavLink>
        ))}
      </nav>
    </div>
  );
}
