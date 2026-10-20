import type { APIRequestContext, TestInfo } from "@playwright/test";

/**
 * SEEDING, OUT OF EVERY OTHER TEST'S WAY. A seed (`POST /api/dev/seed`) holds the fixture worker for its whole span —
 * about a second alone, 6–8 s on a busy runner — and every request sent meanwhile waits behind it, `/api/health` too.
 * Held past 5 s, the pooled connections those requests wait on in wrangler's dev proxy idle out and close under them;
 * the proxy replays a POST once, at once, onto another closed one, and the test's write comes back 500 having never
 * reached the app (CI 39366660097, 2026-10-19: body-check's Undo on the iPhone while coach-notices seeded its next
 * account).
 *
 * So the suite seeds in two places only, both through this module:
 *   - before any test starts, the global setup (global-setup.ts) seeds every account SEEDED lists, one after another —
 *     for each project, and for each execution a test may have in the run (`--repeat-each`, retries). A spec signs
 *     into its account by `seededAccount`, which says so if the account was never seeded;
 *   - `seedAlone`, for a journey that truly needs its account seeded again mid-run: refused unless the run has one
 *     worker, so nothing else runs while the seed holds the worker.
 * The guard (apps/web/test/e2e-seeding.test.ts) fails on `/api/dev/seed` anywhere else under e2e/. The scenario levers
 * (`/api/dev/coach-notices`, `/api/dev/watch-version`, `/api/dev/watch-session`, `/api/dev/threshold`) take
 * milliseconds and stay in the journeys that pull them.
 */

type Env = Readonly<Record<string, string | undefined>>;

/** A spec that signs into accounts of its own, seeded before the run. */
export interface SeededSpec {
  /** The spec's file name under e2e/. */
  readonly file: string;
  /** Whether it runs in this environment: its own file-level `test.skip`, read the same way. */
  readonly runs: (env: Env) => boolean;
  /** Its accounts for one project, before an execution's suffix; `run` is this run's tag (`runTag`). */
  readonly accounts: (project: string, run: string) => readonly string[];
}

const scripted = (env: Env): boolean => env.RG_E2E_DESIGN_MODEL === "scripted:now";

export const SEEDED: readonly SeededSpec[] = [
  // One account per kind: the engine's brings a programme session to today, the run's a run of the plan.
  { file: "body-check.spec.ts", runs: () => true, accounts: (p) => [`body-engine-${p}`, `body-run-${p}`] },
  // One per test, new each run: a seed again leaves the coach's conversations and the review shown, and these start
  // with nothing asked and the review never shown.
  { file: "coach-notices.spec.ts", runs: () => true, accounts: (p, run) => [`notices-${run}-${p}`, `notices-${run}-${p}-l`, `notices-${run}-${p}-h`] },
  { file: "watch.spec.ts", runs: (env) => env.RG_E2E_WATCH === "1", accounts: (p) => [`watch-${p}`] },
  // The training-line journey's, new each run: it stops the line its lever wrote, and the lever writes it once an account.
  { file: "coach-training-line.spec.ts", runs: () => true, accounts: (p, run) => [`line-${run}-${p}`] },
  { file: "coach-plan-retire.spec.ts", runs: scripted, accounts: (p) => [`retire-${p}`] },
  { file: "coach-plan-race.spec.ts", runs: scripted, accounts: (p) => [`race-${p}`] },
];

/** A repeat (`--repeat-each`) or a retry of a test signs into an account of its own, as each once seeded its own. */
export function executionSuffix(repeatEachIndex: number, retry: number): string {
  return `${repeatEachIndex ? `-${repeatEachIndex}` : ""}${retry ? `-r${retry}` : ""}`;
}

/** This run's tag, from the global setup: an account new each run carries it. */
export function runTag(): string {
  const run = process.env.RG_E2E_RUN;
  if (!run) throw new Error("No run tag: the global setup (e2e/global-setup.ts) did not run, and it seeds the accounts the specs sign into.");
  return run;
}

/** The account this execution of a test signs into: `name` as SEEDED lists it, with the execution's suffix. */
export function seededAccount(testInfo: Pick<TestInfo, "repeatEachIndex" | "retry">, name: string): string {
  const account = `${name}${executionSuffix(testInfo.repeatEachIndex, testInfo.retry)}`;
  if (!(process.env.RG_E2E_SEEDED ?? "").split(",").includes(account)) {
    throw new Error(`"${account}" was not seeded before the run: list it in SEEDED (e2e/seeded-accounts.ts), which the global setup seeds before any test starts.`);
  }
  return account;
}

/** Every account to seed before the run, in order, with the spec each is for. */
export function accountsToSeed(opts: {
  projects: readonly string[];
  run: string;
  env: Env;
  /** Whether the run takes this spec file (`selectedSpecs`; all of them when null). */
  selected: ReadonlySet<string> | null;
  repeatEach: number;
  retries: number;
}): Array<{ file: string; account: string }> {
  const out: Array<{ file: string; account: string }> = [];
  for (const spec of SEEDED) {
    if (!spec.runs(opts.env) || (opts.selected && !opts.selected.has(spec.file))) continue;
    for (const project of opts.projects) {
      for (const name of spec.accounts(project, opts.run)) {
        for (let repeat = 0; repeat < opts.repeatEach; repeat++) {
          for (let retry = 0; retry <= opts.retries; retry++) out.push({ file: spec.file, account: `${name}${executionSuffix(repeat, retry)}` });
        }
      }
    }
  }
  return out;
}

/** Playwright's options that take the next argument as their value (`--project` takes every one up to the next option). */
const TAKES_VALUE = new Set([
  "-c", "--config", "--browser", "--global-timeout", "-g", "--grep", "--grep-invert", "--last-failed-file", "--max-failures",
  "--output", "--repeat-each", "--reporter", "--retries", "--run-agents", "--shard", "--timeout", "--trace", "--tsconfig",
  "--test-list", "--test-list-invert", "--ui-host", "--ui-port", "--update-source-method", "-j", "--workers",
]);
/** Options whose value is optional: the next argument is theirs only when it is one of these. */
const MAY_TAKE_VALUE: Record<string, readonly string[]> = {
  "--debug": ["inspector", "cli"],
  "-u": ["all", "changed", "missing", "none"],
  "--update-snapshots": ["all", "changed", "missing", "none"],
};

/**
 * The spec files (names under e2e/) a `playwright test` command line runs — or null for all of them, and whenever in
 * doubt. The global setup runs before Playwright applies the command line's file filters, so it reads them here, only
 * so that a run of one spec seeds that spec's accounts and not every spec's. Playwright takes each positional argument
 * (less a `:line`) as a regular expression on the file's absolute path, and whatever else picks tests (--grep,
 * --last-failed, --only-changed, --shard) picks among those files. Never fewer than it runs: an argument that matches no
 * spec file at all (an option's value this parse missed, such as --only-changed's ref) seeds them all.
 */
export function selectedSpecs(argv: readonly string[], specPaths: readonly string[]): Set<string> | null {
  const at = argv.indexOf("test");
  if (at < 0) return null;
  const filters: string[] = [];
  for (let i = at + 1; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg === "--") break;
    if (arg.startsWith("-")) {
      const option = arg.split("=")[0]!;
      if (arg.includes("=")) continue;
      if (option === "--project") while (i + 1 < argv.length && !argv[i + 1]!.startsWith("-")) i++;
      else if (TAKES_VALUE.has(option)) i++;
      else if (MAY_TAKE_VALUE[option]?.includes(argv[i + 1] ?? "")) i++;
      continue;
    }
    filters.push(arg);
  }
  if (filters.length === 0) return null;
  const selected = new Set<string>();
  for (const filter of filters) {
    const file = /^(.*?):(\d+):?(\d+)?$/.exec(filter)?.[1] ?? filter;
    const literal = /^\/(.*)\/([gi]*)$/.exec(file);
    let re: RegExp;
    try {
      re = literal ? new RegExp(literal[1]!, literal[2]!.replace("g", "")) : new RegExp(file, "i");
    } catch {
      return null;
    }
    const matched = specPaths.filter((p) => re.test(p));
    if (matched.length === 0) return null;
    for (const p of matched) selected.add(p.slice(p.lastIndexOf("/") + 1));
  }
  return selected;
}

/** `--repeat-each` as the command line gives it (the global setup runs before Playwright applies it), else `fallback`. */
export function repeatEachOf(argv: readonly string[], fallback: number): number {
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    const value = arg === "--repeat-each" ? argv[i + 1] : arg.startsWith("--repeat-each=") ? arg.slice("--repeat-each=".length) : undefined;
    if (value !== undefined && Number(value) >= 1) return Math.floor(Number(value));
  }
  return fallback;
}

/**
 * Sign the request in as `account` (the fixture account itself when none) and seed it. A dropped connection or a 5xx
 * seeds it again, twice at most: safe, as a seed resets what it writes, and the request then signs in as it.
 */
export async function seedAccount(request: APIRequestContext, account?: string): Promise<void> {
  const who = account ?? "the fixture account";
  for (let attempt = 1; ; attempt++) {
    try {
      const login = await request.post(`/api/dev/fixture-login${account ? `?account=${account}` : ""}`);
      if (!login.ok()) throw new Error(`fixture-login of ${who} answered ${login.status()}: ${await login.text()}`);
      const seeded = await request.post("/api/dev/seed", { timeout: 120_000 });
      if (!seeded.ok()) throw new Error(`the seed of ${who} answered ${seeded.status()}: ${await seeded.text()}`);
      return;
    } catch (e) {
      if (attempt >= 3 || !/ECONNRESET|socket hang up|answered 5\d\d/.test(String(e))) throw e;
      await new Promise((r) => setTimeout(r, 1_000));
    }
  }
}

/**
 * For a journey that truly needs its account seeded again mid-run (a fresh fixture at each journey's start): only in a
 * run of one worker, where nothing else is running while the seed holds the worker. The request is signed in as the
 * account after.
 */
export async function seedAlone(request: APIRequestContext, testInfo: Pick<TestInfo, "config">, account?: string): Promise<void> {
  if (testInfo.config.workers !== 1) {
    throw new Error(
      `This journey seeds its account again mid-run, and a seed holds the fixture worker for seconds while every other test's requests wait behind it: run it alone, with --workers 1 (this run has ${testInfo.config.workers}).`,
    );
  }
  await seedAccount(request, account);
}
