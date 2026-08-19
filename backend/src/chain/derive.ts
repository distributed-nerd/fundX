import * as quais from "quais"

/**
 * Key derivation.
 *
 * Every user's key is a pure function of one master mnemonic plus a BIP-44 index. Nothing
 * derived is ever written down: the index lives in Postgres, the key is reconstructed in
 * memory to sign and then discarded. A database dump therefore leaks who the users are —
 * a real privacy incident — but leaks no funds.
 *
 * Three facts about Quai derivation, each established by measurement rather than docs:
 *
 *   1. The path is `m/44'/994'/0'/0/i` — coin type 994. Verified by reproducing
 *      `QuaiHDWallet.addAddress(0, i)` exactly.
 *
 *   2. Most indices are unusable. An address encodes region, zone and ledger in its first
 *      9 bits, and those bits fall out of the hash rather than being chosen. Only ~1 in 512
 *      indices lands in Cyprus-1 on the Quai ledger. `addAddress` throws for the rest with
 *      "Failed to derive a valid address zone", and when it does succeed it may hand back a
 *      different zone entirely — index 0 of our own dev seed is Paxos-1.
 *
 *   3. Checking `address.startsWith("0x00")` is NOT sufficient, and fails in the worst
 *      possible way. Measured over 3,137 indices: 10 addresses matched that prefix and only
 *      5 were actually usable. The other half were Cyprus-1 on the *Qi* ledger — a UTXO
 *      ledger with no contracts, where tokens sent are unrecoverable. A 50% false-positive
 *      rate, silently handing users an address that eats their money.
 */

/** Quai's BIP-44 account path. Coin type 994. */
export const ACCOUNT_PATH = "m/44'/994'/0'/0"

/**
 * The nine bits that matter: region(4) | zone(4) | ledger(1).
 * All zero means Cyprus-1 on the Quai ledger — the only place FundX operates.
 *
 * This is the same predicate MockUSDT enforces on-chain in `_update`.
 */
export function isCyprus1Quai(address: string): boolean {
  return BigInt(address) >> 151n === 0n
}

export type Derived = { index: number; address: string }

/**
 * A derivation cursor over one mnemonic.
 *
 * Holds the account-level HD node so each index is a single child derivation (~0.9ms)
 * rather than a full re-walk from the seed.
 */
export class Deriver {
  private readonly node: quais.HDNodeWallet

  constructor(private readonly mnemonic: string) {
    this.node = quais.HDNodeWallet.fromMnemonic(
      quais.Mnemonic.fromPhrase(mnemonic),
      ACCOUNT_PATH,
    )
  }

  /** The address at an index, whatever shard it lands in. */
  addressAt(index: number): string {
    return this.node.deriveChild(index).address
  }

  /**
   * The next index at or after `from` that lands in Cyprus-1 on the Quai ledger.
   *
   * Blocking CPU — roughly 512 derivations, ~566ms. Call it from the pool filler, never
   * from a request handler, or it stalls the event loop for every other caller.
   */
  findNext(from: number, limit = 50_000): Derived | null {
    for (let i = from; i < from + limit; i++) {
      const address = this.addressAt(i)
      if (isCyprus1Quai(address)) return { index: i, address }
    }
    return null
  }

  /**
   * The private key for an index, in memory, for the moment it takes to sign.
   *
   * Never log the return value, never persist it, never put it in an error message. The
   * reference implementation stored these in the database encrypted under a key derived
   * from the key itself — which is to say, not encrypted at all.
   */
  privateKeyAt(index: number): string {
    return this.node.deriveChild(index).privateKey
  }

  /** A signer for an index, bound to a provider. */
  walletAt(index: number, provider?: quais.Provider): quais.Wallet {
    return new quais.Wallet(this.privateKeyAt(index), provider)
  }
}
