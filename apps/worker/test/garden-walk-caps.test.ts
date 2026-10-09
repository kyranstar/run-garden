/**
 * NO GARDEN WALK WITHOUT A CAP (cron reliability, part 4).
 *
 * advanceGarden and resimulateFrom walk to today by default — weeks of days when a long replay is on record — so an
 * invocation that calls them without caps can run far past what the free plan lets one spend. Part 4 found the garden
 * page and seven routes doing exactly that. Every call in the Worker's source now names its caps: the request step
 * (REQUEST_GARDEN_STEP), the crons' own, a `{ maxResimDays, maxWalkDays }` both set, or `opts` handed through by
 * garden-sync itself. A new caller that forgets fails here before it can reach prod.
 *
 * Exempt, on purpose: the dev fixture seed (fixture mode only; it grows a whole garden from nothing) and the
 * staging-only parity resim (POST /api/admin/parity/garden — a whole replay whose hashes are the point).
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";

const SRC = join(__dirname, "../src");
const EXEMPT = new Set(["services/fixtures.ts", "services/parity.ts"]);

function files(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    return statSync(path).isDirectory() ? files(path) : path.endsWith(".ts") ? [path] : [];
  });
}

/** The source with every comment blanked (strings kept), so prose that names a function is not a call. */
function code(text: string): string {
  let out = "";
  let i = 0;
  while (i < text.length) {
    const two = text.slice(i, i + 2);
    if (two === "//") {
      while (i < text.length && text[i] !== "\n") (out += " "), i++;
    } else if (two === "/*") {
      while (i < text.length && text.slice(i, i + 2) !== "*/") (out += text[i] === "\n" ? "\n" : " "), i++;
      out += "  ";
      i += 2;
    } else if (text[i] === '"' || text[i] === "'" || text[i] === "`") {
      const q = text[i]!;
      out += text[i++];
      while (i < text.length && text[i] !== q) {
        if (text[i] === "\\") out += text[i++];
        out += text[i++];
      }
      out += text[i++] ?? "";
    } else out += text[i++];
  }
  return out;
}

/** Each call's top-level arguments, as source text. */
function calls(src: string, name: string): string[][] {
  const found: string[][] = [];
  const re = new RegExp(`(?<![\\w.])${name}\\(`, "g");
  for (let m = re.exec(src); m; m = re.exec(src)) {
    const before = src.slice(Math.max(0, m.index - 16), m.index);
    if (/function\s*$/.test(before)) continue; // the declaration
    let depth = 1;
    let i = m.index + m[0].length;
    let arg = "";
    const args: string[] = [];
    for (; i < src.length && depth > 0; i++) {
      const ch = src[i]!;
      if ("([{".includes(ch)) depth++;
      if (")]}".includes(ch)) depth--;
      if (depth === 0) break;
      if (ch === "," && depth === 1) {
        args.push(arg.trim());
        arg = "";
      } else arg += ch;
    }
    if (arg.trim()) args.push(arg.trim());
    found.push(args);
  }
  return found;
}

/** The options argument names both caps (or is the request step, or garden-sync handing its caller's through). */
function capped(last: string | undefined): boolean {
  if (!last) return false;
  if (last === "REQUEST_GARDEN_STEP" || last === "opts") return true;
  return /\bmaxResimDays\b/.test(last) && /\bmaxWalkDays\b/.test(last);
}

describe("every garden walk in the Worker names its caps", () => {
  it("advanceGarden and resimulateFrom are never called with the uncapped defaults", () => {
    const offenders: string[] = [];
    let seen = 0;
    for (const path of files(SRC)) {
      const rel = relative(SRC, path);
      if (EXEMPT.has(rel)) continue;
      const src = code(readFileSync(path, "utf8"));
      for (const [name, optsAt] of [["advanceGarden", 4], ["resimulateFrom", 5]] as const) {
        for (const args of calls(src, name)) {
          seen += 1;
          if (!capped(args[optsAt])) offenders.push(`${rel}: ${name}(${args.join(", ")})`);
        }
      }
    }
    expect(offenders).toEqual([]);
    expect(seen).toBeGreaterThanOrEqual(14); // the scan found the calls it is about
  });

  it("the scan sees through comments and catches a call without caps", () => {
    const src = code(`
      // advanceGarden(db, userId, prefs) in prose is not a call
      /* nor resimulateFrom(db, userId, d, prefs) here */
      await resimulateFrom(db, userId, day, prefs).catch(() => undefined);
      await advanceGarden(db, userId, prefs, new Date(), { maxWalkDays: 3, maxResimDays: 3 });
      await resimulateFrom(db, userId, day, prefs, new Date(), { maxResimDays: 3 });
    `);
    expect(calls(src, "advanceGarden").map((a) => capped(a[4]))).toEqual([true]);
    expect(calls(src, "resimulateFrom").map((a) => capped(a[5]))).toEqual([false, false]);
  });
});
