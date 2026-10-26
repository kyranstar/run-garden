#!/usr/bin/env node
/**
 * Seed the first capture's posts (saved-posts import, plan Task 20 Step 1; spec §9 "Seed"). Run by the lead, on the
 * owner's machine, BEFORE the extension holds a live token (or with Options → Pages per check at 1), so the extension's
 * first checks never read the captured posts as new:
 *
 *   node apps/worker/scripts/seed-saves.mjs <capture.json> \
 *     --source <the source name the extension uses> --app <the app's origin> --token-file <file holding the saves token> \
 *     [--dry-run]
 *
 * Reads only the paths it is given — the private capture file (a JSON array of post records, or `{posts: [...]}`) and the
 * token file, neither of which may lie inside this repository — and writes nothing anywhere. Each record becomes one
 * `POST /api/saves/posts` with a `seed` (`toSeed`, seed-saves-lib.mjs): the training categories `queued`, everything
 * else `filtered_out` ("not training (first capture)"). The keys are first asked of `POST /api/saves/known` in pages of
 * 200, and only the ones the app has no row for are sent, one at a time: a re-run sends nothing twice, and a seeded post
 * costs no model call. `--dry-run` asks `/known` and sends nothing. What it prints is counts only — never a link, key or
 * creator. A 401 (the token) or 404 (the import is off on the app) stops it.
 */
import { readFileSync, realpathSync } from "node:fs";
import { dirname, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { toSeed, WEB_PROTOCOL } from "./seed-saves-lib.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, "..", "..", "..");
/** The route's own source rule (`SAVE_SOURCE_RE`, @rg/saves). */
const SOURCE_RE = /^[a-z][a-z0-9._-]{0,39}$/;
/** The most keys one `/known` call carries (`KNOWN_MAX_KEYS`). */
const KNOWN_PAGE = 200;

const USAGE = "usage: seed-saves.mjs <capture.json> --source <name> --app <origin> --token-file <file> [--dry-run]";

/** Why a private input may not be read from `path` (inside this repository), or null. */
export function inRepoRefusal(path) {
  const target = realpathSync(resolve(path));
  const repo = realpathSync(REPO);
  return target === repo || target.startsWith(repo + sep) ? "it is inside this repository: keep private files outside it" : null;
}

/** The capture's records: a JSON array, or an object holding one under `posts` or `items`. */
export function recordsOf(raw) {
  if (Array.isArray(raw)) return raw;
  if (raw && typeof raw === "object") {
    if (Array.isArray(raw.posts)) return raw.posts;
    if (Array.isArray(raw.items)) return raw.items;
  }
  throw new Error("the capture file is not a list of posts");
}

class Stop extends Error {}

/** Seed `records` into the app. Counts only. */
export async function seed(records, { source, app, token, dryRun = false, fetchImpl = fetch, log = () => {} }) {
  const counts = { records: records.length, skipped: 0, duplicate: 0, known: 0, queued: 0, filteredOut: 0, failed: 0 };
  const bodies = new Map();
  for (const r of records) {
    const s = toSeed(r);
    if (!s) counts.skipped += 1;
    else if (bodies.has(s.key)) counts.duplicate += 1;
    else bodies.set(s.key, s);
  }
  const base = new URL(app);
  const call = async (path, body) => {
    const res = await fetchImpl(new URL(path, base), {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (res.status === 401) throw new Stop("the app refused the token (401)");
    if (res.status === 404) throw new Stop("the app's saves import is off (404)");
    return res;
  };
  const keys = [...bodies.keys()];
  const fresh = [];
  for (let i = 0; i < keys.length; i += KNOWN_PAGE) {
    const page = keys.slice(i, i + KNOWN_PAGE);
    const res = await call("/api/saves/known", { source, keys: page });
    if (!res.ok) throw new Stop(`/known answered ${res.status}`);
    const got = await res.json();
    fresh.push(...(Array.isArray(got?.fresh) ? got.fresh : []));
  }
  counts.known = keys.length - fresh.length;
  if (dryRun) {
    for (const k of fresh) bodies.get(k)?.seed.status === "queued" ? (counts.queued += 1) : (counts.filteredOut += 1);
    return counts;
  }
  for (const [i, key] of fresh.entries()) {
    const s = bodies.get(key);
    if (!s) continue;
    const res = await call("/api/saves/posts", { source, ...s });
    if (res.ok) s.seed.status === "queued" ? (counts.queued += 1) : (counts.filteredOut += 1);
    else counts.failed += 1;
    if ((i + 1) % 50 === 0) log(`sent ${i + 1} of ${fresh.length}`);
  }
  return counts;
}

async function main(argv) {
  let parsed;
  try {
    parsed = parseArgs({
      args: argv,
      allowPositionals: true,
      strict: true,
      options: { source: { type: "string" }, app: { type: "string" }, "token-file": { type: "string" }, "dry-run": { type: "boolean" } },
    });
  } catch (e) {
    console.error(`${String(e.message ?? e)}\n${USAGE}`);
    return 2;
  }
  const { values, positionals } = parsed;
  const file = positionals[0];
  const source = values.source;
  if (!file || positionals.length > 1 || !source || !values.app || !values["token-file"]) {
    console.error(USAGE);
    return 2;
  }
  if (!SOURCE_RE.test(source)) {
    console.error("--source: lower case letters, digits, . _ -, starting with a letter");
    return 2;
  }
  let app;
  try {
    app = new URL(values.app);
    if (app.protocol !== WEB_PROTOCOL && app.hostname !== "localhost" && app.hostname !== "127.0.0.1") throw new Error("not a web origin");
  } catch {
    console.error("--app: the app's https origin (or localhost, for the fixture stack)");
    return 2;
  }
  for (const [what, path] of [["the capture file", file], ["the token file", values["token-file"]]]) {
    const why = inRepoRefusal(path);
    if (why) {
      console.error(`${what}: ${why}`);
      return 2;
    }
  }
  const token = readFileSync(values["token-file"], "utf8").trim();
  if (!token) {
    console.error("the token file is empty");
    return 2;
  }
  const records = recordsOf(JSON.parse(readFileSync(file, "utf8")));
  try {
    const counts = await seed(records, { source, app: app.origin, token, dryRun: values["dry-run"] === true, log: (m) => console.log(m) });
    console.log(JSON.stringify({ dryRun: values["dry-run"] === true, ...counts }));
    return counts.failed ? 1 : 0;
  } catch (e) {
    if (e instanceof Stop) {
      console.error(e.message);
      return 1;
    }
    throw e;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main(process.argv.slice(2)).then((code) => process.exit(code));
}


