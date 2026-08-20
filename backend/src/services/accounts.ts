import { hashSecret } from "../lib/secrets.js"
import { eq } from "drizzle-orm"
import { db } from "../db/index.js"
import { users, type UserRow } from "../db/schema.js"
import { newId } from "../lib/ids.js"
import {
  USERNAME_RULE,
  isReserved,
  isWeakPin,
  looksLikePhone,
  normalizePhone,
  parseHandle,
} from "../lib/identity.js"
import { fail, ok, type Result } from "../lib/errors.js"
import { claimAddress } from "./pool.js"

/** Accounts: who exists, who a recipient is, and what handles are free. */

export async function findByPhone(phone: string): Promise<UserRow | null> {
  const [row] = await db.select().from(users).where(eq(users.phone, phone))
  return row ?? null
}

export async function findByUsername(username: string): Promise<UserRow | null> {
  const [row] = await db.select().from(users).where(eq(users.username, username))
  return row ?? null
}

export async function findById(id: string): Promise<UserRow | null> {
  const [row] = await db.select().from(users).where(eq(users.id, id))
  return row ?? null
}

export type Availability = {
  available: boolean
  reason?: "taken" | "reserved" | "invalid"
}

/**
 * Is a handle free?
 *
 * Precedence is load-bearing — the frontend renders a different message for each reason,
 * and "invalid" must win over "taken" so a malformed handle is never reported as someone
 * else's.
 */
export async function checkUsername(input: string): Promise<Availability> {
  const label = input.trim().toLowerCase()

  if (!USERNAME_RULE.test(label)) return { available: false, reason: "invalid" }
  if (isReserved(label)) return { available: false, reason: "reserved" }
  if (await findByUsername(label)) return { available: false, reason: "taken" }

  return { available: true }
}

/**
 * Build a handle from someone's name.
 *
 * Mirrors the reference implementation's `generateSafiriUsername`: strip the name down to
 * letters and numbers, and if it is already taken, append a short random suffix. Generating
 * rather than asking is what keeps USSD registration to two questions instead of three —
 * every extra screen costs the user money and loses some of them.
 */
export async function generateHandle(displayName: string): Promise<string> {
  const base = displayName
    .toLowerCase()
    .replace(/[^a-z0-9]/g, "")
    .replace(/^[0-9]+/, "") // handles must start with a letter
    .slice(0, 12)

  const seed = base.length >= 3 ? base : `user${base}`.slice(0, 12)

  if (USERNAME_RULE.test(seed) && !isReserved(seed) && !(await findByUsername(seed))) {
    return seed
  }

  for (let attempt = 0; attempt < 20; attempt++) {
    const suffix = Math.random().toString(36).slice(2, 6)
    const candidate = `${seed.slice(0, 11)}${suffix}`
    if (USERNAME_RULE.test(candidate) && !(await findByUsername(candidate))) return candidate
  }

  throw new Error("could not generate a free handle")
}

export type NewAccount = {
  phone: string
  username: string
  displayName: string
  pin: string
}

/**
 * Create an account.
 *
 * The caller must already have proven the phone number — a verified OTP on web, the telco's
 * MSISDN on USSD. This function does not re-check that.
 */
export async function createAccount(input: NewAccount): Promise<Result<UserRow>> {
  const phone = normalizePhone(input.phone)
  if (!phone) return fail("invalid")

  const username = input.username.trim().toLowerCase()

  // Checked before the username is judged, so an existing user is told the real reason
  // rather than being sent back to pick a different handle.
  if (await findByPhone(phone)) return fail("registered")

  const availability = await checkUsername(username)
  if (!availability.available) return fail(availability.reason ?? "invalid")

  // Enforced here because the frontend's check is client-side and USSD has no client at all.
  if (isWeakPin(input.pin)) return fail("invalid")

  const { index, address } = await claimAddress()

  // argon2id: memory-hard, so a leaked hash resists the offline attack a 4-digit PIN would
  // otherwise fall to instantly.
  const pinHash = await hashSecret(input.pin)

  const [row] = await db
    .insert(users)
    .values({
      id: newId("u"),
      phone,
      username,
      displayName: input.displayName.trim() || username,
      derivationIndex: index,
      address,
      pinHash,
    })
    .returning()

  if (!row) return fail("invalid")
  return ok(row)
}

export type Resolved = { user: UserRow }

/**
 * Turn what someone typed into who they meant.
 *
 * Phone is tested first. A digits-only string can never be a handle — handles must start
 * with a letter — so checking the handle pattern first would swallow phone numbers whole.
 * That is a real bug the frontend shipped with until it was measured.
 */
export async function resolveRecipient(
  query: string,
  selfId?: string,
): Promise<Result<Resolved>> {
  const trimmed = query.trim()
  if (!trimmed) return fail("invalid")

  let found: UserRow | null = null

  if (looksLikePhone(trimmed)) {
    const phone = normalizePhone(trimmed)
    if (!phone) return fail("invalid")
    found = await findByPhone(phone)
  } else {
    const label = parseHandle(trimmed)
    if (!label) return fail("invalid")
    found = await findByUsername(label)
  }

  if (!found) return fail("not_found")
  if (!found.active) return fail("not_found")
  if (selfId && found.id === selfId) return fail("self")

  return ok({ user: found })
}
