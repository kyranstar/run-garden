/**
 * A MOCK COROS THAT RE-ENCODES WHAT IT STORES, the way the real one does.
 *
 * `mockCorosServer()` stores the bytes it is sent and serves them back, so a
 * read-after-write against it can never catch a comparison that only holds for
 * our own encoding. Three live incidents were exactly that (2026-08-17/18: a
 * verified rewrite refused, a pushed lift session rewritten by its own echo).
 * This wrapper sits in front of the mock and, on every program write
 * (`/training/schedule/update` status 1 create and status 2 update), re-encodes
 * the program before the mock stores it. Every read then returns the
 * re-encoded program.
 *
 * The rules, and the recorded evidence for each:
 *
 *  1. NUMERIC STRINGS BECOME NUMBERS — `distance: "871.00"` was sent and `871`
 *     stored (the 2026-08-17 content rewrite; pinned in
 *     packages/providers/test/coros-normalize.test.ts, "comparing a program we
 *     sent with the one the server stored"). The display unit we send as the
 *     string "6" comes back as the number 6 (docs/reports/coros-inspect-2026-08-02.json:
 *     every stored strength step's `intensityDisplayUnit` is a number). Id-like
 *     fields stay strings, as the same capture stores them (`groupId "0"`,
 *     `originId`, `sourceId "0"`, `idInPlan "45"`), and names and overviews are
 *     text however they read.
 *  2. AN EMPTY OVERVIEW IS DROPPED — the capture holds stored steps with no
 *     `overview` key at all beside steps holding `""`, so a reader can never
 *     rely on the key being there. Dropping it here makes every reader prove it
 *     treats an absent overview as an empty one.
 *  3. A BODYWEIGHT STEP LOSES `intensityValue` — `intensityValue: ""` with
 *     `intensityCustom: 1` is stored with NO `intensityValue` key
 *     (docs/reports/coros-inspect-2026-08-02.json, the strength steps; pinned in
 *     coros-normalize.test.ts "a strength session keeps all four of its numbers").
 *  4. DURATION IS RECALCULATED — the stored `duration`/`estimatedTime` are the
 *     server's own estimate (the capture's programs carry values the client
 *     never sent), so what we sent after `/program/calculate` is not what a read
 *     returns. Here: a deterministic sum over the steps, never the calculate
 *     endpoint's figure.
 *  5. THE SERVER ISSUES THE STEP IDS — every stored step carries an 18-digit id
 *     of COROS's own, and a child's `groupId` is its container's NEW id
 *     (docs/reports/coros-inspect-2026-08-02.json: container 4793409533715910xx,
 *     its child under that id). The owner's strength rewrite of 2026-10-10 came
 *     back with our groups 1/3/5 under three fresh server ids. Each write here
 *     issues fresh ones, as a rewrite does live.
 *  6. A CONTAINER'S TARGET IS SERVER-COMPUTED — the same rewrite's containers,
 *     sent at 60 seconds a set, came back 78, 62 and 196; the capture's run
 *     containers hold the sum of their children (540 = 360 + 180). Here: the
 *     children's work plus rest, plus an odd constant no client would send.
 */
import type { RawCorosExercise, RawCorosProgram } from "@rg/providers";
import { mockCorosServer, type MockCorosServer } from "./mock-coros-server.js";

/** Fields COROS keeps as strings even when they read as numbers (ids), and the free text. */
const TEXT_KEYS = new Set([
  "id",
  "originId",
  "groupId",
  "sourceId",
  "planId",
  "idInPlan",
  "planProgramId",
  "authorId",
  "name",
  "overview",
  "sourceUrl",
  "videoUrl",
  "videoCoverUrl",
  "fastIntensityTypeName",
]);
const NUMERIC = /^-?\d+(\.\d+)?$/;

function renumber(o: Record<string, unknown>): void {
  for (const [k, v] of Object.entries(o)) {
    if (!TEXT_KEYS.has(k) && typeof v === "string" && NUMERIC.test(v)) o[k] = Number(v);
  }
}

/** Rule 4: the server's own estimate, deterministic and never the calculate endpoint's figure. */
function recalculatedDuration(exercises: RawCorosExercise[]): number {
  const setsOf = new Map<string, number>();
  for (const e of exercises) if (e.isGroup === true) setsOf.set(String(e.id), Number(e.sets ?? 1));
  let seconds = 0;
  for (const e of exercises) {
    if (e.isGroup === true || Number(e.exerciseType) === 0) continue;
    const tt = Number(e.targetType);
    const tv = Number(e.targetValue ?? 0);
    const work = tt === 2 ? tv : tt === 3 ? tv * 4 : 45;
    const rest = Number(e.restType) === 1 ? Number(e.restValue ?? 0) : 0;
    seconds += (setsOf.get(String(e.groupId)) ?? 1) * (work + rest);
  }
  return seconds + 17; // never a round number a client could have sent
}

/** Rule 6: a container's per-iteration seconds, as the server works it out from its children. */
function containerTarget(container: RawCorosExercise, exercises: RawCorosExercise[]): number {
  let seconds = 0;
  for (const e of exercises) {
    if (e.isGroup === true || String(e.groupId) !== String(container.id)) continue;
    const tt = Number(e.targetType);
    const tv = Number(e.targetValue ?? 0);
    seconds += (tt === 2 ? tv : tt === 3 ? tv * 4 : 45) + (Number(e.restType) === 1 ? Number(e.restValue ?? 0) : 0);
  }
  return seconds + 7;
}

/** Rule 5: the server's step ids — 18 digits, fresh on every write. Synthetic. */
let issued = 0;
function serverStepId(): string {
  issued += 1;
  return String(900_000_000_000_000_000n + BigInt(issued));
}

/** What real COROS stores for a program we write (the rules above). Pure but for rule 5's counter; returns a copy. */
export function reencodeProgram(sent: RawCorosProgram): RawCorosProgram {
  const program = structuredClone(sent) as RawCorosProgram & Record<string, unknown>;
  renumber(program);
  if (program.overview === "") delete program.overview;
  const exercises = (program.exercises ?? []) as Array<RawCorosExercise & Record<string, unknown>>;
  for (const e of exercises) {
    renumber(e);
    if (e.overview === "") delete e.overview;
    if (e.intensityValue === ("" as unknown) && Number(e.intensityCustom) === 1) delete e.intensityValue;
  }
  for (const e of exercises) if (e.isGroup === true) e.targetValue = containerTarget(e, exercises);
  const reissued = new Map<string, string>();
  for (const e of exercises) {
    const id = serverStepId();
    if (e.id !== undefined) reissued.set(String(e.id), id);
    e.id = id;
  }
  for (const e of exercises) {
    const group = reissued.get(String(e.groupId));
    if (group !== undefined && String(e.groupId) !== "0") e.groupId = group;
  }
  const duration = recalculatedDuration(exercises);
  program.duration = duration;
  program.estimatedTime = duration;
  return program;
}

export interface RenormalizingCoros extends MockCorosServer {
  /** How many program writes the wrapper re-encoded. */
  reencoded: number;
}

/** `mockCorosServer()` with a COROS-shaped storage encoding in front of it. */
export function renormalizingCoros(opts: { baseMonday?: string } = {}): RenormalizingCoros {
  const server = mockCorosServer(opts) as RenormalizingCoros;
  server.reencoded = 0;
  const inner = server.fetchImpl;
  // A plain function, called with no receiver below: the mock polices `this` as workerd does.
  const fetchImpl = async function (input: string | URL | Request, init?: RequestInit): Promise<Response> {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    if (url.pathname === "/training/schedule/update" && typeof init?.body === "string") {
      const body = JSON.parse(init.body) as { programs?: RawCorosProgram[]; versionObjects?: Array<{ status?: number }> };
      const status = body.versionObjects?.[0]?.status;
      if ((status === 1 || status === 2) && body.programs?.length) {
        body.programs = body.programs.map(reencodeProgram);
        server.reencoded += 1;
        return inner(input, { ...init, body: JSON.stringify(body) });
      }
    }
    return inner(input, init);
  } as typeof fetch;
  server.fetchImpl = fetchImpl;
  return server;
}
