"use client";

import { useEffect, useState } from "react";
import { NGN_RATE_FALLBACK } from "@/lib/money";

/**
 * The live USD/NGN rate.
 *
 * Every naira figure in the product runs through this. It is fetched rather than hardcoded
 * because the rate moves, and quoting a stale one means promising an amount that will not
 * arrive — the fastest way to lose a user who has been burned by hidden spreads before.
 *
 * The fallback renders only for the moment before the first response.
 */
export function useRate(): { rate: number; live: boolean } {
  const [rate, setRate] = useState<number | null>(null);

  useEffect(() => {
    let active = true;
    const base = process.env.NEXT_PUBLIC_API_BASE ?? "http://localhost:4000";

    fetch(`${base}/api/rate`)
      .then((r) => (r.ok ? r.json() : null))
      .then((body) => {
        if (active && typeof body?.rate === "number") setRate(body.rate);
      })
      .catch(() => {
        /* keep the fallback; the figure is marked as not live */
      });

    return () => {
      active = false;
    };
  }, []);

  return { rate: rate ?? NGN_RATE_FALLBACK, live: rate !== null };
}
