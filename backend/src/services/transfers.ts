import { and, desc, eq, isNotNull, or, sql } from "drizzle-orm"
import { config } from "../config.js"
import { chain } from "../chain/index.js"
import { InsufficientFunds } from "../chain/mock.js"
import { db } from "../db/index.js"
import { transfers, users, type TransferRow, type UserRow } from "../db/schema.js"
import { newId } from "../lib/ids.js"
import { fail, ok, type Result } from "../lib/errors.js"
import { messages, sendSms } from "../sms/index.js"
import { formatUSD } from "../lib/money.js"
import { resolveRecipient } from "./accounts.js"
import { verifyPin } from "./auth.js"

/** Moving money, and reading what moved. */

/**
 * How long a broadcast transaction may be invisible before it is presumed dropped.
 *
 * Five minutes against a ~30s settlement time — deliberately many multiples, because the
 * cost of being wrong is asymmetric: waiting longer delays a failure notice, while calling
 * a live transfer dead tells someone their money is gone when it is not.
 */
const DROPPED_AFTER_MS = 5 * 60_000

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
    // A failed attempt must never be replayed as a success. The key is released on failure
    // below, so this should not match one — but answering "ok" for a transfer that did not
    // move money is bad enough to be worth guarding twice.
    if (existing && existing.status !== "failed") {
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
    /**
     * Release the idempotency key along with marking the row failed.
     *
     * The row stays for audit, but the key must not: `idempotency_key` is UNIQUE, so a
     * client retrying the same send after a chain error would otherwise collide with its
     * own dead attempt and get a database error instead of a second chance.
     */
    await db
      .update(transfers)
      .set({ status: "failed", idempotencyKey: null })
      .where(eq(transfers.id, id))

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

/**
 * Finish what a USSD session could not wait for.
 *
 * When a send outruns the confirmation budget the caller is told "we'll text you when it
 * lands" — and until this existed, nobody ever did. `reconcile` only runs when someone reads
 * their history, which after a USSD session has ended is nobody. The promise was real and
 * the sender was not.
 *
 * Runs on a timer rather than on read for exactly that reason: the person owed the message
 * is the one not looking.
 */
export async function sweepPending(): Promise<number> {
  const stale = await db
    .select()
    .from(transfers)
    .where(and(eq(transfers.status, "pending"), isNotNull(transfers.txHash)))
    .orderBy(desc(transfers.createdAt))
    .limit(50)

  if (stale.length === 0) return 0

  const settled = await reconcile(stale)
  let notified = 0

  for (const row of settled) {
    if (row.status !== "confirmed") continue

    const [from, to] = await Promise.all([
      row.fromUserId ? userById(row.fromUserId) : null,
      row.toUserId ? userById(row.toUserId) : null,
    ])
    if (!from) continue

    const amount = formatUSD(row.amount)
    // Balance is read once, for the sender's message only — the recipient's does not quote one.
    const remaining = await balanceOf(from).catch(() => null)

    if (remaining !== null) {
      void sendSms(from.phone, messages.sent(amount, to ? short(to.displayName) : "them", formatUSD(remaining)))
    }
    if (to) void sendSms(to.phone, messages.received(amount, short(from.displayName)))
    notified++
  }

  return notified
}

/** First name only — an SMS has 160 characters and a full name spends them badly. */
function short(name: string): string {
  return name.split(" ")[0] ?? name
}

/** Everything a user was party to, newest first. The frontend depends on that ordering. */
/**
 * Bring pending rows up to date with the chain.
 *
 * `send` records what it knew when the confirmation budget ran out, which on Orchard is
 * almost always "pending" — the block interval measured ~27s against an 8s budget. Nothing
 * else would ever revisit those rows, so a transfer that succeeded would read as pending
 * forever, both in history and to a client polling for it.
 *
 * Done on read rather than by a background job: history is looked at far less often than it
 * is written, and a lazy check needs no scheduler, no leader election, and no way to fall
 * behind. Rows that are already settled cost nothing.
 */
async function reconcile(rows: TransferRow[]): Promise<TransferRow[]> {
  const stale = rows.filter((r) => r.status === "pending" && r.txHash)
  if (stale.length === 0) return rows

  const adapter = await chain()
  const settled = new Map<string, TransferRow>()

  await Promise.all(
    stale.map(async (row) => {
      const status = await adapter.statusOf(row.txHash!)
      if (status === "pending") return

      /**
       * A hash the node has never heard of.
       *
       * Orchard was observed accepting a transfer, returning its hash, and then dropping
       * it — never mined, never in the mempool, the sender's nonce still zero. Left alone
       * those rows say "Sending" forever while the money never moves, which is the worst
       * of the three things a payment can tell you.
       *
       * Given time to be sure, it is called failed. `DROPPED_AFTER_MS` is the grace period:
       * a transaction really can be briefly invisible right after broadcast, and declaring
       * a live transfer dead is a far worse mistake than waiting another minute.
       */
      if (status === "unknown") {
        if (Date.now() - row.createdAt.getTime() < DROPPED_AFTER_MS) return

        const [updated] = await db
          .update(transfers)
          // The key goes too, so the sender can retry the payment that never happened.
          .set({ status: "failed", idempotencyKey: null })
          .where(eq(transfers.id, row.id))
          .returning()

        if (updated) settled.set(row.id, updated)
        return
      }

      const [updated] = await db
        .update(transfers)
        .set({ status })
        .where(eq(transfers.id, row.id))
        .returning()

      if (updated) settled.set(row.id, updated)
    }),
  )

  return rows.map((r) => settled.get(r.id) ?? r)
}

export async function history(userId: string, limit = 100): Promise<TransferRow[]> {
  const rows = await db
    .select()
    .from(transfers)
    .where(or(eq(transfers.fromUserId, userId), eq(transfers.toUserId, userId)))
    .orderBy(desc(transfers.createdAt))
    .limit(limit)

  return reconcile(rows)
}

export async function byId(userId: string, id: string): Promise<TransferRow | null> {
  const [row] = await db
    .select()
    .from(transfers)
    .where(
      sql`${transfers.id} = ${id} and (${transfers.fromUserId} = ${userId} or ${transfers.toUserId} = ${userId})`,
    )

  if (!row) return null

  // This is what a client polls after an unconfirmed send, so it is the one place that most
  // needs to answer with the chain's opinion rather than the row's.
  const [settled] = await reconcile([row])
  return settled ?? row
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

/**
 * Give a fresh account the gas it will need, without making it wait.
 *
 * `ensureGas` documents itself as happening at signup, and it needs to: dripping
 * just-in-time inside a send means two sequential transactions, and Orchard's block
 * interval measured ~27s, so the first transfer would stall for most of a minute before
 * it was even broadcast.
 *
 * Deliberately not awaited by the caller. The drip is a whole block on its own, and no
 * one should stare at a spinner after choosing a username for it. `transfer` still calls
 * `ensureGas` itself, so this is an optimisation rather than a prerequisite — if it fails,
 * the send path tops the account up and nothing is lost but the head start.
 */
export async function prepareForSpending(user: UserRow): Promise<void> {
  const adapter = await chain()
  await adapter.ensureGas(user.address)
}

/** Fund an account. MockUSDT's mint is open, so this needs no privileged key. */
export async function fund(user: UserRow, amount: bigint): Promise<void> {
  const adapter = await chain()
  await adapter.ensureGas(user.address)
  await adapter.mint(user.address, amount)
}
