/**
 * SAVE ▾ AND "SAVE AS TEMPLATE" (Stage 2 spec §8). The builder's save menu is a small menu under its button: Escape or a
 * tap elsewhere closes it, the arrows move between its items. A choice puts focus back on Save before it runs, so a
 * sheet it opens (the template's name) returns focus there when it closes, and a choice that opens nothing leaves it
 * there — focus never falls to the page.
 */
import { useCallback, useEffect, useId, useRef, useState, type KeyboardEvent } from "react";
import { Sheet, useEscapeKey } from "../../components.js";
import { IconChevron } from "../../icons.js";

export interface SaveChoice {
  label: string;
  run: () => void;
}

export function SaveMenu({ items }: { items: readonly SaveChoice[] }) {
  const [open, setOpen] = useState(false);
  const id = useId();
  const wrap = useRef<HTMLDivElement>(null);
  const button = useRef<HTMLButtonElement>(null);
  const close = useCallback(() => setOpen(false), []);
  useEscapeKey(open, () => {
    close();
    button.current?.focus();
  });
  useEffect(() => {
    if (!open) return;
    const away = (e: PointerEvent) => {
      if (!wrap.current?.contains(e.target as Node)) close();
    };
    document.addEventListener("pointerdown", away);
    wrap.current?.querySelector<HTMLElement>('[role="menuitem"]')?.focus();
    return () => document.removeEventListener("pointerdown", away);
  }, [open, close]);
  const move = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key !== "ArrowDown" && e.key !== "ArrowUp") return;
    e.preventDefault();
    const all = [...(wrap.current?.querySelectorAll<HTMLElement>('[role="menuitem"]') ?? [])];
    const at = all.indexOf(document.activeElement as HTMLElement);
    all[(at + (e.key === "ArrowDown" ? 1 : all.length - 1)) % all.length]?.focus();
  };
  return (
    <div className="stu-save" ref={wrap}>
      <button ref={button} type="button" className="btn stu-save-btn" aria-haspopup="menu" aria-expanded={open} aria-controls={id} onClick={() => setOpen((v) => !v)}>
        Save
        <span className="stu-save-chev" aria-hidden="true">
          <IconChevron size={14} />
        </span>
      </button>
      <div id={id} role="menu" className="stu-save-menu" hidden={!open} onKeyDown={move}>
        {items.map((it) => (
          <button
            key={it.label}
            type="button"
            role="menuitem"
            className="stu-save-item"
            onClick={() => {
              // The item is about to be hidden: focus rests on Save first, so whatever the choice opens returns it there.
              button.current?.focus();
              close();
              it.run();
            }}
          >
            {it.label}
          </button>
        ))}
      </div>
    </div>
  );
}

/** "Save as template": its name (the title by default), then the server keeps it. */
export function NameSheet({ initial, onSave, onClose }: { initial: string; onSave: (name: string) => Promise<string | null>; onClose: () => void }) {
  const [name, setName] = useState(initial);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const id = useId();
  const go = async () => {
    if (!name.trim() || busy) return;
    setBusy(true);
    setError(null);
    const why = await onSave(name);
    setBusy(false);
    if (why) setError(why);
  };
  return (
    <Sheet
      open
      onClose={onClose}
      title="Save as template"
      footer={
        <div className="btn-row stu-sched-actions">
          <button type="button" className="btn btn-primary" disabled={!name.trim() || busy} onClick={() => void go()}>
            {busy ? "Saving…" : "Save"}
          </button>
        </div>
      }
    >
      <label className="stu-field-row stu-field-row--wide" htmlFor={id}>
        <span>Name</span>
        <input
          id={id}
          className="stu-field"
          value={name}
          maxLength={80}
          autoComplete="off"
          onChange={(e) => setName(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") void go();
          }}
        />
      </label>
      {error ? (
        <p className="stu-build-error" role="alert">
          {error}
        </p>
      ) : null}
    </Sheet>
  );
}
