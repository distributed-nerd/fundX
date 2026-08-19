/**
 * Mint MockUSDT to an address. Owner-only.
 *
 *   TO=0x00... AMOUNT=25.00 npx hardhat run scripts/mint.js --network cyprus1
 *
 * AMOUNT is in dollars and is converted with 6 decimals, so 25.00 becomes 25_000_000 base
 * units. Passing base units directly would be the mistake the reference implementations
 * make — sending "5" and moving 0.000005 of a token.
 */

const quais = require("quais")
const Artifact = require("../artifacts/contracts/MockUSDT.sol/MockUSDT.json")
const { tokenAddress } = require("./_shared")

const DECIMALS = 6

async function main() {
  const { url, accounts, chainId } = hre.network.config

  const to = process.env.TO
  const amount = process.env.AMOUNT
  if (!to || !amount) {
    throw new Error("Usage: TO=0x00... AMOUNT=25.00 npx hardhat run scripts/mint.js --network cyprus1")
  }

  const provider = new quais.JsonRpcProvider(url, undefined, { usePathing: true })
  const wallet = new quais.Wallet(accounts[0], provider)
  const token = new quais.Contract(tokenAddress(chainId), Artifact.abi, wallet)

  // Reject a bad recipient here rather than discovering it on-chain. The contract also
  // guards this, but a clear message beats a reverted transaction.
  if (!quais.isQuaiAddress(to)) {
    throw new Error(`${to} is not a Quai-ledger address. Qi addresses (0x008...) cannot hold tokens.`)
  }
  if (!(await token.isInZone(to))) {
    throw new Error(`${to} is outside the token's shard — the transfer would revert.`)
  }

  const units = quais.parseUnits(amount, DECIMALS)
  console.log(`\n  minting ${amount} mUSDT (${units} base units) to ${to}`)

  const tx = await token.mint(to, units)
  console.log(`  tx      ${tx.hash}`)
  await tx.wait()

  const balance = await token.balanceOf(to)
  console.log(`  balance ${quais.formatUnits(balance, DECIMALS)} mUSDT\n`)
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
