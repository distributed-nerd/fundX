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
  /** The recipient resolved to the sender. Distinct from `invalid`, which means unparseable. */
  | "self"
  | "taken"
  | "reserved"
  /**
   * The phone number already has an account.
   *
   * Distinct from `taken`, which is about a username. Conflating them told an existing user
   * that the handle they had just been offered was gone, sending them back to invent
   * another one — a loop they could never get out of, because the handle was never the
   * problem.
   */
  | "registered"
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
