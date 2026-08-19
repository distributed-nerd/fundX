"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { CodeInput } from "@/components/CodeInput";
import { Screen, Title } from "@/components/Screen";
import { getDraft, patchDraft } from "@/lib/onboarding";

/** Sequences and repeats are the PINs that get guessed. */
function isWeak(pin: string): boolean {
  if (/^(\d)\1{3}$/.test(pin)) return true;
  const ascending = "0123456789";
  const descending = "9876543210";
  return ascending.includes(pin) || descending.includes(pin);
}

export default function PinStep() {
  const router = useRouter();
  const [stage, setStage] = useState<"choose" | "confirm">("choose");
  const [pin, setPin] = useState("");
  const [entry, setEntry] = useState("");
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const draft = getDraft();
    if (!draft.phone) router.replace("/phone");
    else if (!draft.verified) router.replace("/verify");
  }, [router]);

  /** Four digits is the whole input, so the step advances on the last keystroke. */
  function handleEntry(next: string) {
    setError(null);

    if (next.length < 4) {
      setEntry(next);
      return;
    }

    if (stage === "choose") {
      if (isWeak(next)) {
        setEntry("");
        setError("Pick something harder to guess.");
        return;
      }
      setPin(next);
      setEntry("");
      setStage("confirm");
      return;
    }

    if (next !== pin) {
      setPin("");
      setEntry("");
      setStage("choose");
      setError("Those didn't match. Start again.");
      return;
    }

    setEntry(next);
    patchDraft({ pin });
    router.push("/username");
  }

  const choosing = stage === "choose";

  return (
    <Screen
      back
      onBack={() => {
        if (choosing) router.back();
        else {
          setStage("choose");
          setPin("");
          setEntry("");
          setError(null);
        }
      }}
    >
      <div className="flex flex-1 flex-col pt-4 pb-10">
        <Title
          sub={
            choosing
              ? "You'll enter this to approve every payment. Four digits."
              : "Once more, so we know it's right."
          }
        >
          {choosing ? "Choose a PIN" : "Enter it again"}
        </Title>

        <div className="mt-10">
          {/* Remounting on stage change clears the field and refocuses cleanly. */}
          <CodeInput
            key={stage}
            label={choosing ? "Choose a four digit PIN" : "Confirm your PIN"}
            length={4}
            value={entry}
            onChange={handleEntry}
            secret
            autoFocus
            error={Boolean(error)}
          />

          {error ? (
            <p className="mt-3 text-[0.85rem] text-alert">{error}</p>
          ) : (
            <p className="mt-3 text-[0.85rem] text-faint">
              Don&rsquo;t use your birth year, and don&rsquo;t share it with anyone.
            </p>
          )}
        </div>
      </div>
    </Screen>
  );
}
