import * as quais from "quais"
import { config } from "../config.js"
import type { ChainAdapter, TransferOutcome } from "./adapter.js"
import { Deriver, isCyprus1Quai } from "./derive.js"
import { InsufficientFunds } from "./mock.js"

/** The slice of MockUSDT this backend calls. */
const ERC20_ABI = [
  "function balanceOf(address) view returns (uint256)",
  "function decimals() view returns (uint8)",
  "function transfer(address to, uint256 amount) returns (bool)",
  "function mint(address to, uint256 amount)",
  "function isInZone(address) view returns (bool)",
]

/**
 * `quais.Contract` resolves method calls dynamically, so TypeScript sees `any`. Naming the
 * shape we actually use restores type checking on the calls that move money.
 */
type Erc20 = {
  balanceOf(address: string): Promise<bigint>
  decimals(): Promise<bigint>
  transfer(to: string, amount: bigint): Promise<quais.ContractTransactionResponse>
  mint(to: string, amount: bigint): Promise<quais.ContractTransactionResponse>
  isInZone(address: string): Promise<boolean>
}

/**
 * Retry a read against the node.
 *
 * Orchard's public RPC was measured returning 502 on 7 of 10 consecutive requests. A blip
 * that size turns "what is my balance" into an error the user sees, so reads get a few
 * attempts with a widening gap.
 *
 * Reads only. Retrying a send could broadcast the same transfer twice, and no amount of
 * convenience is worth that.
 */
async function readWithRetry<T>(work: () => Promise<T>, attempts = 3): Promise<T> {
  let last: unknown
  for (let i = 0; i < attempts; i++) {
    try {
      return await work()
    } catch (error) {
      last = error
      if (i < attempts - 1) await new Promise((r) => setTimeout(r, 400 * 2 ** i))
    }
  }
  throw last
}

/** Enough QUAI for a handful of transfers. Topped up when it runs low. */
const GAS_TOPUP = quais.parseQuai("0.05")
const GAS_FLOOR = quais.parseQuai("0.01")

/**
 * The real thing: quais against Orchard.
 *
 * Live. MockUSDT is deployed at the address in `deployments/15000.json` and this adapter
 * has moved real tokens between real derived addresses on Cyprus-1.
 *
 * The one number that shapes everything here: Orchard's block interval measured ~26.7s and
 * confirmations 16-67s, against docs claiming ~5s. Nothing that must answer a user inside a
 * USSD session can wait for a receipt, which is why sends return `pending` and are
 * reconciled on read.
 */
export class QuaiChain implements ChainAdapter {
  readonly kind = "quai" as const

  private readonly provider: quais.JsonRpcProvider
  private readonly deriver: Deriver
  private readonly treasury: quais.Wallet | null
  private readonly tokenAddress: string

  /**
   * Treasury transactions run one at a time.
   *
   * Every gas drip and every mint is signed by the same key, and `sendTransaction` reads the
   * account nonce at send time. Two concurrent calls therefore claim the same nonce and one
   * of them is discarded — which at signup is how a user silently ends up with no gas and a
   * first transfer that cannot pay for itself. Two people signing up at once is the normal
   * case, not an edge case, so this queue is not optional.
   */
  private treasuryQueue: Promise<unknown> = Promise.resolve()

  constructor() {
    // `usePathing` is how the SDK routes a request to the right shard. Every documented
    // example sets it, and omitting it sends queries to the wrong chain.
    this.provider = new quais.JsonRpcProvider(config.RPC_URL, undefined, { usePathing: true })
    this.deriver = new Deriver(config.MASTER_MNEMONIC!)
    this.tokenAddress = config.MOCK_USDT_ADDRESS!
    this.treasury = config.TREASURY_PK
      ? new quais.Wallet(config.TREASURY_PK, this.provider)
      : null
  }

  custodyAddress(): string {
    if (!this.treasury) throw new Error("TREASURY_PK is required to hold off-ramped funds")
    return this.treasury.address
  }

  canReceive(address: string): boolean {
    try {
      return isCyprus1Quai(address) && quais.isQuaiAddress(address)
    } catch {
      return false
    }
  }

  /** Serialise work that spends from the treasury; see `treasuryQueue`. */
  private queueTreasury<T>(work: () => Promise<T>): Promise<T> {
    const next = this.treasuryQueue.then(work, work)
    // The chain must survive a failure, and must not leave an unhandled rejection behind.
    this.treasuryQueue = next.catch(() => undefined)
    return next
  }

  private token(signer?: quais.Wallet): Erc20 {
    return new quais.Contract(
      this.tokenAddress,
      ERC20_ABI,
      signer ?? this.provider,
    ) as unknown as Erc20
  }

  async balanceOf(address: string): Promise<bigint> {
    return readWithRetry(() => this.token().balanceOf(address))
  }

  async mint(toAddress: string, amount: bigint): Promise<TransferOutcome> {
    if (!this.treasury) throw new Error("TREASURY_PK is required to mint")
    if (!this.canReceive(toAddress)) {
      throw new Error(`${toAddress} cannot hold tokens — wrong shard or Qi ledger`)
    }

    return this.queueTreasury(async () => {
      const tx = await this.token(this.treasury!).mint(toAddress, amount)
      await tx.wait()
      return { txHash: tx.hash, confirmed: true }
    })
  }

  /**
   * Keep an address able to pay its own gas.
   *
   * Dripped at signup rather than just before a send: a just-in-time drip means two
   * sequential transactions, and at ~5s per block that is most of a USSD session spent
   * waiting before the transfer has even been broadcast.
   */
  async ensureGas(address: string): Promise<void> {
    if (!this.treasury) return

    // Checked inside the queue as well as before it: by the time a queued drip runs, an
    // earlier one may already have topped this address up.
    if ((await this.provider.getBalance(address)) >= GAS_FLOOR) return

    await this.queueTreasury(async () => {
      if ((await this.provider.getBalance(address)) >= GAS_FLOOR) return

      const tx = await this.treasury!.sendTransaction({
        from: this.treasury!.address,
        to: address,
        value: GAS_TOPUP,
      })
      await tx.wait()
    })
  }

  async statusOf(txHash: string): Promise<"pending" | "confirmed" | "failed" | "unknown"> {
    try {
      const receipt = await readWithRetry(() => this.provider.getTransactionReceipt(txHash))
      if (receipt) return receipt.status === 1 ? "confirmed" : "failed"

      // No receipt is the ordinary case on Orchard. But it is also what a dropped
      // transaction looks like, so ask whether the node has heard of it at all.
      const tx = await readWithRetry(() => this.provider.getTransaction(txHash))
      return tx ? "pending" : "unknown"
    } catch {
      // An RPC hiccup is not evidence of anything. Calling it failed would be worse than
      // leaving it pending: one is a delay, the other is a lie about money.
      return "pending"
    }
  }

  async transfer(params: {
    fromIndex: number
    fromAddress: string
    toAddress: string
    amount: bigint
    confirmBudgetMs: number
  }): Promise<TransferOutcome> {
    const { fromIndex, fromAddress, toAddress, amount, confirmBudgetMs } = params

    if (!this.canReceive(toAddress)) {
      throw new Error(`${toAddress} cannot hold tokens — wrong shard or Qi ledger`)
    }

    const balance = await this.balanceOf(fromAddress)
    if (balance < amount) throw new InsufficientFunds()

    await this.ensureGas(fromAddress)

    // Derived here, used immediately, never stored or logged.
    const signer = this.deriver.walletAt(fromIndex, this.provider)
    const tx = await this.token(signer).transfer(toAddress, amount)

    /**
     * Wait, but not forever.
     *
     * Quai finalises in ~5s and a USSD session lasts ~20s, so a confirmed receipt on the
     * handset is usually achievable — that is the specific reason this product can exist
     * here. But it cannot be assumed, and blocking indefinitely is how the reference
     * implementation times its own sessions out. Past the budget we return unconfirmed and
     * let the indexer notify by SMS.
     */
    const confirmed = await withTimeout(tx.wait(), confirmBudgetMs)

    return { txHash: tx.hash, confirmed }
  }
}

async function withTimeout(promise: Promise<unknown>, ms: number): Promise<boolean> {
  let timer: NodeJS.Timeout | undefined
  try {
    const timeout = new Promise<false>((resolve) => {
      timer = setTimeout(() => resolve(false), ms)
    })
    const result = await Promise.race([promise.then(() => true), timeout])
    return result
  } catch {
    return false
  } finally {
    if (timer) clearTimeout(timer)
  }
}
