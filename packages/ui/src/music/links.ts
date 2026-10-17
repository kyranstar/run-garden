/**
 * A pasted Spotify link, read (the music dock, 2026-10-17): an `open.spotify.com/{playlist|album}/{id}` link (with or
 * without the scheme, a locale segment or the `?si=` share suffix) or a `spotify:` URI (including the old
 * `spotify:user:<name>:playlist:<id>` form), anywhere in the text pasted. Tracks, artists, other hosts: null.
 */
import type { SpotifyContextKind } from "@rg/domain";

export interface SpotifyLink {
  kind: SpotifyContextKind;
  id: string;
  uri: string;
}

const OPEN = /(?:^|[\s(<"'])(?:https?:\/\/)?open\.spotify\.com\/(?:intl-[a-z]{2}(?:-[a-z]{2})?\/|embed\/)?(playlist|album)\/([A-Za-z0-9]{16,32})(?=$|[?#/\s)>"'!.,])/i;
const URI = /(?:^|[\s(<"'])spotify:(?:user:[^:\s]+:)?(playlist|album):([A-Za-z0-9]{16,32})(?=$|[\s)>"'!.,])/;

export function parseSpotifyLink(text: string): SpotifyLink | null {
  const m = OPEN.exec(text) ?? URI.exec(text);
  if (!m) return null;
  const kind = m[1]!.toLowerCase() as SpotifyContextKind;
  return { kind, id: m[2]!, uri: `spotify:${kind}:${m[2]!}` };
}

/** The web link for a playlist or an album: on a phone it opens the Spotify app (a universal link). */
export function openUrlOf(uri: string): string {
  const [, kind, id] = uri.split(":");
  return `https://open.spotify.com/${kind}/${id}`;
}
