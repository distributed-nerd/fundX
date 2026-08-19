"use client";

import { useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { Screen, Title } from "@/components/Screen";
import { TransferRow } from "@/components/TransferRow";
import { getTransfers } from "@/lib/api";
import { dayLabel } from "@/lib/time";
import { useSession } from "@/lib/session";
import type { Transfer } from "@/lib/types";

export default function Activity() {
  const router = useRouter();
  const { user, loading } = useSession();
  const [transfers, setTransfers] = useState<Transfer[] | null>(null);

  useEffect(() => {
    if (!loading && !user) router.replace("/");
  }, [loading, user, router]);

  useEffect(() => {
    if (user) void getTransfers().then(setTransfers);
  }, [user]);

  const groups = useMemo(() => {
    if (!transfers) return [];
    const map = new Map<string, Transfer[]>();
    for (const t of transfers) {
      const key = dayLabel(t.createdAt);
      const bucket = map.get(key);
      if (bucket) bucket.push(t);
      else map.set(key, [t]);
    }
    return Array.from(map, ([label, items]) => ({ label, items }));
  }, [transfers]);

  if (!user) return <div className="min-h-dvh" />;

  return (
    <Screen back onBack={() => router.replace("/home")}>
      <div className="flex-1 pt-4 pb-12">
        <Title>Activity</Title>

        {transfers === null ? (
          <div className="h-64" />
        ) : groups.length === 0 ? (
          <p className="mt-10 text-[0.95rem] leading-relaxed text-muted">
            Nothing yet. Money you send or receive shows up here.
          </p>
        ) : (
          <div className="mt-8 space-y-8">
            {groups.map((group) => (
              <section key={group.label}>
                <h2 className="text-[0.8rem] font-medium text-muted">
                  {group.label}
                </h2>
                <div className="mt-1 divide-y divide-hairline">
                  {group.items.map((t) => (
                    <TransferRow key={t.id} transfer={t} stamp="clock" />
                  ))}
                </div>
              </section>
            ))}
          </div>
        )}
      </div>
    </Screen>
  );
}
