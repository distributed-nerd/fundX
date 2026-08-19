const fs = require("node:fs")
const path = require("node:path")

/**
 * The deployed token address for a network.
 *
 * Read from deployments/<chainId>.json, with MOCK_USDT_ADDRESS as an override. Addresses are
 * pinned per network and never looked up by symbol — impostor token contracts exist, and
 * "the contract called USDT" is not a safe way to find the one you mean.
 */
function tokenAddress(chainId) {
  if (process.env.MOCK_USDT_ADDRESS) return process.env.MOCK_USDT_ADDRESS

  const file = path.join(__dirname, "..", "deployments", `${chainId}.json`)
  if (!fs.existsSync(file)) {
    throw new Error(
      `No deployment for chainId ${chainId}. Run scripts/deployMockUSDT.js first, ` +
        `or set MOCK_USDT_ADDRESS.`,
    )
  }

  const record = JSON.parse(fs.readFileSync(file, "utf8"))
  const address = record?.contracts?.MockUSDT?.address
  if (!address) throw new Error(`deployments/${chainId}.json has no MockUSDT address`)

  return address
}

module.exports = { tokenAddress }
