"use client";

import type { ButtonHTMLAttributes } from "react";
import { Spinner } from "./icons";

type Variant = "primary" | "secondary" | "ghost";

type Props = ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: Variant;
  full?: boolean;
  loading?: boolean;
};

const variants: Record<Variant, string> = {
  primary:
    "bg-green text-white hover:bg-green-deep disabled:bg-hairline disabled:text-faint",
  secondary:
    "bg-surface text-ink border border-line hover:border-muted disabled:text-faint disabled:border-hairline",
  ghost: "bg-transparent text-muted hover:text-ink disabled:text-faint",
};

export function Button({
  variant = "primary",
  full,
  loading,
  disabled,
  children,
  className = "",
  ...rest
}: Props) {
  return (
    <button
      {...rest}
      disabled={disabled || loading}
      className={[
        "inline-flex h-13 items-center justify-center gap-2 rounded-md px-6",
        "text-[0.95rem] font-medium tracking-[-0.01em]",
        "transition-colors duration-150 ease-out",
        full ? "w-full" : "",
        variants[variant],
        className,
      ].join(" ")}
    >
      {loading ? <Spinner /> : null}
      {children}
    </button>
  );
}
