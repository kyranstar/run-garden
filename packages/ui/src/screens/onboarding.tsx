import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { api } from "@rg/api-client";
import { PRODUCT_NAME } from "@rg/domain";
import { Card, formatDayShort, formatTime, Spinner } from "../components.js";
import { CorosConnectSection } from "./settings.js";

/**
 * Focused onboarding. Value first, then COROS (connected right here — the
 * worker talks to COROS directly), Calendar, preferences, a real 7-day
 * preview, and a one-view garden intro. No long carousel; each step is a card.
 */

const STEPS = ["Value", "COROS", "Calendar", "Preferences", "Preview", "Garden"] as const;

export function Onboarding({ onDone }: { onDone: () => void }) {
  const [step, setStep] = useState(0);
  const [forceWizard, setForceWizard] = useState(false);
  const next = () => setStep((s) => Math.min(s + 1, STEPS.length - 1));
  const back = () => setStep((s) => Math.max(s - 1, 0));

  // An account configured elsewhere must never be walked through setup
  // again: signing in on a new device (the phone PWA, another browser) is a
  // sign-IN, not a first run. `corosConnected` is the tell.
  const today = useQuery({ queryKey: ["today"], queryFn: api.today });
  if (today.isLoading) {
    return (
      <div className="shell">
        <main className="shell-main" style={{ maxWidth: 560 }}>
          <Spinner label="One moment" />
        </main>
      </div>
    );
  }
  if (today.data?.sync.corosConnected && !forceWizard) {
    return (
      <div className="shell">
        <main className="shell-main" style={{ maxWidth: 560 }}>
          <Card>
            <h1 className="hero-title" style={{ fontSize: "1.6rem" }}>
              You're already set up 🌿
            </h1>
            <p className="muted" style={{ marginTop: "0.7rem" }}>
              COROS is already connected — activities, your plan, and watch updates sync in the
              cloud on their own. Nothing to configure here.
            </p>
            <p className="muted">
              On this device you get everything else: your garden, the full plan calendar, the
              lifting studio, and activity insights — wherever you are.
            </p>
            <div style={{ marginTop: "1rem" }}>
              <button className="btn btn-primary" style={{ width: "100%" }} onClick={onDone}>
                Open your garden
              </button>
              <button
                className="btn"
                style={{ width: "100%", marginTop: "0.5rem" }}
                onClick={() => setForceWizard(true)}
              >
                Run setup again anyway
              </button>
            </div>
          </Card>
        </main>
      </div>
    );
  }

  return (
    <div className="shell">
      <main className="shell-main" style={{ maxWidth: 560 }}>
        <div className="row-between" style={{ marginBottom: "0.6rem" }}>
          <span />
          <button className="btn btn-small" onClick={onDone}>
            Skip setup
          </button>
        </div>
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
        {step === 1 ? <CorosStep onNext={next} onBack={back} /> : null}
        {step === 2 ? <CalendarStep onNext={next} onBack={back} /> : null}
        {step === 3 ? <PreferencesStep onNext={next} onBack={back} /> : null}
        {step === 4 ? <PreviewStep onNext={next} onBack={back} /> : null}
        {step === 5 ? <GardenStep onDone={onDone} onBack={back} /> : null}
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
          Get started
        </button>
        <p className="faint" style={{ marginTop: "0.6rem", textAlign: "center" }}>
          {PRODUCT_NAME} is private and single-user.
        </p>
      </div>
    </Card>
  );
}

function CorosStep({ onNext, onBack }: { onNext: () => void; onBack: () => void }) {
  const status = useQuery({ queryKey: ["coros-status"], queryFn: api.corosStatus });
  const connected = status.data?.connected === true;
  return (
    <div className="stack">
      <CorosConnectSection />
      <Card>
        <p className="muted">
          The moment you connect, your activities, plan, and history start syncing — and moves you
          make here are written back to your watch. Your password is hashed on this device before
          it's sent; only the hash is stored, encrypted.
        </p>
      </Card>
      <StepNav onNext={onNext} onBack={onBack} nextLabel={connected ? "Continue" : "Skip for now"} />
    </div>
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
      {count > 0 ? (
        <p className="faint" style={{ marginTop: "0.6rem" }}>
          These {count} workouts land on your calendar automatically once Google Calendar is
          connected — nothing else to press.
        </p>
      ) : null}
      <StepNav onNext={onNext} onBack={onBack} />
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
