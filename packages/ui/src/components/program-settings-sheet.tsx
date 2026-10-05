/**
 * PROGRAM SETTINGS (Phase 2a Task 8; mocks §6, open call "program settings live on the program card"): weekly
 * goal, preferred days, minutes, place, block length, modes, care on/off and name — Save patches the program, and
 * the server re-places its slots. Retire asks first.
 *
 * With no program it is the "New program…" form, which stays hidden until the player ships (ruling 2a-R5).
 * Labels are plain; the care switch is named by the profile's own care label.
 */
import { useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { api, type ConditionViewDto, type ProgramDto, type ProgramsResponse } from "@rg/api-client";
import type { AdaptiveConfig } from "@rg/domain";
import { Banner, ConfirmDialog, Sheet } from "../components.js";
import { MODE_LABEL } from "./today-program.js";

type Mode = keyof typeof MODE_LABEL;
const MODES: Mode[] = ["recovery", "consistent", "build"];
const DAY_LETTERS = ["M", "T", "W", "T", "F", "S", "S"];
const DAY_NAMES = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"];
const MINUTES = [15, 20, 25, 30, 35, 40, 45, 50, 60, 75, 90];
const BLOCK_WEEKS = [4, 5, 6];

/** A new program's starting point (the server fills anything left out the same way). */
const NEW_CONFIG: Pick<
  AdaptiveConfig,
  "weeklyGoal" | "preferredDays" | "defaultMinutes" | "defaultLocationId" | "blockWeeks" | "modes" | "careProfiles"
> = {
  weeklyGoal: 3,
  preferredDays: [],
  defaultMinutes: 30,
  defaultLocationId: null,
  blockWeeks: 5,
  modes: ["recovery", "consistent", "build"],
  careProfiles: [],
};

export function ProgramSettingsSheet({
  program,
  places,
  profiles,
  onClose,
}: {
  program: ProgramDto | null;
  places: ProgramsResponse["places"];
  profiles: readonly ConditionViewDto[];
  onClose: () => void;
}) {
  const qc = useQueryClient();
  const base = program?.config ?? NEW_CONFIG;
  const caring = profiles.filter((p) => p.care);
  const [name, setName] = useState(program?.name ?? "");
  const [goal, setGoal] = useState(base.weeklyGoal);
  const [days, setDays] = useState<number[]>([...base.preferredDays]);
  const [minutes, setMinutes] = useState(base.defaultMinutes);
  const [place, setPlace] = useState<string | null>(base.defaultLocationId);
  const [blockWeeks, setBlockWeeks] = useState(base.blockWeeks);
  const [modes, setModes] = useState<Mode[]>([...base.modes]);
  const [care, setCare] = useState<string[]>(base.careProfiles.filter((id) => caring.some((p) => p.profileId === id)));
  const [confirmRetire, setConfirmRetire] = useState(false);

  const refresh = () => {
    for (const k of ["programs", "plan", "plan-week", "today"]) void qc.invalidateQueries({ queryKey: [k] });
  };
  const config = () => ({
    weeklyGoal: goal,
    preferredDays: days,
    defaultMinutes: minutes,
    defaultLocationId: place,
    blockWeeks,
    // In the order the engine reads them, whatever order they were switched on in.
    modes: MODES.filter((m) => modes.includes(m)),
    // Profiles not shown here (switched off in the account) keep whatever the program had.
    careProfiles: [...base.careProfiles.filter((id) => !caring.some((p) => p.profileId === id)), ...care],
  });
  const save = useMutation({
    mutationFn: () =>
      program
        ? api.updateProgram(program.id, { name: name.trim(), config: config() })
        : api.createProgram({ name: name.trim(), config: config() }),
    onSuccess: () => {
      refresh();
      onClose();
    },
  });
  const retire = useMutation({
    mutationFn: () => api.updateProgram(program!.id, { status: "retired" }),
    onSuccess: () => {
      refresh();
      onClose();
    },
  });
  const toggleDay = (d: number) => setDays((cur) => (cur.includes(d) ? cur.filter((x) => x !== d) : [...cur, d]));
  const toggleMode = (m: Mode) => setModes((cur) => (cur.includes(m) ? cur.filter((x) => x !== m) : [...cur, m]));

  return (
    <Sheet
      open
      onClose={onClose}
      title={program?.name ?? "New program"}
      footer={
        <div className="btn-row">
          <button
            type="button"
            className="btn btn-primary"
            disabled={save.isPending || name.trim().length === 0}
            onClick={() => save.mutate()}
          >
            Save
          </button>
          {program ? (
            <button type="button" className="btn" aria-haspopup="dialog" onClick={() => setConfirmRetire(true)}>
              Retire…
            </button>
          ) : null}
        </div>
      }
    >
      <div className="stack program-settings">
        <label className="program-field">
          <span className="program-field-label">Name</span>
          <input aria-label="Name" type="text" value={name} maxLength={80} onChange={(e) => setName(e.target.value)} />
        </label>
        <div className="program-field">
          <span className="program-field-label">Sessions a week</span>
          <div className="program-seg" role="group" aria-label="Sessions a week">
            {[1, 2, 3, 4, 5, 6, 7].map((n) => (
              <button key={n} type="button" aria-pressed={goal === n} onClick={() => setGoal(n)}>
                {n}
              </button>
            ))}
          </div>
        </div>
        <div className="program-field">
          <span className="program-field-label">Days</span>
          <div className="program-seg" role="group" aria-label="Days">
            {DAY_LETTERS.map((letter, d) => (
              <button key={d} type="button" title={DAY_NAMES[d]} aria-pressed={days.includes(d)} onClick={() => toggleDay(d)}>
                {letter}
              </button>
            ))}
          </div>
        </div>
        <label className="program-field">
          <span className="program-field-label">Minutes</span>
          <select aria-label="Minutes" value={String(minutes)} onChange={(e) => setMinutes(Number(e.target.value))}>
            {[...new Set([...MINUTES, minutes])]
              .sort((a, b) => a - b)
              .map((m) => (
                <option key={m} value={m}>
                  {m} min
                </option>
              ))}
          </select>
        </label>
        {places.length > 0 ? (
          <label className="program-field">
            <span className="program-field-label">Place</span>
            <select aria-label="Place" value={place ?? ""} onChange={(e) => setPlace(e.target.value || null)}>
              <option value="">Default place</option>
              {places.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </select>
          </label>
        ) : null}
        <div className="program-field">
          <span className="program-field-label">Block length</span>
          <div className="program-seg" role="group" aria-label="Block length">
            {BLOCK_WEEKS.map((w) => (
              <button key={w} type="button" aria-pressed={blockWeeks === w} onClick={() => setBlockWeeks(w)}>
                {w} weeks
              </button>
            ))}
          </div>
        </div>
        <div className="program-field">
          <span className="program-field-label">Modes</span>
          <div className="program-seg" role="group" aria-label="Modes">
            {MODES.map((m) => {
              const on = modes.includes(m);
              return (
                <button
                  key={m}
                  type="button"
                  aria-pressed={on}
                  // A program always has at least one mode to build in.
                  disabled={on && modes.length === 1}
                  onClick={() => toggleMode(m)}
                >
                  {MODE_LABEL[m]}
                </button>
              );
            })}
          </div>
        </div>
        {caring.map((p) => {
          const on = care.includes(p.profileId);
          return (
            <div key={p.profileId} className="program-field program-field-switch">
              <span className="program-field-label">{p.care}</span>
              <button
                type="button"
                role="switch"
                aria-checked={on}
                aria-label={p.care!}
                className="program-switch"
                onClick={() => setCare((cur) => (on ? cur.filter((x) => x !== p.profileId) : [...cur, p.profileId]))}
              />
            </div>
          );
        })}
        {save.isError || retire.isError ? <Banner kind="warn">Couldn't save that — try again.</Banner> : null}
      </div>
      {program ? (
        <ConfirmDialog
          open={confirmRetire}
          onClose={() => setConfirmRetire(false)}
          title="Retire this program?"
          confirmLabel="Retire program"
          busy={retire.isPending}
          onConfirm={() => retire.mutate()}
        >
          {`“${program.name}” stops placing sessions and takes back the ones it placed ahead. Sessions you moved or did stay.`}
        </ConfirmDialog>
      ) : null}
    </Sheet>
  );
}
