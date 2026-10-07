import type { WeightUnit } from "@rg/domain";
import type { EngineData, HistorySession } from "@rg/exercise-library";
import { Blocks } from "./blocks.js";
import { Lib } from "./lib.js";
import { Prog } from "./prog.js";
import type { Block, EngineLocation } from "./types.js";

// "Ready for the harder move?" — the core lifts a session topped out, with the harder move the block can switch to.
// Apart from the planner (which builds sessions) so the review can ask it on the phone without the builder.

export interface GraduationOffer {
  family: string;
  from: string;
  to: string;
}

/** What the offers read of a program: its block, its history, its places (Home's gear judges), its unit. */
export interface GraduationProgram {
  block: Block | null;
  sessions: readonly HistorySession[];
  locations: readonly EngineLocation[];
  settings: { unit: WeightUnit };
}

/** A location by id, else Home, else the first. */
function homeOf(locations: readonly EngineLocation[]): EngineLocation {
  const found = locations.find(l => l.id === "home") || locations[0];
  if (!found) throw new Error("The program has no locations.");
  return found;
}

/** Core lifts this session topped out, with the harder move the block can switch to (judged with Home's gear, like the block). */
function offers(data: EngineData, program: GraduationProgram, session: HistorySession): GraduationOffer[] {
  const block = program.block;
  if (!block) return [];
  const sessions = [...program.sessions.filter(s => s.id !== session.id), session];
  const loc = homeOf(program.locations);
  const kbWeights = Lib.kettlebellsAt(loc);
  const out: GraduationOffer[] = [];
  for (const f of data.coreFamilies) {
    const id = block.core[f.id];
    const ex = id ? Lib.get(data, id) : null;
    if (!id || !ex || !(session.entries || []).some(e => e && e.id === id && e.sets && e.sets.length)) continue;
    const ctx = { mode: "build" as const, checks: {}, implement: Lib.implementFor(ex, loc.equipment), kbWeights, unit: program.settings.unit, equipment: loc.equipment };
    const s = Prog.suggest(data, ex, Prog.historyFor(data, sessions, id), ctx);
    if (s.action !== "graduate" || !s.graduate) continue;
    if (Blocks.graduate(data, block, f.id, s.graduate, session.date, loc.equipment) === block) continue;
    out.push({ family: f.id, from: id, to: s.graduate });
  }
  return out;
}

export const Graduation = { offers };
