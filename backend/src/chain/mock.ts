import { randomBytes } from "node:crypto"
import { eq, sql } from "drizzle-orm"
import { db } from "../db/index.js"
import { mockBalances } from "../db/schema.js"
import type { ChainAdapter, TransferOutcome } from "./adapter.js"
import { isCyprus1Quai } from "./derive.js"

/**
 * A chain simulated in Postgres.
 *
 * Exists so the whole product — signup, USSD, transfers, history — can be exercised while
 * no token is deployed. It enforces the same rules the real one does, including the shard
 * guard, so code that works here works there.
 *
 * What it cannot do is produce a transaction anyone else can verify. The "View on Quaiscan"
 * link is the product's central claim, and under this adapter it is theatre. That is the
 * reason to keep it temporary.
 */
export class MockChain implements ChainAdapter {
  readonly kind = "mock" as const

  canReceive(address: string): boolean {
    try {
      return isCyprus1Quai(address)
    } catch {
      return false
    }
  }

  async balanceOf(address: string): Promise<bigint> {
    const [row] = await db
      .select({ amount: mockBalances.amount })
      .from(mockBalances)
      .where(eq(mockBalances.address, address))
    return row?.amount ?? 0n
  }

  async mint(toAddress: string, amount: bigint): Promise<TransferOutcome> {
    if (!this.canReceive(toAddress)) {
      throw new Error(`${toAddress} cannot hold tokens — wrong shard or Qi ledger`)
    }
    if (amount <= 0n) throw new Error("mint amount must be positive")

    await db
      .insert(mockBalances)
      .values({ address: toAddress, amount })
      .onConflictDoUpdate({
        target: mockBalances.address,
        set: { amount: sql`${mockBalances.amount} + ${amount}` },
      })

    return { txHash: fakeTxHash(), confirmed: true }
  }

  async transfer(params: {
    fromIndex: number
    fromAddress: string
    toAddress: string
    amount: bigint
    confirmBudgetMs: number
  }): Promise<TransferOutcome> {
    const { fromAddress, toAddress, amount } = params

    if (amount <= 0n) throw new Error("transfer amount must be positive")
    if (!this.canReceive(toAddress)) {
      throw new Error(`${toAddress} cannot hold tokens — wrong shard or Qi ledger`)
    }

    await db.transaction(async (tx) => {
      // Debit conditionally: the WHERE clause is what makes the balance check atomic.
      // A read-then-write would let two concurrent sends both pass the check.
      const debited = await tx
        .update(mockBalances)
        .set({ amount: sql`${mockBalances.amount} - ${amount}` })
        .where(sql`${mockBalances.address} = ${fromAddress} and ${mockBalances.amount} >= ${amount}`)
        .returning({ address: mockBalances.address })

      if (debited.length === 0) throw new InsufficientFunds()

      await tx
        .insert(mockBalances)
        .values({ address: toAddress, amount })
        .onConflictDoUpdate({
          target: mockBalances.address,
          set: { amount: sql`${mockBalances.amount} + ${amount}` },
        })
    })

    return { txHash: fakeTxHash(), confirmed: true }
  }

  /** Nothing to do — a simulated chain charges no gas. */
  async ensureGas(): Promise<void> {}
}

export class InsufficientFunds extends Error {
  constructor() {
    super("insufficient funds")
    this.name = "InsufficientFunds"
  }
}

function fakeTxHash(): string {
  return `0x${randomBytes(32).toString("hex")}`
}
