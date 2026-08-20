"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/Button";
import { Field } from "@/components/Field";
import { HandleField } from "@/components/HandleField";
import { Screen, Title } from "@/components/Screen";
import { Check, Spinner } from "@/components/icons";
import { USERNAME_RULE, checkUsername, createAccount, formatHandle } from "@/lib/api";
import { clearDraft, getDraft } from "@/lib/onboarding";
import { useSession } from "@/lib/session";

type Availability =
  | { state: "idle" }
  | { state: "checking" }
  | { state: "ok" }
  | { state: "no"; message: string };

const MESSAGES: Record<string, string> = {
  taken: "Someone already has that one.",
  reserved: "That one's reserved.",
  invalid: "Start with a letter. Letters, numbers and underscores, 3 to 16 characters.",
};

export default function UsernameStep() {
  const router = useRouter();
  const { setUser } = useSession();

  const [name, setName] = useState("");
  const [handle, setHandle] = useState("");
  const [availability, setAvailability] = useState<Availability>({ state: "idle" });
  const [busy, setBusy] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);

  useEffect(() => {
    const draft = getDraft();
    if (!draft.phone) router.replace("/phone");
    else if (!draft.signupToken) router.replace("/verify");
    else if (!draft.pin) router.replace("/pin");
  }, [router]);

  /** Shape and validity are decided on the keystroke; only the lookup is deferred. */
  function handleHandle(input: string) {
    const next = input.toLowerCase().replace(/[^a-z0-9_]/g, "");
    setHandle(next);

    if (!next) setAvailability({ state: "idle" });
    else if (!USERNAME_RULE.test(next)) {
      setAvailability({ state: "no", message: MESSAGES.invalid });
    } else setAvailability({ state: "checking" });
  }

  // Debounced availability check, so it settles while they're still typing.
  useEffect(() => {
    if (!handle || !USERNAME_RULE.test(handle)) return;

    let active = true;
    const id = setTimeout(async () => {
      const result = await checkUsername(handle);
      if (!active) return;
      setAvailability(
        result.available
          ? { state: "ok" }
          : { state: "no", message: MESSAGES[result.reason ?? "invalid"] },
      );
    }, 350);

    return () => {
      active = false;
      clearTimeout(id);
    };
  }, [handle]);

  const ready = name.trim().length > 1 && availability.state === "ok";

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    const draft = getDraft();
    if (!ready || !draft.phone || !draft.pin || !draft.signupToken) return;

    setBusy(true);
    setSubmitError(null);

    const result = await createAccount({
      phone: draft.phone,
      username: handle,
      displayName: name,
      pin: draft.pin,
      signupToken: draft.signupToken,
    });

    if (!result.ok) {
      setBusy(false);

      /**
       * Real failures are possible now this reaches a server rather than localStorage: the
       * handle can be claimed between the availability check and the submit, and the signup
       * token expires. Neither could happen against a mock, so neither had a message.
       */
      if (result.reason === "unauthorized") {
        setSubmitError("That took too long. We'll send you a new code.");
        setTimeout(() => router.replace("/phone"), 1800);
        return;
      }

      /**
       * They already have an account on this number.
       *
       * This used to surface as "someone just took that handle", which was both false and
       * a dead end — no handle would ever have worked. Send them to sign in, carrying the
       * number so they do not type it twice.
       */
      if (result.reason === "registered") {
        clearDraft();
        setSubmitError("You already have an account on this number. Taking you to sign in\u2026");
        setTimeout(
          () => router.replace(`/login?reason=registered&phone=${encodeURIComponent(draft.phone!)}`),
          1400,
        );
        return;
      }

      setSubmitError(
        result.reason === "taken"
          ? "Someone just took that handle. Try another."
          : result.reason === "unavailable"
            ? "We couldn't reach FundX. Check your connection and try again."
            : "Something was wrong with those details.",
      );
      return;
    }

    clearDraft();
    setUser(result.user);
    router.replace("/home");
  }

  return (
    <Screen back>
      <form onSubmit={submit} className="flex flex-1 flex-col pt-4 pb-10">
        <Title sub="This is how people find you and send you money.">
          Almost done
        </Title>

        <div className="mt-8 space-y-5">
          <Field
            label="Your name"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Bola Adeyemi"
            autoComplete="name"
            autoFocus
            hint="What people will see when you pay them."
          />

          <HandleField
            label="Your handle"
            value={handle}
            onChange={handleHandle}
            suffixSlot={
              availability.state === "checking" ? (
                <Spinner className="text-faint" />
              ) : availability.state === "ok" ? (
                <Check className="text-green" />
              ) : null
            }
            error={availability.state === "no" ? availability.message : null}
            hint={
              availability.state === "ok"
                ? `${formatHandle(handle)} is yours.`
                : "This is the name people will pay."
            }
          />
        </div>

        <div className="mt-auto pt-8">
          {submitError ? (
            <p className="mb-3 text-[0.85rem] text-alert">{submitError}</p>
          ) : null}
          <Button full type="submit" disabled={!ready} loading={busy}>
            Create my account
          </Button>
        </div>
      </form>
    </Screen>
  );
}
