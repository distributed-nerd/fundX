import { desc, eq } from "drizzle-orm"
import { config } from "../config.js"
import { chain } from "../chain/index.js"
import { db } from "../db/index.js"
import { payouts, type PayoutRow, type UserRow } from "../db/schema.js"
import { toNGN } from "../lib/money.js"
import { newId } from "../lib/ids.js"
import { fail, ok, type Result } from "../lib/errors.js"
import { verifyPin } from "./auth.js"
import { findBank, isValidAccountNumber } from "./banks.js"
import { getRate } from "./pricing.js"

export { isValidAccountNumber } from "./banks.js"

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


/**
 * Naira for a dollar amount, at the live rate.
 *
 * The rate returned here is the one shown to the user and the one stored on the payout —
 * quoted once and frozen, never recomputed later. A payout that settles at a different rate
 * from the one someone agreed to is how you lose their trust permanently.
 */
export async function quote(amountUsd: bigint): Promise<{ ngn: bigint; rate: number }> {
  const { rate } = await getRate()
  return { ngn: toNGN(amountUsd, rate), rate }
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

  const bank = await findBank(input.bankCode)
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

  const { ngn, rate } = await quote(amountUsd)

  const [row] = await db
    .insert(payouts)
    .values({
      id: newId("p"),
      userId: user.id,
      kind: input.kind,
      amountUsd,
      amountNgn: ngn,
      // Stored in hundredths so a fractional rate survives the integer column exactly.
      rate: Math.round(rate * 100),
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
   * Move the dollars into custody.
   *
   * They have to leave the user's balance for the same reason a real off-ramp would: the
   * value is going somewhere this ledger cannot see, and leaving it credited would
   * double-count it.
   *
   * This used to send to the zero address and call it a burn. That reverts against the
   * deployed contract — `transfer` rejects `address(0)` outright, and only `_burn` reaches
   * `_update`, which MockUSDT does not expose. It passed for as long as it did because the
   * in-database simulation had no such rule. See `custodyAddress`.
   */
  try {
    await adapter.transfer({
      fromIndex: user.derivationIndex,
      fromAddress: user.address,
      toAddress: adapter.custodyAddress(),
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

export async function history(userId: string, limit = 50): Promise<PayoutRow[]> {
  return db
    .select()
    .from(payouts)
    .where(eq(payouts.userId, userId))
    .orderBy(desc(payouts.createdAt))
    .limit(limit)
}
