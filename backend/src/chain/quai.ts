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

/** Enough QUAI for a handful of transfers. Topped up when it runs low. */
const GAS_TOPUP = quais.parseQuai("0.05")
const GAS_FLOOR = quais.parseQuai("0.01")

/**
 * The real thing: quais against Orchard.
 *
 * Not yet exercisable — every Quai faucet hostname is dead, so the deployer has no QUAI and
 * MockUSDT is not deployed. This is written against the ABI the contract tests already
 * exercise, and becomes live the moment there is gas.
 */
export class QuaiChain implements ChainAdapter {
  readonly kind = "quai" as const

  private readonly provider: quais.JsonRpcProvider
  private readonly deriver: Deriver
  private readonly treasury: quais.Wallet | null
  private readonly tokenAddress: string

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

  canReceive(address: string): boolean {
    try {
      return isCyprus1Quai(address) && quais.isQuaiAddress(address)
    } catch {
      return false
    }
  }

  private token(signer?: quais.Wallet): Erc20 {
    return new quais.Contract(
      this.tokenAddress,
      ERC20_ABI,
      signer ?? this.provider,
    ) as unknown as Erc20
  }

  async balanceOf(address: string): Promise<bigint> {
    return this.token().balanceOf(address)
  }

  async mint(toAddress: string, amount: bigint): Promise<TransferOutcome> {
    if (!this.treasury) throw new Error("TREASURY_PK is required to mint")
    if (!this.canReceive(toAddress)) {
      throw new Error(`${toAddress} cannot hold tokens — wrong shard or Qi ledger`)
    }

    const tx = await this.token(this.treasury).mint(toAddress, amount)
    await tx.wait()
    return { txHash: tx.hash, confirmed: true }
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

    const balance = await this.provider.getBalance(address)
    if (balance >= GAS_FLOOR) return

    const tx = await this.treasury.sendTransaction({
      from: this.treasury.address,
      to: address,
      value: GAS_TOPUP,
    })
    await tx.wait()
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
