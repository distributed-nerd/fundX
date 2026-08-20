"use client";

import Link from "next/link";
import { formatUSD } from "@/lib/money";
import { clockTime, relativeTime } from "@/lib/time";
import type { Transfer } from "@/lib/types";
import { Avatar } from "./Avatar";

export function TransferRow({
  transfer,
  /**
   * "relative" for standalone lists ("2h", "Yesterday"); "clock" where a day
   * heading already carries the date, so the row doesn't repeat it back.
   */
  stamp = "relative",
}: {
  transfer: Transfer;
  stamp?: "relative" | "clock";
}) {
  const incoming = transfer.direction === "in";
  const amount = BigInt(transfer.amount);

  // Credits are green; debits are ink. Spending money is not an error state,
  // and colouring every payment red would make ordinary use feel like a warning.
  const tone = incoming ? "text-green" : "text-ink";
  const sign = incoming ? "+" : "−";

  const when =
    stamp === "clock" ? clockTime(transfer.createdAt) : relativeTime(transfer.createdAt);

  /**
   * Unsettled transfers say so in the list, not only on the detail screen.
   *
   * A receipt stays pending for minutes on Orchard, so a row that reads exactly like a
   * settled payment is the misleading state a user is most likely to meet — and "did that
   * actually go through" is the question the list exists to answer.
   */
  const state =
    transfer.status === "pending" ? "Sending" : transfer.status === "failed" ? "Didn't send" : null;

  const meta = [when, state ?? transfer.memo].filter(Boolean).join(" · ");

  return (
    <Link
      href={`/activity/${transfer.id}`}
      className="-mx-2 flex items-center gap-3 rounded-sm px-2 py-3.5 transition-colors duration-150 hover:bg-surface"
    >
      <Avatar
        name={transfer.counterparty.displayName}
        external={transfer.counterparty.external}
      />

      <span className="min-w-0 flex-1">
        <span className="block truncate text-[0.95rem] text-ink">
          {transfer.counterparty.displayName}
        </span>
        <span className="mt-0.5 block truncate text-[0.8rem] text-muted">{meta}</span>
      </span>

      <span
        className={`shrink-0 figure text-[0.95rem] ${tone} ${
          // Money that has not settled reads as provisional rather than done.
          transfer.status === "pending" ? "opacity-55" : ""
        } ${transfer.status === "failed" ? "line-through opacity-55" : ""}`}
      >
        {sign}
        {formatUSD(amount)}
      </span>
    </Link>
  );
}
