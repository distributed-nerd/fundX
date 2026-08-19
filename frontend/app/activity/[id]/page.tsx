"use client";

import { useEffect, useState } from "react";
import { useParams, useRouter } from "next/navigation";
import { Avatar } from "@/components/Avatar";
import { CopyButton } from "@/components/CopyButton";
import { Screen } from "@/components/Screen";
import { External } from "@/components/icons";
import { formatHandle, getTransfer } from "@/lib/api";
import { formatNGN, formatRate, formatUSD } from "@/lib/money";
import { fullTime } from "@/lib/time";
import { useSession } from "@/lib/session";
import type { Transfer } from "@/lib/types";

function Detail({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div className="flex items-start justify-between gap-6 py-4">
      <span className="shrink-0 text-[0.85rem] text-muted">{label}</span>
      <span className="min-w-0 text-right text-[0.9rem]">{children}</span>
    </div>
  );
}

export default function TransferDetail() {
  const router = useRouter();
  const params = useParams<{ id: string }>();
  const { user, loading } = useSession();

  const [transfer, setTransfer] = useState<Transfer | null>(null);
  const [missing, setMissing] = useState(false);

  useEffect(() => {
    if (!loading && !user) router.replace("/");
  }, [loading, user, router]);

  useEffect(() => {
    if (!user || !params?.id) return;
    void getTransfer(params.id).then((t) => {
      if (t) setTransfer(t);
      else setMissing(true);
    });
  }, [user, params?.id]);

  if (!user) return <div className="min-h-dvh" />;

  if (missing) {
    return (
      <Screen back onBack={() => router.replace("/activity")}>
        <p className="pt-10 text-[0.95rem] text-muted">
          We couldn&rsquo;t find that payment.
        </p>
      </Screen>
    );
  }

  if (!transfer) return <Screen back><div className="h-64" /></Screen>;

  const incoming = transfer.direction === "in";
  const amount = BigInt(transfer.amount);

  return (
    <Screen back onBack={() => router.back()}>
      <div className="flex-1 pt-6 pb-12">
        <div className="flex flex-col items-center text-center">
          <Avatar
            name={transfer.counterparty.displayName}
            size={56}
            external={transfer.counterparty.external}
          />

          <p className="mt-4 text-[1.05rem]">
            {transfer.counterparty.displayName}
          </p>
          <p className="mt-0.5 text-[0.85rem] text-muted">
            {incoming ? "Received" : "Sent"}
            {transfer.counterparty.username
              ? ` · ${formatHandle(transfer.counterparty.username)}`
              : ""}
          </p>

          <p
            className={`mt-6 font-display text-[3rem] leading-none tracking-[-0.02em] figure ${
              incoming ? "text-green" : "text-ink"
            }`}
          >
            {incoming ? "+" : "−"}
            {formatUSD(amount)}
          </p>

          <p className="mt-2.5 text-[0.85rem] text-muted figure">
            ≈ {formatNGN(amount)}
            <span className="text-faint"> · at {formatRate()}</span>
          </p>
        </div>

        <div className="mt-10 divide-y divide-hairline border-y border-hairline">
          {transfer.memo ? <Detail label="Note">{transfer.memo}</Detail> : null}

          <Detail label="Date">
            <span className="figure">{fullTime(transfer.createdAt)}</span>
          </Detail>

          <Detail label="Status">
            {transfer.status === "confirmed" ? (
              <span className="text-green">Confirmed</span>
            ) : transfer.status === "pending" ? (
              <span className="text-muted">Pending</span>
            ) : (
              <span className="text-alert">Failed</span>
            )}
          </Detail>

          {transfer.txHash ? (
            <Detail label="Reference">
              <span className="flex items-center justify-end gap-1">
                <span className="font-mono text-[0.8rem]">
                  {transfer.txHash.slice(0, 10)}…{transfer.txHash.slice(-6)}
                </span>
                <CopyButton value={transfer.txHash} label="Copy reference" />
              </span>
            </Detail>
          ) : null}
        </div>

        {/*
          The claim the whole product rests on: the record is public and we
          can't quietly change it. Stated without demanding the user care why.
        */}
        {transfer.txHash ? (
          <div className="mt-6">
            <p className="text-[0.8rem] leading-relaxed text-muted">
              This payment is recorded publicly on Quai. Anyone can check it —
              including you.
            </p>
            <a
              href={`https://orchard.quaiscan.io/tx/${transfer.txHash}`}
              target="_blank"
              rel="noreferrer"
              className="mt-3 inline-flex items-center gap-1.5 text-[0.85rem] text-green underline-offset-2 transition-opacity duration-150 hover:underline"
            >
              View the record
              <External className="h-3.5 w-3.5" />
            </a>
          </div>
        ) : null}
      </div>
    </Screen>
  );
}
