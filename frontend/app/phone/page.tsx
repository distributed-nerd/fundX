"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/Button";
import { Field } from "@/components/Field";
import { Screen, Title } from "@/components/Screen";
import { normalizePhone, requestOtp } from "@/lib/api";
import { patchDraft } from "@/lib/onboarding";

export default function PhoneStep() {
  const router = useRouter();
  const [raw, setRaw] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  /**
   * Set when the number already has an account.
   *
   * Kept apart from `error` because it is not a mistake to correct — the number is right,
   * they are simply already a customer. It needs a way onward, not a red line telling them
   * to try again.
   */
  const [existing, setExisting] = useState(false);

  const phone = normalizePhone(raw);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!phone) {
      setError("That doesn't look like a complete number.");
      return;
    }

    setBusy(true);
    setError(null);
    setExisting(false);

    const result = await requestOtp(phone);
    setBusy(false);

    // Answered before an SMS is spent, so nobody pays to deliver news we already had.
    if (result.registered) {
      setExisting(true);
      return;
    }

    if (result.limited) {
      setError("Too many attempts. Wait a minute and try again.");
      return;
    }

    if (!result.sent) {
      setError("We couldn't send your code. Check your connection and try again.");
      return;
    }

    patchDraft({ phone });
    router.push("/verify");
  }

  return (
    <Screen back>
      <form onSubmit={submit} className="flex flex-1 flex-col pt-4 pb-10">
        <Title sub="We'll send you a code to confirm it's really you.">
          What&rsquo;s your number?
        </Title>

        <div className="mt-8">
          <Field
            label="Phone number"
            value={raw}
            onChange={(e) => {
              setRaw(e.target.value);
              setError(null);
              setExisting(false);
            }}
            onBlur={() => {
              if (raw && !phone) setError("That doesn't look like a complete number.");
            }}
            placeholder="0803 123 4567"
            inputMode="tel"
            autoComplete="tel"
            autoFocus
            error={error}
            hint={phone ? phone : "Nigerian numbers work with or without +234."}
            className="figure"
          />
        </div>

        {existing ? (
          <div className="mt-6 rounded-md border border-line bg-surface px-4 py-3.5">
            <p className="text-[0.9rem] text-ink">
              You already have a FundX account on this number.
            </p>
            <p className="mt-1 text-[0.85rem] text-muted">
              Sign in with your PIN instead — there&rsquo;s no need to register again.
            </p>
          </div>
        ) : null}

        <div className="mt-auto pt-8">
          {existing ? (
            <Button
              full
              type="button"
              onClick={() =>
                router.push(`/login?reason=registered&phone=${encodeURIComponent(phone!)}`)
              }
            >
              Sign in instead
            </Button>
          ) : (
            <Button full type="submit" disabled={!phone} loading={busy}>
              Continue
            </Button>
          )}
          <p className="mt-4 text-center text-[0.8rem] text-faint">
            Your number is how people send you money. It stays private.
          </p>
        </div>
      </form>
    </Screen>
  );
}
