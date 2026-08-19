import { config } from "../config.js"
import type { ChainAdapter } from "./adapter.js"
import { MockChain } from "./mock.js"

let instance: ChainAdapter | null = null

/** The adapter this process runs with, chosen once by CHAIN_ADAPTER. */
export async function chain(): Promise<ChainAdapter> {
  if (instance) return instance

  if (config.CHAIN_ADAPTER === "quai") {
    // Loaded lazily so a mock-mode process never needs a mnemonic or an RPC connection.
    const { QuaiChain } = await import("./quai.js")
    instance = new QuaiChain()
  } else {
    instance = new MockChain()
  }

  return instance
}

export type { ChainAdapter, TransferOutcome } from "./adapter.js"
