/**
 * THE SCREEN STAYS ON WHILE PLAYING (spec §2b "Player"; spike report "Things the player must do" 2). A wake lock is
 * released whenever the page is hidden and never comes back by itself, so it is taken again each time the page is
 * visible. A browser without one (older iOS) or that refuses changes nothing else. Returns `release`.
 */
interface Sentinel {
  release(): Promise<void>;
}
interface NavLike {
  wakeLock?: { request(type: "screen"): Promise<Sentinel> };
}
type DocLike = Pick<Document, "visibilityState"> & Pick<EventTarget, "addEventListener" | "removeEventListener">;

export function holdWakeLock(
  nav: NavLike = typeof navigator === "undefined" ? {} : (navigator as unknown as NavLike),
  doc: DocLike = document,
): () => void {
  let sentinel: Sentinel | null = null;
  let stopped = false;
  const take = () => {
    if (stopped || !nav.wakeLock || doc.visibilityState !== "visible") return;
    nav.wakeLock
      .request("screen")
      .then((s) => {
        if (stopped) void s.release().catch(() => undefined);
        else sentinel = s;
      })
      .catch(() => undefined);
  };
  const onVisible = () => {
    if (doc.visibilityState === "visible") take();
  };
  doc.addEventListener("visibilitychange", onVisible);
  take();
  return () => {
    stopped = true;
    doc.removeEventListener("visibilitychange", onVisible);
    void sentinel?.release().catch(() => undefined);
    sentinel = null;
  };
}
