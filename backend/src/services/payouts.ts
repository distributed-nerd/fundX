import { desc, eq } from "drizzle-orm"
import { config } from "../config.js"
import { chain } from "../chain/index.js"
import { db } from "../db/index.js"
import { payouts, users, type PayoutRow, type UserRow } from "../db/schema.js"
import { NGN_RATE, toNGN } from "../lib/money.js"
import { newId } from "../lib/ids.js"
import { fail, ok, type Result } from "../lib/errors.js"
import { verifyPin } from "./auth.js"

/**
 * Naira payouts: off-ramp to your own bank, and fiat transfers to someone else's.
 *
 * ⚠️ **No payout rail is connected.** The quote, the balance debit and the record are real;
 * the bank leg is simulated and rows land as `status: "simulated"`. Connecting a provider —
 * Paystack, Flutterwave, Monnify all expose a NIP transfer API — means replacing `dispatch`
 * below. Nothing else in the system changes, which is the point of keeping it behind a
 * function.
 *
 * The balance is genuinely debited even so. Pretending otherwise would make every other
 * number in the product wrong, and a demo where the balance never moves teaches the wrong
 * thing about what off-ramp costs.
 */

/** Nigerian banks by NIP code. The first six are what the USSD menu can fit on one screen. */
export const BANKS = [
  { code: "058", name: "GTBank" },
  { code: "044", name: "Access Bank" },
  { code: "057", name: "Zenith Bank" },
  { code: "033", name: "UBA" },
  { code: "011", name: "First Bank" },
  { code: "232", name: "Sterling Bank" },
  { code: "070", name: "Fidelity Bank" },
  { code: "214", name: "FCMB" },
  { code: "032", name: "Union Bank" },
  { code: "035", name: "Wema Bank" },
] as const

/** The subset shown on a USSD screen, numbered 1..6. */
export const USSD_BANKS = BANKS.slice(0, 6)

export function bankByMenuChoice(choice: string) {
  const index = Number(choice) - 1
  return Number.isInteger(index) ? USSD_BANKS[index] : undefined
}

export function bankByCode(code: string) {
  return BANKS.find((b) => b.code === code)
}

/** Ten digits, which is the NUBAN format every Nigerian bank uses. */
export function isValidAccountNumber(input: string): boolean {
  return /^\d{10}$/.test(input.trim())
}

/** Naira the user receives for a dollar amount, at the current quote. */
export function quote(amountUsd: bigint): { ngn: bigint; rate: number } {
  return { ngn: toNGN(amountUsd, NGN_RATE), rate: NGN_RATE }
}

export type PayoutInput = {
  user: UserRow
  kind: "offramp" | "fiat_transfer"
  amountUsd: bigint
  bankAccountNumber: string
  bankCode: string
  accountName?: string
  pin: string
  idempotencyKey?: string
}

export async function createPayout(input: PayoutInput): Promise<Result<PayoutRow>> {
  const { user, amountUsd, idempotencyKey } = input

  if (amountUsd <= 0n) return fail("invalid")
  if (!isValidAccountNumber(input.bankAccountNumber)) return fail("invalid")

  const bank = bankByCode(input.bankCode)
  if (!bank) return fail("invalid")

  // Replay protection before any side effect, same as transfers: a retried USSD hop must
  // not withdraw twice.
  if (idempotencyKey) {
    const [existing] = await db.select().from(payouts).where(eq(payouts.idempotencyKey, idempotencyKey))
    if (existing) return ok(existing)
  }

  const pinCheck = await verifyPin(user, input.pin)
  if (!pinCheck.ok) return fail(pinCheck.reason)

  const adapter = await chain()
  const balance = await adapter.balanceOf(user.address)
  if (balance < amountUsd) return fail("insufficient")

  const { ngn, rate } = quote(amountUsd)

  const [row] = await db
    .insert(payouts)
    .values({
      id: newId("p"),
      userId: user.id,
      kind: input.kind,
      amountUsd,
      amountNgn: ngn,
      rate,
      bankAccountNumber: input.bankAccountNumber,
      bankCode: bank.code,
      bankName: bank.name,
      accountName: input.accountName ?? null,
      status: "pending",
      idempotencyKey: idempotencyKey ?? null,
    })
    .returning()

  if (!row) return fail("invalid")

  /**
   * Burn the dollars.
   *
   * Sent to the zero address, which MockUSDT's `_update` permits precisely because
   * OpenZeppelin routes burns through it. The tokens have to leave the user's balance for
   * the same reason a real off-ramp would: the value is going somewhere this ledger cannot
   * see, and leaving it credited would double-count it.
   */
  try {
    await adapter.transfer({
      fromIndex: user.derivationIndex,
      fromAddress: user.address,
      toAddress: "0x0000000000000000000000000000000000000000",
      amount: amountUsd,
      confirmBudgetMs: config.CONFIRM_BUDGET_MS,
    })
  } catch {
    await db.update(payouts).set({ status: "failed" }).where(eq(payouts.id, row.id))
    return fail("chain_error")
  }

  const dispatched = await dispatch(row)

  const [updated] = await db
    .update(payouts)
    .set({ status: dispatched.status, reference: dispatched.reference })
    .where(eq(payouts.id, row.id))
    .returning()

  return ok(updated ?? row)
}

/**
 * Hand the naira leg to a bank.
 *
 * The seam where a real provider goes. Until one exists this records `simulated`, which is
 * deliberately not `paid` — nothing downstream should be able to mistake a demo for a
 * settled transfer.
 */
async function dispatch(row: PayoutRow): Promise<{ status: string; reference: string }> {
  return { status: "simulated", reference: `sim_${row.id.slice(-12)}` }
}

/** Remember a user's bank so the next withdrawal is amount + PIN, not ten digits again. */
export async function linkBank(
  userId: string,
  accountNumber: string,
  bankCode: string,
): Promise<void> {
  const bank = bankByCode(bankCode)
  if (!bank) return

  await db
    .update(users)
    .set({ bankAccountNumber: accountNumber, bankCode: bank.code, bankName: bank.name })
    .where(eq(users.id, userId))
}

export async function history(userId: string, limit = 50): Promise<PayoutRow[]> {
  return db
    .select()
    .from(payouts)
    .where(eq(payouts.userId, userId))
    .orderBy(desc(payouts.createdAt))
    .limit(limit)
}
