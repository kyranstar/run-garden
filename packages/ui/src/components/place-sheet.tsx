/**
 * A PLACE AND ITS GEAR (Phase 2c Task 3; mocks §7, spec §2c "Places & equipment"): its name, the gear there as
 * toggles, and for gear that takes weights the weights as the athlete types them ("10, 15, 20 lb, 12kg") — kept and
 * shown back exactly as typed (Review Focus 3); a list that is not weights names the part that is not. The default
 * place switch; Delete… asks first, and a place a program builds at is refused by the server, naming the program.
 *
 * Every gear word comes from the server's vocabulary; labels are plain.
 */
import { useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { api, ApiError, type PlaceDto, type PlacesResponse } from "@rg/api-client";
import { weightListProblem } from "@rg/domain";
import { Banner, ConfirmDialog, Sheet } from "../components.js";

export function PlaceSheet({
  place,
  vocabulary,
  onClose,
}: {
  /** null: a new place. */
  place: PlaceDto | null;
  vocabulary: PlacesResponse["equipment"];
  onClose: () => void;
}) {
  const qc = useQueryClient();
  const [name, setName] = useState(place?.name ?? "");
  const [gear, setGear] = useState<string[]>(place ? [...place.equipment] : []);
  const [lists, setLists] = useState<Record<string, string>>({ ...(place?.implements ?? {}) });
  const [makeDefault, setMakeDefault] = useState(false);
  const [problems, setProblems] = useState<Record<string, string>>({});
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [refusal, setRefusal] = useState<string | null>(null);

  const weighted = vocabulary.filter((v) => v.weighted && gear.includes(v.id));
  const refresh = () => {
    for (const k of ["places", "library", "programs"]) void qc.invalidateQueries({ queryKey: [k] });
  };

  const body = () => {
    // Only lists for gear the place has, as typed; an emptied list is no list.
    const kept: Record<string, string> = {};
    for (const v of weighted) {
      const typed = (lists[v.id] ?? "").trim();
      if (typed !== "") kept[v.id] = lists[v.id]!.trim();
    }
    return { name: name.trim(), equipment: vocabulary.map((v) => v.id).filter((id) => gear.includes(id)), implements: kept, ...(makeDefault ? { isDefault: true as const } : {}) };
  };

  const save = useMutation({
    mutationFn: () => (place ? api.updatePlace(place.id, body()) : api.createPlace(body())),
    onSuccess: () => {
      refresh();
      onClose();
    },
  });
  const remove = useMutation({
    mutationFn: () => api.deletePlace(place!.id),
    onSuccess: () => {
      refresh();
      onClose();
    },
    onError: (e) => {
      setConfirmDelete(false);
      const program = e instanceof ApiError && e.status === 409 ? (e.body as { program?: { name?: string } } | null)?.program?.name : null;
      setRefusal(program ? `${program} builds its sessions here: choose another place for it first.` : "Couldn't delete that place — try again.");
    },
  });

  const submit = () => {
    const found: Record<string, string> = {};
    for (const v of weighted) {
      const typed = (lists[v.id] ?? "").trim();
      if (typed === "") continue;
      const problem = weightListProblem(typed);
      if (problem) found[v.id] = problem;
    }
    setProblems(found);
    if (Object.keys(found).length === 0) save.mutate();
  };

  const toggle = (id: string) => setGear((cur) => (cur.includes(id) ? cur.filter((g) => g !== id) : [...cur, id]));

  return (
    <Sheet
      open
      onClose={onClose}
      title={place?.name ?? "New place"}
      footer={
        <div className="btn-row">
          <button type="button" className="btn btn-primary" disabled={save.isPending || name.trim().length === 0} onClick={submit}>
            Save
          </button>
          {place ? (
            <button type="button" className="btn" aria-haspopup="dialog" onClick={() => setConfirmDelete(true)}>
              Delete…
            </button>
          ) : null}
        </div>
      }
    >
      <div className="stack place-sheet">
        <label className="program-field">
          <span className="program-field-label">Name</span>
          <input aria-label="Name" type="text" value={name} maxLength={60} onChange={(e) => setName(e.target.value)} />
        </label>
        <div className="program-field">
          <span className="program-field-label">Equipment</span>
          <div className="gear-toggles" role="group" aria-label="Equipment">
            {vocabulary.map((v) => (
              <button key={v.id} type="button" className="chipbtn" aria-pressed={gear.includes(v.id)} onClick={() => toggle(v.id)}>
                {v.label}
              </button>
            ))}
          </div>
        </div>
        {weighted.map((v) => (
          <label key={v.id} className="program-field">
            <span className="program-field-label">{`${v.label} weights`}</span>
            <input
              aria-label={`${v.label} weights`}
              aria-invalid={problems[v.id] ? true : undefined}
              type="text"
              inputMode="text"
              autoComplete="off"
              value={lists[v.id] ?? ""}
              maxLength={200}
              onChange={(e) => setLists((cur) => ({ ...cur, [v.id]: e.target.value }))}
            />
            {problems[v.id] ? (
              <span className="place-problem" role="alert">
                {problems[v.id] === "empty" ? "No weights in that list" : `“${problems[v.id]}” isn't a weight`}
              </span>
            ) : null}
          </label>
        ))}
        <div className="program-field program-field-switch">
          <span className="program-field-label">Default place</span>
          <button
            type="button"
            role="switch"
            aria-checked={place?.isDefault || makeDefault}
            aria-label="Default place"
            className="program-switch"
            // The default place stops being it only when another becomes it.
            disabled={place?.isDefault}
            onClick={() => setMakeDefault((on) => !on)}
          />
        </div>
        {refusal ? <Banner kind="warn">{refusal}</Banner> : null}
        {save.isError ? <Banner kind="warn">Couldn't save that — try again.</Banner> : null}
      </div>
      {place ? (
        <ConfirmDialog
          open={confirmDelete}
          onClose={() => setConfirmDelete(false)}
          title="Delete this place?"
          confirmLabel="Delete place"
          busy={remove.isPending}
          onConfirm={() => remove.mutate()}
        >
          {`“${place.name}” and its weights go. Sessions you did there stay.`}
        </ConfirmDialog>
      ) : null}
    </Sheet>
  );
}
