"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { Avatar } from "@/components/Avatar";
import { Button } from "@/components/Button";
import { CodeInput } from "@/components/CodeInput";
import { Field } from "@/components/Field";
import { Screen, Title } from "@/components/Screen";
import { CheckSeal, ChevronRight, External, Spinner } from "@/components/icons";
import {
  formatHandle,
  getBalance,
  getBanks,
  getRecentRecipients,
  isValidAccountNumber,
  resolveAccount,
  resolveRecipient,
  sendMoney,
  sendToBank,
  watchTransfer,
} from "@/lib/api";
import {
  formatNGN,
  formatRate,
  formatUSD,
  parseAmount,
  sanitizeAmountInput,
} from "@/lib/money";
import { fullTime } from "@/lib/time";
import { useRate } from "@/lib/rate";
import { useSession } from "@/lib/session";
import type { Bank, Payout, PublicUser, Transfer } from "@/lib/types";

/**
 * Sending money, two ways.
 *
 * Crypto goes to another FundX user by handle or phone. Fiat goes to any Nigerian bank
 * account — which is the more useful of the two in practice, because every business already
 * has an account number and none of them need to sign up for anything.
 *
 * The two share a PIN step and a receipt but nothing else: they resolve different things,
 * are denominated in different currencies, and settle on different rails.
 */

type Mode = "crypto" | "fiat";
type Step =
  | "kind"
  | "recipient"
  | "amount"
  | "account"
  | "bank"
  | "confirm-account"
  | "naira"
  | "pin"
  | "sending"
  | "done";

/** Naira is entered whole — no kobo, and no decimal point to fumble on a phone. */
function sanitizeNaira(raw: string): string {
  return raw.replace(/[^\d]/g, "").slice(0, 9);
}

/** Dollar cost of a naira amount, rounded up so we never under-debit. */
function nairaToUsd(naira: bigint, rate: number): bigint {
  // Scaled to hundredths: the rate is fractional, and floating point here would put rounding
  // error into what someone is charged.
  const hundredths = BigInt(Math.round(rate * 100));
  return (naira * 100_000_000n + hundredths - 1n) / hundredths;
}

export default function Send() {
  const router = useRouter();
  const { user, loading } = useSession();
  const { rate } = useRate();

  const [step, setStep] = useState<Step>("kind");
  const [mode, setMode] = useState<Mode | null>(null);
  const [balance, setBalance] = useState<bigint | null>(null);
  const [recents, setRecents] = useState<PublicUser[]>([]);

  // crypto
  const [query, setQuery] = useState("");
  const [resolving, setResolving] = useState(false);
  const [lookupError, setLookupError] = useState<string | null>(null);
  const [recipient, setRecipient] = useState<PublicUser | null>(null);
  const [raw, setRaw] = useState("");
  const [memo, setMemo] = useState("");

  // fiat
  const [banks, setBanks] = useState<Bank[]>([]);
  const [account, setAccount] = useState("");
  const [accountError, setAccountError] = useState<string | null>(null);
  const [bank, setBank] = useState<Bank | null>(null);
  const [bankQuery, setBankQuery] = useState("");
  const [accountName, setAccountName] = useState<string | null>(null);
  /** Set when the name could not be checked — the account may still be perfectly valid. */
  const [nameUnchecked, setNameUnchecked] = useState<string | null>(null);
  const [resolvingAccount, setResolvingAccount] = useState(false);
  const [naira, setNaira] = useState("");

  const [pin, setPin] = useState("");
  const [pinError, setPinError] = useState<string | null>(null);

  const [receipt, setReceipt] = useState<Transfer | null>(null);
  /** Survives re-renders so a retry reuses the same key; see `confirm`. */
  const sendKey = useRef<string | null>(null);
  const [payoutReceipt, setPayoutReceipt] = useState<Payout | null>(null);

  useEffect(() => {
    if (!loading && !user) router.replace("/");
  }, [loading, user, router]);

  useEffect(() => {
    if (!user) return;
    void getBalance().then((b) => setBalance(BigInt(b.usd)));
    void getRecentRecipients().then(setRecents);
    void getBanks().then(setBanks);
  }, [user]);

  /**
   * A confirmed send is the common case on a fast chain and the rare one here: Orchard's
   * block interval measured ~27s, so the backend's confirm budget expires first and the
   * receipt arrives `pending`. Rather than hold the user on a spinner for half a minute,
   * the receipt shows immediately and settles itself underneath them.
   */
  useEffect(() => {
    if (!receipt || receipt.status !== "pending") return;

    let live = true;
    void watchTransfer(receipt.id, (latest) => {
      if (live) setReceipt(latest);
    });
    return () => {
      live = false;
    };
    // Keyed on the id, not the object — re-polling on every status change would stack timers.
  }, [receipt?.id, receipt?.status]);

  const amount = parseAmount(raw);
  const overBalance = amount !== null && balance !== null && amount > balance;
  const canContinue = amount !== null && amount > 0n && !overBalance;

  const nairaAmount = naira ? BigInt(naira) : 0n;
  const nairaCost = nairaAmount > 0n ? nairaToUsd(nairaAmount, rate) : 0n;
  const nairaOverBalance = balance !== null && nairaCost > balance;
  const canContinueNaira = nairaAmount > 0n && !nairaOverBalance;

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
          ? `No one on FundX is using ${trimmed} yet.`
          : result.reason === "self"
            ? "That's you."
            : "Enter a handle like chidi.fundX, or a phone number.",
      );
      return;
    }
    setRecipient(result.user);
    setStep("amount");
  }

  async function confirm(value: string) {
    setStep("sending");

    if (mode === "fiat") {
      if (!bank) return;
      const result = await sendToBank({
        bankCode: bank.code,
        accountNumber: account,
        amountNgn: nairaAmount,
        accountName: accountName ?? undefined,
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

      setPayoutReceipt(result.payout);
      setStep("done");
      return;
    }

    if (!recipient || amount === null) return;

    /**
     * One key for this send, reused across retries.
     *
     * If the network drops after the request left, we do not know whether it landed. Retrying
     * with the same key lets the server answer from its own record instead of moving the
     * money twice. A wrong PIN never reaches the ledger, so retrying under the same key is
     * safe; a chain failure releases the key server-side so the retry is a fresh attempt.
     */
    sendKey.current ??= crypto.randomUUID();

    const result = await sendMoney({
      recipient: recipient.username,
      amount,
      memo,
      pin: value,
      idempotencyKey: sendKey.current,
    });

    if (!result.ok) {
      setPin("");
      setPinError(
        result.reason === "wrong_pin"
          ? "That PIN isn't right."
          : result.reason === "insufficient"
            ? "You don't have enough for that."
            : result.reason === "locked"
              ? "Too many wrong PINs. Try again later."
              : result.reason === "not_found"
                ? `${formatHandle(recipient.username)} is no longer on FundX.`
                : // Covers chain_error and anything unrecognised. Deliberately does not claim
                  // the money stayed put, because after a network failure we do not know.
                  "We couldn't complete that. Check your balance before trying again.",
      );
      setStep("pin");
      return;
    }

    sendKey.current = null;
    setReceipt(result.transfer);
    setStep("done");
  }

  /**
   * Choosing a bank triggers the name lookup.
   *
   * Ten digits cannot be eyeballed and a wrong transfer is irreversible, so the name is
   * confirmed on its own screen before any amount is named — the same check every Nigerian
   * bank app performs, and the only one a human can actually make.
   */
  async function pickBank(b: Bank) {
    setBank(b);
    setAccountName(null);
    setNameUnchecked(null);
    setStep("confirm-account");
    setResolvingAccount(true);

    const result = await resolveAccount(account, b.code);
    setResolvingAccount(false);

    if (result.ok) {
      setAccountName(result.accountName);
      return;
    }

    /**
     * Two very different failures.
     *
     * `not_found` and `invalid` mean the bank looked and the details are wrong — send the
     * user back to fix them. `quota` and `unavailable` mean *we* could not look, which says
     * nothing at all about the account. Bouncing someone back to re-check digits that were
     * correct is worse than useless, so the flow continues with the name plainly marked as
     * unchecked. That is honest; inventing a name would not be.
     */
    if (result.reason === "not_found" || result.reason === "invalid") {
      setAccountError(
        result.reason === "not_found"
          ? "No account found with those details. Check the number and bank."
          : "Check the account number and bank.",
      );
      setStep("account");
      return;
    }

    setNameUnchecked(
      result.reason === "quota"
        ? "Name checks have hit today's limit on this Paystack test key (3 a day). The account may be perfectly fine — we just couldn't look."
        : "We couldn't reach the bank to check the name right now.",
    );
  }

  /** Four digits is the whole input — no separate confirm press. */
  function handlePin(next: string) {
    setPinError(null);
    setPin(next);
    if (next.length === 4) void confirm(next);
  }

  if (!user) return <div className="min-h-dvh" />;

  // ------------------------------------------------------------------ receipt

  if (step === "done" && (receipt || payoutReceipt)) {
    const isBank = Boolean(payoutReceipt);
    const settling = receipt?.status === "pending";
    const failed = receipt?.status === "failed";

    return (
      <Screen bare>
        <div className="flex flex-1 flex-col items-center justify-center py-16 text-center">
          {/*
            The seal is a claim that the money arrived, so it waits for confirmation rather
            than leading with it. A pending transfer gets the spinner it has earned.
          */}
          {settling ? (
            <Spinner className="text-muted" />
          ) : (
            <CheckSeal className={failed ? "text-alert" : "text-green"} />
          )}

          <p className="mt-6 text-[0.9rem] text-muted">
            {failed ? "Didn't go through" : settling ? "Sending" : "Sent"}
          </p>
          <p className="mt-1 font-display text-[3rem] leading-none tracking-[-0.02em] figure">
            {payoutReceipt
              ? `₦${Number(payoutReceipt.amountNgn).toLocaleString("en-NG")}`
              : formatUSD(BigInt(receipt!.amount))}
          </p>

          {payoutReceipt ? (
            <>
              <p className="mt-2 text-[0.85rem] text-muted figure">
                {formatUSD(BigInt(payoutReceipt.amountUsd))} at{" "}
                {formatRate(payoutReceipt.rate)}
              </p>
              <div className="mt-6">
                <p className="text-[0.95rem]">
                  {payoutReceipt.accountName ?? payoutReceipt.bankName}
                </p>
                <p className="mt-0.5 text-[0.85rem] text-muted figure">
                  {payoutReceipt.bankName} &middot; {payoutReceipt.bankAccountNumber}
                </p>
              </div>
            </>
          ) : (
            <div className="mt-6 flex items-center gap-2.5">
              <Avatar name={receipt!.counterparty.displayName} size={28} />
              <span className="text-[0.95rem]">
                {receipt!.counterparty.displayName}
              </span>
            </div>
          )}

          <p className="mt-6 text-[0.8rem] text-faint">
            {fullTime((payoutReceipt ?? receipt)!.createdAt)}
          </p>

          {receipt?.txHash ? (
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

          {/*
            Confirmation on Orchard was measured at ~36s, so this line is the normal path,
            not an edge case. It says what is true right now and disappears by itself when
            the poller sees the transfer confirm.
          */}
          {settling ? (
            <p className="mt-6 max-w-[17rem] text-[0.75rem] leading-relaxed text-faint">
              Waiting for the network to confirm. You can close this &mdash; it will finish
              on its own.
            </p>
          ) : null}

          {/*
            Honesty about the bank leg. No payout rail is connected, so the naira never
            actually moves — saying so is better than a receipt that implies it did. This
            line disappears on its own once status stops being "simulated".
          */}
          {isBank && payoutReceipt?.status === "simulated" ? (
            <p className="mt-6 max-w-[17rem] text-[0.75rem] leading-relaxed text-faint">
              Demo: the dollars left your balance, but no bank transfer was made.
            </p>
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

  if (step === "pin") {
    const goBack = () => {
      setStep(mode === "fiat" ? "naira" : "amount");
      setPin("");
      setPinError(null);
    };

    return (
      <Screen back onBack={goBack}>
        <div className="flex flex-1 flex-col pt-4 pb-10">
          <Title sub="Enter your PIN to approve this payment.">Confirm</Title>

          <div className="mt-8 rounded-md border border-hairline bg-surface p-5">
            {mode === "fiat" && bank ? (
              <>
                <div className="flex items-baseline justify-between gap-3">
                  <p className="min-w-0 flex-1 truncate text-[0.95rem]">
                    {accountName ?? bank.name}
                  </p>
                  <p className="shrink-0 figure text-[1.05rem]">
                    ₦{Number(nairaAmount).toLocaleString("en-NG")}
                  </p>
                </div>
                <p className="mt-0.5 text-[0.8rem] text-muted figure">
                  {bank.name} &middot; {account}
                </p>
                <p className="mt-4 border-t border-hairline pt-4 text-[0.85rem] text-muted figure">
                  Costs {formatUSD(nairaCost)} · at {formatRate(rate)}
                </p>
              </>
            ) : recipient && amount !== null ? (
              <>
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
              </>
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

  // ------------------------------------------------------------- naira amount

  if (step === "naira" && bank) {
    return (
      <Screen back onBack={() => setStep("confirm-account")}>
        <div className="flex flex-1 flex-col pt-4 pb-10">
          <div>
            <p className="text-[1.05rem]">{accountName ?? bank.name}</p>
            <p className="mt-0.5 text-[0.85rem] text-muted figure">
              {bank.name} &middot; {account}
            </p>
          </div>

          <div className="flex flex-1 flex-col justify-center text-center">
            <div className="flex items-baseline justify-center gap-0.5">
              <span
                className={`text-[2.6rem] leading-none font-light ${naira ? "text-muted" : "text-hairline"}`}
              >
                ₦
              </span>
              <input
                value={naira ? Number(naira).toLocaleString("en-NG") : ""}
                onChange={(e) => setNaira(sanitizeNaira(e.target.value))}
                inputMode="numeric"
                autoFocus
                aria-label="Amount in naira"
                placeholder="0"
                size={1}
                className="figure min-w-0 bg-transparent text-[3.25rem] leading-none font-medium tracking-[-0.02em] outline-none placeholder:text-hairline"
                style={{
                  width: `${Math.max(naira ? Number(naira).toLocaleString("en-NG").length : 1, 1)}ch`,
                }}
              />
            </div>

            {/*
              The rate is always visible before confirmation. Nigerians are acutely
              rate-aware and have been burned by hidden spreads; showing it is a
              competitive advantage, not a concession.
            */}
            <p className="mt-4 text-[0.85rem] text-muted figure">
              {nairaAmount > 0n ? (
                <>
                  Costs {formatUSD(nairaCost)}
                  <span className="text-faint"> · at {formatRate(rate)}</span>
                </>
              ) : (
                <span className="text-faint">The recipient receives naira</span>
              )}
            </p>

            <p className="mt-1.5 text-[0.8rem] figure">
              {nairaOverBalance ? (
                <span className="text-alert">
                  More than your balance of {balance !== null ? formatUSD(balance) : ""}
                </span>
              ) : (
                <span className="text-faint">
                  {balance !== null ? `${formatUSD(balance)} available` : ""}
                </span>
              )}
            </p>
          </div>

          <div className="shrink-0 pt-10">
            <Button full disabled={!canContinueNaira} onClick={() => setStep("pin")}>
              Continue
            </Button>
          </div>
        </div>
      </Screen>
    );
  }

  // -------------------------------------------------------------- choose bank

  if (step === "confirm-account") {
    return (
      <Screen back onBack={() => setStep("bank")}>
        <div className="flex flex-1 flex-col pt-4 pb-10">
          <Title
            sub={
              nameUnchecked
                ? "We couldn't confirm who owns this account. Only continue if you're sure."
                : "Check the name before you send. Bank transfers can't be reversed."
            }
          >
            {nameUnchecked ? "Double-check this" : "Is this right?"}
          </Title>

          <div className="mt-8 rounded-md border border-hairline bg-surface p-5">
            {resolvingAccount ? (
              <div className="flex items-center gap-3 py-2 text-muted">
                <Spinner className="text-faint" />
                <span className="text-[0.9rem]">Checking the account&hellip;</span>
              </div>
            ) : nameUnchecked ? (
              <>
                <p className="text-[1.05rem] text-muted">Name not checked</p>
                <p className="mt-2 text-[0.85rem] text-muted figure">
                  {bank?.name} &middot; {account}
                </p>
                <p className="mt-4 border-t border-hairline pt-4 text-[0.8rem] leading-relaxed text-alert">
                  {nameUnchecked}
                </p>
              </>
            ) : accountName ? (
              <>
                <p className="font-display text-[1.6rem] leading-tight tracking-[-0.01em]">
                  {accountName}
                </p>
                <p className="mt-2 text-[0.85rem] text-muted figure">
                  {bank?.name} &middot; {account}
                </p>
                {/* Every name shown here came from the bank. There is no stand-in. */}
                <p className="mt-4 border-t border-hairline pt-4 text-[0.75rem] leading-relaxed text-faint">
                  Confirmed with the bank.
                </p>
              </>
            ) : null}
          </div>

          <div className="mt-auto space-y-3 pt-8">
            <Button
              full
              disabled={resolvingAccount || (!accountName && !nameUnchecked)}
              onClick={() => setStep("naira")}
            >
              {nameUnchecked ? "Send anyway" : "Yes, continue"}
            </Button>
            <Button full variant="ghost" onClick={() => setStep("account")}>
              No, change the details
            </Button>
          </div>
        </div>
      </Screen>
    );
  }

  if (step === "bank") {
    const q = bankQuery.trim().toLowerCase();
    const matches = q ? banks.filter((b) => b.name.toLowerCase().includes(q)) : banks;

    return (
      <Screen back onBack={() => setStep("account")}>
        <div className="flex-1 pt-4 pb-10">
          <Title sub={`Where account ${account} is held.`}>Which bank?</Title>

          <div className="mt-6">
            <Field
              value={bankQuery}
              onChange={(e) => setBankQuery(e.target.value)}
              placeholder="Search — OPay, GTBank, Moniepoint…"
              autoFocus
              autoCapitalize="none"
              spellCheck={false}
            />
          </div>

          {matches.length === 0 ? (
            <p className="mt-8 text-[0.95rem] text-muted">
              No bank matches &ldquo;{bankQuery.trim()}&rdquo;.
            </p>
          ) : null}

          <div className="mt-2 divide-y divide-hairline">
            {matches.map((b) => (
              <button
                key={b.code}
                type="button"
                onClick={() => void pickBank(b)}
                className="-mx-2 flex w-[calc(100%+1rem)] items-center gap-3 rounded-sm px-2 py-4 text-left transition-colors duration-150 hover:bg-surface"
              >
                <span className="flex-1 text-[0.95rem]">{b.name}</span>
                {b.fintech ? (
                  <span className="shrink-0 rounded-full bg-green-sk px-2 py-0.5 text-[0.7rem] text-green">
                    app
                  </span>
                ) : null}
                <ChevronRight className="shrink-0 text-faint" />
              </button>
            ))}
          </div>
        </div>
      </Screen>
    );
  }

  // ---------------------------------------------------------- account number

  if (step === "account") {
    const valid = isValidAccountNumber(account);

    return (
      <Screen
        back
        onBack={() => {
          setStep("kind");
          setMode(null);
          setAccount("");
          setAccountError(null);
        }}
      >
        <form
          onSubmit={(e) => {
            e.preventDefault();
            if (valid) setStep("bank");
            else setAccountError("A Nigerian account number is 10 digits.");
          }}
          className="flex flex-1 flex-col pt-4 pb-10"
        >
          <Title sub="Any Nigerian bank. They receive naira — they don't need FundX.">
            Which account?
          </Title>

          <div className="mt-8">
            <Field
              label="Account number"
              value={account}
              onChange={(e) => {
                setAccount(e.target.value.replace(/[^\d]/g, "").slice(0, 10));
                setAccountError(null);
              }}
              placeholder="0123456789"
              inputMode="numeric"
              autoFocus
              error={accountError}
              hint="10 digits"
              className="figure"
            />
          </div>

          <div className="mt-auto pt-8">
            <Button full type="submit" disabled={!valid}>
              Continue
            </Button>
          </div>
        </form>
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
                size={1}
                className="figure min-w-0 bg-transparent text-[3.25rem] leading-none font-medium tracking-[-0.02em] outline-none placeholder:text-hairline"
                style={{ width: `${Math.max(raw.length, 1)}ch` }}
              />
            </div>

            <p className="mt-4 text-[0.85rem] text-muted figure">
              {amount !== null && amount > 0n ? (
                <>
                  ≈ {formatNGN(amount, rate)}
                  <span className="text-faint"> · at {formatRate(rate)}</span>
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

  if (step === "recipient") {
    return (
      <Screen
        back
        onBack={() => {
          setStep("kind");
          setMode(null);
          setQuery("");
          setLookupError(null);
        }}
      >
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

  // ------------------------------------------------------------ choose a kind

  return (
    <Screen back onBack={() => router.replace("/home")}>
      <div className="flex-1 pt-4 pb-10">
        <Title sub="Money to a person, or naira to a bank account.">Send money</Title>

        <div className="mt-8 space-y-3">
          <KindCard
            title="To a FundX user"
            detail="By handle or phone number. Arrives in seconds."
            onClick={() => {
              setMode("crypto");
              setStep("recipient");
            }}
          />
          <KindCard
            title="To a bank account"
            detail="Naira, to any Nigerian bank. They don't need FundX."
            onClick={() => {
              setMode("fiat");
              setStep("account");
            }}
          />
        </div>

        {balance !== null ? (
          <p className="mt-8 text-[0.85rem] text-muted figure">
            {formatUSD(balance)} available
            <span className="text-faint"> · ≈ {formatNGN(balance, rate)}</span>
          </p>
        ) : null}
      </div>
    </Screen>
  );
}

function KindCard({
  title,
  detail,
  onClick,
}: {
  title: string;
  detail: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="flex w-full items-center gap-4 rounded-md border border-hairline bg-surface p-5 text-left transition-colors duration-150 hover:border-line"
    >
      <span className="min-w-0 flex-1">
        <span className="block text-[1rem]">{title}</span>
        <span className="mt-1 block text-[0.85rem] leading-relaxed text-muted">
          {detail}
        </span>
      </span>
      <ChevronRight className="shrink-0 text-faint" />
    </button>
  );
}
