"use client";

/** Four quiet tints. Avatars identify people; they shouldn't compete with money. */
const TINTS = [
  { bg: "#EAE3D6", fg: "#5A4F3C" },
  { bg: "#DFE8E1", fg: "#2E4A3A" },
  { bg: "#EEE0D9", fg: "#61463A" },
  { bg: "#E2E4DE", fg: "#454A42" },
];

function initials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return "?";
  if (parts.length === 1) return parts[0].slice(0, 1).toUpperCase();
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
}

function tintFor(seed: string) {
  let hash = 0;
  for (let i = 0; i < seed.length; i += 1) {
    hash = (hash * 31 + seed.charCodeAt(i)) >>> 0;
  }
  return TINTS[hash % TINTS.length];
}

export function Avatar({
  name,
  size = 40,
  external,
}: {
  name: string;
  size?: number;
  /** Money that arrived from outside FundX has no person behind it. */
  external?: boolean;
}) {
  const tint = external ? { bg: "#EFF4F0", fg: "#1B5E3F" } : tintFor(name);

  return (
    <span
      className="flex shrink-0 items-center justify-center rounded-full font-medium select-none"
      style={{
        width: size,
        height: size,
        backgroundColor: tint.bg,
        color: tint.fg,
        fontSize: size * 0.36,
      }}
      aria-hidden
    >
      {external ? (
        <svg viewBox="0 0 20 20" width={size * 0.45} height={size * 0.45} fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
          <path d="M10 15V5M6 9l4-4 4 4" />
        </svg>
      ) : (
        initials(name)
      )}
    </span>
  );
}
