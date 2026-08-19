/**
 * The chain, as the rest of the backend sees it.
 *
 * Services depend on this interface and never on `quais`, so the same domain logic runs
 * against a real Quai node or against an in-database simulation. That matters right now for
 * a practical reason: every Quai faucet hostname is dead, so there is no gas to deploy
 * MockUSDT with, and `MockChain` is the only adapter that can actually run.
 */

export type TransferOutcome = {
  txHash: string
  /** True if a receipt arrived inside the confirmation budget. */
  confirmed: boolean
}

export interface ChainAdapter {
  readonly kind: "mock" | "quai"

  /** Token balance in base units (6 decimals). */
  balanceOf(address: string): Promise<bigint>

  /**
   * Move tokens between two FundX-controlled addresses.
   *
   * `fromIndex` is the sender's BIP-44 index — the adapter derives the key itself so no
   * caller ever holds one.
   */
  transfer(params: {
    fromIndex: number
    fromAddress: string
    toAddress: string
    amount: bigint
    /** How long to wait for a receipt before returning unconfirmed. */
    confirmBudgetMs: number
  }): Promise<TransferOutcome>

  /** Issue tokens. MockUSDT's mint is open, so this needs no privileged key. */
  mint(toAddress: string, amount: bigint): Promise<TransferOutcome>

  /**
   * Make sure an address can pay for its own gas.
   *
   * Quai has no gas sponsorship of any kind — `paymaster`, `4337`, `relayer` and
   * `meta-transaction` are zero hits across the entire documentation. A custodial treasury
   * dripping QUAI is the only way to deliver "the user never needs a gas token".
   */
  ensureGas(address: string): Promise<void>

  /** Whether this address can hold tokens at all — right shard, Quai ledger. */
  canReceive(address: string): boolean
}
