/**
 * A text's UTF-8 length — what `new TextEncoder().encode(text).length` answers — without encoding it into a buffer of
 * its own size. The coach designer checks sizes in bytes several times a step (the stored state, up to 200 KB; the
 * model's answer; every tool result), and allocating a fresh copy of each text only to read its length is CPU the
 * Workers free plan's 10 ms can't spare. The text is encoded a piece at a time into one fixed scratch buffer, reused:
 * the platform's own encoder, so a lone surrogate counts as U+FFFD (3 bytes), exactly as it is written.
 */

/** The scratch buffer's size: a piece of at most this many bytes is encoded at a time. */
export const UTF8_SCRATCH_BYTES = 65_536;

const encoder = new TextEncoder();
let scratch: Uint8Array | null = null;

export function utf8Bytes(text: string): number {
  scratch ??= new Uint8Array(UTF8_SCRATCH_BYTES);
  let total = 0;
  let rest = text;
  // Each pass encodes as much as fits — never part of a character — and goes on from there. A character is at most
  // 4 bytes, so every pass reads at least one.
  for (;;) {
    const { read, written } = encoder.encodeInto(rest, scratch);
    total += written;
    if (read >= rest.length) return total;
    rest = rest.substring(read);
  }
}
