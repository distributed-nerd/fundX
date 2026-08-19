import type { PayoutRow, TransferRow, UserRow } from "../db/schema.js"

/**
 * Wire shapes.
 *
 * These mirror `frontend/lib/types.ts` exactly. The frontend's mock API was written as the
 * specification for this backend, so any drift here breaks screens rather than surfacing as
 * a type error.
 *
 * Amounts cross as decimal strings in base units, because JSON has no bigint. The frontend
 * converts with `BigInt()` on arrival — never `Number()`.
 */

export type UserDto = {
  id: string
  phone: string
  /** Bare label. The ".fundX" suffix is added for display, never stored or sent. */
  username: string
  displayName: string
  address: string
}

export type PublicUserDto = {
  username: string
  displayName: string
}

export type CounterpartyDto = {
  username: string | null
  displayName: string
  external?: boolean
}

export type TransferDto = {
  id: string
  direction: "in" | "out"
  counterparty: CounterpartyDto
  amount: string
  memo: string | null
  status: "pending" | "confirmed" | "failed"
  txHash: string | null
  createdAt: string
}

export const toUserDto = (u: UserRow): UserDto => ({
  id: u.id,
  phone: u.phone,
  username: u.username,
  displayName: u.displayName,
  address: u.address,
})

/** What someone else is allowed to see: a name and a handle. Never an address or a phone. */
export const toPublicUserDto = (u: UserRow): PublicUserDto => ({
  username: u.username,
  displayName: u.displayName,
})

/**
 * A transfer as one participant sees it.
 *
 * Direction is per-viewer rather than stored — the same row is an "out" to the sender and an
 * "in" to the recipient, and `amount` stays positive in both.
 */
export function toTransferDto(row: TransferRow, viewerId: string, counterparty: UserRow | null): TransferDto {
  const outgoing = row.fromUserId === viewerId

  return {
    id: row.id,
    direction: outgoing ? "out" : "in",
    counterparty: counterparty
      ? { username: counterparty.username, displayName: counterparty.displayName }
      : // Money that arrived from outside FundX has no person behind it.
        { username: null, displayName: "Received from outside FundX", external: true },
    amount: row.amount.toString(),
    memo: row.memo,
    status: row.status as TransferDto["status"],
    txHash: row.txHash,
    createdAt: row.createdAt.toISOString(),
  }
}


export type PayoutDto = {
  id: string
  kind: "offramp" | "fiat_transfer"
  /** Base units as a string, debited from the balance. */
  amountUsd: string
  /** Whole naira, as quoted at confirmation. */
  amountNgn: string
  rate: number
  bankName: string
  bankAccountNumber: string
  /** "simulated" until a real payout rail is connected — never mistake it for "paid". */
  status: string
  reference: string | null
  createdAt: string
}

export const toPayoutDto = (p: PayoutRow): PayoutDto => ({
  id: p.id,
  kind: p.kind as PayoutDto["kind"],
  amountUsd: p.amountUsd.toString(),
  amountNgn: p.amountNgn.toString(),
  rate: p.rate,
  bankName: p.bankName,
  bankAccountNumber: p.bankAccountNumber,
  status: p.status,
  reference: p.reference,
  createdAt: p.createdAt.toISOString(),
})
