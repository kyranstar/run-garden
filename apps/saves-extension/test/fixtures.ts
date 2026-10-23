// Synthetic feed fixtures, shaped like the web app's saved-posts feed (`items[].media`). Every handle, caption and URL here
// is made up (media on a made-up `synthetic.` host under the CDN domain the extension accepts); nothing comes from a
// real saved post, and nothing is ever fetched.
import { shortcodeToPk } from "../src/shortcode.js";
import type { KvStore } from "../src/queue.js";

export type MediaKind = "video" | "image" | "carousel";

const candidates = (tag: string) => [
  { width: 1080, height: 1350, url: `https://synthetic.cdninstagram.com/${tag}-1080.jpg` },
  { width: 640, height: 800, url: `https://synthetic.cdninstagram.com/${tag}-640.jpg` },
  { width: 320, height: 400, url: `https://synthetic.cdninstagram.com/${tag}-320.jpg` },
  { width: 150, height: 150, url: `https://synthetic.cdninstagram.com/${tag}-150.jpg` },
];

const videos = (tag: string, widths = [720, 480, 360]) =>
  widths.map((w) => ({ width: w, height: Math.round((w * 16) / 9), url: `https://synthetic.cdninstagram.com/${tag}-${w}.mp4`, type: 101 }));

/** One synthetic media object. `code` is the post's shortcode; its pk is derived from it, as the site's are. */
export function media(code: string, kind: MediaKind = "video", over: Record<string, unknown> = {}): Record<string, unknown> {
  const base: Record<string, unknown> = {
    pk: shortcodeToPk(code),
    id: `${shortcodeToPk(code)}_4242`,
    code,
    taken_at: 1_760_000_000,
    media_type: kind === "video" ? 2 : kind === "image" ? 1 : 8,
    user: { username: "example_coach", full_name: "Example Coach" },
    caption: { text: `Synthetic drill for ${code} #Mobility #hips #mobility` },
  };
  if (kind === "video") {
    base.product_type = "clips";
    base.video_versions = videos(code);
    base.image_versions2 = { candidates: candidates(code) };
  } else if (kind === "image") {
    base.image_versions2 = { candidates: candidates(code) };
  } else {
    base.carousel_media = [
      { media_type: 1, image_versions2: { candidates: candidates(`${code}-s1`) } },
      { media_type: 2, image_versions2: { candidates: candidates(`${code}-s2`) }, video_versions: videos(`${code}-s2`) },
      { media_type: 1, image_versions2: { candidates: candidates(`${code}-s3`) } },
    ];
  }
  return { ...base, ...over };
}

export function page(medias: Record<string, unknown>[], nextMaxId: string | null): Record<string, unknown> {
  return {
    items: medias.map((m) => ({ media: m })),
    num_results: medias.length,
    more_available: nextMaxId !== null,
    ...(nextMaxId !== null ? { next_max_id: nextMaxId } : {}),
    status: "ok",
  };
}

/** A shortcode-like synthetic key: "Syn" + a zero-padded number, 11 characters like the site's. */
export const code = (n: number): string => `Syn${String(n).padStart(8, "0")}`;

/** An in-memory store that round-trips values through JSON, as chrome.storage does (no shared references survive). */
export function memoryStore(): KvStore & { dump(): Record<string, unknown> } {
  const data = new Map<string, string>();
  return {
    async get(key) {
      const raw = data.get(key);
      return raw === undefined ? undefined : JSON.parse(raw);
    },
    async set(key, value) {
      data.set(key, JSON.stringify(value));
    },
    dump: () => Object.fromEntries([...data].map(([k, v]) => [k, JSON.parse(v)])),
  };
}

/** A fetch that answers every media URL with a few bytes, typed by the URL's extension. Records each URL. */
export function mediaFetch(over: (url: string) => Response | null = () => null): typeof fetch & { urls: string[] } {
  const urls: string[] = [];
  const f = (async (input: RequestInfo | URL) => {
    const url = String(input);
    urls.push(url);
    const custom = over(url);
    if (custom) return custom;
    const type = url.endsWith(".mp4") ? "video/mp4" : "image/jpeg";
    return new Response(new Uint8Array([1, 2, 3, 4, 5, 6]), { status: 200, headers: { "content-type": type } });
  }) as typeof fetch & { urls: string[] };
  f.urls = urls;
  return f;
}
