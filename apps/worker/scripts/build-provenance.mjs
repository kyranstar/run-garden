#!/usr/bin/env node
/**
 * The private provenance file, built on the owner's machine (Phase 2 spec §2c "Provenance import"; plan 2c Task 6).
 *
 *   node apps/worker/scripts/build-provenance.mjs \
 *     --library <the standalone tool's data/exercises dir> --saves <the saves catalogue's exercises.json> --out <file>
 *
 * Reads only the paths it is given (nothing personal is named in this repository):
 *   - the standalone tool's exercise files (`Data.addExercises([...])`): each record's `sources` ({type, url, creator, key});
 *   - the saves catalogue: a JSON array of saved exercises ({exerciseKey, postUrl, creator, name, aliases,
 *     postNeedsHumanReview}).
 * Writes `{format: "rg-provenance", version: 1, items: [{exerciseId, sourceType, url, creator, sourceKey}]}` to --out,
 * which must lie outside this repository and outside any git work tree, readable by the owner only. Settings → Import →
 * "Saved-post links…" imports it into the account (`exercise_provenance`); delete the file after.
 *
 * How a source finds its Run Garden move:
 *   1. A standalone record's sources go to that record's move: by id, or through the library's legacy ids.
 *   2. A saved exercise the standalone library does not cite, from a post not flagged for review, goes to the move whose
 *      name it carries — its name or one of its aliases, ignoring case, punctuation, a plural "s" and small words — when
 *      exactly one move does. That is how moves curated from the saves find theirs: no save is named in the library.
 *   Everything else is counted (unmapped, flagged, unresolved) and left out.
 * One saved exercise cited by several moves keeps a row per move (`<key>~<move id>`), since the account holds one row
 * per (source type, key). What the command prints is counts only.
 */
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import vm from "node:vm";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, "..", "..", "..");
const LIBRARY_SRC = join(REPO, "packages", "exercise-library", "src");

const SMALL_WORDS = new Set(["a", "an", "and", "for", "in", "of", "on", "the", "to", "with", "your"]);

/** A name as matching reads it: "Hamstring bridge (heels on chair)" and "Hamstring bridge · heels on chair" agree. */
export function nameKey(name) {
  return String(name ?? "")
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .split(/\s+/)
    .filter((t) => t && !SMALL_WORDS.has(t))
    .map((t) => (t.length > 3 && t.endsWith("s") && !t.endsWith("ss") ? t.slice(0, -1) : t))
    .join(" ");
}

/** The source type a saved post's link implies — the site's own name (its host's second-level label). */
function sourceTypeOf(url) {
  try {
    const labels = new URL(url).hostname.split(".").filter(Boolean);
    return labels.length > 1 ? labels[labels.length - 2] : labels[0] ?? "saved";
  } catch {
    return "saved";
  }
}

const text = (v) => (typeof v === "string" && v.trim() ? v : null);

/**
 * The provenance items for a library, the standalone tool's records and the saves catalogue, with counts.
 * `library`: [{id, name, legacyIds}] (Run Garden's moves).
 */
export function buildProvenance({ library, standalone, saves }) {
  const byId = new Map();
  const byLegacy = new Map();
  const byName = new Map();
  for (const ex of library) {
    byId.set(ex.id, ex.id);
    for (const old of ex.legacyIds ?? []) if (!byLegacy.has(old)) byLegacy.set(old, ex.id);
    const key = nameKey(ex.name);
    if (key) byName.set(key, [...(byName.get(key) ?? []), ex.id]);
  }
  const resolveId = (id) => byId.get(id) ?? byLegacy.get(id) ?? null;

  const counts = { items: 0, moves: 0, fromStandalone: 0, fromSaves: 0, unmapped: 0, flagged: 0, unresolved: 0, shared: 0 };
  const found = [];
  const seen = new Set();
  const cited = new Set();
  const pair = (type, key) => `${type}\u0000${key}`;
  const add = (c) => {
    const k = `${pair(c.sourceType, c.key)}\u0000${c.exerciseId}`;
    if (seen.has(k)) return false;
    seen.add(k);
    found.push(c);
    return true;
  };

  for (const record of standalone) {
    const sources = Array.isArray(record?.sources) ? record.sources : [];
    if (!sources.length) continue;
    const exerciseId = [record.id, ...(Array.isArray(record.legacyIds) ? record.legacyIds : [])].map(resolveId).find(Boolean) ?? null;
    for (const s of sources) {
      const key = text(s?.key);
      if (!exerciseId || !key) {
        counts.unresolved += 1;
        continue;
      }
      const sourceType = text(s.type) ?? sourceTypeOf(s.url);
      cited.add(pair(sourceType, key));
      if (add({ exerciseId, sourceType, url: text(s.url), creator: text(s.creator), key })) counts.fromStandalone += 1;
    }
  }

  for (const e of saves) {
    const key = text(e?.exerciseKey);
    if (!key) continue;
    const sourceType = sourceTypeOf(e.postUrl);
    if (cited.has(pair(sourceType, key))) continue;
    if (e.postNeedsHumanReview) {
      counts.flagged += 1;
      continue;
    }
    const ids = new Set();
    for (const name of [e.name, ...(Array.isArray(e.aliases) ? e.aliases : [])]) for (const id of byName.get(nameKey(name)) ?? []) ids.add(id);
    if (ids.size !== 1) {
      counts.unmapped += 1;
      continue;
    }
    if (add({ exerciseId: [...ids][0], sourceType, url: text(e.postUrl), creator: text(e.creator), key })) counts.fromSaves += 1;
  }

  const movesPerKey = new Map();
  for (const c of found) {
    const k = pair(c.sourceType, c.key);
    movesPerKey.set(k, (movesPerKey.get(k) ?? new Set()).add(c.exerciseId));
  }
  const items = found.map((c) => ({
    exerciseId: c.exerciseId,
    sourceType: c.sourceType,
    url: c.url,
    creator: c.creator,
    sourceKey: movesPerKey.get(pair(c.sourceType, c.key)).size > 1 ? `${c.key}~${c.exerciseId}` : c.key,
  }));
  counts.shared = [...movesPerKey.values()].filter((ids) => ids.size > 1).length;
  counts.items = items.length;
  counts.moves = new Set(items.map((i) => i.exerciseId)).size;
  return { items, counts };
}

/** The standalone tool's records: its exercise files run against a stand-in for its `Data` registry. */
export function loadStandalone(dir) {
  const records = [];
  const context = vm.createContext({ Data: { addExercises: (list) => records.push(...list) } });
  for (const file of readdirSync(dir).filter((f) => f.endsWith(".js")).sort()) {
    vm.runInContext(readFileSync(join(dir, file), "utf8"), context, { filename: file, timeout: 5000 });
  }
  return records;
}

/** Run Garden's moves ({id, name, legacyIds}), read from the library's own source (transpiled to a temp dir). */
async function loadLibrary() {
  const ts = (await import("typescript")).default;
  const out = mkdtempSync(join(tmpdir(), "rg-library-"));
  try {
    const copy = (from, to) => {
      mkdirSync(to, { recursive: true });
      for (const name of readdirSync(from)) {
        const path = join(from, name);
        if (statSync(path).isDirectory()) copy(path, join(to, name));
        else if (name.endsWith(".ts")) {
          const js = ts.transpileModule(readFileSync(path, "utf8"), {
            fileName: name,
            compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022, verbatimModuleSyntax: true },
          }).outputText;
          writeFileSync(join(to, name.replace(/\.ts$/, ".js")), js);
        }
      }
    };
    copy(LIBRARY_SRC, join(out, "src"));
    writeFileSync(join(out, "package.json"), JSON.stringify({ type: "module" }));
    const { EXERCISES } = await import(pathToFileURL(join(out, "src", "exercises", "index.js")).href);
    return EXERCISES.map((ex) => ({ id: ex.id, name: ex.name, legacyIds: [...(ex.legacyIds ?? [])] }));
  } finally {
    rmSync(out, { recursive: true, force: true });
  }
}

/** Why `--out` may not be written (inside this repository or any git work tree), or null. */
export function outRefusal(outPath) {
  let existing = resolve(outPath);
  while (!existsSync(existing) && dirname(existing) !== existing) existing = dirname(existing);
  const target = realpathSync(existing);
  const repo = realpathSync(REPO);
  if (target === repo || target.startsWith(repo + sep)) return "it is inside this repository";
  for (let dir = target; ; dir = dirname(dir)) {
    if (existsSync(join(dir, ".git"))) return "it is inside a git work tree";
    if (dirname(dir) === dir) return null;
  }
}

const USAGE = "usage: build-provenance.mjs --library <standalone data/exercises dir> --saves <saves exercises.json> --out <file outside the repository>";

async function main(argv) {
  let values;
  try {
    ({ values } = parseArgs({ args: argv, options: { library: { type: "string" }, saves: { type: "string" }, out: { type: "string" } }, strict: true }));
  } catch {
    values = {};
  }
  if (!values.library || !values.saves || !values.out) {
    console.error(USAGE);
    return 2;
  }
  const refusal = outRefusal(values.out);
  if (refusal) {
    console.error(`build-provenance: refusing --out (${refusal}). The file holds private links: write it outside the repository and any git work tree.`);
    return 2;
  }
  const standalone = loadStandalone(values.library);
  const saves = JSON.parse(readFileSync(values.saves, "utf8"));
  if (!Array.isArray(saves)) {
    console.error("build-provenance: --saves must be a JSON array of saved exercises.");
    return 2;
  }
  const { items, counts } = buildProvenance({ library: await loadLibrary(), standalone, saves });
  const out = resolve(values.out);
  mkdirSync(dirname(out), { recursive: true, mode: 0o700 });
  writeFileSync(out, `${JSON.stringify({ format: "rg-provenance", version: 1, items }, null, 2)}\n`, { mode: 0o600 });
  chmodSync(out, 0o600);
  console.log(
    `${counts.items} items for ${counts.moves} moves: ${counts.fromStandalone} from the standalone library, ${counts.fromSaves} by name from the saves. ` +
      `Left out: ${counts.unmapped} saved exercises with no single matching move, ${counts.flagged} from posts flagged for review, ` +
      `${counts.unresolved} standalone sources with no move. ${counts.shared} saved exercises are cited by more than one move.`,
  );
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) {
  main(process.argv.slice(2)).then(
    (code) => process.exit(code),
    (e) => {
      console.error(`build-provenance: ${e instanceof Error ? e.message : String(e)}`);
      process.exit(1);
    },
  );
}
