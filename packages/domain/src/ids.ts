/** Generates an opaque unique id. Works in Workers, Node, and browsers. */
export function newId(): string {
  return crypto.randomUUID();
}
