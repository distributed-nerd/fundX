"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { Avatar } from "@/components/Avatar";
import { Button } from "@/components/Button";
import { CodeInput } from "@/components/CodeInput";
import { Field } from "@/components/Field";
import { Screen, Title } from "@/components/Screen";
import { CheckSeal, External, Spinner } from "@/components/icons";
import {
  formatHandle,
  getBalance,
  getRecentRecipients,
  resolveRecipient,
  sendMoney,
} from "@/lib/api";
import {
  formatNGN,
  formatRate,
  formatUSD,
  parseAmount,
  sanitizeAmountInput,
} from "@/lib/money";
import { fullTime } from "@/lib/time";
import { useSession } from "@/lib/session";
import type { PublicUser, Transfer } from "@/lib/types";

type Step = "recipient" | "amount" | "pin" | "sending" | "done";

export default function Send() {
  const router = useRouter();
  const { user, loading } = useSession();

  const [step, setStep] = useState<Step>("recipient");
  const [balance, setBalance] = useState<bigint | null>(null);
  const [recents, setRecents] = useState<PublicUser[]>([]);

  const [query, setQuery] = useState("");
  const [resolving, setResolving] = useState(false);
  const [lookupError, setLookupError] = useState<string | null>(null);
  const [recipient, setRecipient] = useState<PublicUser | null>(null);

  const [raw, setRaw] = useState("");
  const [memo, setMemo] = useState("");

  const [pin, setPin] = useState("");
  const [pinError, setPinError] = useState<string | null>(null);

  const [receipt, setReceipt] = useState<Transfer | null>(null);

  useEffect(() => {
    if (!loading && !user) router.replace("/");
  }, [loading, user, router]);

  useEffect(() => {
    if (!user) return;
    void getBalance().then((b) => setBalance(BigInt(b.usd)));
    void getRecentRecipients().then(setRecents);
  }, [user]);

  const amount = parseAmount(raw);
  const overBalance = amount !== null && balance !== null && amount > balance;
  const canContinue = amount !== null && amount > 0n && !overBalance;

  async function lookup(value: string) {
    const trimmed = value.trim();
    if (!trimmed) return;

    setResolving(true);
    setLookupError(null);
    const result = await resolveRecipient(trimmed);
    setResolving(false);

    if (!result.found) {
      setLookupError(
        result.reason === "not_found"
          ? "No one on FundX with that handle or number yet."
          : "Enter a handle like chidi.fundX, or a phone number.",
      );
      return;
    }
    setRecipient(result.user);
    setStep("amount");
  }

  async function confirm(value: string) {
    if (!recipient || amount === null) return;

    setStep("sending");
    const result = await sendMoney({
      recipient: recipient.username,
      amount,
      memo,
      pin: value,
    });

    if (!result.ok) {
      setPin("");
      setPinError(
        result.reason === "wrong_pin"
          ? "That PIN isn't right."
          : result.reason === "insufficient"
            ? "You don't have enough for that."
            : "Something went wrong. Try again.",
      );
      setStep("pin");
      return;
    }

    setReceipt(result.transfer);
    setStep("done");
  }

  /** Four digits is the whole input — no separate confirm press. */
  function handlePin(next: string) {
    setPinError(null);
    setPin(next);
    if (next.length === 4) void confirm(next);
  }

  if (!user) return <div className="min-h-dvh" />;

  // ------------------------------------------------------------------ receipt

  if (step === "done" && receipt) {
    return (
      <Screen bare>
        <div className="flex flex-1 flex-col items-center justify-center py-16 text-center">
          <CheckSeal className="text-green" />

          <p className="mt-6 text-[0.9rem] text-muted">Sent</p>
          <p className="mt-1 font-display text-[3rem] leading-none tracking-[-0.02em] figure">
            {formatUSD(BigInt(receipt.amount))}
          </p>

          <div className="mt-6 flex items-center gap-2.5">
            <Avatar name={receipt.counterparty.displayName} size={28} />
            <span className="text-[0.95rem]">
              {receipt.counterparty.displayName}
            </span>
          </div>

          <p className="mt-6 text-[0.8rem] text-faint">
            {fullTime(receipt.createdAt)}
          </p>

          {receipt.txHash ? (
            <a
              href={`https://orchard.quaiscan.io/tx/${receipt.txHash}`}
              target="_blank"
              rel="noreferrer"
              className="mt-2 inline-flex items-center gap-1.5 text-[0.8rem] text-muted underline-offset-2 transition-colors duration-150 hover:text-ink hover:underline"
            >
              View on Quaiscan
              <External className="h-3.5 w-3.5" />
            </a>
          ) : null}
        </div>

        <div className="shrink-0 pb-10">
          <Button full onClick={() => router.replace("/home")}>
            Done
          </Button>
        </div>
      </Screen>
    );
  }

  // ------------------------------------------------------------------ sending

  if (step === "sending") {
    return (
      <Screen bare>
        <div className="flex flex-1 flex-col items-center justify-center gap-4 text-muted">
          <Spinner className="text-green" />
          <p className="text-[0.95rem]">Sending&hellip;</p>
        </div>
      </Screen>
    );
  }

  // ---------------------------------------------------------------------- PIN

  if (step === "pin" && recipient && amount !== null) {
    return (
      <Screen
        back
        onBack={() => {
          setStep("amount");
          setPin("");
          setPinError(null);
        }}
      >
        <div className="flex flex-1 flex-col pt-4 pb-10">
          <Title sub="Enter your PIN to approve this payment.">Confirm</Title>

          <div className="mt-8 rounded-md border border-hairline bg-surface p-5">
            <div className="flex items-center gap-3">
              <Avatar name={recipient.displayName} size={40} />
              <div className="min-w-0 flex-1">
                <p className="truncate text-[0.95rem]">{recipient.displayName}</p>
                <p className="truncate text-[0.8rem] text-muted">
                  {formatHandle(recipient.username)}
                </p>
              </div>
              <p className="figure text-[1.05rem]">{formatUSD(amount)}</p>
            </div>

            {memo.trim() ? (
              <p className="mt-4 border-t border-hairline pt-4 text-[0.85rem] text-muted">
                {memo.trim()}
              </p>
            ) : null}
          </div>

          <div className="mt-8">
            <CodeInput
              label="Your PIN"
              length={4}
              value={pin}
              onChange={handlePin}
              secret
              autoFocus
              error={Boolean(pinError)}
            />
            {pinError ? (
              <p className="mt-3 text-[0.85rem] text-alert">{pinError}</p>
            ) : null}
          </div>
        </div>
      </Screen>
    );
  }

  // ------------------------------------------------------------------- amount

  if (step === "amount" && recipient) {
    return (
      <Screen
        back
        onBack={() => {
          setStep("recipient");
          setRecipient(null);
          setRaw("");
          setMemo("");
        }}
      >
        <div className="flex flex-1 flex-col pt-4 pb-10">
          <div className="flex items-center gap-3">
            <Avatar name={recipient.displayName} size={44} />
            <div className="min-w-0">
              <p className="truncate text-[1.05rem]">{recipient.displayName}</p>
              <p className="truncate text-[0.85rem] text-muted">
                {formatHandle(recipient.username)}
              </p>
            </div>
          </div>

          <div className="flex flex-1 flex-col justify-center text-center">
            {/* Tabular figures keep the field from jittering as digits are typed. */}
            <div className="flex items-baseline justify-center gap-0.5">
              <span
                className={`text-[2.6rem] leading-none font-light ${raw ? "text-muted" : "text-hairline"}`}
              >
                $
              </span>
              <input
                value={raw}
                onChange={(e) => setRaw(sanitizeAmountInput(e.target.value))}
                inputMode="decimal"
                autoFocus
                aria-label="Amount in dollars"
                placeholder="0"
                className="figure min-w-0 bg-transparent text-[3.25rem] leading-none font-medium tracking-[-0.02em] outline-none placeholder:text-hairline"
                style={{ width: `${Math.max(raw.length, 1)}ch` }}
              />
            </div>

            <p className="mt-4 text-[0.85rem] text-muted figure">
              {amount !== null && amount > 0n ? (
                <>
                  ≈ {formatNGN(amount)}
                  <span className="text-faint"> · at {formatRate()}</span>
                </>
              ) : (
                <span className="text-faint">Enter an amount</span>
              )}
            </p>

            <p className="mt-1.5 text-[0.8rem] figure">
              {overBalance ? (
                <span className="text-alert">
                  More than your balance of{" "}
                  {balance !== null ? formatUSD(balance) : ""}
                </span>
              ) : (
                <span className="text-faint">
                  {balance !== null ? `${formatUSD(balance)} available` : ""}
                </span>
              )}
            </p>
          </div>

          <div className="shrink-0 space-y-4 pt-10">
            <Field
              value={memo}
              onChange={(e) => setMemo(e.target.value.slice(0, 60))}
              placeholder="What's it for? (optional)"
              maxLength={60}
            />
            <Button full disabled={!canContinue} onClick={() => setStep("pin")}>
              Continue
            </Button>
          </div>
        </div>
      </Screen>
    );
  }

  // ---------------------------------------------------------------- recipient

  return (
    <Screen back onBack={() => router.replace("/home")}>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          void lookup(query);
        }}
        className="flex flex-1 flex-col pt-4 pb-10"
      >
        <Title sub="Their FundX handle, or the phone number they signed up with.">
          Who are you paying?
        </Title>

        <div className="mt-8">
          <Field
            value={query}
            onChange={(e) => {
              setQuery(e.target.value);
              setLookupError(null);
            }}
            placeholder="chidi.fundX or 0803 123 4567"
            autoFocus
            autoCapitalize="none"
            spellCheck={false}
            error={lookupError}
            suffix={resolving ? <Spinner className="text-faint" /> : null}
          />
        </div>

        {recents.length > 0 ? (
          <div className="mt-10">
            <h2 className="text-[0.85rem] font-medium text-muted">Recent</h2>
            <div className="mt-1 divide-y divide-hairline">
              {recents.map((person) => (
                <button
                  key={person.username}
                  type="button"
                  onClick={() => {
                    setQuery(formatHandle(person.username));
                    void lookup(person.username);
                  }}
                  className="-mx-2 flex w-[calc(100%+1rem)] items-center gap-3 rounded-sm px-2 py-3.5 text-left transition-colors duration-150 hover:bg-surface"
                >
                  <Avatar name={person.displayName} />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-[0.95rem]">
                      {person.displayName}
                    </span>
                    <span className="block truncate text-[0.8rem] text-muted">
                      {formatHandle(person.username)}
                    </span>
                  </span>
                </button>
              ))}
            </div>
          </div>
        ) : null}

        <div className="mt-auto pt-8">
          <Button full type="submit" disabled={!query.trim()} loading={resolving}>
            Continue
          </Button>
        </div>
      </form>
    </Screen>
  );
}
