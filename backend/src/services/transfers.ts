import { desc, eq, or, sql } from "drizzle-orm"
import { config } from "../config.js"
import { chain } from "../chain/index.js"
import { InsufficientFunds } from "../chain/mock.js"
import { db } from "../db/index.js"
import { transfers, users, type TransferRow, type UserRow } from "../db/schema.js"
import { newId } from "../lib/ids.js"
import { fail, ok, type Result } from "../lib/errors.js"
import { resolveRecipient } from "./accounts.js"
import { verifyPin } from "./auth.js"

/** Moving money, and reading what moved. */

export type SendInput = {
  from: UserRow
  /** A handle or a phone number, as typed. */
  recipient: string
  amount: bigint
  memo?: string
  pin: string
  /** USSD passes the gateway sessionId; the web client generates one. */
  idempotencyKey?: string
}

export type SendOutput = {
  transfer: TransferRow
  counterparty: UserRow
  /** False when the receipt did not arrive inside the budget — an SMS follows. */
  confirmed: boolean
}

export async function send(input: SendInput): Promise<Result<SendOutput>> {
  const { from, amount, idempotencyKey } = input

  if (amount <= 0n) return fail("invalid")

  // Replay protection first, before any side effect. A USSD gateway retrying the final hop
  // must not move money twice, and checking here means an identical request is answered
  // from the record instead of re-executed.
  if (idempotencyKey) {
    const existing = await findByIdempotencyKey(idempotencyKey)
    if (existing) {
      const counterparty = existing.toUserId ? await userById(existing.toUserId) : null
      if (counterparty) {
        return ok({
          transfer: existing,
          counterparty,
          confirmed: existing.status === "confirmed",
        })
      }
    }
  }

  const resolved = await resolveRecipient(input.recipient, from.id)
  if (!resolved.ok) return fail(resolved.reason)
  const to = resolved.value.user

  // PIN is checked after resolution so a wrong recipient doesn't burn an attempt, but before
  // anything touches the chain.
  const pinCheck = await verifyPin(from, input.pin)
  if (!pinCheck.ok) return fail(pinCheck.reason)

  const adapter = await chain()

  if (!adapter.canReceive(to.address)) return fail("invalid")

  const balance = await adapter.balanceOf(from.address)
  if (balance < amount) return fail("insufficient")

  // Recorded as pending *before* broadcasting, so a crash mid-flight leaves a row to
  // reconcile rather than a transfer that happened with nothing to show for it.
  const id = newId("t")
  const [row] = await db
    .insert(transfers)
    .values({
      id,
      fromUserId: from.id,
      toUserId: to.id,
      fromAddress: from.address,
      toAddress: to.address,
      amount,
      memo: input.memo?.trim() ? input.memo.trim().slice(0, 60) : null,
      status: "pending",
      idempotencyKey: idempotencyKey ?? null,
    })
    .returning()

  if (!row) return fail("invalid")

  try {
    const outcome = await adapter.transfer({
      fromIndex: from.derivationIndex,
      fromAddress: from.address,
      toAddress: to.address,
      amount,
      confirmBudgetMs: config.CONFIRM_BUDGET_MS,
    })

    const [updated] = await db
      .update(transfers)
      .set({
        txHash: outcome.txHash,
        status: outcome.confirmed ? "confirmed" : "pending",
      })
      .where(eq(transfers.id, id))
      .returning()

    return ok({
      transfer: updated ?? row,
      counterparty: to,
      confirmed: outcome.confirmed,
    })
  } catch (error) {
    await db.update(transfers).set({ status: "failed" }).where(eq(transfers.id, id))

    if (error instanceof InsufficientFunds) return fail("insufficient")
    return fail("chain_error")
  }
}

async function findByIdempotencyKey(key: string): Promise<TransferRow | null> {
  const [row] = await db.select().from(transfers).where(eq(transfers.idempotencyKey, key))
  return row ?? null
}

async function userById(id: string): Promise<UserRow | null> {
  const [row] = await db.select().from(users).where(eq(users.id, id))
  return row ?? null
}

/** Everything a user was party to, newest first. The frontend depends on that ordering. */
export async function history(userId: string, limit = 100): Promise<TransferRow[]> {
  return db
    .select()
    .from(transfers)
    .where(or(eq(transfers.fromUserId, userId), eq(transfers.toUserId, userId)))
    .orderBy(desc(transfers.createdAt))
    .limit(limit)
}

export async function byId(userId: string, id: string): Promise<TransferRow | null> {
  const [row] = await db
    .select()
    .from(transfers)
    .where(
      sql`${transfers.id} = ${id} and (${transfers.fromUserId} = ${userId} or ${transfers.toUserId} = ${userId})`,
    )
  return row ?? null
}

/** The handful of people this user has dealt with, newest first, deduplicated. */
export async function recentCounterparties(userId: string, max = 4): Promise<UserRow[]> {
  const rows = await history(userId, 40)
  const seen = new Set<string>()
  const out: UserRow[] = []

  for (const t of rows) {
    const otherId = t.fromUserId === userId ? t.toUserId : t.fromUserId
    if (!otherId || seen.has(otherId)) continue
    seen.add(otherId)

    const user = await userById(otherId)
    if (user) out.push(user)
    if (out.length >= max) break
  }

  return out
}

export async function balanceOf(user: UserRow): Promise<bigint> {
  const adapter = await chain()
  return adapter.balanceOf(user.address)
}

/** Fund an account. MockUSDT's mint is open, so this needs no privileged key. */
export async function fund(user: UserRow, amount: bigint): Promise<void> {
  const adapter = await chain()
  await adapter.ensureGas(user.address)
  await adapter.mint(user.address, amount)
}
