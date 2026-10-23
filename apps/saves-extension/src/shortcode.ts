/** A post's shortcode is its numeric id (pk) in base 64, over this alphabet. */
const ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
/** A pk fits in 11 characters; a private post's longer code carries a suffix after them. */
const PK_CHARS = 11;

/** The post id behind a shortcode, as a decimal string (pks pass 2^53, so BigInt, never a number). */
export function shortcodeToPk(code: string): string {
  if (!code) throw new Error("empty shortcode");
  let n = 0n;
  for (const ch of code.slice(0, PK_CHARS)) {
    const i = ALPHABET.indexOf(ch);
    if (i < 0) throw new Error("not a shortcode");
    n = n * 64n + BigInt(i);
  }
  return n.toString();
}
