import { Router, type Request, type Response } from "express"
import { z } from "zod"
import { config, isProduction } from "../../config.js"
import { db } from "../../db/index.js"
import { users, type UserRow } from "../../db/schema.js"
import { eq, inArray } from "drizzle-orm"
import { NGN_RATE, parseBaseUnits } from "../../lib/money.js"
import { normalizePhone } from "../../lib/identity.js"
import * as accounts from "../../services/accounts.js"
import * as auth from "../../services/auth.js"
import * as payoutsService from "../../services/payouts.js"
import * as transfersService from "../../services/transfers.js"
import { sendSms } from "../../sms/index.js"
import { toPayoutDto, toPublicUserDto, toTransferDto, toUserDto } from "../dto.js"

/**
 * The JSON API the Next.js app calls.
 *
 * One-to-one with the 13 functions in `frontend/lib/api/index.ts`, including the exact
 * failure `reason` strings the UI switches on. This layer parses and formats; every rule
 * lives in `services/`, so the USSD adapter enforces the same ones.
 */

const SESSION_COOKIE = "fundx_session"

const cookieOptions = {
  httpOnly: true,
  sameSite: "lax" as const,
  secure: isProduction,
  path: "/",
  maxAge: config.SESSION_TTL_DAYS * 24 * 60 * 60 * 1000,
}

export const api = Router()

/** Attaches the signed-in user, or 401s. */
async function requireUser(req: Request, res: Response): Promise<UserRow | null> {
  const user = await auth.sessionUser(req.cookies?.[SESSION_COOKIE])
  if (!user) {
    res.status(401).json({ error: "unauthorized" })
    return null
  }
  return user
}

// ------------------------------------------------------------------------ onboarding

api.post("/auth/otp/request", async (req, res) => {
  const body = z.object({ phone: z.string() }).safeParse(req.body)
  if (!body.success) return res.status(400).json({ error: "invalid" })

  const phone = normalizePhone(body.data.phone)
  if (!phone) return res.status(400).json({ error: "invalid" })

  const { code } = await auth.requestOtp(phone)
  await sendSms(phone, `Your FundX code is ${code}. It expires in ${config.OTP_TTL_MINUTES} minutes.`)

  // In development the SMS provider is a no-op that logs, so the code is returned to make
  // the flow testable. Never in production — that would hand the OTP to anyone who asks.
  return res.json(isProduction ? { sent: true } : { sent: true, devCode: code })
})

api.post("/auth/otp/verify", async (req, res) => {
  const body = z.object({ phone: z.string(), code: z.string() }).safeParse(req.body)
  if (!body.success) return res.status(400).json({ ok: false })

  const phone = normalizePhone(body.data.phone)
  if (!phone) return res.json({ ok: false })

  const result = await auth.verifyOtp(phone, body.data.code)
  if (!result.ok) return res.json({ ok: false, reason: result.reason })

  return res.json({ ok: true, signupToken: result.value.signupToken })
})

api.get("/auth/username/check", async (req, res) => {
  const username = String(req.query.username ?? "")
  return res.json(await accounts.checkUsername(username))
})

api.post("/auth/signup", async (req, res) => {
  const body = z
    .object({
      signupToken: z.string(),
      username: z.string(),
      displayName: z.string().min(2).max(60),
      pin: z.string(),
    })
    .safeParse(req.body)

  if (!body.success) return res.status(400).json({ error: "invalid" })

  // The phone comes from the token, not from the request — a client cannot claim a number
  // it hasn't proven.
  const phone = await auth.consumeSignupToken(body.data.signupToken)
  if (!phone) return res.status(401).json({ error: "unauthorized" })

  const created = await accounts.createAccount({
    phone,
    username: body.data.username,
    displayName: body.data.displayName,
    pin: body.data.pin,
  })

  if (!created.ok) return res.status(400).json({ error: created.reason })

  const token = await auth.createSession(created.value.id)
  res.cookie(SESSION_COOKIE, token, cookieOptions)

  return res.status(201).json({ user: toUserDto(created.value) })
})

api.post("/auth/login", async (req, res) => {
  const body = z.object({ phone: z.string(), pin: z.string() }).safeParse(req.body)
  if (!body.success) return res.status(400).json({ error: "invalid" })

  const phone = normalizePhone(body.data.phone)
  if (!phone) return res.status(400).json({ error: "invalid" })

  const user = await accounts.findByPhone(phone)
  // Same response whether the number is unknown or the PIN is wrong, so the endpoint can't
  // be used to enumerate who has an account.
  if (!user) return res.status(401).json({ error: "wrong_pin" })

  const check = await auth.verifyPin(user, body.data.pin)
  if (!check.ok) return res.status(401).json({ error: check.reason })

  const token = await auth.createSession(user.id)
  res.cookie(SESSION_COOKIE, token, cookieOptions)

  return res.json({ user: toUserDto(user) })
})

api.post("/auth/signout", async (req, res) => {
  await auth.destroySession(req.cookies?.[SESSION_COOKIE])
  res.clearCookie(SESSION_COOKIE, { ...cookieOptions, maxAge: undefined })
  return res.status(204).end()
})

// --------------------------------------------------------------------------- account

api.get("/me", async (req, res) => {
  const user = await auth.sessionUser(req.cookies?.[SESSION_COOKIE])
  return res.json(user ? toUserDto(user) : null)
})

api.get("/balance", async (req, res) => {
  const user = await requireUser(req, res)
  if (!user) return

  const balance = await transfersService.balanceOf(user)
  return res.json({ usd: balance.toString(), ngnRate: NGN_RATE })
})

api.get("/transfers", async (req, res) => {
  const user = await requireUser(req, res)
  if (!user) return

  const rows = await transfersService.history(user.id)
  return res.json(await withCounterparties(rows, user.id))
})

api.get("/transfers/:id", async (req, res) => {
  const user = await requireUser(req, res)
  if (!user) return

  const row = await transfersService.byId(user.id, String(req.params.id))
  if (!row) return res.json(null)

  const [dto] = await withCounterparties([row], user.id)
  return res.json(dto ?? null)
})

api.get("/recipients/recent", async (req, res) => {
  const user = await requireUser(req, res)
  if (!user) return

  const people = await transfersService.recentCounterparties(user.id)
  return res.json(people.map(toPublicUserDto))
})

api.get("/resolve", async (req, res) => {
  const user = await requireUser(req, res)
  if (!user) return

  const result = await accounts.resolveRecipient(String(req.query.q ?? ""), user.id)
  return res.json(
    result.ok
      ? { found: true, user: toPublicUserDto(result.value.user) }
      : { found: false, reason: result.reason === "not_found" ? "not_found" : "invalid" },
  )
})

// -------------------------------------------------------------------------- payments

api.post("/transfers", async (req, res) => {
  const user = await requireUser(req, res)
  if (!user) return

  const body = z
    .object({
      recipient: z.string(),
      /** Base units as a string — JSON has no bigint, and a float here would be a bug. */
      amount: z.string(),
      memo: z.string().max(60).optional(),
      pin: z.string(),
      idempotencyKey: z.string().max(128).optional(),
    })
    .safeParse(req.body)

  if (!body.success) return res.status(400).json({ ok: false, reason: "invalid" })

  const amount = parseBaseUnits(body.data.amount)
  if (amount === null) return res.status(400).json({ ok: false, reason: "invalid" })

  const result = await transfersService.send({
    from: user,
    recipient: body.data.recipient,
    amount,
    memo: body.data.memo,
    pin: body.data.pin,
    idempotencyKey: body.data.idempotencyKey,
  })

  if (!result.ok) return res.status(400).json({ ok: false, reason: result.reason })

  const [dto] = await withCounterparties([result.value.transfer], user.id)
  return res.json({ ok: true, transfer: dto })
})

// ---------------------------------------------------------------- payouts & PIN
//
// Parity with USSD. Every option on the handset has an endpoint here, so neither door can
// quietly grow a capability the other lacks — the rules live in `services/` either way.

api.get("/banks", (_req, res) => res.json(payoutsService.BANKS))

api.post("/auth/pin", async (req, res) => {
  const user = await requireUser(req, res)
  if (!user) return

  const body = z
    .object({ currentPin: z.string(), newPin: z.string() })
    .safeParse(req.body)
  if (!body.success) return res.status(400).json({ ok: false, reason: "invalid" })

  const result = await auth.changePin(user, body.data.currentPin, body.data.newPin)
  if (!result.ok) return res.status(400).json({ ok: false, reason: result.reason })

  return res.json({ ok: true })
})

api.get("/payouts", async (req, res) => {
  const user = await requireUser(req, res)
  if (!user) return

  const rows = await payoutsService.history(user.id)
  return res.json(rows.map(toPayoutDto))
})

/**
 * Off-ramp, or a fiat transfer to someone else's bank.
 *
 * The naira leg is simulated — no payout rail is connected — so rows come back with
 * `status: "simulated"`. The dollar debit is real.
 */
api.post("/payouts", async (req, res) => {
  const user = await requireUser(req, res)
  if (!user) return

  const body = z
    .object({
      kind: z.enum(["offramp", "fiat_transfer"]),
      /** Base units as a string. JSON has no bigint, and a float here would be a bug. */
      amount: z.string(),
      bankAccountNumber: z.string(),
      bankCode: z.string(),
      accountName: z.string().max(60).optional(),
      pin: z.string(),
      idempotencyKey: z.string().max(128).optional(),
    })
    .safeParse(req.body)

  if (!body.success) return res.status(400).json({ ok: false, reason: "invalid" })

  const amount = parseBaseUnits(body.data.amount)
  if (amount === null) return res.status(400).json({ ok: false, reason: "invalid" })

  const result = await payoutsService.createPayout({
    user,
    kind: body.data.kind,
    amountUsd: amount,
    bankAccountNumber: body.data.bankAccountNumber,
    bankCode: body.data.bankCode,
    accountName: body.data.accountName,
    pin: body.data.pin,
    idempotencyKey: body.data.idempotencyKey,
  })

  if (!result.ok) return res.status(400).json({ ok: false, reason: result.reason })
  return res.json({ ok: true, payout: toPayoutDto(result.value) })
})

/** Development helper: top up an account so the flow can be exercised without a faucet. */
api.post("/dev/fund", async (req, res) => {
  if (isProduction) return res.status(404).end()

  const user = await requireUser(req, res)
  if (!user) return

  const amount = parseBaseUnits(String(req.body?.amount ?? "40000000"))
  if (amount === null) return res.status(400).json({ error: "invalid" })

  await transfersService.fund(user, amount)
  return res.json({ usd: (await transfersService.balanceOf(user)).toString() })
})

/** Resolve counterparties for a page of transfers in one query rather than N. */
async function withCounterparties(rows: Awaited<ReturnType<typeof transfersService.history>>, viewerId: string) {
  const otherIds = [
    ...new Set(
      rows
        .map((r) => (r.fromUserId === viewerId ? r.toUserId : r.fromUserId))
        .filter((id): id is string => Boolean(id)),
    ),
  ]

  const people = otherIds.length
    ? await db.select().from(users).where(inArray(users.id, otherIds))
    : []
  const byId = new Map(people.map((p) => [p.id, p]))

  return rows.map((row) => {
    const otherId = row.fromUserId === viewerId ? row.toUserId : row.fromUserId
    return toTransferDto(row, viewerId, otherId ? (byId.get(otherId) ?? null) : null)
  })
}

export { SESSION_COOKIE, cookieOptions, eq }
