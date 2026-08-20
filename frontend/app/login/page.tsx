"use client";

import { Suspense, useEffect, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { Button } from "@/components/Button";
import { CodeInput } from "@/components/CodeInput";
import { Field } from "@/components/Field";
import { Screen, Title } from "@/components/Screen";
import { login, normalizePhone, prettyPhone } from "@/lib/api";
import { useSession } from "@/lib/session";

function SignIn() {
  const router = useRouter();
  const params = useSearchParams();
  const { setUser, user, loading } = useSession();

  /**
   * The number can arrive prefilled.
   *
   * Someone who tapped "Get started" with an account already gets sent here rather than
   * being asked to invent a handle they cannot have. Making them retype the number they
   * just entered would be a second small insult.
   */
  const [raw, setRaw] = useState(params.get("phone") ?? "");
  const [pin, setPin] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const note = params.get("reason") === "registered";
  const phone = normalizePhone(raw);

  useEffect(() => {
    if (!loading && user) router.replace("/home");
  }, [loading, user, router]);

  async function submit(value: string) {
    if (!phone) return;
    setBusy(true);
    setError(null);

    const result = await login(phone, value);
    setBusy(false);

    if (!result.ok) {
      setPin("");
      setError(
        result.reason === "locked"
          ? "Too many tries. Wait a few minutes before trying again."
          : result.reason === "unavailable"
            ? "We couldn't reach FundX. Check your connection."
            : // The server answers the same for an unknown number and a wrong PIN, so this
              // must not claim to know which. Naming the number would leak who has an account.
              "That didn't work. Check your number and PIN.",
      );
      return;
    }

    setUser(result.user);
    router.replace("/home");
  }

  function handlePin(next: string) {
    setError(null);
    setPin(next);
    if (next.length === 4 && !busy && phone) void submit(next);
  }

  return (
    <Screen back>
      <div className="flex flex-1 flex-col pt-4 pb-10">
        <Title
          sub={
            note
              ? "You already have a FundX account on this number. Enter your PIN to get back in."
              : "Your number and your PIN."
          }
        >
          Welcome back
        </Title>

        <div className="mt-8 space-y-5">
          <Field
            label="Phone number"
            value={raw}
            onChange={(e) => {
              setRaw(e.target.value);
              setError(null);
            }}
            placeholder="0803 123 4567"
            inputMode="tel"
            autoComplete="tel"
            autoFocus={!params.get("phone")}
            hint={phone ? prettyPhone(phone) : "The number your account is on."}
            className="figure"
          />

          <CodeInput
            label="Your four digit PIN"
            length={4}
            value={pin}
            onChange={handlePin}
            secret
            error={Boolean(error)}
            autoFocus={Boolean(params.get("phone"))}
          />
        </div>

        {error ? <p className="mt-3 text-[0.85rem] text-alert">{error}</p> : null}

        <div className="mt-auto pt-8">
          <Button
            full
            disabled={!phone || pin.length !== 4}
            loading={busy}
            onClick={() => void submit(pin)}
          >
            Sign in
          </Button>
          <p className="mt-4 text-center text-[0.8rem] text-faint">
            New to FundX?{" "}
            <button
              type="button"
              onClick={() => router.push("/phone")}
              className="underline underline-offset-2 transition-colors duration-150 hover:text-ink"
            >
              Create an account
            </button>
          </p>
        </div>
      </div>
    </Screen>
  );
}

export default function LoginPage() {
  // `useSearchParams` needs a boundary or the whole route opts out of static rendering.
  return (
    <Suspense fallback={<div className="min-h-dvh" />}>
      <SignIn />
    </Suspense>
  );
}
