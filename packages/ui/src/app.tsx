import { useEffect, useState } from "react";
import { BrowserRouter, Navigate, Route, Routes, useNavigate, useParams } from "react-router-dom";
import { QueryClient, QueryClientProvider, useQuery } from "@tanstack/react-query";
import { api, ApiError } from "@rg/api-client";
import { AppShell } from "./shell.js";
import { ErrorBoundary, Spinner } from "./components.js";
import { PlanScreen } from "./screens/plan.js";
import { RunsScreen } from "./screens/runs.js";
import { GardenScreen } from "./screens/garden.js";
import { SettingsScreen } from "./screens/settings.js";
import { WelcomeScreen } from "./screens/welcome.js";
import { Onboarding } from "./screens/onboarding.js";
import { PlayerScreen } from "./screens/player.js";
import { StudioScreen } from "./screens/studio/screen.js";
import { BuilderRoute } from "./screens/studio/builder.js";
import { TemplatesScreen } from "./screens/studio/templates.js";
import { coachOn } from "./features.js";
import { CoachKeeper } from "./screens/studio/run-keeper.js";
import { CoachSheetProvider } from "./screens/studio/coach-sheet.js";
import { onOfflineDbReplaced } from "./offline/idb.js";
import { meWithOfflineFallback } from "./offline/me.js";
import { OutboxSync } from "./components/outbox-sync.js";
import { PlayerMusicTools } from "./music/dock.js";

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      retry: (count, error) => !(error instanceof ApiError && error.status === 401) && count < 2,
      refetchOnWindowFocus: false,
      staleTime: 15_000,
      // Offline, a read still goes out: the service worker answers it from its cache (Today, the garden, Plan).
      // React Query's default ("online") would hold every query paused while the browser says offline, and the
      // home would read "Couldn't load the garden" over data the device holds (Phase 2b Task 8, journey b).
      networkMode: "offlineFirst",
    },
  },
});

/**
 * The Studio's pages (the new shape, §3): no tab, but every page keeps its route — the builder at `/studio/build/*` (one
 * instance across a new workout, a quick start, a template and a planned workout), the templates at
 * `/studio/templates`, else the library itself (its browse, search and a move's detail), reached from the coach's opening
 * screen and search. The objectives board became Growth's quests: its old address goes there.
 */
export function StudioRoute() {
  return (
    <Routes>
      <Route path="build/*" element={<BuilderRoute />} />
      <Route path="templates" element={<TemplatesScreen />} />
      <Route path="objectives" element={<Navigate to="/growth" replace />} />
      <Route path="*" element={<StudioScreen />} />
    </Routes>
  );
}

function AuthedApp() {
  const me = useQuery({
    queryKey: ["me"],
    // Offline with a session in progress, the last known answer lets the athlete back in (plan 2b Task 3).
    queryFn: () => meWithOfflineFallback(),
    retry: false,
    // Who is signed in keeps React Query's default: offline it waits, and the shell opens on what the device holds
    // (plan 2b Task 3) rather than on a service worker slow to answer for it.
    networkMode: "online",
    // A restore running elsewhere says so until it stops (B10): look again.
    refetchInterval: (q) => (q.state.data?.restore?.running ? 30_000 : false),
  });

  if (me.isLoading) {
    return (
      <div className="shell">
        <main className="shell-main">
          <Spinner label="Signing in" />
        </main>
      </div>
    );
  }
  if (me.isError) {
    // Only an actual 401 means signed out. A flaky connection or a 500 must
    // not dump a signed-in user onto the login screen.
    if (me.error instanceof ApiError && me.error.status === 401) {
      return <Navigate to="/welcome" replace />;
    }
    return (
      <div className="shell">
        <main className="shell-main">
          <p className="muted">Couldn't reach Run Garden — check your connection.</p>
          <button className="btn" onClick={() => me.refetch()}>
            Try again
          </button>
        </main>
      </div>
    );
  }

  const shell = (
    <AppShell
      fixtureMode={me.data?.fixtureMode}
      footer={<span>{me.data?.email}</span>}
      restore={me.data?.restore ?? null}
      who={me.data?.email ?? null}
    >
      <Routes>
        <Route path="/" element={<GardenScreen />} />
        <Route path="/plan" element={<PlanScreen />} />
        {/* The Studio's pages: no tab (the new shape), every page at its own route (`StudioRoute`). */}
        <Route path="/studio/*" element={<StudioRoute />} />
        {/* Growth (the new shape, §7): what Activity was, and the objectives as quests. The boundary sits OUTSIDE the
            screen rather than inside it: a boundary never catches an error thrown by its own render, and a chart bug
            must not take the rest of the app down with it. */}
        <Route
          path="/growth"
          element={
            <ErrorBoundary
              title="Couldn't render Growth"
              // Not voided: ErrorBoundary awaits this promise before clearing its error state, so the remount happens
              // against freshly refetched data rather than the same cached payload that crashed the first render.
              onRetry={() =>
                Promise.all([
                  queryClient.refetchQueries({ queryKey: ["runs"] }),
                  queryClient.refetchQueries({ queryKey: ["insights"] }),
                ])
              }
            >
              <RunsScreen />
            </ErrorBoundary>
          }
        />
        {/* Activity and Insights became Growth. */}
        <Route path="/runs" element={<Navigate to="/growth" replace />} />
        <Route path="/insights" element={<Navigate to="/growth" replace />} />
        <Route path="/settings" element={<SettingsScreen />} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </AppShell>
  );
  // With the coach designer on, the app keeps the athlete's run stepping on every screen (the run keeper): leaving the
  // Studio mid-response no longer pauses it. And one coach sheet beside it (coach everywhere, A3): every screen's "Ask"
  // opens it in place, with what the athlete was looking at. Off, nothing is mounted — and no screen draws an Ask.
  return coachOn() ? (
    <CoachKeeper>
      <CoachSheetProvider>{shell}</CoachSheetProvider>
    </CoachKeeper>
  ) : (
    shell
  );
}

function WelcomeRoute() {
  const me = useQuery({ queryKey: ["me"], queryFn: api.me, retry: false });
  const [fixtureMode, setFixtureMode] = useState(false);
  useEffect(() => {
    void fetch("/api/health")
      .then((r) => r.json())
      .then((h: { fixtureMode?: boolean }) => setFixtureMode(!!h.fixtureMode))
      .catch(() => undefined);
  }, []);
  if (me.data) return <Navigate to="/" replace />;
  return <WelcomeScreen fixtureMode={fixtureMode} />;
}

function OnboardingRoute() {
  const navigate = useNavigate();
  const me = useQuery({ queryKey: ["me"], queryFn: api.me, retry: false });
  if (me.isLoading) return <Spinner />;
  if (me.isError) return <Navigate to="/welcome" replace />;
  return <Onboarding onDone={() => navigate("/")} />;
}

/**
 * The session player (Phase 2b): full screen, outside the tab shell — no tab bar. It plays what Start left on the
 * device, so only a real 401 sends it to sign-in; offline, or with the server down, it plays on.
 */
function PlayerRoute() {
  const { workoutId = "" } = useParams();
  const me = useQuery({ queryKey: ["me"], queryFn: () => meWithOfflineFallback(), retry: false, networkMode: "online" });
  if (me.isLoading) {
    return (
      <div className="player player-status">
        <Spinner label="Signing in" />
      </div>
    );
  }
  if (me.isError && me.error instanceof ApiError && me.error.status === 401) return <Navigate to="/welcome" replace />;
  // The music dock, among the top bar's tools: never over the player's own lines (mounted only while the dock is on).
  return <PlayerScreen workoutId={workoutId} tools={<PlayerMusicTools />} />;
}

export function App() {
  // Another tab opened a newer version of the offline database: this page runs older code than what stores its
  // sessions now, and its connection has let go — reload onto the new build (audit 2b-A M-11).
  useEffect(() => onOfflineDbReplaced(() => window.location.reload()), []);
  return (
    <QueryClientProvider client={queryClient}>
      {/* Sessions saved on this device go to the server from app start, exactly once (Phase 2b). */}
      <OutboxSync />
      <BrowserRouter>
        <Routes>
          <Route path="/welcome" element={<WelcomeRoute />} />
          <Route path="/onboarding" element={<OnboardingRoute />} />
          <Route path="/session/:workoutId" element={<PlayerRoute />} />
          <Route path="/*" element={<AuthedApp />} />
        </Routes>
      </BrowserRouter>
    </QueryClientProvider>
  );
}
