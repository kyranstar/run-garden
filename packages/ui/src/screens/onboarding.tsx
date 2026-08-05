import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { api } from "@rg/api-client";
import { PRODUCT_NAME } from "@rg/domain";
import { Banner, Card, formatDayShort, formatTime, Spinner } from "../components.js";

/**
 * Focused onboarding. Value first, then the desktop companion, COROS, Calendar,
 * preferences, a real 7-day preview, and a one-view garden
 * intro. No long carousel; each step is a card.
 */

const STEPS = ["Value", "Desktop", "COROS", "Calendar", "Preferences", "Preview", "Garden"] as const;

export function Onboarding({ onDone }: { onDone: () => void }) {
  const [step, setStep] = useState(0);
  const [forceWizard, setForceWizard] = useState(false);
  const next = () => setStep((s) => Math.min(s + 1, STEPS.length - 1));
  const back = () => setStep((s) => Math.max(s - 1, 0));

  // An account configured elsewhere must never be walked through setup
  // again: signing in on a new device (the phone PWA, another browser) is a
  // sign-IN, not a first run. `deviceRegistered` is the tell — the desktop
  // companion has already been paired.
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
  if (today.data?.sync.deviceRegistered && !forceWizard) {
    return (
      <div className="shell">
        <main className="shell-main" style={{ maxWidth: 560 }}>
          <Card>
            <h1 className="hero-title" style={{ fontSize: "1.6rem" }}>
              You're already set up 🌿
            </h1>
            <p className="muted" style={{ marginTop: "0.7rem" }}>
              The Run Garden desktop app on your Mac keeps COROS and your calendar synced in the
              background — nothing to configure here.
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
        {step === 1 ? <DesktopStep onNext={next} onBack={back} /> : null}
        {step === 2 ? <CorosStep onNext={next} onBack={back} /> : null}
        {step === 3 ? <CalendarStep onNext={next} onBack={back} /> : null}
        {step === 4 ? <PreferencesStep onNext={next} onBack={back} /> : null}
        {step === 5 ? <PreviewStep onNext={next} onBack={back} /> : null}
        {step === 6 ? <GardenStep onDone={onDone} onBack={back} /> : null}
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

const DESKTOP_BUILD_CMD =
  "pnpm --filter @rg/desktop sidecar:build && pnpm --filter @rg/desktop tauri build";

function DesktopStep({ onNext, onBack }: { onNext: () => void; onBack: () => void }) {
  const devices = useQuery({ queryKey: ["devices"], queryFn: api.devices, refetchInterval: 5000 });
  const connected = (devices.data?.devices ?? []).some((d) => !d.revokedAt);
  const [copied, setCopied] = useState(false);

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(DESKTOP_BUILD_CMD);
      setCopied(true);
      setTimeout(() => setCopied(false), 2500);
    } catch {
      /* clipboard blocked — the command is shown below regardless */
    }
  };

  return (
    <Card title="Desktop companion — and why it's needed">
      <p>
        COROS has no cloud API that lets an app change your training plan, and it blocks logins from
        cloud servers. So a small companion app on your Mac does the talking to COROS — reading your
        plan and pushing schedule changes back to your watch.
      </p>
      <p className="muted" style={{ marginTop: "0.6rem" }}>
        It also means your COROS password never leaves your Mac (it's kept in the macOS Keychain,
        never sent to Run Garden's cloud). Run Garden's website works without it — you just won't see
        your COROS plan until the Mac companion is connected.
      </p>

      <div style={{ marginTop: "0.9rem" }}>
        <p className="faint" style={{ marginBottom: "0.3rem" }}>
          Build &amp; install it from the project (produces a .dmg):
        </p>
        <div className="stage-summary" style={{ fontFamily: "ui-monospace, monospace", fontSize: "0.8rem" }}>
          {DESKTOP_BUILD_CMD}
        </div>
        <div className="btn-row" style={{ marginTop: "0.5rem" }}>
          <button className="btn btn-small" onClick={copy}>
            {copied ? "Copied ✓" : "Copy command"}
          </button>
        </div>
      </div>

      {connected ? (
        <Banner kind="info">Your Mac is connected — you're all set.</Banner>
      ) : (
        <p className="faint" style={{ marginTop: "0.7rem" }}>
          Once the companion is running and paired, it shows up here automatically. You can also do
          the COROS connection entirely inside the desktop app.
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
        Even if Run Garden can't update your COROS watch automatically, it still mirrors your whole
        plan to Google Calendar — you'd just move workouts on the watch yourself.
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
