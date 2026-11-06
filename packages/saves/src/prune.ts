import type { ZodTypeAny } from "zod";

// A READING PRUNED TO ITS SCHEMA (final audit G8): a model's reply that puts `null` where a field is optional, or adds
// a key the format doesn't have, at any depth, is not a reason to throw a paid reading away. Both are left out quietly
// — they say nothing about the move, so they never flag it. A required field is never touched: a reply whose required
// value is unusable is still refused, and its retry names the fix.

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

type Def = { typeName?: string; innerType?: ZodTypeAny; schema?: ZodTypeAny; type?: ZodTypeAny; options?: ZodTypeAny[] };
const defOf = (s: ZodTypeAny): Def => (s as unknown as { _def: Def })._def;

/** The schema under its optional, nullable, default and effects wrappers. */
function bare(s: ZodTypeAny): ZodTypeAny {
  let cur = s;
  for (let i = 0; i < 10; i++) {
    const d = defOf(cur);
    const next = d.typeName === "ZodOptional" || d.typeName === "ZodNullable" || d.typeName === "ZodDefault" ? d.innerType : d.typeName === "ZodEffects" ? d.schema : undefined;
    if (!next) return cur;
    cur = next;
  }
  return cur;
}

/** `value` with every null optional value and every unknown key removed, as `schema` reads it. */
export function pruneToSchema(value: unknown, schema: ZodTypeAny): unknown {
  const s = bare(schema);
  const d = defOf(s);
  if (d.typeName === "ZodObject" && isObj(value)) {
    const shape = (s as unknown as { shape: Record<string, ZodTypeAny> }).shape;
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) {
      const field = shape[k];
      if (!field) continue; // a key the format doesn't have
      if (v === null && field.isOptional()) continue; // nothing said where saying nothing is allowed
      out[k] = pruneToSchema(v, field);
    }
    return out;
  }
  if (d.typeName === "ZodArray" && Array.isArray(value) && d.type) return value.map((x) => pruneToSchema(x, d.type!));
  if (d.typeName === "ZodUnion" && isObj(value) && d.options) {
    const object = d.options.find((o) => defOf(bare(o)).typeName === "ZodObject");
    return object ? pruneToSchema(value, object) : value;
  }
  return value;
}
