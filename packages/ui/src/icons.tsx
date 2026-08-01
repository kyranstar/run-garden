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

export const IconGarden = ({ size }: IconProps) => (
  <svg {...base(size)}>
    <path d="M12 21v-8" />
    <path d="M12 13c0-3.5 2.5-6 6-6 0 3.5-2.5 6-6 6Z" />
    <path d="M12 10C12 6.5 9.5 4 6 4c0 3.5 2.5 6 6 6Z" />
    <path d="M5 21h14" />
  </svg>
);

export const IconInsights = ({ size }: IconProps) => (
  <svg {...base(size)}>
    <path d="M4 20V10M10 20V4M16 20v-7M21 20H3" />
  </svg>
);

export const IconRuns = ({ size }: IconProps) => (
  <svg {...base(size)}>
    <circle cx="12" cy="13" r="8" />
    <path d="M12 13V9M9.5 3h5" />
  </svg>
);

export const IconSettings = ({ size }: IconProps) => (
  <svg {...base(size)}>
    <circle cx="12" cy="12" r="3.2" />
    <path d="M19 12a7 7 0 0 0-.14-1.4l2-1.55-2-3.46-2.36.95a7 7 0 0 0-2.42-1.4L13.7 2.6h-3.4l-.38 2.54a7 7 0 0 0-2.42 1.4l-2.36-.95-2 3.46 2 1.55A7 7 0 0 0 5 12c0 .48.05.94.14 1.4l-2 1.55 2 3.46 2.36-.95a7 7 0 0 0 2.42 1.4l.38 2.54h3.4l.38-2.54a7 7 0 0 0 2.42-1.4l2.36.95 2-3.46-2-1.55c.09-.46.14-.92.14-1.4Z" />
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
