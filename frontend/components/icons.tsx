/**
 * The only icons the product uses. Drawn here rather than pulled from a library:
 * six glyphs at one stroke weight, sized to the type around them.
 */

type IconProps = { className?: string };

const base = {
  fill: "none",
  stroke: "currentColor",
  strokeWidth: 1.5,
  strokeLinecap: "round" as const,
  strokeLinejoin: "round" as const,
};

export function ArrowLeft({ className }: IconProps) {
  return (
    <svg viewBox="0 0 20 20" width="20" height="20" className={className} aria-hidden {...base}>
      <path d="M12 4 6 10l6 6" />
    </svg>
  );
}

export function ChevronRight({ className }: IconProps) {
  return (
    <svg viewBox="0 0 20 20" width="20" height="20" className={className} aria-hidden {...base}>
      <path d="M8 4l6 6-6 6" />
    </svg>
  );
}

export function ChevronDown({ className }: IconProps) {
  return (
    <svg viewBox="0 0 20 20" width="20" height="20" className={className} aria-hidden {...base}>
      <path d="M4 7.5l6 6 6-6" />
    </svg>
  );
}

export function Copy({ className }: IconProps) {
  return (
    <svg viewBox="0 0 20 20" width="20" height="20" className={className} aria-hidden {...base}>
      <rect x="7" y="7" width="9" height="9" rx="2" />
      <path d="M13 7V6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v5a2 2 0 0 0 2 2h1" />
    </svg>
  );
}

export function Check({ className }: IconProps) {
  return (
    <svg viewBox="0 0 20 20" width="20" height="20" className={className} aria-hidden {...base}>
      <path d="M4.5 10.5l3.5 3.5 7.5-8" />
    </svg>
  );
}

export function External({ className }: IconProps) {
  return (
    <svg viewBox="0 0 20 20" width="20" height="20" className={className} aria-hidden {...base}>
      <path d="M8 4H5a1 1 0 0 0-1 1v10a1 1 0 0 0 1 1h10a1 1 0 0 0 1-1v-3" />
      <path d="M11 4h5v5M16 4l-7 7" />
    </svg>
  );
}

/** The confirmation mark. Draws itself once, then holds. */
export function CheckSeal({ className }: IconProps) {
  return (
    <svg viewBox="0 0 56 56" width="56" height="56" className={className} aria-hidden>
      <circle cx="28" cy="28" r="27" fill="none" stroke="currentColor" strokeWidth="1" opacity="0.25" />
      <path
        d="M17 28.5l7.5 7.5L39 21"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
        style={{
          strokeDasharray: 40,
          strokeDashoffset: 40,
          animation: "fx-draw 420ms ease-out 120ms forwards",
        }}
      />
    </svg>
  );
}

export function Spinner({ className }: IconProps) {
  return (
    <svg viewBox="0 0 20 20" width="18" height="18" className={className} aria-hidden>
      <circle cx="10" cy="10" r="7.5" fill="none" stroke="currentColor" strokeWidth="2" opacity="0.25" />
      <path
        d="M10 2.5a7.5 7.5 0 0 1 7.5 7.5"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
      >
        <animateTransform
          attributeName="transform"
          type="rotate"
          from="0 10 10"
          to="360 10 10"
          dur="700ms"
          repeatCount="indefinite"
        />
      </path>
    </svg>
  );
}
