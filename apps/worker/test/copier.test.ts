/**
 * The staging copier (Phase 0 Task 13; spec §13.2): a temporary Worker bound
 * to production's D1 (SRC, read) and staging's (DST, write) that copies the
 * whole database table by table, in pages small enough for D1's limits,
 * resumable after any interruption, and verified by per-table hashes
 * computed on both sides (Ruling R2: primary-key order, canonical JSON).
 *
 * Nothing it answers carries a row — only progress, counts and hashes — and
 * nothing leaves Cloudflare: no export file, no local copy. Provider tokens
 * are never copied, and the scrub leaves staging with no usable credential.
 *
 * Two in-memory databases stand in for the two bindings, both as strict as
 * D1 about bound variables.
 */
import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { eq, getTableColumns, isNotNull, or, sql } from "drizzle-orm";
import { schema } from "@rg/database";
import { nowInstant } from "@rg/domain";
import type { Db } from "../src/services/db.js";
import { ACCOUNT_TABLES, orderedRows, type AccountTable } from "../src/services/account-tables.js";
import { patchAccountState } from "../src/services/account-state.js";
import { createSession } from "../src/auth/sessions.js";
import {
  COPY_TABLES,
  copyFinished,
  copyStep,
  guardBindings,
  initialCopyState,
  loadCopyState,
  scrubSecrets,
  secretsRemaining,
  SENTINEL_TABLE,
  STAGING_DB_NAME,
  verifyCopy,
  type CopyState,
} from "../src/copier/copy.js";
import { copierApp, type CopierEnv } from "../src/copier/index.js";
import { seedFullAccount } from "./account-fixture.js";
import { isWrite, makeTestDb, makeTestUser } from "./helpers.js";

const CAP = { boundVariableCap: 100 } as const;

/** A row for a table no account owns, every column filled. */
function catalogRow(entry: AccountTable, i: number): Record<string, unknown> {
  const row: Record<string, unknown> = {};
  for (const [key, col] of Object.entries(getTableColumns(entry.table))) {
    if (col.dataType === "boolean") row[key] = true;
    else if (col.dataType === "number") row[key] = i + 1;
    else if (col.dataType === "json") row[key] = { key, i };
    else row[key] = `${entry.name}-catalog-${i}`;
  }
  return row;
}

/** Production as the copier sees it: two fully seeded accounts, sessions and
 * OAuth handshakes (never copied), the global catalogs and the restore
 * bookkeeping (copied whole). */
async function seedSource(opts: { onStatement?: (sql: string) => void } = {}) {
  const src = makeTestDb({ ...CAP, onStatement: opts.onStatement });
  const users: string[] = [];
  for (let n = 0; n < 2; n += 1) {
    const { userId } = await makeTestUser(src);
    await seedFullAccount(src, userId);
    await createSession(src, userId, "test");
    users.push(userId);
  }
  for (const name of ["garden_species", "coros_exercises", "schema_versions", "oauth_states"]) {
    const entry = ACCOUNT_TABLES.find((t) => t.name === name)!;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await src.insert(entry.table as any).values([catalogRow(entry, 0), catalogRow(entry, 1)] as any);
  }
  await patchAccountState(src, users[0]!, { gardenCatchUpPending: false });
  return { src, users };
}

async function copyAll(src: Db, dst: Db, maxRows: number): Promise<{ state: CopyState; steps: number }> {
  let state = initialCopyState();
  let steps = 0;
  while (!copyFinished(state)) {
    state = await copyStep(src, dst, state, { maxRows });
    steps += 1;
    if (steps > 5000) throw new Error("copy did not finish");
  }
  return { state, steps };
}

async function rowCount(db: Db, entry: AccountTable): Promise<number> {
  return (await orderedRows(db, entry.table)).length;
}

const tokenColumns = or(
  isNotNull(schema.providerConnections.encryptedAccessToken),
  isNotNull(schema.providerConnections.encryptedRefreshToken),
);

/** Every string the fixture wrote (they all carry an account's tag). */
async function seededStrings(db: Db, users: string[]): Promise<string[]> {
  const tags = users.map((u) => u.slice(0, 8));
  const out = new Set<string>();
  const walk = (value: unknown): void => {
    if (typeof value === "string") {
      if (tags.some((t) => value.includes(t))) out.add(value);
    } else if (Array.isArray(value)) value.forEach(walk);
    else if (value && typeof value === "object") Object.values(value).forEach(walk);
  };
  for (const t of ACCOUNT_TABLES) for (const row of await orderedRows(db, t.table)) walk(row);
  return [...out];
}

describe("copyStep — whole tables, small pages, D1's bind limit", () => {
  it("copies every table but sessions and oauth_states, every account's rows, and verifies", async () => {
    const { src, users } = await seedSource();
    const dst = makeTestDb(CAP);

    const { state, steps } = await copyAll(src, dst, 7);

    expect([...state.done].sort()).toEqual(COPY_TABLES.map((t) => t.name).sort());
    expect(COPY_TABLES.map((t) => t.name)).not.toContain("sessions");
    expect(COPY_TABLES.map((t) => t.name)).not.toContain("oauth_states");
    expect(COPY_TABLES).toHaveLength(ACCOUNT_TABLES.length - 2);
    expect(steps).toBeGreaterThan(500 / 7); // 2 × 250 planned workouts alone

    const checks = await verifyCopy(src, dst);
    expect(checks.map((c) => c.table).sort()).toEqual(COPY_TABLES.map((t) => t.name).sort());
    expect(checks.filter((c) => !c.ok)).toEqual([]);
    for (const c of checks) {
      expect(c.dstRows, c.table).toBe(c.srcRows);
      expect(c.src).toMatch(/^[0-9a-f]{64}$/);
    }

    // Whole tables: both accounts, the catalogs and the bookkeeping.
    for (const entry of COPY_TABLES) expect(await rowCount(dst, entry), entry.name).toBe(await rowCount(src, entry));
    expect((await orderedRows(dst, schema.users)).map((u) => u.id).sort()).toEqual([...users].sort());
    expect(await rowCount(dst, ACCOUNT_TABLES.find((t) => t.name === "garden_species")!)).toBe(2);
    expect(await rowCount(dst, ACCOUNT_TABLES.find((t) => t.name === "account_state")!)).toBe(1);
    expect(await rowCount(dst, ACCOUNT_TABLES.find((t) => t.name === "coach_locks")!)).toBeGreaterThan(0);

    // Never copied: sign-ins, OAuth handshakes, provider credentials.
    expect(await dst.select().from(schema.sessions)).toEqual([]);
    expect(await dst.select().from(schema.oauthStates)).toEqual([]);
    expect((await src.select().from(schema.providerConnections).where(tokenColumns)).length).toBeGreaterThan(0);
    expect(await dst.select().from(schema.providerConnections).where(tokenColumns)).toEqual([]);
  });

  it("copies the same with one big page per step", async () => {
    const { src } = await seedSource();
    const dst = makeTestDb(CAP);
    await copyAll(src, dst, 500);
    expect((await verifyCopy(src, dst)).every((c) => c.ok)).toBe(true);
  });

  it("an interrupted copy resumes from the last state it returned, with no duplicates", async () => {
    const { src } = await seedSource();
    const total = (await copyAll(src, makeTestDb(CAP), 7)).steps;

    const dst = makeTestDb(CAP);
    let state = initialCopyState();
    let previous = state;
    for (let i = 0; i < Math.floor(total / 2); i += 1) {
      previous = state;
      state = await copyStep(src, dst, state, { maxRows: 7 });
    }
    expect(copyFinished(state)).toBe(false);
    expect(state.done.length).toBeGreaterThan(0);

    // The process dies: the in-memory state is gone. Only the last state it
    // handed back survives (the Worker keeps it in DST as JSON).
    let resumed = JSON.parse(JSON.stringify(state)) as CopyState;
    state = undefined as unknown as CopyState;
    // Worse: the last step's rows landed but its state was never saved, so
    // the step before it runs again over rows already copied.
    const replay = await copyStep(src, dst, JSON.parse(JSON.stringify(previous)) as CopyState, { maxRows: 7 });
    expect(replay).toEqual(resumed);
    while (!copyFinished(resumed)) resumed = await copyStep(src, dst, resumed, { maxRows: 7 });

    const checks = await verifyCopy(src, dst);
    expect(checks.filter((c) => !c.ok)).toEqual([]);
    for (const entry of COPY_TABLES) expect(await rowCount(dst, entry), entry.name).toBe(await rowCount(src, entry));
  });

  it("verify names a table whose copy differs", async () => {
    const { src } = await seedSource();
    const dst = makeTestDb(CAP);
    await copyAll(src, dst, 100);
    const [one] = await orderedRows(dst, schema.plannedWorkouts, { limit: 1 });
    await dst.update(schema.plannedWorkouts).set({ title: "edited" }).where(eq(schema.plannedWorkouts.id, String(one!.id)));
    const after = await verifyCopy(src, dst, { tables: ["planned_workouts", "activities"] });
    expect(after.map((c) => [c.table, c.ok])).toEqual([
      ["planned_workouts", false],
      ["activities", true],
    ]);
  });
});

describe("scrubSecrets", () => {
  it("leaves no credential in DST: tokens null, sessions and OAuth handshakes gone — SRC untouched", async () => {
    const { src } = await seedSource();
    const dst = makeTestDb(CAP);
    await copyAll(src, dst, 100);
    // Staging's own state: a sign-in, a handshake, and a connection someone
    // made there (staging's own key, still a credential).
    await dst
      .update(schema.providerConnections)
      .set({ encryptedAccessToken: "staging-token", encryptedRefreshToken: "staging-refresh" })
      .where(isNotNull(schema.providerConnections.id));
    const [user] = await orderedRows(dst, schema.users, { limit: 1 });
    await createSession(dst, String(user!.id), "test");
    await dst.insert(schema.oauthStates).values({ state: "s", provider: "google", createdAt: nowInstant(), expiresAt: nowInstant() });
    expect((await secretsRemaining(dst)).secrets).toBeGreaterThan(0);

    await scrubSecrets(dst);

    expect(await secretsRemaining(dst)).toEqual({ secrets: 0, sessions: 0, oauthStates: 0 });
    expect(await dst.select().from(schema.providerConnections).where(tokenColumns)).toEqual([]);
    // Connections themselves stay (parity compares them); only the secrets go.
    expect(await rowCount(dst, ACCOUNT_TABLES.find((t) => t.name === "provider_connections")!)).toBeGreaterThan(0);
    // Verify masks the secret columns on both sides, so it still agrees.
    expect((await verifyCopy(src, dst)).every((c) => c.ok)).toBe(true);
    // Production keeps its sessions and tokens.
    expect((await src.select().from(schema.sessions)).length).toBe(2);
    expect((await src.select().from(schema.providerConnections).where(tokenColumns)).length).toBeGreaterThan(0);
  });
});

describe("guardBindings — the copier refuses anything but production → an empty or prepared staging", () => {
  it("prepares an empty DST once (creates the sentinel); later calls find it", async () => {
    const { src } = await seedSource();
    const dst = makeTestDb(CAP);
    expect(await guardBindings(src, dst, { prepare: false })).toBe("dst_not_prepared");
    expect(await guardBindings(src, dst, { prepare: true })).toBeNull();
    expect(await guardBindings(src, dst, { prepare: false })).toBeNull();
    expect(await guardBindings(src, dst, { prepare: true })).toBeNull();
  });

  it("refuses when SRC has the sentinel — SRC is a staging database (or the bindings are swapped)", async () => {
    const staging = makeTestDb(CAP);
    const { src: prod } = await seedSource();
    expect(await guardBindings(prod, staging, { prepare: true })).toBeNull();
    // Swapped bindings: staging as SRC.
    expect(await guardBindings(staging, prod, { prepare: true })).toBe("src_is_staging");
    expect(await guardBindings(staging, makeTestDb(CAP), { prepare: false })).toBe("src_is_staging");
  });

  it("never prepares a DST that holds data — production never gets a sentinel, and nothing is written", async () => {
    const writes: string[] = [];
    const { src: prod } = await seedSource({ onStatement: (s) => writes.push(s) });
    const { src: alsoProd } = await seedSource();
    writes.length = 0;
    // DST = production (the bindings swapped on a first run, or both prod).
    expect(await guardBindings(makeTestDb(CAP), prod, { prepare: true })).toBe("dst_not_empty");
    expect(await guardBindings(prod, prod, { prepare: true })).toBe("dst_not_empty");
    expect(await guardBindings(alsoProd, prod, { prepare: true })).toBe("dst_not_empty");
    expect(writes.filter((s) => isWrite(s) || /create|drop/i.test(s))).toEqual([]);
    expect(await guardBindings(makeTestDb(CAP), prod, { prepare: false })).toBe("dst_not_prepared");
  });

  it("refuses a prepared DST when SRC holds no rows — an empty SRC never empties DST (Audit 2 M2)", async () => {
    // A DST that somehow carries the sentinel table (say, production) with an
    // empty SRC bound (a freshly recreated staging, bindings swapped): before,
    // the guard passed and `restart=1` emptied DST.
    const { src: prod } = await seedSource();
    await prod.run(sql.raw(`CREATE TABLE ${SENTINEL_TABLE} (id TEXT PRIMARY KEY NOT NULL, state TEXT, updated_at TEXT NOT NULL)`));
    const empty = makeTestDb(CAP);
    expect(await guardBindings(empty, prod, { prepare: true })).toBe("src_empty");
    expect(await guardBindings(empty, prod, { prepare: false })).toBe("src_empty");

    const before = (await prod.select().from(schema.plannedWorkouts)).length;
    expect(before).toBeGreaterThan(0);
    const app = copierApp(() => ({ src: empty, dst: prod }));
    for (const path of ["/step?restart=1", "/step", "/verify", "/scrub"]) {
      const res = await post(app, `${path}${path.includes("?") ? "&" : "?"}${DST_Q}`, makeCopierEnv());
      expect(res.status, path).toBe(409);
      expect(await res.json()).toEqual({ error: "src_empty" });
    }
    expect((await prod.select().from(schema.plannedWorkouts)).length).toBe(before);
  });

  it("refuses when SRC and DST are the same empty database, and leaves no sentinel behind", async () => {
    const same = makeTestDb(CAP);
    expect(await guardBindings(same, same, { prepare: true })).toBe("same_database");
    expect(await guardBindings(makeTestDb(CAP), same, { prepare: false })).toBe("dst_not_prepared");
    expect(await guardBindings(same, makeTestDb(CAP), { prepare: true })).toBeNull();
  });
});

const KEY = "k".repeat(40);

function makeCopierEnv(overrides: Partial<CopierEnv> = {}): CopierEnv {
  return {
    SRC: {} as unknown as CopierEnv["SRC"],
    DST: {} as unknown as CopierEnv["DST"],
    COPIER_KEY: KEY,
    DST_NAME: STAGING_DB_NAME,
    ...overrides,
  };
}

function post(app: ReturnType<typeof copierApp>, path: string, env: CopierEnv, key: string | null = KEY) {
  const headers: Record<string, string> = {};
  if (key !== null) headers["x-copier-key"] = key;
  return app.request(path, { method: "POST", headers }, env);
}

const DST_Q = `dst=${STAGING_DB_NAME}`;

describe("the copier Worker", () => {
  it("answers only POST /step, /verify and /scrub, with the key, for the confirmed staging database", async () => {
    const src = makeTestDb(CAP);
    const dst = makeTestDb(CAP);
    const app = copierApp(() => ({ src, dst }));
    const env = makeCopierEnv();

    for (const path of ["/step", "/verify", "/scrub"]) {
      expect((await post(app, `${path}?${DST_Q}`, env, null)).status, path).toBe(401);
      expect((await post(app, `${path}?${DST_Q}`, env, "wrong")).status, path).toBe(401);
      expect((await post(app, `${path}?${DST_Q}`, env, KEY.slice(0, -1))).status, path).toBe(401);
      expect((await post(app, `${path}?${DST_Q}`, makeCopierEnv({ COPIER_KEY: undefined }), "")).status, path).toBe(401);
      expect((await post(app, `${path}?${DST_Q}`, makeCopierEnv({ COPIER_KEY: "" }), "")).status, path).toBe(401);
      expect((await post(app, path, env)).status, path).toBe(400);
      expect((await post(app, `${path}?dst=run-garden-db`, env)).status, path).toBe(400);
      expect((await post(app, `${path}?${DST_Q}`, makeCopierEnv({ DST_NAME: "run-garden-db" }))).status, path).toBe(400);
      const get = await app.request(`${path}?${DST_Q}`, { headers: { "x-copier-key": KEY } }, env);
      expect(get.status, path).toBe(404);
    }
    expect((await post(app, `/export?${DST_Q}`, env)).status).toBe(404);
    expect((await post(app, `/?${DST_Q}`, env)).status).toBe(404);
  });

  it("refuses to run when the sentinel says the bindings are wrong", async () => {
    const { src: prod } = await seedSource();
    const staging = makeTestDb(CAP);
    // First, a good copy prepares staging.
    const good = copierApp(() => ({ src: prod, dst: staging }));
    expect((await post(good, `/step?${DST_Q}`, makeCopierEnv())).status).toBe(200);

    const swapped = copierApp(() => ({ src: staging, dst: prod }));
    for (const path of ["/step", "/verify", "/scrub"]) {
      const res = await post(swapped, `${path}?${DST_Q}`, makeCopierEnv());
      expect(res.status, path).toBe(409);
      expect(await res.json()).toEqual({ error: "src_is_staging" });
    }
    const both = copierApp(() => ({ src: prod, dst: prod }));
    const res = await post(both, `/step?${DST_Q}`, makeCopierEnv());
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: "dst_not_empty" });
    const unprepared = copierApp(() => ({ src: prod, dst: makeTestDb(CAP) }));
    expect(await (await post(unprepared, `/verify?${DST_Q}`, makeCopierEnv())).json()).toEqual({
      error: "dst_not_prepared",
    });
  });

  it("steps until finished (state kept in DST), verifies, scrubs — never writes SRC, never returns a row", async () => {
    const srcStatements: string[] = [];
    const { src, users } = await seedSource({ onStatement: (s) => srcStatements.push(s) });
    srcStatements.length = 0;
    const dst = makeTestDb(CAP);
    const app = copierApp(() => ({ src, dst }));
    const env = makeCopierEnv();
    const responses: unknown[] = [];

    let finished = false;
    let steps = 0;
    while (!finished) {
      const res = await post(app, `/step?${DST_Q}&maxRows=40`, env);
      expect(res.status).toBe(200);
      const body = (await res.json()) as { finished: boolean; tablesDone: number; tables: number };
      responses.push(body);
      finished = body.finished;
      steps += 1;
      expect(steps).toBeLessThan(500);
    }
    expect(steps).toBeGreaterThan(10);
    const saved = await loadCopyState(dst);
    expect(saved && copyFinished(saved)).toBe(true);
    // A finished copy stays finished.
    const again = await post(app, `/step?${DST_Q}`, env);
    expect(await again.json()).toMatchObject({ finished: true, rowsThisStep: 0 });

    const verify = await post(app, `/verify?${DST_Q}`, env);
    expect(verify.status).toBe(200);
    const verified = (await verify.json()) as { ok: boolean; tables: Array<{ ok: boolean }> };
    responses.push(verified);
    expect(verified.ok).toBe(true);
    expect(verified.tables).toHaveLength(COPY_TABLES.length);

    const only = await post(app, `/verify?${DST_Q}&tables=planned_workouts,users`, env);
    expect(((await only.json()) as { tables: unknown[] }).tables).toHaveLength(2);
    expect((await post(app, `/verify?${DST_Q}&tables=sessions`, env)).status).toBe(400);

    const scrub = await post(app, `/scrub?${DST_Q}`, env);
    expect(scrub.status).toBe(200);
    const scrubbed = await scrub.json();
    responses.push(scrubbed);
    expect(scrubbed).toEqual({ ok: true, remaining: { secrets: 0, sessions: 0, oauthStates: 0 } });

    // SRC was only ever read.
    expect(srcStatements.length).toBeGreaterThan(0);
    expect(srcStatements.filter((s) => isWrite(s) || /\b(create|drop|alter)\b/i.test(s))).toEqual([]);

    // Nothing in any answer is a row: no fixture string, no account id.
    const text = JSON.stringify(responses);
    const content = await seededStrings(src, users);
    expect(content.length).toBeGreaterThan(200);
    expect(content.filter((s) => text.includes(s))).toEqual([]);
    for (const u of users) expect(text).not.toContain(u);
  });

  it("restart=1 empties what was copied and copies again from the first table", async () => {
    const { src } = await seedSource();
    const dst = makeTestDb(CAP);
    const app = copierApp(() => ({ src, dst }));
    const env = makeCopierEnv();
    for (let i = 0; i < 5; i += 1) await post(app, `/step?${DST_Q}&maxRows=100`, env);
    // Staging drifted (a sign-in, a stray edit): a fresh copy replaces it.
    await dst.delete(schema.plannedWorkouts);

    const first = (await (await post(app, `/step?${DST_Q}&maxRows=1&restart=1`, env)).json()) as {
      tablesDone: number;
      rowsTotal: number;
    };
    expect(first).toMatchObject({ tablesDone: 0, rowsTotal: 1 });
    let finished = false;
    while (!finished) finished = ((await (await post(app, `/step?${DST_Q}&maxRows=500`, env)).json()) as { finished: boolean }).finished;
    const verified = (await (await post(app, `/verify?${DST_Q}`, env)).json()) as { ok: boolean };
    expect(verified.ok).toBe(true);
    // The sentinel table itself is staging's own; restart keeps it.
    expect(await guardBindings(src, dst, { prepare: false })).toBeNull();
  });

  it("answers a failure with its kind only, never the error text", async () => {
    const src = makeTestDb(CAP);
    const dst = makeTestDb(CAP);
    const broken = {
      ...src,
      all: () => {
        throw new Error("boom: secret-row-value");
      },
    } as unknown as Db;
    const app = copierApp(() => ({ src: broken, dst }));
    const logged = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const res = await post(app, `/step?${DST_Q}`, makeCopierEnv());
    expect(JSON.stringify(logged.mock.calls)).not.toContain("secret-row-value");
    logged.mockRestore();
    expect(res.status).toBe(500);
    const text = await res.text();
    expect(text).not.toContain("secret-row-value");
    expect(JSON.parse(text)).toEqual({ error: "copier_failed", kind: "Error" });
  });
});

describe("wrangler.copier.toml", () => {
  const toml = readFileSync(new URL("../wrangler.copier.toml", import.meta.url), "utf8");
  const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as {
    scripts: Record<string, string>;
  };

  it("is its own Worker, on workers.dev, with no crons, no assets and no routes", () => {
    expect(/^name = "([^"]+)"/m.exec(toml)?.[1]).toBe("rg-staging-copier");
    expect(toml).toMatch(/^main = "src\/copier\/index\.ts"$/m);
    expect(toml).toMatch(/^workers_dev = true$/m);
    expect(toml).not.toMatch(/^\[assets\]/m);
    expect(toml).not.toMatch(/^routes?\s*=/m);
    expect(toml).not.toMatch(/^\[env\./m);
    expect(toml).toMatch(/^\[triggers\]\s*\ncrons = \[\]$/m);
    expect(toml).not.toMatch(/migrations_dir/);
  });

  it("binds production as SRC and staging as DST, by name and id", () => {
    const blocks = toml.split("[[d1_databases]]").slice(1);
    expect(blocks).toHaveLength(2);
    const binding = (b: string, key: string) => new RegExp(`^${key} = "([^"]+)"`, "m").exec(b)?.[1];
    const byBinding = Object.fromEntries(blocks.map((b) => [binding(b, "binding"), b]));
    expect(binding(byBinding.SRC!, "database_name")).toBe("run-garden-db");
    expect(binding(byBinding.SRC!, "database_id")).toBe("00acb208-8450-4bc0-88da-6b1e75f76280");
    expect(binding(byBinding.DST!, "database_name")).toBe(STAGING_DB_NAME);
    expect(binding(byBinding.DST!, "database_id")).toBe("c8d38f02-0723-4990-8220-5492a1b29824");
    expect(toml).toContain(`DST_NAME = "${STAGING_DB_NAME}"`);
    expect(toml).not.toMatch(/^binding = "DB"$/m);
  });

  it("has deploy and delete scripts, and the main Worker's config is untouched", () => {
    expect(pkg.scripts["copier:deploy"]).toBe("WRANGLER_WRITE_LOGS=false wrangler deploy -c wrangler.copier.toml");
    expect(pkg.scripts["copier:delete"]).toBe("WRANGLER_WRITE_LOGS=false wrangler delete -c wrangler.copier.toml");
    const main = readFileSync(new URL("../wrangler.toml", import.meta.url), "utf8");
    expect(main).not.toMatch(/binding = "(SRC|DST)"/);
    expect(main).not.toContain("rg-staging-copier");
  });

  it("names the sentinel table nothing in the schema uses", () => {
    expect(ACCOUNT_TABLES.map((t) => t.name)).not.toContain(SENTINEL_TABLE);
  });
});
