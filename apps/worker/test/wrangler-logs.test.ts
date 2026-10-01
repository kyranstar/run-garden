/**
 * Ruling C1 (Audit 2): wrangler appends everything it prints to a debug log
 * under ~/Library/Preferences/.wrangler/logs unless WRANGLER_WRITE_LOGS is
 * "false" or "0" — `d1 execute` query results included. Every package script
 * and documented command that runs wrangler against remote production or
 * staging data must therefore turn that off. These tests hold the scripts and
 * the runbooks to it.
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const read = (rel: string): string => readFileSync(new URL(rel, import.meta.url), "utf8");
const scripts = (JSON.parse(read("../package.json")) as { scripts: Record<string, string> }).scripts;

/** wrangler scripts that never reach Cloudflare's remote data. */
const LOCAL_ONLY = new Set(["dev", "build", "db:migrate:local"]);

describe("wrangler never writes a remote command's output to its debug log", () => {
  it("every package script that runs wrangler remotely sets WRANGLER_WRITE_LOGS=false", () => {
    const remote = Object.entries(scripts).filter(([name, cmd]) => /\bwrangler\b/.test(cmd) && !LOCAL_ONLY.has(name));
    expect(remote.map(([name]) => name).sort()).toEqual(
      ["copier:delete", "copier:deploy", "db:migrate:remote", "deploy", "deploy:staging", "migrate:staging"].sort(),
    );
    for (const [name, cmd] of remote) {
      expect(cmd, name).toMatch(/^WRANGLER_WRITE_LOGS=false wrangler /);
    }
  });

  it("the local-only scripts really are local", () => {
    for (const name of LOCAL_ONLY) {
      const cmd = scripts[name] ?? "";
      expect(cmd, name).not.toMatch(/--remote|--env staging|wrangler\.copier/);
      if (/wrangler deploy/.test(cmd)) expect(cmd, name).toContain("--dry-run");
    }
  });

  for (const doc of ["../../../docs/STAGING.md", "../../../docs/DEPLOYMENT.md", "../scripts/deploy.sh"]) {
    it(`${doc.split("/").pop()} turns logging off before its first wrangler command`, () => {
      const text = read(doc);
      const off = text.indexOf("export WRANGLER_WRITE_LOGS=false");
      const firstCommand = text.search(/npx wrangler /);
      expect(off, "export WRANGLER_WRITE_LOGS=false").toBeGreaterThanOrEqual(0);
      expect(firstCommand).toBeGreaterThan(off);
    });
  }

  it("the staging runbook says why, and sweeps wrangler's log folder after prod work", () => {
    const text = read("../../../docs/STAGING.md");
    expect(text).toMatch(/WRANGLER_WRITE_LOGS/);
    expect(text).toContain("~/Library/Preferences/.wrangler/logs");
  });
});
