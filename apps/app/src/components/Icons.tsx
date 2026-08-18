interface IconProps {
  className?: string;
}

function Svg({ className, children }: IconProps & { children: React.ReactNode }) {
  return (
    <svg
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.4}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      className={className ?? "size-4"}
    >
      {children}
    </svg>
  );
}

export const Play = (p: IconProps) => (
  <Svg {...p}>
    <path d="M5 3.4 12.4 8 5 12.6z" fill="currentColor" stroke="none" />
  </Svg>
);

export const Stop = (p: IconProps) => (
  <Svg {...p}>
    <rect x="4.2" y="4.2" width="7.6" height="7.6" rx="1.4" fill="currentColor" stroke="none" />
  </Svg>
);

/** Connections: three rules with knobs (settings, in the house style). */
export const Sliders = (p: IconProps) => (
  <Svg {...p}>
    <path d="M2.5 4.5h11M2.5 8h11M2.5 11.5h11" opacity={0.4} />
    <circle cx="6" cy="4.5" r="1.7" fill="currentColor" stroke="none" />
    <circle cx="10.5" cy="8" r="1.7" fill="currentColor" stroke="none" />
    <circle cx="5" cy="11.5" r="1.7" fill="currentColor" stroke="none" />
  </Svg>
);

export const Check = (p: IconProps) => (
  <Svg {...p}>
    <path d="m3 8.6 3.3 3L13 4.4" />
  </Svg>
);

export const ChevronRight = (p: IconProps) => (
  <Svg {...p}>
    <path d="m6 3.5 4.5 4.5L6 12.5" />
  </Svg>
);

export const ArrowLeft = (p: IconProps) => (
  <Svg {...p}>
    <path d="M13 8H3.5m0 0L7 4.5M3.5 8 7 11.5" />
  </Svg>
);

export const External = (p: IconProps) => (
  <Svg {...p}>
    <path d="M6.5 3H3.4A.4.4 0 0 0 3 3.4v9.2c0 .22.18.4.4.4h9.2a.4.4 0 0 0 .4-.4V9.5" />
    <path d="M9.5 2.5H13.5V6.5M13 3 7.5 8.5" />
  </Svg>
);

export const Repo = (p: IconProps) => (
  <Svg {...p}>
    <path d="M3.5 2.5h8a.5.5 0 0 1 .5.5v10l-2.2-1.5L8 13l-1.8-1.5L4 13V3a.5.5 0 0 1 .5-.5z" />
    <path d="M6 5.5h3.5" />
  </Svg>
);

export const Warn = (p: IconProps) => (
  <Svg {...p}>
    <path d="M8 2.6 14.2 13H1.8L8 2.6z" />
    <path d="M8 6.6v3M8 11.4v.1" />
  </Svg>
);

export const Image = (p: IconProps) => (
  <Svg {...p}>
    <rect x="2" y="3" width="12" height="10" rx="1.2" />
    <path d="m2.6 11 3.1-3.1 2.4 2.4 2-2L13.4 11" />
    <circle cx="6" cy="6" r="1" />
  </Svg>
);

export const Film = (p: IconProps) => (
  <Svg {...p}>
    <rect x="2" y="3" width="12" height="10" rx="1.2" />
    <path d="M5.2 3v10M10.8 3v10M2 8h12" />
  </Svg>
);

export const Doc = (p: IconProps) => (
  <Svg {...p}>
    <path d="M9 2H4.4a.4.4 0 0 0-.4.4v11.2c0 .22.18.4.4.4h7.2a.4.4 0 0 0 .4-.4V5L9 2z" />
    <path d="M8.8 2.2V5h2.9M6 8.5h4M6 10.8h3" />
  </Svg>
);

export const Terminal = (p: IconProps) => (
  <Svg {...p}>
    <rect x="1.8" y="2.8" width="12.4" height="10.4" rx="1.4" />
    <path d="m4.8 6.4 2 1.7-2 1.7M8.6 10.2h2.8" />
  </Svg>
);

export const Copy = (p: IconProps) => (
  <Svg {...p}>
    <rect x="5.5" y="5.5" width="7" height="7" rx="1.2" />
    <path d="M10.5 3.5h-6a1 1 0 0 0-1 1v6" opacity={0.5} />
  </Svg>
);

export const Branch = (p: IconProps) => (
  <Svg {...p}>
    <circle cx="4.5" cy="3.6" r="1.6" />
    <circle cx="4.5" cy="12.4" r="1.6" />
    <circle cx="11.5" cy="6" r="1.6" />
    <path d="M4.5 5.2v5.6M11.5 7.6c0 2-1.6 2.6-3.4 2.9-1.6.26-3.6.5-3.6 2.5" />
  </Svg>
);

export const Merge = (p: IconProps) => (
  <Svg {...p}>
    <circle cx="4.5" cy="3.8" r="1.6" />
    <circle cx="4.5" cy="12.2" r="1.6" />
    <circle cx="11.5" cy="8" r="1.6" />
    <path d="M4.5 5.4v5.2M9.9 8H8.4c-2 0-3.9-1.2-3.9-3" />
  </Svg>
);

/** Git pull request, in the same family as Branch and Merge. */
export const Pull = (p: IconProps) => (
  <Svg {...p}>
    <circle cx="4.5" cy="3.8" r="1.6" />
    <circle cx="4.5" cy="12.2" r="1.6" />
    <circle cx="11.5" cy="12.2" r="1.6" />
    <path d="M4.5 5.4v5.2M8.3 3.8h1.6a1.6 1.6 0 0 1 1.6 1.6v5.2" />
  </Svg>
);

export const Comment = (p: IconProps) => (
  <Svg {...p}>
    <path d="M13.5 9.4a1.6 1.6 0 0 1-1.6 1.6H6l-3 2.4V4.2a1.6 1.6 0 0 1 1.6-1.6h7.3a1.6 1.6 0 0 1 1.6 1.6z" />
  </Svg>
);

export const Plus = (p: IconProps) => (
  <Svg {...p}>
    <path d="M8 3.2v9.6M3.2 8h9.6" />
  </Svg>
);

export const Minus = (p: IconProps) => (
  <Svg {...p}>
    <path d="M3.2 8h9.6" />
  </Svg>
);

export const Close = (p: IconProps) => (
  <Svg {...p}>
    <path d="m4 4 8 8M12 4l-8 8" />
  </Svg>
);

export const Pin = (p: IconProps) => (
  <Svg {...p}>
    <path d="M8 2.6v8.2m0 0L4.6 7.4M8 10.8l3.4-3.4M3 13.4h10" />
  </Svg>
);

export const Sun = (p: IconProps) => (
  <Svg {...p}>
    <circle cx="8" cy="8" r="3" />
    <path d="M8 1.6v1.6M8 12.8v1.6M1.6 8h1.6M12.8 8h1.6M3.5 3.5l1.1 1.1M11.4 11.4l1.1 1.1M12.5 3.5l-1.1 1.1M4.6 11.4l-1.1 1.1" />
  </Svg>
);

export const Moon = (p: IconProps) => (
  <Svg {...p}>
    <path d="M13.4 9.6A5.8 5.8 0 0 1 6.4 2.6a5.8 5.8 0 1 0 7 7z" />
  </Svg>
);

export const Monitor = (p: IconProps) => (
  <Svg {...p}>
    <rect x="1.8" y="2.8" width="12.4" height="8.4" rx="1.2" />
    <path d="M5.8 13.6h4.4M8 11.2v2.4" />
  </Svg>
);

export const Refresh = (p: IconProps) => (
  <Svg {...p}>
    <path d="M3.2 8a4.8 4.8 0 0 1 8.1-3.5M12.8 8a4.8 4.8 0 0 1-8.1 3.5" />
    <path d="M11.3 2.6v2.3H9M4.7 13.4v-2.3H7" />
  </Svg>
);

/** Circular arrow: run it again. */
export const Retry = (p: IconProps) => (
  <Svg {...p}>
    <path d="M12.9 8A4.9 4.9 0 1 1 11 4.1" />
    <path d="M11.4 1.8v2.5H8.9" />
  </Svg>
);

/** Take another look at shipped work. */
export const Eye = (p: IconProps) => (
  <Svg {...p}>
    <path d="M1.8 8S4.1 3.9 8 3.9 14.2 8 14.2 8 11.9 12.1 8 12.1 1.8 8 1.8 8z" />
    <circle cx="8" cy="8" r="1.9" />
  </Svg>
);

/** Pencil: rename affordance. */
export const Edit = (p: IconProps) => (
  <Svg {...p}>
    <path d="M11.1 2.7a1.6 1.6 0 0 1 2.2 2.2L5.5 12.7l-3 .8.8-3z" />
    <path d="M9.6 4.2 11.8 6.4" />
  </Svg>
);

export const Graph = (p: IconProps) => (
  <Svg {...p}>
    <path d="M2.5 2.5v11h11" />
    <path d="M5.5 10.5V7.8M8.5 10.5V5.2M11.5 10.5V6.5" />
  </Svg>
);

export const Archive = (p: IconProps) => (
  <Svg {...p}>
    <rect x="2" y="3" width="12" height="3.2" rx="0.8" />
    <path d="M3.2 6.2v6a1 1 0 0 0 1 1h7.6a1 1 0 0 0 1-1v-6M6.4 8.8h3.2" />
  </Svg>
);

export const Unarchive = (p: IconProps) => (
  <Svg {...p}>
    <rect x="2" y="3" width="12" height="3.2" rx="0.8" />
    <path d="M3.2 6.2v6a1 1 0 0 0 1 1h7.6a1 1 0 0 0 1-1v-6M8 12v-3.4M6.5 10.1 8 8.6l1.5 1.5" />
  </Svg>
);

/** A cogwheel: hub, rim, and eight teeth. */
export const Gear = (p: IconProps) => (
  <Svg {...p}>
    <circle cx="8" cy="8" r="1.9" />
    <circle cx="8" cy="8" r="4.4" />
    <path d="M8 1.6v2M8 12.4v2M14.4 8h-2M3.6 8h-2M12.5 3.5 11.1 4.9M4.9 11.1l-1.4 1.4M12.5 12.5l-1.4-1.4M4.9 4.9 3.5 3.5" />
  </Svg>
);
