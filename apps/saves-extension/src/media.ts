import { MediaError } from "./errors.js";

/** The narrowest video the model is sent: on-screen text must stay legible. Probe R4 sets the real value. */
export const MIN_VIDEO_WIDTH = 480;
/** A carousel slide or photo is sent at about this width. */
export const MIN_IMAGE_WIDTH = 640;
/** The cover thumbnail the filter sees. */
export const COVER_WIDTH = 320;

export interface Variant {
  url: string;
  width: number;
}

/** The smallest variant at least `minWidth` wide, else the largest there is. */
export function pickVariant<V extends Variant>(variants: readonly V[], minWidth: number): V {
  if (variants.length === 0) throw new Error("no variants");
  const byWidth = [...variants].sort((a, b) => a.width - b.width);
  return byWidth.find((v) => v.width >= minWidth) ?? byWidth[byWidth.length - 1]!;
}

/** The largest variant narrower than `width`, or null when there is none. */
export function nextSmaller<V extends Variant>(variants: readonly V[], width: number): V | null {
  const smaller = variants.filter((v) => v.width < width).sort((a, b) => b.width - a.width);
  return smaller[0] ?? null;
}

/** Bytes as base64, in chunks (a spread of millions of arguments would overflow the stack). */
export function bytesToBase64(bytes: Uint8Array): string {
  const CHUNK = 0x8000;
  let binary = "";
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(binary);
}

/** Download one media file into memory as base64. A failed download (an expired signed link, the network) is MediaError. */
export async function fetchAsBase64(
  url: string,
  fetchImpl: typeof fetch,
  fallbackMime = "application/octet-stream",
): Promise<{ mime: string; base64: string; bytes: number }> {
  let res: Response;
  try {
    // A signed CDN link needs no cookie; sending none keeps the request as small as the site's own.
    res = await fetchImpl(url, { credentials: "omit" });
  } catch {
    throw new MediaError("A media download failed");
  }
  if (!res.ok) throw new MediaError(`A media download answered ${res.status}`);
  const bytes = new Uint8Array(await res.arrayBuffer());
  const mime = (res.headers.get("content-type") ?? "").split(";")[0]!.trim().toLowerCase() || fallbackMime;
  return { mime, base64: bytesToBase64(bytes), bytes: bytes.length };
}
