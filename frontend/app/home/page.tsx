"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Avatar } from "@/components/Avatar";
import { Button } from "@/components/Button";
import { Screen } from "@/components/Screen";
import { TransferRow } from "@/components/TransferRow";
import { formatHandle, getBalance, getTransfers } from "@/lib/api";
import { formatNGN, formatRate, formatUSD } from "@/lib/money";
import { useRate } from "@/lib/rate";
import { useSession } from "@/lib/session";
import type { Balance, Transfer } from "@/lib/types";

export default function Home() {
  const router = useRouter();
  const { user, loading } = useSession();
  const { rate } = useRate();

  const [balance, setBalance] = useState<Balance | null>(null);
  const [transfers, setTransfers] = useState<Transfer[] | null>(null);

  useEffect(() => {
    if (!loading && !user) router.replace("/");
  }, [loading, user, router]);

  useEffect(() => {
    if (!user) return;
    void getBalance().then(setBalance);
    void getTransfers().then(setTransfers);
  }, [user]);

  if (!user) return <div className="min-h-dvh" />;

  const amount = balance ? BigInt(balance.usd) : null;
  const recent = transfers?.slice(0, 4) ?? [];

  return (
    <Screen
      action={
        /* Your handle is what people pay you with — it reads as identity, not chrome. */
        <Link
          href="/receive"
          className="flex items-center gap-2 rounded-full border border-hairline bg-surface py-1 pr-1 pl-3.5 transition-colors duration-150 hover:border-line"
        >
          <span className="text-[0.9rem] text-ink">{formatHandle(user.username)}</span>
          <Avatar name={user.displayName} size={30} />
        </Link>
      }
    >
      <main className="flex-1 pb-12">
        <section className="pt-8">
          <p className="text-[0.85rem] text-muted">Your balance</p>

          <p className="mt-1.5 font-display text-[3.5rem] leading-none tracking-[-0.02em] figure">
            {amount === null ? (
              <span className="text-hairline">$0.00</span>
            ) : (
              formatUSD(amount)
            )}
          </p>

          <p className="mt-2.5 text-[0.85rem] text-muted figure">
            {amount === null ? (
              <span className="opacity-0">placeholder</span>
            ) : (
              <>
                ≈ {formatNGN(amount, rate)}
                <span className="text-faint"> · at {formatRate(rate)}</span>
              </>
            )}
          </p>
        </section>

        <section className="mt-8 flex gap-3">
          <Button full onClick={() => router.push("/send")}>
            Send
          </Button>
          <Button full variant="secondary" onClick={() => router.push("/receive")}>
            Receive
          </Button>
        </section>

        <section className="mt-12">
          <div className="flex items-baseline justify-between">
            <h2 className="text-[0.85rem] font-medium text-muted">Recent</h2>
            {recent.length > 0 ? (
              <Link
                href="/activity"
                className="text-[0.85rem] text-muted underline-offset-2 transition-colors duration-150 hover:text-ink hover:underline"
              >
                See all
              </Link>
            ) : null}
          </div>

          <div className="mt-1 divide-y divide-hairline">
            {transfers === null ? (
              <div className="h-40" />
            ) : recent.length === 0 ? (
              <p className="py-10 text-[0.95rem] leading-relaxed text-muted">
                Nothing yet. Money you send or receive shows up here.
              </p>
            ) : (
              recent.map((t) => <TransferRow key={t.id} transfer={t} />)
            )}
          </div>
        </section>
      </main>
    </Screen>
  );
}
