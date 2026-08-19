/**
 * Domain failures the UI already knows how to render.
 *
 * The frontend switches on these exact strings (`app/send/page.tsx`,
 * `app/username/page.tsx`), so they are part of the API contract, not internal detail.
 */
export type FailureReason =
  | "wrong_pin"
  | "insufficient"
  | "not_found"
  | "invalid"
  | "taken"
  | "reserved"
  | "locked"
  | "unauthorized"
  | "chain_error"

export class DomainError extends Error {
  constructor(
    readonly reason: FailureReason,
    message?: string,
  ) {
    super(message ?? reason)
    this.name = "DomainError"
  }
}

export type Result<T> = { ok: true; value: T } | { ok: false; reason: FailureReason }

export const ok = <T,>(value: T): Result<T> => ({ ok: true, value })
export const fail = <T,>(reason: FailureReason): Result<T> => ({ ok: false, reason })
