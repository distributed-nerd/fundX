"use client";

import { useEffect, useState } from "react";
import { Check, Copy } from "./icons";

export function CopyButton({ value, label }: { value: string; label: string }) {
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    if (!copied) return;
    const id = setTimeout(() => setCopied(false), 1600);
    return () => clearTimeout(id);
  }, [copied]);

  return (
    <button
      type="button"
      aria-label={copied ? "Copied" : label}
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(value);
          setCopied(true);
        } catch {
          /* clipboard blocked — the value is on screen to read anyway */
        }
      }}
      className={[
        "flex h-9 w-9 shrink-0 items-center justify-center rounded-full",
        "transition-colors duration-150 ease-out",
        copied ? "text-green" : "text-faint hover:text-ink",
      ].join(" ")}
    >
      {copied ? <Check /> : <Copy />}
    </button>
  );
}
