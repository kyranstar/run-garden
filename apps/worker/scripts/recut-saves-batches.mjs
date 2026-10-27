#!/usr/bin/env node
/**
 * Print the SQL that dissolves held saves batches so the assembler re-cuts them (saves-flow redesign, Task 15). Run by
 * the lead after deploy:
 *
 *   node apps/worker/scripts/recut-saves-batches.mjs --batch <id> [--batch <id> ...] [--dry-run]
 *
 * With --dry-run it prints the read-only SELECT counts; without it, the four UPDATEs in order, joined by ";\n". It
 * never runs wrangler, never opens a database and writes no file: the lead pipes what it prints, one statement at a time.
 */
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { checkStatements, recutStatements } from "./recut-saves-lib.mjs";

const USAGE = "usage: recut-saves-batches.mjs --batch <id> [--batch <id> ...] [--dry-run]";

export function main(argv, { log = (m) => console.log(m) } = {}) {
  let parsed;
  try {
    parsed = parseArgs({
      args: argv,
      allowPositionals: false,
      strict: true,
      options: { batch: { type: "string", multiple: true }, "dry-run": { type: "boolean" } },
    });
  } catch (e) {
    console.error(`${String(e.message ?? e)}\n${USAGE}`);
    return 2;
  }
  const ids = parsed.values.batch ?? [];
  try {
    const statements = parsed.values["dry-run"] ? checkStatements(ids) : recutStatements(ids);
    log(statements.join(";\n"));
    return 0;
  } catch (e) {
    console.error(`${String(e.message ?? e)}\n${USAGE}`);
    return 2;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  process.exit(main(process.argv.slice(2)));
}
