import { PRODUCT_NAME } from "@rg/domain";
import { Card } from "../components.js";

export function WelcomeScreen({ fixtureMode }: { fixtureMode?: boolean }) {
  return (
    <div className="shell">
      <main className="shell-main" style={{ maxWidth: 460, display: "flex", flexDirection: "column", justifyContent: "center", minHeight: "80dvh" }}>
        <div style={{ textAlign: "center", marginBottom: "var(--space-7)" }}>
          <div className="welcome-mark" aria-hidden>🌿</div>
          <h1 className="display">
            {PRODUCT_NAME}
          </h1>
          <p className="muted" style={{ marginTop: "var(--space-3)" }}>
            Your COROS plan, fitted to your real week.
          </p>
        </div>
        <Card>
          <a
            className="btn btn-primary"
            style={{ width: "100%" }}
            href="/api/auth/google/start?mode=signin&redirect=/onboarding"
          >
            Continue with Google
          </a>
          <p className="faint" style={{ marginTop: "var(--space-5)", textAlign: "center" }}>
            Private and single-user. Only the configured account can sign in.
          </p>
          {fixtureMode ? (
            <form method="post" action="/api/dev/fixture-login" style={{ marginTop: "var(--space-5)" }}>
              <button className="btn" style={{ width: "100%" }} type="submit">
                Enter fixture mode (sample data)
              </button>
            </form>
          ) : null}
        </Card>
      </main>
    </div>
  );
}
