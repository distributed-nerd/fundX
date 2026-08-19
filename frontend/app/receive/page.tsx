"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/Button";
import { CopyButton } from "@/components/CopyButton";
import { Screen, Title } from "@/components/Screen";
import { ChevronDown } from "@/components/icons";
import { formatHandle, prettyPhone } from "@/lib/api";
import { useSession } from "@/lib/session";

export default function Receive() {
  const router = useRouter();
  const { user, loading, signOut } = useSession();
  const [showAddress, setShowAddress] = useState(false);

  useEffect(() => {
    if (!loading && !user) router.replace("/");
  }, [loading, user, router]);

  if (!user) return <div className="min-h-dvh" />;

  return (
    <Screen back onBack={() => router.replace("/home")}>
      <div className="flex flex-1 flex-col pt-4 pb-10">
        <Title sub="Give either of these to anyone on FundX and they can pay you.">
          Get paid
        </Title>

        <div className="mt-8 divide-y divide-hairline border-y border-hairline">
          <div className="flex items-center gap-3 py-5">
            <div className="min-w-0 flex-1">
              <p className="text-[0.8rem] text-muted">Your handle</p>
              <p className="mt-1 font-display text-[1.75rem] leading-none tracking-[-0.01em]">
                {formatHandle(user.username)}
              </p>
            </div>
            <CopyButton value={formatHandle(user.username)} label="Copy handle" />
          </div>

          <div className="flex items-center gap-3 py-5">
            <div className="min-w-0 flex-1">
              <p className="text-[0.8rem] text-muted">Your number</p>
              <p className="mt-1 figure text-[1.1rem]">{prettyPhone(user.phone)}</p>
            </div>
            <CopyButton value={user.phone} label="Copy phone number" />
          </div>
        </div>

        {/*
          The one place in the product where a hex address is legitimate, and it
          stays folded away until someone explicitly needs it. Everywhere else a
          recipient is a person.
        */}
        <div className="mt-8">
          <button
            type="button"
            onClick={() => setShowAddress((v) => !v)}
            aria-expanded={showAddress}
            className="flex w-full items-center justify-between gap-3 py-2 text-left transition-colors duration-150 hover:text-ink"
          >
            <span className="text-[0.9rem] text-muted">
              Receiving from outside FundX
            </span>
            <ChevronDown
              className={`shrink-0 text-faint transition-transform duration-150 ${
                showAddress ? "rotate-180" : ""
              }`}
            />
          </button>

          {showAddress ? (
            <div className="fade mt-3 rounded-md border border-hairline bg-surface p-5">
              <p className="text-[0.8rem] text-muted">Your deposit address</p>

              <div className="mt-2 flex items-start gap-2">
                <p className="min-w-0 flex-1 break-all font-mono text-[0.8rem] leading-relaxed text-ink">
                  {user.address}
                </p>
                <CopyButton value={user.address} label="Copy deposit address" />
              </div>

              <p className="mt-4 border-t border-hairline pt-4 text-[0.8rem] leading-relaxed text-muted">
                Only send USDT on the Quai network here. Anything sent from another
                network will not arrive and cannot be recovered.
              </p>
            </div>
          ) : null}
        </div>

        <div className="mt-auto pt-10">
          <Button
            full
            variant="ghost"
            onClick={async () => {
              await signOut();
              router.replace("/");
            }}
          >
            Sign out
          </Button>
        </div>
      </div>
    </Screen>
  );
}
