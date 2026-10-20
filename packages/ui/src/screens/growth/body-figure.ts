/**
 * THE BODY MAP'S FIGURE (drawn for Run Garden, no outside path data): a front view and a back view side by side, the
 * way a muscle map is drawn, each area where it actually is. Every shape is a smooth path in its view's own frame, 100
 * wide with its middle at x = 50; the back view is drawn 100 to the right. Only one side of the body is written here —
 * the other is its mirror across the view's middle (`mirrorPath`), and a shape across the middle is written as its
 * right half (`wholePath`) — so the figure is symmetric by construction.
 *
 * Where each area is drawn:
 *   front  neck (the front of the neck and the upper traps' slope), shoulders (front delts), chest (pecs), arms (biceps,
 *          forearms), core (abs, obliques), hips (the hip flexors and adductors at the top of the inner thigh), quads,
 *          calves (the calf's edges a front view shows, either side of the shin)
 *   back   neck (the back of the neck and the upper traps), shoulders (rear delts), arms (triceps, forearms), back (the
 *          middle and lower traps, the shoulder blade's muscles, the lats, the low back), hips (glute medius, the upper
 *          outer hip), glutes, hamstrings, calves
 *
 * The trapezius is split where its work changes: its upper part, from the skull to the top of the shoulder, shrugs and
 * bends the neck, so it is the neck's (in both views — from the front it is the slope from the neck to the shoulder);
 * its middle and lower parts draw the shoulder blades back and down, so they are the back's.
 *
 * What is no area — the head, the hands, the feet, the knees, the elbows, the spine's line, the shin — is the
 * silhouette under the areas, a step quieter than an area at rest.
 */
import type { BodyArea } from "@rg/domain";

export const BODY_VIEWS = ["front", "back"] as const;
export type BodyView = (typeof BODY_VIEWS)[number];

/** Each view's middle, in its own frame. */
export const VIEW_MID = 50;
/** Where each view's frame sits in the figure. */
export const VIEW_X: Record<BodyView, number> = { front: 0, back: 100 };
/** The figure's box: both views, and their captions under them. */
export const FIGURE_BOX = { x: 6, y: 0, w: 188, h: 244 } as const;
export const VIEW_CAPTION_Y = 239;

// ── Path helpers (absolute M, L, C and Z only) ───────────────────────────────────────────────────────────────────────

type Cmd = { c: "M" | "L" | "C" | "Z"; n: number[] };

function parse(d: string): Cmd[] {
  return [...d.matchAll(/([MLCZ])([^MLCZ]*)/g)].map((m) => ({ c: m[1] as Cmd["c"], n: (m[2]!.match(/-?\d*\.?\d+/g) ?? []).map(Number) }));
}

const num = (v: number) => String(Math.round(v * 100) / 100);
const print = (cmds: Cmd[]) => cmds.map((k) => k.c + k.n.map(num).join(" ")).join("");

/** A path's mirror across x = mid: every x reflected, every y kept. */
export function mirrorPath(d: string, mid = VIEW_MID): string {
  return print(parse(d).map((k) => ({ c: k.c, n: k.n.map((v, i) => (i % 2 === 0 ? 2 * mid - v : v)) })));
}

/** A path's segments walked the other way round, from its last point back to its first (where it starts is the caller's). */
function walkedBack(cmds: Cmd[]): Cmd[] {
  const ends = cmds.map((k) => k.n.slice(-2));
  const out: Cmd[] = [];
  for (let i = cmds.length - 1; i > 0; i--) {
    const k = cmds[i]!;
    const back = ends[i - 1]!;
    out.push(k.c === "C" ? { c: "C", n: [...k.n.slice(2, 4), ...k.n.slice(0, 2), ...back] } : { c: "L", n: back });
  }
  return out;
}

/**
 * A shape across the middle, from its right half: `half` starts on the middle, goes round the right side and comes back
 * to the middle; the whole shape is that, then its mirror walked back to the start, closed.
 */
export function wholePath(half: string, mid = VIEW_MID): string {
  return print([...parse(half), ...walkedBack(parse(mirrorPath(half, mid))), { c: "Z", n: [] }]);
}

/** A shape on one side and its mirror on the other. */
const pair = (d: string): string[] => [d, mirrorPath(d)];
const whole = (half: string): string[] => [wholePath(half)];

// ── The silhouette: what is no area ──────────────────────────────────────────────────────────────────────────────────

const HEAD = "M50 3.6C55.6 3.6 59.2 7.6 59.2 13.6C59.2 19 57.6 23.6 54.8 26.2C53.4 27.5 51.8 28.2 50 28.2";
const EAR = "M58.6 13.2C59.8 12.4 60.8 13.2 60.8 15C60.8 17.2 60 19 58.8 19.4Z";
const TORSO =
  "M50 25.5L54.6 25.5C55 28.8 55.6 31.4 57 33.2C60 35.2 64.4 36.6 68.2 37.7C72.6 38.8 75.4 42.4 75.6 47.8C75.8 52.8 74.6 57 73 60.2L69.6 62.8C69.4 68.8 68.8 74.4 67.4 80.2C66.2 84.8 65.4 88.4 65.5 92.2C65.6 97.2 68.5 106.4 69.4 111.4C62 114.6 55.6 116.3 50 117";
const ARM =
  "M70 43.5C73.8 43.4 76.4 46.8 76.4 51.4C76.4 58.6 78.2 68.4 79.6 76.8C80.2 80.6 80.6 84 80.8 87.2C83.1 92.2 84.2 101.5 84.7 110.9C85.8 113.5 86.8 117 86.9 120.4C87 123.8 86.2 126.8 84.7 127.6C83.2 128.4 82 126.6 81.6 123.6C81.2 120.4 81.2 117 80.4 114C79.2 106.2 74.5 97 74.4 88.5C73.6 84.6 72.8 80.8 71.8 76.4C70.6 70.2 69.6 65 69.2 60C68.8 53 68.8 47 70 43.5Z";
const LEG =
  "M50.8 108C57.6 106.2 63.6 105.6 68.4 107C70.4 114 70.8 122.6 70.1 132.2C69.3 142 67.2 152.5 65.6 160.2C65.2 163.4 65.5 166.6 66.2 170.7C67.2 177.1 66.8 186.8 65 196.4C64.1 201.5 63.4 206 63.2 210.9L56 210.9C56 205.8 54.6 198.3 54 189.7C53.4 181.8 53.8 173.9 55.2 168.8C55.6 165.8 55.6 163 55.2 160.2C54 148.7 52.4 133.7 51.2 121.9C50.8 117.2 50.6 112.5 50.8 108Z";
const FOOT_FRONT = "M55.9 204L63.5 204C63.3 208.4 63.6 211.4 65 214.6C66.6 218 66 223.1 62.6 223.1L58.2 223.1C55.6 223.1 54.9 221.2 55.2 218.6C55.6 214.4 56 209.6 55.9 204Z";
const HEEL = "M55.9 204L63.5 204C63.3 208.6 64 212.6 63.9 216.6C63.8 221.4 62.2 223.3 59.6 223.3C57 223.3 55.4 221.4 55.3 216.6C55.2 212.6 55.9 208.6 55.9 204Z";

const BODY = [...whole(HEAD), ...pair(EAR), ...whole(TORSO), ...pair(ARM), ...pair(LEG)];
export const SILHOUETTE: Record<BodyView, readonly string[]> = {
  front: [...BODY, ...pair(FOOT_FRONT)],
  back: [...BODY, ...pair(HEEL)],
};

// ── The areas ────────────────────────────────────────────────────────────────────────────────────────────────────────

// The arm's two segments read the same from either side: the biceps in front, the triceps behind; the forearm's flexors
// in front, its extensors behind.
const UPPER_ARM =
  "M70.6 61.8C72.2 60.6 74.4 61.6 76.2 63.8C77.2 66.4 77.8 70.6 78 75.4C78.2 80 77.8 83.4 76.8 85.2C75.6 86.4 74.2 86.4 73.4 85.4C72.4 80.8 71.2 73.2 70.8 67.6C70.6 65.4 70.4 63.2 70.6 61.8Z";
const FOREARM = "M75.3 89.9C77.6 88.5 80 88.5 81.7 89.7C82.6 95.1 83.2 101.5 83.5 107.1C83.2 109.2 82.3 110.4 81.1 110.2C78.9 104 76.1 96.7 75.3 89.9Z";

/** Every area's paths, in each view it is drawn in, in that view's own frame. */
export const FIGURE: Record<BodyArea, Partial<Record<BodyView, readonly string[]>>> = {
  neck: {
    front: whole("M50 29.6C51.8 29.4 53.6 28.4 55 27.4C55.3 30 56 32.2 57.4 33.6C60.4 35.4 64.4 36.6 67.6 37.6C63.8 38.4 58.2 37.6 53.6 36.9C52.2 36.7 51 36.7 50 36.9"),
    back: whole("M50 27.4C52 27.4 53.8 26.8 54.8 26.4C55.2 29.6 56 32.2 57.6 33.6C60.6 35.4 64.6 36.6 67.6 37.6C68.4 38.2 68.6 38.8 68.2 39.4C63.2 40 56 40.4 50 40.6"),
  },
  shoulders: {
    front: pair("M61.8 39.4C65.6 38.6 69.6 38.6 72 39.8C74.4 41.2 75 44.4 75 48.6C75 53.6 76 58.4 76.4 62.4C74.4 59.8 72.6 56.2 71 52.6C69 48.6 65.6 43.2 61.8 39.4Z"),
    back: pair("M66.6 44C68 41.6 70.4 40 72.4 40.2C74.4 41.2 75 44.4 75 48.6C75 53.6 76 58.4 76.4 62.4C74.6 59.6 73.2 56 72 52.6C70.6 49.4 68.8 46.4 66.6 44Z"),
  },
  chest: {
    front: pair("M50.8 38.8C54.6 38.4 58.2 38.6 60.6 39.6C64.2 43 67.4 47.6 69.6 52.6C70.2 54.6 70.4 56.6 70 58.4C69.4 60 68 61 66 61.8C62.4 63.4 58 64.4 54.6 64C52.8 63.8 51.6 63.2 50.8 62.4Z"),
  },
  arms: {
    front: [...pair(UPPER_ARM), ...pair(FOREARM)],
    back: [...pair(UPPER_ARM), ...pair(FOREARM)],
  },
  back: {
    back: [
      // The middle and lower traps, from the base of the neck to the middle of the back.
      ...pair("M50.7 42.2C55.6 41.8 61.4 41.4 66.4 41.4C64 44 61.6 46.8 59.6 49.6C57.8 53.6 57 57.8 56.4 62C55.4 68.4 53.6 75 50.7 80.4Z"),
      // The shoulder blade's muscles: the infraspinatus and the teres.
      ...pair("M60.6 50.6C62.8 48.6 64.8 46.6 66.4 45.4C69 47.6 71.2 51.4 72.4 55.6C72.8 57.4 72.4 58.8 71.2 59.6C68 61 64.4 62.2 61.6 62.4C60.4 59 60 54.4 60.6 50.6Z"),
      // The lats.
      ...pair("M69.2 62.2C68.8 68.4 68 74.4 66.8 80C65.8 84 65 87.6 64.8 90.6C62.6 92.4 60.2 93.2 58 93.4C57.6 88.6 56.4 83.6 54.2 79.4C55.8 76.6 56.8 70.4 57.6 65.4C61.6 65.2 65.6 64 69.2 62.2Z"),
      // The low back: the erectors either side of the spine.
      ...pair("M50.7 82.6C52.4 82.8 53.8 84 54.4 86.4C55.2 91.4 55.2 97 54.6 101.2C54 103.4 52.6 104.8 50.7 105.2Z"),
    ],
  },
  core: {
    front: [
      // The abs, either side of the midline.
      ...pair("M50.7 65.6C53.6 65 56.6 65 58.6 65.8C59.6 73 59.6 84 58.6 93C57.6 100.4 55.4 106 52.6 109.9C51.8 110.8 51.2 111.2 50.7 111.2Z"),
      // The obliques, from under the chest to the hip's crest.
      ...pair("M60.4 66.6C63.4 65.2 66.4 64.2 68.8 63.4C68.8 69.6 68 75.6 66.6 81C65.4 86 64.8 90 64.9 94C65 97.4 65.6 100 66 101.8C63 104.6 59.6 107.4 56.2 109.1C57.6 104.6 60 99 60.4 92.8C61 84 61 74 60.4 66.6Z"),
    ],
  },
  hips: {
    front: pair("M52.6 114.2C55.8 112.3 59.4 110.1 62.6 108.2C62 115.1 60.4 122.6 58.6 129C57.4 133.5 56 138.2 54.4 142.7C53.6 135.2 52.4 125.5 51.8 118.1C51.7 116.3 51.9 114.8 52.6 114.2Z"),
    back: pair("M57.8 101.2C60.4 99 62.8 97.8 65 97.6C66.2 100.2 66.9 103.6 67.1 107.4C64.6 106.4 61.8 105 59.4 104.4C58.4 103.4 57.9 102.4 57.8 101.2Z"),
  },
  glutes: {
    back: pair("M50.8 107.6C53.4 106 57 105.6 60.4 106.4C63.8 107.4 66.6 109.5 67.6 112.9C68.4 117.6 67 122.3 64 124.9C60.6 127.5 55.4 127.9 52.2 126.4C51.2 125.8 50.8 124.9 50.8 123.6Z"),
  },
  quads: {
    front: pair(
      "M64.4 107C66.2 107 67.4 107.8 67.9 109.1C69.4 115.5 69.6 123.8 69 132.2C68.2 141.8 66.8 149.9 65.2 155.9C63.6 158.2 60 160.6 56.6 160.9C55.9 160.9 55.5 159.1 55.6 156.8C55.8 152.5 56.2 148.4 57 144.8C58.6 138.4 60.6 129.8 61.8 121.9C62.6 116.1 63.4 110.8 64.4 107Z",
    ),
  },
  hamstrings: {
    back: pair(
      "M52.4 129C56 130 61.6 129.8 66.8 127C68.6 133.7 68.4 142.2 67 149.7C66.2 154 65 157.6 63.8 160C62.6 157.4 61.4 155.5 60 155.3C58.6 155.5 57.4 157.4 56.4 160.2C55.4 152.9 54.4 145.5 53.8 139.5C53.4 135.2 53 132 52.4 129Z",
    ),
  },
  calves: {
    front: [
      // The inner calf, and the outer edge of the lower leg, either side of the shin.
      ...pair("M56 169.4C57.4 173.7 58.2 181.2 58 188.9C57.8 193.4 57 197.2 56 200C55 196.4 54.4 191 54.4 185.3C54.4 179 54.9 173.3 56 169.4Z"),
      ...pair("M65.2 171.8C66.2 177.1 66.2 185 64.8 193.6C64.2 197.5 63.6 201.1 63.4 203.9C62.6 199 62.4 191.5 62.6 184C62.8 179 63.8 174.8 65.2 171.8Z"),
    ],
    back: pair(
      "M57 165.4C58.6 164.1 61.6 164.1 64 165.4C65.6 170.1 66.4 176.5 66 184C65.6 190.4 64.4 196.4 63 201.5C62.4 203.7 61.8 205.2 61.2 206.2L58.4 206.2C57.6 204.1 56.6 200.7 55.6 195.7C54.6 190 54.2 181.8 54.6 176.5C54.8 171.8 55.6 167.5 57 165.4Z",
    ),
  },
};

// ── The faint lines inside the areas ─────────────────────────────────────────────────────────────────────────────────

/** Hairlines that let a group read as muscle: the abs' segments, the quads' heads, the kneecap, the hamstrings' two
 * sides, the calf's two heads over the soleus. */
export const LINES: Record<BodyView, readonly string[]> = {
  front: [
    ...pair("M51 73.8C53.6 73 56.6 73 59.2 73.6"),
    ...pair("M51 82C53.6 81.2 56.6 81.2 59.3 81.8"),
    ...pair("M51 90.4C53.4 89.8 56.2 89.8 58.8 90.4"),
    ...pair("M66.8 113.4C66.4 126.2 65.4 142.2 62.8 155.7"),
    ...pair("M58.6 144.2C60 148.7 60.6 152.9 60.4 157"),
    ...pair("M58 163C58.6 165.8 61.4 165.8 62.2 163"),
  ],
  back: [
    ...pair("M60 132.6C60.4 140.1 60.4 147.6 60 155.3"),
    ...pair("M60.4 166.4C60.6 173.3 60.6 180.8 60.2 188.3"),
    ...pair("M55.4 188.9C57.4 192.1 59.2 193.8 60.2 194C61.6 193 63.4 190.4 65.4 186.3"),
  ],
};
