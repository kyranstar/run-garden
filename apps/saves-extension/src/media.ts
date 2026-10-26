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

/** The media hosts the manifest grants (`https://*.cdninstagram.com/*`, `https://*.fbcdn.net/*`): nothing else is fetched. */
const MEDIA_DOMAINS = ["cdninstagram.com", "fbcdn.net"];

export function isMediaUrl(url: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  const host = parsed.hostname.toLowerCase();
  return parsed.protocol === "https:" && MEDIA_DOMAINS.some((d) => host === d || host.endsWith(`.${d}`));
}

/** The most a media download may take, headers to last byte. A CDN that stalls must not pin the whole check (2026-10-26). */
export const MEDIA_TIMEOUT_MS = 90_000;

/**
 * Download one media file into memory as base64. Only from the site's media hosts; a link elsewhere, a failed download
 * (an expired signed link, the network), or one that outlasts `timeoutMs` is MediaError.
 */
export async function fetchAsBase64(
  url: string,
  fetchImpl: typeof fetch,
  fallbackMime = "application/octet-stream",
  timeoutMs = MEDIA_TIMEOUT_MS,
): Promise<{ mime: string; base64: string; bytes: number }> {
  if (!isMediaUrl(url)) throw new MediaError("A media link is not on the site's media hosts");
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    let res: Response;
    try {
      // A signed CDN link needs no cookie; sending none keeps the request as small as the site's own.
      res = await fetchImpl(url, { credentials: "omit", signal: controller.signal });
    } catch {
      throw new MediaError(controller.signal.aborted ? "A media download timed out" : "A media download failed");
    }
    if (!res.ok) throw new MediaError(`A media download answered ${res.status}`);
    let bytes: Uint8Array;
    try {
      bytes = new Uint8Array(await res.arrayBuffer());
    } catch {
      throw new MediaError(controller.signal.aborted ? "A media download timed out" : "A media download failed");
    }
    const mime = (res.headers.get("content-type") ?? "").split(";")[0]!.trim().toLowerCase() || fallbackMime;
    return { mime, base64: bytesToBase64(bytes), bytes: bytes.length };
  } finally {
    clearTimeout(timer);
  }
}
