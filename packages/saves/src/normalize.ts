import { asciiFold } from "./ids.js";

const STOP = new Set(["the", "a", "an", "with", "your"]);

const singular = (w: string): string => {
  if (w.length > 3 && w.endsWith("es") && /(?:ch|sh|x|s|z)es$/.test(w)) return w.slice(0, -2);
  if (w.length > 2 && w.endsWith("s") && !w.endsWith("ss")) return w.slice(0, -1);
  return w;
};

/** A move name in a form that spellings of the same move share. */
export function normalizeMoveName(name: string): string {
  return asciiFold(name)
    .toLowerCase()
    .replace(/[/\-_]/g, " ")
    .split(/\s+/)
    .filter((w) => w && !STOP.has(w))
    .map(singular)
    .join(" ");
}
