/**
 * ONE TAP, ONE REQUEST (the robustness pass). A button is disabled while its request is out — but only once React has
 * drawn it so, and a double or triple tap lands before that: two runs started, two answers sent, two approves raced,
 * the second answered "isn't open any more" over a decision that worked. `useOneTap` drops a tap while the last one's
 * request is still out, whatever has been drawn.
 */
import { useCallback, useRef } from "react";

/** Wraps a tap's request: another tap while it is out does nothing. A request that throws or fails frees the button. */
export function useOneTap(): (send: () => Promise<unknown>) => void {
  const out = useRef(false);
  return useCallback((send: () => Promise<unknown>) => {
    if (out.current) return;
    out.current = true;
    let sent: Promise<unknown>;
    try {
      sent = send();
    } catch {
      out.current = false;
      return;
    }
    void sent
      .catch(() => undefined)
      .finally(() => {
        out.current = false;
      });
  }, []);
}
