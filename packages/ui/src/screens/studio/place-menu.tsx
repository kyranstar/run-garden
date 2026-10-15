/**
 * THE PLACE (CUJ R8): where the workout is done, a chip in the builder's header — the default place until another is
 * chosen. Its menu lists the athlete's places and "No equipment"; the choice is the document's own (`setting.placeId`,
 * "none" for no equipment, one edit and one Undo), so the gear the builder judges and suggests with, and the server's,
 * are that place's. A menu as the Save menu is: Escape or a tap elsewhere closes it, the arrows move in it, and a
 * choice puts focus back on the chip. A workout that can't change says its place, with nothing to choose.
 */
import { useCallback, useEffect, useId, useRef, useState, type KeyboardEvent } from "react";
import { useEscapeKey } from "../../components.js";
import { IconChevron } from "../../icons.js";

export interface PlaceChoice {
  /** The place's id; "none" for no equipment; undefined for the library's Home (no place saved). */
  id: string | undefined;
  name: string;
}

export function PlaceMenu({
  name,
  chosen,
  choices,
  onPick,
  readOnly = false,
}: {
  /** The place it is done at, by name. */
  name: string;
  /** Its id, as the choices carry it. */
  chosen: string | undefined;
  choices: readonly PlaceChoice[];
  onPick: (id: string | undefined) => void;
  readOnly?: boolean;
}) {
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
    (wrap.current?.querySelector<HTMLElement>('[aria-checked="true"]') ?? wrap.current?.querySelector<HTMLElement>('[role="menuitemradio"]'))?.focus();
    return () => document.removeEventListener("pointerdown", away);
  }, [open, close]);
  const move = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key !== "ArrowDown" && e.key !== "ArrowUp") return;
    e.preventDefault();
    const all = [...(wrap.current?.querySelectorAll<HTMLElement>('[role="menuitemradio"]') ?? [])];
    const at = all.indexOf(document.activeElement as HTMLElement);
    all[(at + (e.key === "ArrowDown" ? 1 : all.length - 1)) % all.length]?.focus();
  };
  return (
    <div className="stu-build-place">
      <span className="stu-build-k">Place</span>
      {readOnly ? (
        <span className="stu-place-name">{name}</span>
      ) : (
        <div className="stu-place" ref={wrap}>
          <button
            ref={button}
            type="button"
            className="chip stu-place-btn"
            aria-label={`Place: ${name}`}
            aria-haspopup="menu"
            aria-expanded={open}
            aria-controls={id}
            onClick={() => setOpen((v) => !v)}
          >
            {name}
            <span className="stu-place-chev" aria-hidden="true">
              <IconChevron size={14} />
            </span>
          </button>
          <div id={id} role="menu" aria-label="Place" className="stu-save-menu stu-place-menu" hidden={!open} onKeyDown={move}>
            {choices.map((c) => (
              <button
                key={c.id ?? "default"}
                type="button"
                role="menuitemradio"
                aria-checked={c.id === chosen}
                className="stu-save-item"
                onClick={() => {
                  button.current?.focus();
                  close();
                  onPick(c.id);
                }}
              >
                {c.name}
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
