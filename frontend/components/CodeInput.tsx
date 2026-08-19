"use client";

import { useEffect, useRef, useState } from "react";

/**
 * Fixed-length numeric entry — the OTP and the PIN.
 *
 * One real input sits invisibly over the boxes, so paste, backspace, and the
 * phone's numeric keypad all behave the way the OS intends. The boxes are
 * presentation only.
 */
export function CodeInput({
  length,
  value,
  onChange,
  secret,
  autoFocus,
  error,
  label,
}: {
  length: number;
  value: string;
  onChange: (next: string) => void;
  /** Render filled dots instead of digits. */
  secret?: boolean;
  autoFocus?: boolean;
  error?: boolean;
  label: string;
}) {
  const ref = useRef<HTMLInputElement>(null);
  const [focused, setFocused] = useState(false);

  useEffect(() => {
    if (autoFocus) ref.current?.focus();
  }, [autoFocus]);

  const boxes = Array.from({ length }, (_, i) => i);

  return (
    <div className="relative">
      <input
        ref={ref}
        value={value}
        onChange={(e) => onChange(e.target.value.replace(/\D/g, "").slice(0, length))}
        onFocus={() => setFocused(true)}
        onBlur={() => setFocused(false)}
        inputMode="numeric"
        autoComplete={secret ? "off" : "one-time-code"}
        aria-label={label}
        maxLength={length}
        className="absolute inset-0 z-10 h-full w-full cursor-pointer text-transparent caret-transparent opacity-0"
      />

      <div className="flex gap-2.5" aria-hidden>
        {boxes.map((i) => {
          const filled = i < value.length;
          const active = focused && i === Math.min(value.length, length - 1);

          return (
            <div
              key={i}
              className={[
                "flex h-14 flex-1 items-center justify-center rounded-md border bg-surface",
                "text-[1.25rem] figure transition-colors duration-150 ease-out",
                error
                  ? "border-alert"
                  : active
                    ? "border-green"
                    : filled
                      ? "border-muted"
                      : "border-line",
              ].join(" ")}
            >
              {secret ? (
                filled ? (
                  <span className="h-2.5 w-2.5 rounded-full bg-ink" />
                ) : null
              ) : (
                value[i] ?? ""
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
