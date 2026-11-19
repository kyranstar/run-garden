/**
 * A PROPOSAL'S VERSION (R1; the LifeOS migration's DESIGN-3 §3.4.4): the sha-256 of its status and ops, canonical — keys
 * sorted, undefined dropped — so the same proposal reads the same version in memory and as stored. A leaf: the approve
 * (design-approve.ts) answers the version it leaves, and the proposal read the version it finds.
 */
import { sha256Hex } from "../auth/crypto.js";

/** JSON with every object's keys sorted and undefined dropped: the same value, the same text. */
export function canonicalJson(v: unknown): string {
  if (v === null || typeof v !== "object") return JSON.stringify(v) ?? "null";
  if (Array.isArray(v)) return `[${v.map((x) => (x === undefined ? "null" : canonicalJson(x))).join(",")}]`;
  const o = v as Record<string, unknown>;
  return `{${Object.keys(o)
    .filter((k) => o[k] !== undefined)
    .sort()
    .map((k) => `${JSON.stringify(k)}:${canonicalJson(o[k])}`)
    .join(",")}}`;
}

/** The proposal's version: sha-256 (hex) of its status and ops, canonical. */
export async function proposalVersion(p: { status: string; ops: unknown }): Promise<string> {
  return sha256Hex(canonicalJson({ status: p.status, ops: p.ops }));
}
