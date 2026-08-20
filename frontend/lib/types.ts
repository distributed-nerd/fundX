/**
 * Wire types.
 *
 * These mirror the shape the Node backend will return, so replacing the mock
 * client with real HTTP calls is a change to `lib/api` and nothing else.
 *
 * Amounts cross this boundary as decimal strings in *base units* (6-decimal),
 * because JSON has no bigint. Convert with BigInt() on arrival — never Number().
 */

export type User = {
  id: string;
  /** E.164, e.g. "+2348031234567" */
  phone: string;
  /** Without the leading "@" */
  username: string;
  displayName: string;
  /** Cyprus-1 Quai address. Surfaced only on the Receive screen. */
  address: string;
};

/** A user as seen by someone else — no address, no contact details they own. */
export type PublicUser = {
  username: string;
  displayName: string;
};

export type Balance = {
  /** Base units as a string, e.g. "40000000" = $40.00 */
  usd: string;
  /** Naira per dollar at quote time. Always displayed alongside the figure. */
  ngnRate: number;
};

export type TransferStatus = "pending" | "confirmed" | "failed";
export type TransferDirection = "in" | "out";

export type Counterparty = {
  username: string | null;
  displayName: string;
  /** Present only when the counterparty is not a FundX user. */
  external?: boolean;
};

export type Transfer = {
  id: string;
  direction: TransferDirection;
  counterparty: Counterparty;
  /** Base units as a string. Always positive; `direction` carries the sign. */
  amount: string;
  memo: string | null;
  status: TransferStatus;
  /** Quai transaction hash. Null while pending. */
  txHash: string | null;
  /** ISO 8601 */
  createdAt: string;
};

export type ResolveResult =
  | { found: true; user: PublicUser }
  /**
   * `not_found` means the handle or number parsed fine and nobody on FundX has it —
   * the one case worth naming plainly to the sender. `self` is a slip they can correct.
   * `invalid` means it was not a handle or a phone number at all.
   */
  | { found: false; reason: "not_found" | "self" | "invalid" };

export type SendResult =
  | { ok: true; transfer: Transfer }
  | {
      ok: false;
      /**
       * These are the backend's own `FailureReason` strings, not a translation of them.
       * `locked` is a real outcome once PIN attempts run out, and `chain_error` means the
       * money did not move — both were unreachable against the mock and so had no message.
       */
      reason:
        | "wrong_pin"
        | "insufficient"
        | "not_found"
        | "self"
        | "locked"
        | "chain_error"
        | "invalid";
    };


export type Bank = {
  /** Bank code as Paystack returns it, e.g. "058" for GTBank, "999992" for OPay. */
  code: string
  name: string
  /** Mobile-money operators and neobanks, surfaced first. */
  fintech?: boolean
}

/**
 * The name on a bank account, as the bank reports it.
 *
 * There is no fabricated variant. If it cannot be resolved the answer is `unavailable`, and
 * the UI must say so rather than show a name — this is the one check a human can perform
 * before sending money that cannot be reversed.
 */
export type AccountResolution =
  | { ok: true; accountName: string; cached?: boolean }
  /**
   * `not_found` means the bank looked and there is no such account — the user must fix
   * something. `quota` and `unavailable` mean *we* could not look, which says nothing about
   * the account and must not be presented as if it did.
   */
  | { ok: false; reason: "not_found" | "invalid" | "unavailable" | "quota" }

export type PayoutKind = "offramp" | "fiat_transfer"

/**
 * A naira payout — money leaving FundX for a Nigerian bank account.
 *
 * Distinct from a Transfer: a transfer moves tokens between two addresses FundX controls,
 * a payout leaves the system entirely. Hence separate history and a separate status.
 */
export type Payout = {
  id: string
  kind: PayoutKind
  /** Base units, debited from the balance. */
  amountUsd: string
  /** Whole naira, as quoted at confirmation. */
  amountNgn: string
  /** The rate the user was shown before confirming — quoted, not reconstructed. */
  rate: number
  bankName: string
  bankAccountNumber: string
  accountName: string | null
  /**
   * "simulated" until a real payout rail is connected — deliberately never "paid", so
   * nothing downstream can mistake a demo for a settled bank transfer.
   */
  status: "pending" | "simulated" | "paid" | "failed"
  createdAt: string
}

export type PayoutResult =
  | { ok: true; payout: Payout }
  | { ok: false; reason: "wrong_pin" | "insufficient" | "invalid" }
