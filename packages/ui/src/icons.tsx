/** Minimal inline icon set (stroke-based, inherits currentColor). */

interface IconProps {
  size?: number;
}

function base(size?: number) {
  return {
    width: size,
    height: size,
    viewBox: "0 0 24 24",
    fill: "none",
    stroke: "currentColor",
    strokeWidth: 1.8,
    strokeLinecap: "round" as const,
    strokeLinejoin: "round" as const,
    "aria-hidden": true,
  };
}

export const IconToday = ({ size }: IconProps) => (
  <svg {...base(size)}>
    <circle cx="12" cy="12" r="4.2" />
    <path d="M12 2.5v3M12 18.5v3M2.5 12h3M18.5 12h3M5 5l2.1 2.1M16.9 16.9L19 19M19 5l-2.1 2.1M7.1 16.9L5 19" />
  </svg>
);

export const IconPlan = ({ size }: IconProps) => (
  <svg {...base(size)}>
    <rect x="3.5" y="5" width="17" height="15.5" rx="2.5" />
    <path d="M3.5 9.5h17M8 3v4M16 3v4M7.5 13.5h3M7.5 17h6" />
  </svg>
);

/** The Studio (a tab): a kettlebell in outline: a round body under a handle, drawn on IconPlan's grid and stroke. */
export const IconStudio = ({ size }: IconProps) => (
  <svg {...base(size)}>
    <path d="M9 8.5V7a3 3 0 0 1 6 0v1.5" />
    <path d="M12 8.5c-4.4 0-7.5 2.7-7.5 6.2 0 3.2 3 5.8 7.5 5.8s7.5-2.6 7.5-5.8c0-3.5-3.1-6.2-7.5-6.2Z" />
  </svg>
);

/** The coach's button in the nav (the new shape, §3): the garden's two-leaf sprout, standing alone — it sits on a
 * filled pill, so it carries no ground line. */
export const IconSprout = ({ size }: IconProps) => (
  <svg {...base(size)}>
    <path d="M12 21v-8.5" />
    <path d="M12 12.5c0-3.5 2.5-6 6-6 0 3.5-2.5 6-6 6Z" />
    <path d="M12 9.5C12 6 9.5 3.5 6 3.5c0 3.5 2.5 6 6 6Z" />
  </svg>
);

/** Growth (the new shape, §7): a line rising to the right, its tip a leaf. */
export const IconGrowth = ({ size }: IconProps) => (
  <svg {...base(size)}>
    <path d="M3.5 19.5h17" />
    <path d="M4.5 16 9 11.5l3.5 3 5-5.5" />
    <path d="M17.5 9c0-2.6 1.9-4.5 4-4.5 0 2.6-1.9 4.5-4 4.5Z" />
  </svg>
);

/** ⌕ — search. */
export const IconSearch = ({ size }: IconProps) => (
  <svg {...base(size)}>
    <circle cx="10.8" cy="10.8" r="6.3" />
    <path d="M15.6 15.6 20.5 20.5" />
  </svg>
);

/** Two sliders — filters. */
export const IconFilters = ({ size }: IconProps) => (
  <svg {...base(size)}>
    <path d="M4 7.5h9M17.5 7.5H20M4 16.5h2.5M11 16.5h9" />
    <circle cx="15.2" cy="7.5" r="2.2" />
    <circle cx="8.8" cy="16.5" r="2.2" />
  </svg>
);

/** ＋ — add. */
export const IconPlus = ({ size }: IconProps) => (
  <svg {...base(size)}>
    <path d="M12 5v14M5 12h14" />
  </svg>
);

export const IconSettings = ({ size }: IconProps) => (
  <svg {...base(size)}>
    <circle cx="12" cy="12" r="3.2" />
    <path d="M19 12a7 7 0 0 0-.14-1.4l2-1.55-2-3.46-2.36.95a7 7 0 0 0-2.42-1.4L13.7 2.6h-3.4l-.38 2.54a7 7 0 0 0-2.42 1.4l-2.36-.95-2 3.46 2 1.55A7 7 0 0 0 5 12c0 .48.05.94.14 1.4l-2 1.55 2 3.46 2.36-.95a7 7 0 0 0 2.42 1.4l.38 2.54h3.4l.38-2.54a7 7 0 0 0 2.42-1.4l2.36.95 2-3.46-2-1.55c.09-.46.14-.92.14-1.4Z" />
  </svg>
);

/** The coach's mark (2026-08-20): a speech bubble growing the garden
 * glyph's own two-leaf sprout — the coach is the garden's voice. Use at
 * 18px and up; below that, IconCoachSmall. */
export const IconCoach = ({ size }: IconProps) => (
  <svg {...base(size)}>
    <path d="M21.5 6.5A3.5 3.5 0 0 0 18 3H6A3.5 3.5 0 0 0 2.5 6.5v7.2A3.5 3.5 0 0 0 6 17.2h1.2V21l4.6-3.8H18a3.5 3.5 0 0 0 3.5-3.5Z" />
    <path d="M12 14.6v-3.4" />
    <path d="M12 11.2c0-2.5 1.8-4.3 4.3-4.3 0 2.5-1.8 4.3-4.3 4.3Z" />
    <path d="M12 9.8c0-2.5-1.8-4.3-4.3-4.3 0 2.5 1.8 4.3 4.3 4.3Z" />
  </svg>
);

/** The small cut of the coach mark for <18px (feed read-marks): same
 * bubble, one big leaf — two leaves and a stem can't resolve that small. */
export const IconCoachSmall = ({ size }: IconProps) => (
  <svg {...base(size)} strokeWidth={2}>
    <path d="M21.5 6.5A3.5 3.5 0 0 0 18 3H6A3.5 3.5 0 0 0 2.5 6.5v7.2A3.5 3.5 0 0 0 6 17.2h1.2V21l4.6-3.8H18a3.5 3.5 0 0 0 3.5-3.5Z" />
    <path d="M10.2 14.3c0-3.4 2.5-5.9 5.9-5.9 0 3.4-2.5 5.9-5.9 5.9Z" />
    <path d="M10.2 14.3c-1.1.9-1.8 1.7-2.2 2.5" />
  </svg>
);

export const IconCheck = ({ size }: IconProps) => (
  <svg {...base(size)}>
    <path d="M4.5 12.5l5 5L19.5 7" />
  </svg>
);

export const IconSync = ({ size }: IconProps) => (
  <svg {...base(size)}>
    <path d="M20 5v5h-5M4 19v-5h5" />
    <path d="M5.5 9a7 7 0 0 1 12.7-2M18.5 15a7 7 0 0 1-12.7 2" />
  </svg>
);

export const IconClock = ({ size }: IconProps) => (
  <svg {...base(size)}>
    <circle cx="12" cy="12" r="8.5" />
    <path d="M12 7.5V12l3 2.5" />
  </svg>
);

export const IconLaptop = ({ size }: IconProps) => (
  <svg {...base(size)}>
    <rect x="4.5" y="5" width="15" height="10" rx="1.5" />
    <path d="M2.5 18.5h19" />
  </svg>
);

export const IconAlert = ({ size }: IconProps) => (
  <svg {...base(size)}>
    <path d="M12 3.5 22 20H2Z" />
    <path d="M12 10v4.2M12 17.2v.1" />
  </svg>
);

export const IconCalendarOnly = ({ size }: IconProps) => (
  <svg {...base(size)}>
    <rect x="3.5" y="5" width="17" height="15.5" rx="2.5" />
    <path d="M3.5 9.5h17M8 3v4M16 3v4" />
  </svg>
);

export const IconChevron = ({ size }: IconProps) => (
  <svg {...base(size)}>
    <path d="M9 6l6 6-6 6" />
  </svg>
);

export const IconClose = ({ size }: IconProps) => (
  <svg {...base(size)}>
    <path d="M6 6l12 12M18 6L6 18" />
  </svg>
);

/** ⇄ — swap a move for another. */
export const IconSwap = ({ size }: IconProps) => (
  <svg {...base(size)}>
    <path d="M4 8h14M14.5 4.5L18 8l-3.5 3.5M20 16H6M9.5 12.5L6 16l3.5 3.5" />
  </svg>
);

/** A watch face on its strap — Send to watch, On your watch (Phase 3; approved mocks). */
export const IconWatch = ({ size }: IconProps) => (
  <svg {...base(size)}>
    <rect x="5.6" y="6" width="12.8" height="12" rx="3.4" />
    <path d="M8.6 6V2.6h6.8V6M8.6 18v3.4h6.8V18M12 9.5V12l1.6 1.5" />
  </svg>
);

/** A pushpin — pin a move, keep it in the rotation (Stage 2). */
export const IconPin = ({ size }: IconProps) => (
  <svg {...base(size)}>
    <path d="M9 3.5h6M10 3.5v5.2L6.8 12.5h10.4L14 8.7V3.5M12 12.5V20.5" />
  </svg>
);

/** ⓘ — how to do a move. */
export const IconInfo = ({ size }: IconProps) => (
  <svg {...base(size)}>
    <circle cx="12" cy="12" r="8.5" />
    <path d="M12 11v5.5M12 7.6v.1" />
  </svg>
);

/** ↶ — undo the last edit (the Studio's builder). */
export const IconUndo = ({ size }: IconProps) => (
  <svg {...base(size)}>
    <path d="M9 14 4.5 9.5 9 5M4.5 9.5H14a5.5 5.5 0 0 1 0 11h-3" />
  </svg>
);

/** ↷ — redo it. */
export const IconRedo = ({ size }: IconProps) => (
  <svg {...base(size)}>
    <path d="M15 14l4.5-4.5L15 5M19.5 9.5H10a5.5 5.5 0 0 0 0 11h3" />
  </svg>
);

/** ⋯ — more about a part or a move. */
export const IconMore = ({ size }: IconProps) => (
  <svg {...base(size)}>
    <path d="M5.5 12h.01M12 12h.01M18.5 12h.01" strokeWidth={3} />
  </svg>
);

/** ↑ / ↓ — move up or down one place. */
export const IconArrowUp = ({ size }: IconProps) => (
  <svg {...base(size)}>
    <path d="M12 19.5v-15M6 10.5l6-6 6 6" />
  </svg>
);

export const IconArrowDown = ({ size }: IconProps) => (
  <svg {...base(size)}>
    <path d="M12 4.5v15M6 13.5l6 6 6-6" />
  </svg>
);

/** ‹ — back. */
export const IconBack = ({ size }: IconProps) => (
  <svg {...base(size)}>
    <path d="M15 6l-6 6 6 6" />
  </svg>
);
