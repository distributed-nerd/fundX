/**
 * Identity rules.
 *
 * These mirror `frontend/lib/api/index.ts` exactly. If the two ever disagree about what a
 * valid handle is, or about which E.164 form a typed number normalises to, the frontend will
 * happily let someone address a payment the backend then refuses — or worse, resolves to a
 * different person. Keep them in lockstep.
 */

/**
 * Handles must start with a letter. That is not cosmetic: an all-digit handle is
 * indistinguishable from a phone number, and both are valid ways to address a payment.
 * Requiring a leading letter keeps the two namespaces provably disjoint.
 */
export const USERNAME_RULE = /^[a-z][a-z0-9_]{2,15}$/

/** Handles are shown as `suleiman.fundX` and stored as the bare label. */
export const HANDLE_SUFFIX = ".fundX"

/** Names nobody gets to claim. Owned here so it can change without a frontend deploy. */
const RESERVED = new Set([
  "fundx",
  "admin",
  "support",
  "help",
  "root",
  "me",
  "you",
  "team",
  "official",
  "system",
])

export function isReserved(label: string): boolean {
  return RESERVED.has(label.toLowerCase())
}

export function formatHandle(username: string): string {
  return `${username}${HANDLE_SUFFIX}`
}

/**
 * Accept a handle the forgiving way — "suleiman.fundX", "suleiman.FUNDX", "suleiman" or
 * "@suleiman" — and return the canonical bare label, or null. Lenient on input, canonical on
 * storage and display.
 */
export function parseHandle(input: string): string | null {
  const label = input
    .trim()
    .toLowerCase()
    .replace(/^@/, "")
    .replace(/\.fundx$/, "")
  return USERNAME_RULE.test(label) ? label : null
}

/** True when the input contains only characters a phone number can contain. */
export function looksLikePhone(input: string): boolean {
  return /^[\d+\s()-]+$/.test(input.trim())
}

/**
 * Normalise to E.164. Nigerian numbers arrive in every shape people type them, and the USSD
 * gateway supplies its own — all of them must land on one canonical string, because that
 * string is the account's identity.
 */
export function normalizePhone(input: string): string | null {
  const digits = input.replace(/[^\d+]/g, "")

  if (/^\+234\d{10}$/.test(digits)) return digits
  if (/^234\d{10}$/.test(digits)) return `+${digits}`
  if (/^0\d{10}$/.test(digits)) return `+234${digits.slice(1)}`
  if (/^\d{10}$/.test(digits)) return `+234${digits}`

  // Anything else carrying a country code, loosely.
  if (/^\+\d{8,15}$/.test(digits)) return digits

  return null
}

/** "+2348031234567" -> "+234 803 123 4567" */
export function prettyPhone(e164: string): string {
  if (/^\+234\d{10}$/.test(e164)) {
    const n = e164.slice(4)
    return `+234 ${n.slice(0, 3)} ${n.slice(3, 6)} ${n.slice(6)}`
  }
  return e164
}

/**
 * Sequences and repeats are the PINs that get guessed first.
 *
 * The frontend checks this too, but that check is client-side and therefore advisory. USSD
 * never runs it at all, so this is where it actually holds.
 */
export function isWeakPin(pin: string): boolean {
  if (!/^\d{4}$/.test(pin)) return true
  if (/^(\d)\1{3}$/.test(pin)) return true
  return "0123456789".includes(pin) || "9876543210".includes(pin)
}
