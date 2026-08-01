import { useEffect, useState } from "react";
import { BrowserRouter, Navigate, Route, Routes, useNavigate } from "react-router-dom";
import { QueryClient, QueryClientProvider, useQuery } from "@tanstack/react-query";
import { api, ApiError } from "@rg/api-client";
import { AppShell } from "./shell.js";
import { Spinner } from "./components.js";
import { PlanScreen } from "./screens/plan.js";
import { RunsScreen } from "./screens/runs.js";
import { GardenScreen } from "./screens/garden.js";
import { InsightsScreen } from "./screens/insights.js";
import { SettingsScreen } from "./screens/settings.js";
import { WelcomeScreen } from "./screens/welcome.js";
import { Onboarding } from "./screens/onboarding.js";

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
  const me = useQuery({ queryKey: ["me"], queryFn: api.me, retry: false });

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
    return <Navigate to="/welcome" replace />;
  }

  return (
    <AppShell
      fixtureMode={me.data?.fixtureMode}
      footer={<span>{me.data?.email}</span>}
    >
      <Routes>
        <Route path="/" element={<GardenScreen />} />
        <Route path="/plan" element={<PlanScreen />} />
        <Route path="/runs" element={<RunsScreen />} />
        <Route path="/garden" element={<GardenScreen />} />
        <Route path="/insights" element={<InsightsScreen />} />
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

export function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <BrowserRouter>
        <Routes>
          <Route path="/welcome" element={<WelcomeRoute />} />
          <Route path="/onboarding" element={<OnboardingRoute />} />
          <Route path="/*" element={<AuthedApp />} />
        </Routes>
      </BrowserRouter>
    </QueryClientProvider>
  );
}
