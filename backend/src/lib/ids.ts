import { randomBytes, randomUUID } from "node:crypto"

export const newId = (prefix: string): string => `${prefix}_${randomUUID()}`

/** URL-safe opaque token. Used for sessions and signup tokens. */
export const newToken = (): string => randomBytes(32).toString("base64url")

/** A six digit OTP, uniformly distributed and leading zeros preserved. */
export function newOtp(): string {
  return String(randomBytes(4).readUInt32BE(0) % 1_000_000).padStart(6, "0")
}
