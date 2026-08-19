"use client";

import { useRouter } from "next/navigation";
import { ArrowLeft } from "./icons";

/**
 * The page shell. One narrow column, phone-shaped, centred on wide screens —
 * this is a product for a cheap Android held in one hand, and the desktop view
 * should look like that rather than a stretched dashboard.
 */
export function Screen({
  children,
  back,
  onBack,
  action,
  bare,
}: {
  children: React.ReactNode;
  /** Show a back control. `true` uses browser history. */
  back?: boolean;
  onBack?: () => void;
  /** Optional element pinned to the top right. */
  action?: React.ReactNode;
  /** Drop the header row entirely. */
  bare?: boolean;
}) {
  const router = useRouter();

  return (
    <div className="min-h-dvh">
      <div className="mx-auto flex min-h-dvh w-full max-w-[26.25rem] flex-col px-6">
        {!bare && (
          <header className="flex h-16 shrink-0 items-center justify-between">
            {back ? (
              <button
                type="button"
                onClick={onBack ?? (() => router.back())}
                aria-label="Go back"
                className="-ml-2 flex h-10 w-10 items-center justify-center rounded-full text-muted transition-colors duration-150 hover:text-ink"
              >
                <ArrowLeft />
              </button>
            ) : (
              <span className="font-display text-xl tracking-[-0.01em]">FundX</span>
            )}
            {action}
          </header>
        )}
        {children}
      </div>
    </div>
  );
}

/** Screen title + supporting line. Consistent rhythm across every step. */
export function Title({
  children,
  sub,
}: {
  children: React.ReactNode;
  sub?: React.ReactNode;
}) {
  return (
    <div className="rise">
      <h1 className="font-display text-[2rem] leading-[1.15] tracking-[-0.02em]">
        {children}
      </h1>
      {sub ? <p className="mt-2 text-[0.95rem] leading-relaxed text-muted">{sub}</p> : null}
    </div>
  );
}
