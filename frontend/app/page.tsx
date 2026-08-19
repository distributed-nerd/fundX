"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/Button";
import { useSession } from "@/lib/session";

export default function Welcome() {
  const { user, loading } = useSession();
  const router = useRouter();

  useEffect(() => {
    if (!loading && user) router.replace("/home");
  }, [loading, user, router]);

  if (loading || user) return <div className="min-h-dvh" />;

  return (
    <div className="mx-auto flex min-h-dvh w-full max-w-[26.25rem] flex-col px-6">
      <header className="flex h-16 shrink-0 items-center">
        <span className="font-display text-xl tracking-[-0.01em]">FundX</span>
      </header>

      <main className="flex flex-1 flex-col justify-center py-10">
        <h1 className="font-display text-[2.4rem] leading-[1.1] tracking-[-0.02em] text-balance rise">
          Getting money is hard.
          <br />
          <em className="text-green">Spending it shouldn&rsquo;t be.</em>
        </h1>

        <p className="mt-6 max-w-[22rem] text-[1.05rem] leading-relaxed text-muted rise">
          Send and receive money with nothing but a phone number. It arrives in
          seconds, and it works on any phone.
        </p>
      </main>

      <footer className="shrink-0 pb-10">
        <Button full onClick={() => router.push("/phone")}>
          Get started
        </Button>
        <p className="mt-4 text-center text-[0.8rem] text-faint">
          Takes about a minute. You&rsquo;ll need your phone number.
        </p>
      </footer>
    </div>
  );
}
