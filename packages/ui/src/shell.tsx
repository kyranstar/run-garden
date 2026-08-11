import type { ReactNode } from "react";
import { NavLink, useLocation } from "react-router-dom";
import { PRODUCT_NAME } from "@rg/domain";
import { IconGarden, IconInsights, IconPlan, IconRuns, IconSettings } from "./icons.js";

const NAV = [
  { to: "/", label: "Garden", icon: <IconGarden /> },
  { to: "/plan", label: "Plan", icon: <IconPlan /> },
  { to: "/runs", label: "Activity", icon: <IconRuns /> },
  { to: "/insights", label: "Insights", icon: <IconInsights /> },
  { to: "/settings", label: "Settings", icon: <IconSettings /> },
];

export function AppShell({
  children,
  fixtureMode,
  footer,
}: {
  children: ReactNode;
  fixtureMode?: boolean;
  footer?: ReactNode;
}) {
  // The garden route escapes the reading column on desktop — the scene is a
  // stage, not a card (see .garden-stage). The plan route gets the milder
  // wide treatment (rework spec §6): the week grid and the floating coach
  // both need more than the 880px reading column. Every other route keeps it.
  const { pathname } = useLocation();
  const immersive = pathname === "/" || pathname === "/garden";
  const wide = pathname.startsWith("/plan");
  return (
    <div className="shell">
      <nav className="side-nav" aria-label="Main">
        <div className="brand">{PRODUCT_NAME}</div>
        {NAV.map((item) => (
          <NavLink key={item.to} to={item.to} end={item.to === "/"}>
            {item.icon}
            {item.label}
          </NavLink>
        ))}
        <div className="nav-footer">{footer}</div>
      </nav>

      <main
        className={`shell-main${immersive ? " shell-main--immersive" : ""}${wide ? " shell-main--wide" : ""}`}
      >
        {fixtureMode ? (
          <div className="banner banner-info" style={{ marginBottom: "0.9rem" }} role="status">
            Fixture mode — showing sample data, no real providers connected.
          </div>
        ) : null}
        {children}
      </main>

      <nav className="bottom-nav" aria-label="Main">
        {NAV.map((item) => (
          <NavLink key={item.to} to={item.to} end={item.to === "/"}>
            {item.icon}
            {item.label}
          </NavLink>
        ))}
      </nav>
    </div>
  );
}
