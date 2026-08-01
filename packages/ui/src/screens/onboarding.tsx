import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { api } from "@rg/api-client";
import { PRODUCT_NAME } from "@rg/domain";
import { Banner, Card, formatDayShort, formatTime, Spinner } from "../components.js";

/**
 * Focused onboarding. Value first, then the desktop companion, COROS, Calendar,
 * Strava (optional), preferences, a real 7-day preview, and a one-view garden
 * intro. No long carousel; each step is a card.
 */

const STEPS = ["Value", "Desktop", "COROS", "Calendar", "Strava", "Preferences", "Preview", "Garden"] as const;

export function Onboarding({ onDone }: { onDone: () => void }) {
  const [step, setStep] = useState(0);
  const next = () => setStep((s) => Math.min(s + 1, STEPS.length - 1));
  const back = () => setStep((s) => Math.max(s - 1, 0));

  return (
    <div className="shell">
      <main className="shell-main" style={{ maxWidth: 560 }}>
        <div className="row" style={{ gap: 4, marginBottom: "1.2rem" }} aria-hidden>
          {STEPS.map((_, i) => (
            <span
              key={i}
              style={{
                flex: 1,
                height: 4,
                borderRadius: 2,
                background: i <= step ? "var(--green)" : "var(--border)",
              }}
            />
          ))}
        </div>
        {step === 0 ? <ValueStep onNext={next} /> : null}
        {step === 1 ? <DesktopStep onNext={next} onBack={back} /> : null}
        {step === 2 ? <CorosStep onNext={next} onBack={back} /> : null}
        {step === 3 ? <CalendarStep onNext={next} onBack={back} /> : null}
        {step === 4 ? <StravaStep onNext={next} onBack={back} /> : null}
        {step === 5 ? <PreferencesStep onNext={next} onBack={back} /> : null}
        {step === 6 ? <PreviewStep onNext={next} onBack={back} /> : null}
        {step === 7 ? <GardenStep onDone={onDone} onBack={back} /> : null}
      </main>
    </div>
  );
}

function StepNav({ onNext, onBack, nextLabel = "Continue" }: { onNext: () => void; onBack?: () => void; nextLabel?: string }) {
  return (
    <div className="row-between" style={{ marginTop: "1rem" }}>
      {onBack ? (
        <button className="btn" onClick={onBack}>
          Back
        </button>
      ) : (
        <span />
      )}
      <button className="btn btn-primary" onClick={onNext}>
        {nextLabel}
      </button>
    </div>
  );
}

function ValueStep({ onNext }: { onNext: () => void }) {
  return (
    <Card>
      <h1 className="hero-title" style={{ fontSize: "1.7rem" }}>
        Your COROS plan, fitted to your real week.
      </h1>
      <p className="muted" style={{ marginTop: "0.7rem" }}>
        Mirror workouts to Calendar, move them on COROS, and grow a living garden by staying
        consistent.
      </p>
      <div style={{ marginTop: "1rem" }}>
        <button className="btn btn-primary" onClick={onNext} style={{ width: "100%" }}>
          Continue with Google
        </button>
        <p className="faint" style={{ marginTop: "0.6rem", textAlign: "center" }}>
          {PRODUCT_NAME} is private and single-user.
        </p>
      </div>
    </Card>
  );
}

function DesktopStep({ onNext, onBack }: { onNext: () => void; onBack: () => void }) {
  const devices = useQuery({ queryKey: ["devices"], queryFn: api.devices, refetchInterval: 5000 });
  const connected = (devices.data?.devices ?? []).some((d) => !d.revokedAt);
  return (
    <Card title="Desktop companion">
      <p>
        The desktop companion securely connects to COROS and updates your training calendar. Your
        COROS password stays on this Mac.
      </p>
      <div className="btn-row" style={{ marginTop: "0.8rem" }}>
        <button className="btn">Download desktop app</button>
        <button className="btn">Open installed app</button>
      </div>
      {connected ? (
        <Banner kind="info" >Desktop connected — you're all set.</Banner>
      ) : (
        <p className="faint" style={{ marginTop: "0.7rem" }}>
          Waiting for a Mac to connect… you can also finish setup on the desktop app itself.
        </p>
      )}
      <StepNav onNext={onNext} onBack={onBack} nextLabel={connected ? "Continue" : "Skip for now"} />
    </Card>
  );
}

function CorosStep({ onNext, onBack }: { onNext: () => void; onBack: () => void }) {
  return (
    <Card title="COROS">
      <p>Connect COROS from the desktop app:</p>
      <ul className="muted" style={{ paddingLeft: "1.2rem", marginTop: "0.5rem" }}>
        <li>Enter your COROS email, password, and region</li>
        <li>Test the connection</li>
        <li>Credentials are stored in the macOS Keychain — never in the cloud</li>
        <li>Run Garden reads your active plan and reports what it can do</li>
      </ul>
      <p className="faint" style={{ marginTop: "0.7rem" }}>
        If automatic COROS schedule updates aren't available, Calendar-only mode still works fully.
      </p>
      <StepNav onNext={onNext} onBack={onBack} />
    </Card>
  );
}

function CalendarStep({ onNext, onBack }: { onNext: () => void; onBack: () => void }) {
  return (
    <Card title="Google Calendar">
      <p>Run Garden uses Google Calendar to:</p>
      <ul className="muted" style={{ paddingLeft: "1.2rem", marginTop: "0.5rem" }}>
        <li>Read your busy periods (to schedule around them)</li>
        <li>Create and update workout events with realistic time blocks</li>
        <li>Notice when you move or delete an event by hand</li>
        <li>Add sleep-protection and pre-run reminders</li>
      </ul>
      <div className="btn-row" style={{ marginTop: "0.8rem" }}>
        <a className="btn" href="/api/auth/google/start?mode=calendar&redirect=/onboarding">
          Connect Google Calendar
        </a>
      </div>
      <p className="faint" style={{ marginTop: "0.6rem" }}>
        You can create a dedicated “Run Garden” calendar or pick an existing one in Settings.
      </p>
      <StepNav onNext={onNext} onBack={onBack} />
    </Card>
  );
}

function StravaStep({ onNext, onBack }: { onNext: () => void; onBack: () => void }) {
  return (
    <Card title="Strava (optional)">
      <p>
        COROS already sends completed runs to Strava. Run Garden reads the Strava copy for faster
        completion updates and route details.
      </p>
      <Banner kind="info">Run Garden never uploads or creates activities on Strava.</Banner>
      <div className="btn-row" style={{ marginTop: "0.8rem" }}>
        <a className="btn" href="/api/strava/connect">
          Connect Strava
        </a>
      </div>
      <StepNav onNext={onNext} onBack={onBack} nextLabel="Skip / Continue" />
    </Card>
  );
}

function PreferencesStep({ onNext, onBack }: { onNext: () => void; onBack: () => void }) {
  const settings = useQuery({ queryKey: ["settings"], queryFn: api.settings });
  if (!settings.data) return <Spinner />;
  const p = settings.data.prefs;
  return (
    <Card title="Scheduling preferences">
      <p className="muted">
        We start with sensible defaults — you can change any of these now or later in Settings.
      </p>
      <ul className="muted" style={{ paddingLeft: "1.2rem", marginTop: "0.6rem" }}>
        <li>Weekday morning run: {formatTime(p.weekdayMorningTime)}</li>
        <li>Weekday evening run: {formatTime(p.weekdayEveningTime)}</li>
        <li>Weekend morning run: {formatTime(p.weekendMorningTime)}</li>
        <li>Previous-evening reminder: {formatTime(p.eveningReminderTime)}</li>
        <li>
          Buffers: {p.bufferBeforeMinutes} min before, {p.bufferAfterMinutes} min after
        </li>
        <li>Latest evening finish: {formatTime(p.latestEveningFinish)}</li>
      </ul>
      <StepNav onNext={onNext} onBack={onBack} />
    </Card>
  );
}

function PreviewStep({ onNext, onBack }: { onNext: () => void; onBack: () => void }) {
  const preview = useQuery({ queryKey: ["preview"], queryFn: api.calendarPreview, retry: false });
  const days = (preview.data?.days ?? []) as Array<Record<string, unknown>>;
  const count = preview.data?.eventCount ?? 0;
  return (
    <Card title="Your next 7 days">
      {preview.isLoading ? (
        <Spinner />
      ) : days.length === 0 ? (
        <p className="muted">
          No upcoming workouts found yet — once COROS is connected and the plan imports, they'll show
          here.
        </p>
      ) : (
        <div className="stack">
          {days.map((d) => (
            <div className="workout-row" key={d.id as string}>
              <div className="body">
                <div className="title">{d.title as string}</div>
                <div className="meta">
                  {formatDayShort(d.date as string)} at {formatTime(d.time as string)} ·{" "}
                  {Math.round(((d.workoutSeconds as number) ?? 0) / 60)} min workout ·{" "}
                  {Math.round(((d.calendarSeconds as number) ?? 0) / 60)} min block
                </div>
                <div className="faint">
                  {(d.morning as boolean)
                    ? `Sleep reminder ${formatTime(d.eveningReminderTime as string)} the night before`
                    : `Reminder ${d.preRunReminderMinutes as number} min before`}
                </div>
              </div>
            </div>
          ))}
        </div>
      )}
      <StepNav onNext={onNext} onBack={onBack} nextLabel={count > 0 ? `Add ${count} workouts to Calendar` : "Continue"} />
    </Card>
  );
}

function GardenStep({ onDone, onBack }: { onDone: () => void; onBack: () => void }) {
  return (
    <Card title="Your garden">
      <div className="stack">
        <p>🌱 Every completed planned run waters the garden.</p>
        <p>🌸 Hard workouts introduce new plants.</p>
        <p>🌳 Long-term consistency builds a whole ecosystem.</p>
        <p>💧 A few missed runs are easy to recover from.</p>
        <p>🍂 Long breaks cause a slow drought — never an instant reset.</p>
      </div>
      <div className="row-between" style={{ marginTop: "1rem" }}>
        <button className="btn" onClick={onBack}>
          Back
        </button>
        <button className="btn btn-primary" onClick={onDone}>
          Enter Run Garden
        </button>
      </div>
    </Card>
  );
}
