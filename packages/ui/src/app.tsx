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
import { meWithOfflineFallback } from "./offline/me.js";
import { OutboxSync } from "./components/outbox-sync.js";

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      retry: (count, error) => !(error instanceof ApiError && error.status === 401) && count < 2,
      refetchOnWindowFocus: false,
      staleTime: 15_000,
    },
  },
});

function AuthedApp() {
  const me = useQuery({
    queryKey: ["me"],
    // Offline with a session in progress, the last known answer lets the athlete back in (plan 2b Task 3).
    queryFn: () => meWithOfflineFallback(),
    retry: false,
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

  return (
    <AppShell
      fixtureMode={me.data?.fixtureMode}
      footer={<span>{me.data?.email}</span>}
      restore={me.data?.restore ?? null}
    >
      <Routes>
        <Route path="/" element={<GardenScreen />} />
        <Route path="/plan" element={<PlanScreen />} />
        {/* The boundary sits OUTSIDE the screen rather than inside it: a
            boundary never catches an error thrown by its own render, so
            wrapping the screen's returned tree would have missed anything
            the screen body itself threw (the payload destructuring, say).
            Only this route is wrapped — the dashboard carries every chart in
            the app now (System 2), and a chart bug must not take the rest of
            the app down with it; everything else keeps failing loudly in dev. */}
        <Route
          path="/runs"
          element={
            <ErrorBoundary
              title="Couldn't render activity"
              // Not voided: ErrorBoundary awaits this promise before
              // clearing its error state, so the remount happens against
              // freshly refetched data rather than the same cached payload
              // that crashed the first render.
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
        <Route path="/garden" element={<GardenScreen />} />
        {/* Insights merged into the Activity dashboard (System 2). */}
        <Route path="/insights" element={<Navigate to="/runs" replace />} />
        <Route path="/settings" element={<SettingsScreen />} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </AppShell>
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
  const me = useQuery({ queryKey: ["me"], queryFn: () => meWithOfflineFallback(), retry: false });
  if (me.isLoading) {
    return (
      <div className="player player-status">
        <Spinner label="Signing in" />
      </div>
    );
  }
  if (me.isError && me.error instanceof ApiError && me.error.status === 401) return <Navigate to="/welcome" replace />;
  return <PlayerScreen workoutId={workoutId} />;
}

export function App() {
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
