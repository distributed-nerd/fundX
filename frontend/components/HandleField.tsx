"use client";

import type { ReactNode } from "react";
import { HANDLE_SUFFIX } from "@/lib/api";

/**
 * Handle entry: you type the label, and `.fundX` sits immediately after it.
 *
 * The input auto-sizes by stacking it on an invisible copy of its own text in a
 * 1×1 grid — the copy sets the column width, so the suffix tracks the text
 * exactly. Sizing in `ch` would drift, because the face is proportional.
 */
export function HandleField({
  label,
  value,
  onChange,
  suffixSlot,
  hint,
  error,
  autoFocus,
}: {
  label: string;
  value: string;
  onChange: (next: string) => void;
  /** Status indicator pinned to the right of the field. */
  suffixSlot?: ReactNode;
  hint?: ReactNode;
  error?: string | null;
  autoFocus?: boolean;
}) {
  const placeholder = "suleiman";

  return (
    <label className="block">
      <span className="mb-2 block text-[0.8rem] font-medium tracking-[0.01em] text-muted">
        {label}
      </span>

      <span
        className={[
          "flex h-13 items-center gap-1 rounded-md border bg-surface px-4",
          "transition-colors duration-150 ease-out focus-within:border-green",
          error ? "border-alert" : "border-line",
        ].join(" ")}
      >
        <span className="inline-grid min-w-0 max-w-full">
          <span
            aria-hidden
            className="invisible col-start-1 row-start-1 min-w-0 whitespace-pre text-[1rem]"
          >
            {value || placeholder}
          </span>
          <input
            value={value}
            onChange={(e) => onChange(e.target.value)}
            placeholder={placeholder}
            /* An input contributes ~20 characters of intrinsic width to grid
               sizing regardless of its value. size=1 hands that job to the
               measuring span above, so the suffix hugs the typed text. */
            size={1}
            autoComplete="off"
            autoCapitalize="none"
            spellCheck={false}
            autoFocus={autoFocus}
            className="col-start-1 row-start-1 w-full min-w-0 bg-transparent text-[1rem] text-ink outline-none placeholder:text-faint"
          />
        </span>

        <span className={`shrink-0 text-[1rem] ${value ? "text-muted" : "text-faint"}`}>
          {HANDLE_SUFFIX}
        </span>

        <span className="ml-auto shrink-0 pl-2">{suffixSlot}</span>
      </span>

      {error ? (
        <span className="mt-2 block text-[0.85rem] text-alert">{error}</span>
      ) : hint ? (
        <span className="mt-2 block text-[0.85rem] text-muted">{hint}</span>
      ) : null}
    </label>
  );
}
