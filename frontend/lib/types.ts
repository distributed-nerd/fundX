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
  | { found: false; reason: "not_found" | "invalid" };

export type SendResult =
  | { ok: true; transfer: Transfer }
  | { ok: false; reason: "wrong_pin" | "insufficient" | "not_found" };
