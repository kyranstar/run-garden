/**
 * FROM A MOVE BACK TO ITS POST (audit 2026-11-06, I10): a move's links to saved posts carry the post's id and the move's
 * place in it — read from `exercise_provenance.source_key` (`imp:<post's key>#<position>`, written by Save) — so the app
 * opens the post's trail at the move; a curated link (any other key) has none. A personal move's own read carries its
 * corrections (`import_corrections`), newest first, in words. Synthetic data only: made-up names, links built here.
 */
import { beforeEach, describe, expect, it } from "vitest";
import { schema } from "@rg/database";
import { PROFILE_IDS } from "@rg/exercise-library";
import type { ExtractedMove } from "@rg/saves";
import type { Db } from "../src/services/db.js";
import { forgetAccountLibrary } from "../src/services/account-library.js";
import { correctionLine, MOVE_FIELDS } from "../src/services/import-corrections.js";
import { libraryItem, listPersonalMoves } from "../src/services/library-view.js";
import { moveCorrectionLine } from "../src/services/move-correction-words.js";
import { toPersonalRecord } from "../src/services/personal-records.js";
import { savedPostId } from "../src/services/saves-ledger.js";
import { makeTestDb, makeTestUser } from "./helpers.js";

const NOW = "2026-11-06T10:00:00.000Z";
const S = ["ht", "tps://"].join("");
const reel = (code: string) => `${S}www.${["insta", "gram.com"].join("")}/reel/${code}/`;
const MOVE = "myZorbexHipLift0a1b2c";

const draft: ExtractedMove = {
  name: "Zorbex hip lift", aliases: [], summary: "Lift the hips, slow and even.", steps: ["Lie down.", "Lift the hips."], cues: [], mistakes: [],
  purpose: "Opens the hips.", dose: { text: "2 x 8", range: [8, 8] }, patterns: ["mobility"], regions: ["hips"], equipment: [], position: "supine",
  laterality: "bilateral", load: "none", contraction: ["isotonic"], difficulty: 2,
  conditions: Object.fromEntries(PROFILE_IDS.map((p) => [p, { attrs: { clench: 0, neckLoad: 1, faceDown: false }, note: "Easy on the jaw." }])) as unknown as ExtractedMove["conditions"],
  evidence: { name: "stated", dose: "stated", steps: "stated" }, confidence: "high",
};

let db: Db;
let userId: string;
let statements = 0;

beforeEach(async () => {
  db = makeTestDb({ boundVariableCap: 100, onStatement: () => (statements += 1) });
  ({ userId } = await makeTestUser(db));
  await db.insert(schema.personalMoves).values({ id: MOVE, userId, status: "active", record: toPersonalRecord(MOVE, draft), createdAt: NOW, updatedAt: NOW });
});

async function savedFrom(code: string, position: number) {
  const postId = await savedPostId(userId, "instagram", code);
  await db.insert(schema.savedPosts).values({ id: postId, userId, source: "instagram", sourceKey: code, url: reel(code), creatorHandle: "zorbexcoach", firstSeenAt: NOW, status: "matched", updatedAt: NOW });
  await db.insert(schema.exerciseProvenance).values({
    id: `prov-${code}`, userId, exerciseId: MOVE, sourceType: "instagram", url: reel(code), creator: "zorbexcoach", sourceKey: `imp:${code}#${position}`, createdAt: NOW, note: "Opens the hips.",
  });
  return postId;
}

describe("a move's links name their post (audit 2026-11-06, I10)", () => {
  it("the move's own read: each link Save wrote carries its post's id and the move's place; a curated one none", async () => {
    const post = await savedFrom("ZorbexPost1", 2);
    await db.insert(schema.exerciseProvenance).values({ id: "prov-curated", userId, exerciseId: MOVE, sourceType: "instagram", url: reel("Curated01"), creator: "Curated Coach", sourceKey: "curated:1", createdAt: "2026-11-01T10:00:00.000Z" });
    const item = await libraryItem(db, userId, MOVE);
    expect(item.provenance).toEqual([
      { sourceType: "instagram", url: reel("Curated01"), creator: "Curated Coach", note: null, postId: null, position: null },
      { sourceType: "instagram", url: reel("ZorbexPost1"), creator: "zorbexcoach", note: "Opens the hips.", postId: post, position: 2 },
    ]);
  });

  it("the owner's moves list: the same, in its one statement for the links", async () => {
    const post = await savedFrom("ZorbexPost1", 0);
    statements = 0;
    const { moves } = await listPersonalMoves(db, userId);
    expect(moves[0]!.links).toEqual([{ url: reel("ZorbexPost1"), creator: "zorbexcoach", note: "Opens the hips.", postId: post, position: 0 }]);
    expect(statements).toBe(2);
  });

  it("another account's post is never named", async () => {
    await savedFrom("ZorbexPost1", 0);
    const other = (await makeTestUser(db)).userId;
    await db.insert(schema.personalMoves).values({ id: "myOtherMove0a1b2c3d", userId: other, status: "active", record: toPersonalRecord("myOtherMove0a1b2c3d", draft), createdAt: NOW, updatedAt: NOW });
    await db.insert(schema.exerciseProvenance).values({ id: "prov-other", userId: other, exerciseId: "myOtherMove0a1b2c3d", sourceType: "instagram", url: reel("ZorbexPost1"), creator: "x", sourceKey: "imp:ZorbexPost1#0", createdAt: NOW });
    expect((await libraryItem(db, other, "myOtherMove0a1b2c3d")).provenance[0]).toMatchObject({ postId: null, position: null });
  });
});

describe("a personal move's corrections (audit 2026-11-06, I10)", () => {
  it("its own read carries them, newest first, in words: what changed, why, by whom", async () => {
    await db.insert(schema.importCorrections).values([
      { id: "c1", userId, target: "move", targetId: MOVE, field: "dose", before: { type: "reps", range: [8, 12] }, after: { type: "time", range: [30, 30], sets: [2, 2] }, why: "The transcript says two holds of thirty seconds at 3:12.", basis: "evidence", by: "coach", at: "2026-11-04T10:00:00.000Z" },
      { id: "c2", userId, target: "move", targetId: MOVE, field: "name", before: "Zorbex hip lift", after: "Zorbex hip raise", why: "I call it that.", basis: "owner", by: "owner", at: "2026-11-05T10:00:00.000Z" },
      { id: "c3", userId, target: "move", targetId: "myOtherMove", field: "name", before: "a", after: "b", why: "x", basis: "owner", by: "owner", at: NOW },
    ]);
    const item = await libraryItem(db, userId, MOVE);
    expect(item.corrections.map((c) => [c.field, c.by, c.basis, c.why, c.at])).toEqual([
      ["name", "owner", "owner", "I call it that.", "2026-11-05T10:00:00.000Z"],
      ["dose", "coach", "evidence", "The transcript says two holds of thirty seconds at 3:12.", "2026-11-04T10:00:00.000Z"],
    ]);
    expect(item.corrections[0]!.line).toBe("Name of Zorbex hip lift: Zorbex hip raise (was Zorbex hip lift)");
    expect(item.corrections[1]!.line).toMatch(/^Dose of Zorbex hip lift: /);
  });

  it("a library move's read has none, and asks for none", async () => {
    forgetAccountLibrary(db, userId);
    statements = 0;
    const item = await libraryItem(db, userId, "gobletSquat");
    expect(item.corrections).toEqual([]);
    const withMove = statements;
    forgetAccountLibrary(db, userId);
    statements = 0;
    await libraryItem(db, userId, MOVE);
    expect(statements).toBe(withMove + 1);
  });
});

describe("a move's correction in words", () => {
  it("reads as the trail's and the card's do, for every field a move's correction may change", () => {
    for (const field of MOVE_FIELDS) {
      expect(moveCorrectionLine(field, "a", "b", "Zorbex hip lift")).toBe(correctionLine({ target: "move", field, before: "a", after: "b", name: "Zorbex hip lift" }, (x) => x));
    }
  });
});
