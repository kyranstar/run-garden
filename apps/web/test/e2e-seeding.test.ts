/**
 * NO SEED WHILE OTHER TESTS RUN (CI 39366660097, 2026-10-19). A seed holds the fixture worker for seconds, every request
 * sent meanwhile waits behind it, and wrangler's dev proxy can close the connections they wait on: coach-notices seeding
 * its next account at each test's start turned body-check's Undo into a 500 that never reached the app. The e2e suite
 * now seeds before any test starts (e2e/global-setup.ts), or alone in a run of one worker (`seedAlone`), both through
 * e2e/seeded-accounts.ts. This guard keeps it so: `/api/dev/seed` is sent from that module alone, the global setup is
 * the only caller of its bare seed, and the Playwright config runs the global setup.
 */
import { readdirSync, readFileSync } from "node:fs";
import ts from "typescript";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  SEEDED,
  accountsToSeed,
  executionSuffix,
  repeatEachOf,
  seedAlone,
  seededAccount,
  selectedSpecs,
} from "../e2e/seeded-accounts.js";

const E2E = new URL("../e2e/", import.meta.url);
const read = (file: string): string => readFileSync(new URL(file, E2E), "utf8");
const files = (readdirSync(E2E, { recursive: true }) as string[]).filter((f) => /\.(c|m)?[jt]s$/.test(f)).sort();
/** The spec files at a root of their own: what a filter matches must not hang on where the repo is checked out. */
const specPaths = files.filter((f) => f.endsWith(".spec.ts")).map((f) => `/repo/apps/web/e2e/${f}`);

function parse(file: string): ts.SourceFile {
  return ts.createSourceFile(file, read(file), ts.ScriptTarget.Latest, true, file.endsWith("ts") ? ts.ScriptKind.TS : ts.ScriptKind.JS);
}

/** Every string a file's code holds — its literals and its templates' text, `${…}` left out — never its comments. */
function codeStrings(file: string): string[] {
  const out: string[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isStringLiteralLike(node)) out.push(node.text);
    else if (ts.isTemplateExpression(node)) out.push(node.head.text + node.templateSpans.map((s) => s.literal.text).join(""));
    ts.forEachChild(node, visit);
  };
  visit(parse(file));
  return out;
}

/** The names a file imports from seeded-accounts (`*` for the whole module). */
function seedingImports(file: string): string[] {
  const names: string[] = [];
  for (const st of parse(file).statements) {
    if (!ts.isImportDeclaration(st) || !ts.isStringLiteral(st.moduleSpecifier) || !/seeded-accounts(\.[jt]s)?$/.test(st.moduleSpecifier.text)) continue;
    const bindings = st.importClause?.namedBindings;
    if (bindings && ts.isNamedImports(bindings)) names.push(...bindings.elements.map((e) => (e.propertyName ?? e.name).text));
    if ((bindings && ts.isNamespaceImport(bindings)) || st.importClause?.name) names.push("*");
  }
  return names;
}

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("the e2e suite seeds before the run, or alone", () => {
  it("POST /api/dev/seed is sent from seeded-accounts.ts alone — no spec seeds while other tests run", () => {
    expect(files.length).toBeGreaterThan(10);
    const sending = files.filter((f) => codeStrings(f).some((s) => s.includes("/api/dev/seed")));
    expect(sending).toEqual(["seeded-accounts.ts"]);
  });

  it("the bare seed is the global setup's: a spec reseeds only through seedAlone, which needs a run of one worker", () => {
    const callers = files.filter((f) => seedingImports(f).some((n) => n === "seedAccount" || n === "*"));
    expect(callers).toEqual(["global-setup.ts"]);
  });

  it("the Playwright config runs the global setup", () => {
    expect(readFileSync(new URL("../playwright.config.ts", import.meta.url), "utf8")).toMatch(/^\s*globalSetup: "\.\/e2e\/global-setup\.ts",$/m);
    expect(seedingImports("global-setup.ts")).toEqual(expect.arrayContaining(["accountsToSeed", "seedAccount", "selectedSpecs", "repeatEachOf"]));
  });

  it("each spec SEEDED lists is a spec, and signs into its accounts through seededAccount", () => {
    for (const { file } of SEEDED) {
      expect(files).toContain(file);
      expect(seedingImports(file), file).toContain("seededAccount");
    }
  });

  it("seedAlone refuses a run of more than one worker, sending nothing", async () => {
    const post = vi.fn();
    const request = { post } as unknown as Parameters<typeof seedAlone>[0];
    await expect(seedAlone(request, { config: { workers: 2 } } as Parameters<typeof seedAlone>[1])).rejects.toThrow(/--workers 1 \(this run has 2\)/);
    expect(post).not.toHaveBeenCalled();
  });

  it("seedAlone, in a run of one worker, signs in as the account and seeds it", async () => {
    const sent: string[] = [];
    const ok = { ok: () => true, status: () => 200, text: async () => "" };
    const request = { post: async (url: string) => (sent.push(url), ok) } as unknown as Parameters<typeof seedAlone>[0];
    await seedAlone(request, { config: { workers: 1 } } as Parameters<typeof seedAlone>[1], "lift");
    await seedAlone(request, { config: { workers: 1 } } as Parameters<typeof seedAlone>[1]);
    expect(sent).toEqual(["/api/dev/fixture-login?account=lift", "/api/dev/seed", "/api/dev/fixture-login", "/api/dev/seed"]);
  });
});

describe("the accounts seeded before the run", () => {
  const base = { projects: ["iphone", "desktop"], run: "a1b2c3", env: {}, selected: null, repeatEach: 1, retries: 0 };

  it("the default suite: body-check's two kinds and coach-notices' three tests, each project its own", () => {
    expect(accountsToSeed(base).map((a) => a.account)).toEqual([
      "body-engine-iphone", "body-run-iphone", "body-engine-desktop", "body-run-desktop",
      "notices-a1b2c3-iphone", "notices-a1b2c3-iphone-l", "notices-a1b2c3-iphone-h",
      "notices-a1b2c3-desktop", "notices-a1b2c3-desktop-l", "notices-a1b2c3-desktop-h",
    ]);
  });

  it("a spec that skips itself in this environment seeds nothing; on its switch, its accounts", () => {
    const files = (env: Record<string, string>) => new Set(accountsToSeed({ ...base, env }).map((a) => a.file));
    expect(files({})).toEqual(new Set(["body-check.spec.ts", "coach-notices.spec.ts"]));
    expect(files({ RG_E2E_WATCH: "1" })).toContain("watch.spec.ts");
    expect(files({ RG_E2E_DESIGN_MODEL: "scripted:now" })).toEqual(
      new Set(["body-check.spec.ts", "coach-notices.spec.ts", "coach-plan-retire.spec.ts", "coach-plan-race.spec.ts"]),
    );
    expect(accountsToSeed({ ...base, selected: new Set(["smoke.spec.ts"]) })).toEqual([]);
    expect(new Set(accountsToSeed({ ...base, selected: new Set(["body-check.spec.ts"]) }).map((a) => a.file))).toEqual(new Set(["body-check.spec.ts"]));
  });

  it("each repeat and each retry has an account of its own, every name one the fixture sign-in takes", () => {
    const all = accountsToSeed({ ...base, env: { RG_E2E_WATCH: "1", RG_E2E_DESIGN_MODEL: "scripted:now" }, repeatEach: 20, retries: 2 });
    expect(all).toHaveLength(16 * 20 * 3);
    expect(new Set(all.map((a) => a.account)).size).toBe(all.length);
    // The worker's FIXTURE_ACCOUNT (services/fixtures.ts).
    for (const { account } of all) expect(account).toMatch(/^[a-z0-9][a-z0-9-]{0,31}$/);
    expect(all.map((a) => a.account)).toContain("notices-a1b2c3-desktop-h-19-r2");
  });

  it("a test signs into its execution's account, and only one seeded before the run", () => {
    expect([executionSuffix(0, 0), executionSuffix(3, 0), executionSuffix(0, 1), executionSuffix(19, 2)]).toEqual(["", "-3", "-r1", "-19-r2"]);
    vi.stubEnv("RG_E2E_SEEDED", "body-run-iphone,body-run-iphone-1");
    expect(seededAccount({ repeatEachIndex: 0, retry: 0 }, "body-run-iphone")).toBe("body-run-iphone");
    expect(seededAccount({ repeatEachIndex: 1, retry: 0 }, "body-run-iphone")).toBe("body-run-iphone-1");
    expect(() => seededAccount({ repeatEachIndex: 0, retry: 1 }, "body-run-iphone")).toThrow(/"body-run-iphone-r1" was not seeded before the run/);
    expect(() => seededAccount({ repeatEachIndex: 0, retry: 0 }, "body-run-desktop")).toThrow(/list it in SEEDED/);
  });
});

describe("the spec files a command line runs (so a run of one spec seeds that spec's accounts)", () => {
  const cli = (...args: string[]) => {
    const picked = selectedSpecs(["/usr/bin/node", "/x/playwright/cli.js", "test", ...args], specPaths);
    return picked && [...picked].sort();
  };

  it("names the files its filters match, as Playwright does: a regular expression on the path, less a :line", () => {
    expect(cli("body-check")).toEqual(["body-check.spec.ts"]);
    expect(cli("body-check.spec.ts:208", "--workers", "2")).toEqual(["body-check.spec.ts"]);
    expect(cli("coach-notices", "--workers=1", "--project", "desktop")).toEqual(["coach-notices.spec.ts"]);
    expect(cli("smoke", "--project", "iphone", "desktop")).toEqual(["smoke.spec.ts"]);
    expect(cli("body-check", "--last-failed", "--test-list", "list.txt")).toEqual(["body-check.spec.ts"]);
    expect(cli("watch")).toEqual(["watch-version.spec.ts", "watch.spec.ts"]);
    expect(cli("--grep", "body-check", "smoke")).toEqual(["smoke.spec.ts"]);
    expect(cli("-u", "body-check")).toEqual(["body-check.spec.ts"]);
    expect(cli("/coach-plan-r(ace|etire)/")).toEqual(["coach-plan-race.spec.ts", "coach-plan-retire.spec.ts"]);
  });

  it("all of them (null) with no filter: options and their values only, or arguments after --", () => {
    expect(cli()).toBeNull();
    expect(cli("--project", "iphone", "desktop", "--workers", "2", "--repeat-each", "3", "--reporter", "list")).toBeNull();
    expect(cli("--last-failed")).toBeNull();
    expect(cli("--", "body-check")).toBeNull();
  });

  it("all of them when in doubt: a filter that matches no spec file, or one that is no regular expression", () => {
    expect(cli("body-check", "not-a-spec-anywhere")).toBeNull();
    expect(cli("body-check(")).toBeNull();
    expect(cli("--only-changed", "main", "body-check")).toBeNull();
    expect(selectedSpecs(["/usr/bin/node", "/x/playwright/cli.js"], specPaths)).toBeNull();
  });

  it("--repeat-each from the command line, which the global setup reads before Playwright applies it", () => {
    expect(repeatEachOf(["node", "cli.js", "test", "--repeat-each", "20"], 1)).toBe(20);
    expect(repeatEachOf(["node", "cli.js", "test", "--repeat-each=3"], 1)).toBe(3);
    expect(repeatEachOf(["node", "cli.js", "test", "body-check"], 2)).toBe(2);
  });
});
