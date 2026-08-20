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

  /**
   * What became of a transaction we already broadcast.
   *
   * Needed because the confirmation budget is far shorter than a Quai block. A send that
   * returns unconfirmed is not a send that failed — it is one whose receipt had not arrived
   * yet, and something has to go back and look. Without this, a row that reached the chain
   * perfectly well stays `pending` in the database forever.
   *
   * `unknown` means the node has no record of the hash at all. Orchard was observed
   * accepting a transaction, returning its hash, and then dropping it — never mined, never
   * in the mempool. That is indistinguishable from "not yet" for the first few seconds and
   * permanent after that, so the caller decides using the transfer's age.
   */
  statusOf(txHash: string): Promise<"pending" | "confirmed" | "failed" | "unknown">

  /**
   * Where dollars go when they leave FundX for the naira rail.
   *
   * Not the zero address. Burning would be the honest accounting, but `transfer` to
   * `address(0)` reverts in OpenZeppelin (`ERC20InvalidReceiver`) — only `_burn` reaches
   * `_update` that way, and MockUSDT exposes no burn. The in-database simulation never
   * enforced that, so the off-ramp looked fine until it met the deployed contract.
   *
   * Custody is arguably the truer model anyway: the dollars are not destroyed, they are
   * held by FundX against a naira payout that has not settled yet.
   */
  custodyAddress(): string

  /** Whether this address can hold tokens at all — right shard, Quai ledger. */
  canReceive(address: string): boolean
}
