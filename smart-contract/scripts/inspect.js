/**
 * Read the deployed token's state.
 *
 *   npx hardhat run scripts/inspect.js --network cyprus1
 *   ADDRESS=0x00... npx hardhat run scripts/inspect.js --network cyprus1
 *
 * A standalone script rather than a console session, because the Hardhat console does not
 * work against Quai — the docs state that outright.
 */

const quais = require("quais")
const Artifact = require("../artifacts/contracts/MockUSDT.sol/MockUSDT.json")
const { tokenAddress } = require("./_shared")

async function main() {
  const { url, chainId } = hre.network.config
  const provider = new quais.JsonRpcProvider(url, undefined, { usePathing: true })

  const address = tokenAddress(chainId)
  const token = new quais.Contract(address, Artifact.abi, provider)

  const [name, symbol, decimals, supply] = await Promise.all([
    token.name(),
    token.symbol(),
    token.decimals(),
    token.totalSupply(),
  ])

  console.log(`\n  MockUSDT @ ${address}   (chainId ${chainId})`)
  console.log(`  name       ${name}`)
  console.log(`  symbol     ${symbol}`)
  console.log(`  decimals   ${decimals}`)
  console.log(`  supply     ${quais.formatUnits(supply, decimals)} (${supply} base units)`)

  const who = process.env.ADDRESS
  if (who) {
    const balance = await token.balanceOf(who)
    const inZone = await token.isInZone(who)
    console.log(`\n  ${who}`)
    console.log(`  balance    ${quais.formatUnits(balance, decimals)} (${balance} base units)`)
    console.log(`  in zone    ${inZone}`)
  }
  console.log("")
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
