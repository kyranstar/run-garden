/**
 * THE APP'S SEARCH FIELD (Stage 2 spec §3–§4). A labelled `type="search"` input inside a `role="search"` landmark, with
 * the magnifier drawn beside it and one ✕ that empties it (the platform's own cancel button is hidden so there is
 * never two). Escape empties a field that has something in it, as a search field does everywhere else.
 *
 * Instant by construction: `onChange` fires on every keystroke and the caller filters as it goes. The input is 16px
 * so a phone never zooms into it, and the whole pill is the target (44px).
 */
import { useId, useRef } from "react";
import { IconClose, IconSearch } from "../icons.js";

export function SearchField({
  value,
  onChange,
  label,
  placeholder,
}: {
  value: string;
  onChange: (value: string) => void;
  /** The accessible name ("Search moves"). */
  label: string;
  placeholder?: string;
}) {
  const id = useId();
  const inputRef = useRef<HTMLInputElement>(null);
  return (
    <div className="search-field" role="search">
      <label className="visually-hidden" htmlFor={id}>
        {label}
      </label>
      <IconSearch />
      <input
        ref={inputRef}
        id={id}
        type="search"
        value={value}
        placeholder={placeholder}
        autoComplete="off"
        autoCapitalize="none"
        spellCheck={false}
        enterKeyHint="search"
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Escape" && value !== "") {
            // Emptying the field is this press's whole job: nothing behind it (a sheet) closes too.
            e.stopPropagation();
            e.nativeEvent.stopImmediatePropagation();
            onChange("");
          }
        }}
      />
      {value !== "" ? (
        <button
          type="button"
          className="search-clear tap-pad"
          aria-label="Clear search"
          onClick={() => {
            onChange("");
            // The button goes with the text; the field keeps the focus, ready for the next word.
            inputRef.current?.focus();
          }}
        >
          <IconClose />
        </button>
      ) : null}
    </div>
  );
}
