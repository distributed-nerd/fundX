"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/Button";
import { CodeInput } from "@/components/CodeInput";
import { Screen, Title } from "@/components/Screen";
import { prettyPhone, requestOtp, verifyOtp } from "@/lib/api";
import { getDraft, patchDraft } from "@/lib/onboarding";

const RESEND_SECONDS = 30;

export default function VerifyStep() {
  const router = useRouter();
  const [phone, setPhone] = useState<string | null>(null);
  const [code, setCode] = useState("");
  const [error, setError] = useState(false);
  const [busy, setBusy] = useState(false);
  const [countdown, setCountdown] = useState(RESEND_SECONDS);

  useEffect(() => {
    // Async so state lands in a callback rather than synchronously in the effect
    // body — and because this becomes a real request once the backend exists.
    void (async () => {
      const draft = getDraft();
      if (!draft.phone) router.replace("/phone");
      else setPhone(draft.phone);
    })();
  }, [router]);

  useEffect(() => {
    if (countdown === 0) return;
    const id = setTimeout(() => setCountdown((c) => c - 1), 1000);
    return () => clearTimeout(id);
  }, [countdown]);

  async function submit(value: string) {
    if (!phone) return;
    setBusy(true);
    const { ok, signupToken, registered } = await verifyOtp(phone, value);
    setBusy(false);

    if (!ok || !signupToken) {
      setError(true);
      setCode("");
      return;
    }

    /**
     * They already have an account, and just proved they own the number.
     *
     * Caught here rather than three screens later at signup: continuing would ask them to
     * choose a PIN and a handle before failing on the handle, which was never the problem.
     */
    if (registered) {
      router.replace(`/login?reason=registered&phone=${encodeURIComponent(phone)}`);
      return;
    }

    // The server's own proof that this number was verified. Signup requires it, which is
    // why a client-set `verified: true` was worthless here.
    patchDraft({ signupToken });
    router.push("/pin");
  }

  // Six digits is the whole input — submit rather than make them press a button.
  function handleCode(next: string) {
    setError(false);
    setCode(next);
    if (next.length === 6 && !busy) void submit(next);
  }

  return (
    <Screen back>
      <div className="flex flex-1 flex-col pt-4 pb-10">
        <Title
          sub={
            phone ? (
              <>
                Sent to <span className="figure text-ink">{prettyPhone(phone)}</span>.{" "}
                <button
                  type="button"
                  onClick={() => router.replace("/phone")}
                  className="underline underline-offset-2 transition-colors duration-150 hover:text-ink"
                >
                  Change
                </button>
              </>
            ) : null
          }
        >
          Enter the code
        </Title>

        <div className="mt-8">
          <CodeInput
            label="Six digit code"
            length={6}
            value={code}
            onChange={handleCode}
            error={error}
            autoFocus
          />

          {/*
            The slot keeps its height whether or not there is an error, so the button below
            does not jump upward the moment a code is rejected — which is exactly when
            someone is about to tap it again.
          */}
          <div className="mt-3 min-h-[1.25rem]">
            {error ? (
              <p className="text-[0.85rem] text-alert">
                That code didn&rsquo;t match. Try again.
              </p>
            ) : null}
          </div>
        </div>

        <div className="mt-auto pt-8">
          <Button
            full
            variant="ghost"
            disabled={countdown > 0 || busy}
            onClick={async () => {
              if (!phone) return;
              await requestOtp(phone);
              setCountdown(RESEND_SECONDS);
            }}
          >
            {countdown > 0 ? `Resend code in ${countdown}s` : "Resend code"}
          </Button>
        </div>
      </div>
    </Screen>
  );
}
