import { createHash } from "node:crypto"
import argon2 from "argon2"
import { and, eq, gt, isNull, sql } from "drizzle-orm"
import { config } from "../config.js"
import { db } from "../db/index.js"
import { otpCodes, signupTokens, users, webSessions, type UserRow } from "../db/schema.js"
import { newId, newOtp, newToken } from "../lib/ids.js"
import { isWeakPin } from "../lib/identity.js"
import { fail, ok, type Result } from "../lib/errors.js"
import { findById } from "./accounts.js"

/**
 * Authentication.
 *
 * Two doors with different trust. On USSD the MSISDN comes from the telco and the caller
 * cannot type it. On web a phone number is an unverified string until an OTP proves it, and
 * proof is recorded server-side — the frontend keeps `verified: true` in sessionStorage,
 * where the user controls it, so the server cannot take that as evidence of anything.
 */

const minutes = (n: number) => new Date(Date.now() + n * 60_000)

/** Tokens are stored hashed, so a database dump cannot be replayed as a live session. */
const hashToken = (token: string): string =>
  createHash("sha256").update(`${token}${config.SESSION_SECRET}`).digest("hex")

// ------------------------------------------------------------------------------- OTP

export async function requestOtp(phone: string): Promise<{ code: string }> {
  const code = newOtp()

  await db.insert(otpCodes).values({
    id: newId("otp"),
    phone,
    // Hashed: an OTP is a credential, and this table is as sensitive as a password store.
    codeHash: await argon2.hash(code, { type: argon2.argon2id }),
    expiresAt: minutes(config.OTP_TTL_MINUTES),
  })

  return { code }
}

/**
 * Check a code and, on success, mint a signup token.
 *
 * The token is the server's own record that this phone number was proven, and signup
 * requires one. Without it, anyone could POST a signup for a number they don't hold.
 */
export async function verifyOtp(
  phone: string,
  code: string,
): Promise<Result<{ signupToken: string }>> {
  const [row] = await db
    .select()
    .from(otpCodes)
    .where(
      and(eq(otpCodes.phone, phone), isNull(otpCodes.consumedAt), gt(otpCodes.expiresAt, new Date())),
    )
    .orderBy(sql`${otpCodes.createdAt} desc`)
    .limit(1)

  if (!row) return fail("invalid")
  if (row.attempts >= 5) return fail("locked")

  const matches = await argon2.verify(row.codeHash, code)
  if (!matches) {
    await db
      .update(otpCodes)
      .set({ attempts: row.attempts + 1 })
      .where(eq(otpCodes.id, row.id))
    return fail("invalid")
  }

  await db.update(otpCodes).set({ consumedAt: new Date() }).where(eq(otpCodes.id, row.id))

  const token = newToken()
  await db.insert(signupTokens).values({
    tokenHash: hashToken(token),
    phone,
    expiresAt: minutes(30),
  })

  return ok({ signupToken: token })
}

/** Exchange a signup token for the phone number it proved. Single use. */
export async function consumeSignupToken(token: string): Promise<string | null> {
  const [row] = await db
    .update(signupTokens)
    .set({ consumedAt: new Date() })
    .where(
      and(
        eq(signupTokens.tokenHash, hashToken(token)),
        isNull(signupTokens.consumedAt),
        gt(signupTokens.expiresAt, new Date()),
      ),
    )
    .returning({ phone: signupTokens.phone })

  return row?.phone ?? null
}

// ------------------------------------------------------------------------------- PIN

export type PinCheck = { ok: true } | { ok: false; reason: "wrong_pin" | "locked" }

/**
 * Verify a PIN, counting failures.
 *
 * A 4-digit PIN is 10,000 possibilities. Without a counter and a lockout, an endpoint that
 * accepts one is a wallet-drain path — which is exactly what the reference implementation
 * shipped, with the PIN stored as a plaintext INTEGER and compared with `!=`.
 */
export async function verifyPin(user: UserRow, pin: string): Promise<PinCheck> {
  if (user.lockedUntil && user.lockedUntil > new Date()) {
    return { ok: false, reason: "locked" }
  }

  const matches = await argon2.verify(user.pinHash, pin)

  if (!matches) {
    const attempts = user.pinAttempts + 1
    const locked = attempts >= config.PIN_MAX_ATTEMPTS

    await db
      .update(users)
      .set({
        pinAttempts: locked ? 0 : attempts,
        lockedUntil: locked ? minutes(config.PIN_LOCKOUT_MINUTES) : user.lockedUntil,
      })
      .where(eq(users.id, user.id))

    return { ok: false, reason: locked ? "locked" : "wrong_pin" }
  }

  if (user.pinAttempts !== 0 || user.lockedUntil) {
    await db
      .update(users)
      .set({ pinAttempts: 0, lockedUntil: null })
      .where(eq(users.id, user.id))
  }

  return { ok: true }
}

/** Remaining attempts before lockout, for a USSD prompt that can actually warn someone. */
export function attemptsLeft(user: UserRow): number {
  return Math.max(0, config.PIN_MAX_ATTEMPTS - user.pinAttempts)
}

// --------------------------------------------------------------------------- sessions

export async function createSession(userId: string): Promise<string> {
  const token = newToken()
  await db.insert(webSessions).values({
    tokenHash: hashToken(token),
    userId,
    expiresAt: minutes(config.SESSION_TTL_DAYS * 24 * 60),
  })
  return token
}

export async function sessionUser(token: string | undefined): Promise<UserRow | null> {
  if (!token) return null

  const [row] = await db
    .select({ userId: webSessions.userId })
    .from(webSessions)
    .where(and(eq(webSessions.tokenHash, hashToken(token)), gt(webSessions.expiresAt, new Date())))

  return row ? findById(row.userId) : null
}

export async function destroySession(token: string | undefined): Promise<void> {
  if (!token) return
  await db.delete(webSessions).where(eq(webSessions.tokenHash, hashToken(token)))
}


/**
 * Change a PIN.
 *
 * The current PIN is verified through the same counted path as any other use, so a wrong
 * guess here costs an attempt exactly as it would at a payment prompt — otherwise this
 * endpoint would be a free oracle for guessing it.
 */
export async function changePin(
  user: UserRow,
  currentPin: string,
  newPin: string,
): Promise<Result<true>> {
  const check = await verifyPin(user, currentPin)
  if (!check.ok) return fail(check.reason)

  if (isWeakPin(newPin)) return fail("invalid")
  if (newPin === currentPin) return fail("invalid")

  await db
    .update(users)
    .set({
      pinHash: await argon2.hash(newPin, { type: argon2.argon2id }),
      pinAttempts: 0,
      lockedUntil: null,
    })
    .where(eq(users.id, user.id))

  return ok(true)
}
