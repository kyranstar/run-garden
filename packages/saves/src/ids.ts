// Personal move ids: a move imported from the owner's saves, never colliding with a library id.

export const PERSONAL_ID_RE = /^my[A-Z][A-Za-z0-9]{1,60}$/;

export const asciiFold = (s: string): string => s.normalize("NFKD").replace(/[̀-ͯ]/g, "");

/** 32-bit FNV-1a. */
function fnv1a(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

/** "my" + PascalCase words of the folded name (cut to 40) + 6 base36 characters of an FNV-1a hash of `salt`. */
export function personalMoveId(name: string, salt: string): string {
  const words = asciiFold(name).split(/[^A-Za-z0-9]+/).filter(Boolean);
  let body = words.map((w) => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase()).join("");
  // The id's first character after "my" must be a capital letter (digits and empty names get a neutral lead).
  if (!/^[A-Z]/.test(body)) body = "Move" + body;
  body = body.slice(0, 40);
  const tail = (fnv1a(salt) % 36 ** 6).toString(36).padStart(6, "0");
  return "my" + body + tail;
}

export const isPersonalId = (id: string): boolean => id.length <= 80 && PERSONAL_ID_RE.test(id);
