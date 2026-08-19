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

  const phone = normalizePhone(raw);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!phone) {
      setError("That doesn't look like a complete number.");
      return;
    }

    setBusy(true);
    setError(null);
    await requestOtp(phone);
    patchDraft({ phone, verified: false });
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

        <div className="mt-auto pt-8">
          <Button full type="submit" disabled={!phone} loading={busy}>
            Continue
          </Button>
          <p className="mt-4 text-center text-[0.8rem] text-faint">
            Your number is how people send you money. It stays private.
          </p>
        </div>
      </form>
    </Screen>
  );
}
