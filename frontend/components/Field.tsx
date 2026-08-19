"use client";

import type { InputHTMLAttributes, ReactNode } from "react";

type Props = InputHTMLAttributes<HTMLInputElement> & {
  label?: string;
  /** Fixed text sitting inside the field, before the value. */
  prefix?: ReactNode;
  /** Element pinned to the right inside the field. */
  suffix?: ReactNode;
  hint?: ReactNode;
  error?: string | null;
};

export function Field({
  label,
  prefix,
  suffix,
  hint,
  error,
  className = "",
  ...rest
}: Props) {
  return (
    <label className="block">
      {label ? (
        <span className="mb-2 block text-[0.8rem] font-medium tracking-[0.01em] text-muted">
          {label}
        </span>
      ) : null}

      <span
        className={[
          "flex h-13 items-center gap-1 rounded-md border bg-surface px-4",
          "transition-colors duration-150 ease-out",
          "focus-within:border-green",
          error ? "border-alert" : "border-line",
        ].join(" ")}
      >
        {prefix ? <span className="shrink-0 text-muted">{prefix}</span> : null}
        <input
          {...rest}
          className={[
            "min-w-0 flex-1 bg-transparent text-[1rem] text-ink outline-none",
            "placeholder:text-faint",
            className,
          ].join(" ")}
        />
        {suffix ? <span className="shrink-0">{suffix}</span> : null}
      </span>

      {error ? (
        <span className="mt-2 block text-[0.85rem] text-alert">{error}</span>
      ) : hint ? (
        <span className="mt-2 block text-[0.85rem] text-muted">{hint}</span>
      ) : null}
    </label>
  );
}
