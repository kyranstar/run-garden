/**
 * SETTINGS SAVED AS YOU GO, DONE RIGHT (the new shape; the integrated review, I5 and the switches' minor):
 *
 *  - `useSaveAsYouGo` — a card's fields: a choice saves itself, a typed value when it is left. What the server brings
 *    back never overwrites a field being edited or one whose change is not saved yet. Saves go one at a time, and while
 *    one is out the next changes wait and merge — the last value of each field wins. A failed save says so and keeps
 *    what was typed (the field stays the athlete's until a save takes it).
 *  - `useSettingSwitch` — a switch: it moves on the tap (the settings in hand change at once), stays there while the
 *    settings are read again, and goes back — saying so — when the save fails.
 */
import { useEffect, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient, type QueryClient } from "@tanstack/react-query";
import { api, type SettingsResponse } from "@rg/api-client";
import type { UserPreferences } from "@rg/domain";

type Prefs = UserPreferences;

/** What was saved shows at once: a read still in flight is cancelled first (it would land older settings over the saved
 * ones); the reads that depend on the settings follow. */
export async function applySavedPrefs(qc: QueryClient, prefs: Prefs, also: readonly string[] = ["today", "plan", "plan-week", "library"]): Promise<void> {
  await qc.cancelQueries({ queryKey: ["settings"] });
  qc.setQueryData(["settings"], (cur: unknown) => ({ ...(cur && typeof cur === "object" ? cur : {}), prefs }));
  for (const k of ["settings", ...also]) void qc.invalidateQueries({ queryKey: [k] });
}

/** The settings as they are now (a save elsewhere on the page included), the page's copy until they load. */
export function useLivePrefs(prefs: Prefs): Prefs {
  const live = useQuery({ queryKey: ["settings"], queryFn: api.settings });
  return live.data?.prefs ?? prefs;
}

export const SAVE_FAILED = "Couldn't save — try again.";

export function useSaveAsYouGo(prefs: Prefs) {
  const qc = useQueryClient();
  const live = useLivePrefs(prefs);
  const [draft, setDraft] = useState(live);
  const draftRef = useRef(draft);
  draftRef.current = draft;
  /** Fields the athlete holds: being edited, or changed and not yet saved. The server's copy never overwrites them. */
  const held = useRef(new Set<keyof Prefs>());
  /** The changes waiting while a save is out, merged: the last value of each field wins. */
  const waiting = useRef<Partial<Prefs> | null>(null);
  const out = useRef(false);
  /** The save that is out, as sent: a value already on its way is not sent again (a whole race date, then a blur). */
  const sending = useRef<Partial<Prefs> | null>(null);
  const [status, setStatus] = useState("");

  // What the server holds comes back after each save: the fields follow it — all but the ones the athlete holds.
  useEffect(() => {
    setDraft((d) => {
      const next = { ...live };
      for (const k of held.current) (next as Record<string, unknown>)[k] = d[k];
      return next;
    });
  }, [live]);

  const flush = async () => {
    if (out.current || !waiting.current) return;
    const body = waiting.current;
    waiting.current = null;
    out.current = true;
    sending.current = body;
    try {
      const res = await api.updateSettings(body);
      // A field is the server's again once what it holds is what was saved and nothing newer waits for it.
      for (const k of Object.keys(body) as Array<keyof Prefs>) {
        if (draftRef.current[k] === body[k] && !(waiting.current && k in waiting.current)) held.current.delete(k);
      }
      setStatus("Saved.");
      await applySavedPrefs(qc, res.prefs);
    } catch {
      setStatus(SAVE_FAILED);
    } finally {
      out.current = false;
      sending.current = null;
      if (waiting.current) void flush();
    }
  };

  /** A field is being typed in: it is the athlete's until it is saved. */
  const set = <K extends keyof Prefs>(k: K, v: Prefs[K]) => {
    held.current.add(k);
    setDraft((d) => ({ ...d, [k]: v }));
  };
  /** A field's value is chosen (a tap) or left (a blur): save it, after any save already out. */
  const commit = <K extends keyof Prefs>(k: K, v: Prefs[K]) => {
    setDraft((d) => ({ ...d, [k]: v }));
    const pendingHere = waiting.current !== null && k in waiting.current;
    if (!pendingHere && sending.current && k in sending.current && sending.current[k] === v) return;
    if (v === live[k] && !pendingHere && !out.current) {
      held.current.delete(k);
      return;
    }
    held.current.add(k);
    waiting.current = { ...(waiting.current ?? {}), [k]: v };
    void flush();
  };
  return { draft, set, commit, status, live };
}

/** A switch on one setting: on the tap, held while the settings are read again, back (and said) on a failure. */
export function useSettingSwitch<K extends "aiEnabled" | "corosWritesEnabled">(key: K, prefs: Prefs, also: readonly string[]) {
  const qc = useQueryClient();
  const live = useLivePrefs(prefs);
  const [failed, setFailed] = useState(false);
  const toggle = useMutation({
    mutationFn: (value: boolean) => api.updateSettings({ [key]: value } as Partial<Prefs>),
    onMutate: async (value: boolean) => {
      setFailed(false);
      await qc.cancelQueries({ queryKey: ["settings"] });
      const before = qc.getQueryData<SettingsResponse>(["settings"]);
      qc.setQueryData(["settings"], (cur: unknown) => {
        const c = (cur && typeof cur === "object" ? cur : { prefs }) as { prefs?: Prefs };
        return { ...c, prefs: { ...(c.prefs ?? prefs), [key]: value } };
      });
      return { before };
    },
    onError: (_e, _v, ctx) => {
      if (ctx?.before) qc.setQueryData(["settings"], ctx.before);
      setFailed(true);
    },
    onSuccess: (res) => applySavedPrefs(qc, res.prefs, also),
  });
  const on = live[key] as boolean;
  return { on, busy: toggle.isPending, failed, flip: () => toggle.mutate(!on) };
}
