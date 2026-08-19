/**
 * Deploy MockUSDT to the configured network.
 *
 *   npx hardhat run scripts/deployMockUSDT.js --network cyprus1
 *
 * Follows the shape documented at docs.qu.ai/guides/development/solidity. Two details are
 * load-bearing and easy to get wrong:
 *
 *   - `usePathing: true` on the provider. Every documented example sets it; it is how the
 *     SDK routes a request to the right shard.
 *   - The IPFS CID as ContractFactory's *fourth* argument. It gets embedded in the deployed
 *     bytecode, and Quaiscan reads it back to fetch the source. Without it the contract
 *     deploys fine and can then never be verified.
 *
 * Address grinding is handled by quais: contract addresses must carry the shard prefix, and
 * the SDK searches for a deployment that lands in scope. (This is also why CREATE2 is off
 * limits — quais cannot grind for it.)
 */

const fs = require("node:fs")
const path = require("node:path")
const quais = require("quais")
const { deployMetadata } = require("hardhat")

const Artifact = require("../artifacts/contracts/MockUSDT.sol/MockUSDT.json")

async function main() {
  const { url, accounts, chainId } = hre.network.config

  if (!accounts || accounts.length === 0 || !accounts[0]) {
    throw new Error("No CYPRUS1_PK in .env — run: node scripts/newAccount.js")
  }

  const provider = new quais.JsonRpcProvider(url, undefined, { usePathing: true })
  const wallet = new quais.Wallet(accounts[0], provider)

  console.log(`\n  network   chainId ${chainId} — ${url}`)
  console.log(`  deployer  ${wallet.address}`)

  const balance = await provider.getBalance(wallet.address)
  console.log(`  balance   ${quais.formatQuai(balance)} QUAI`)
  if (balance === 0n) {
    throw new Error(
      `Deployer has no QUAI. Fund ${wallet.address} at https://orchard.faucet.quai.network`,
    )
  }

  // Push source metadata to IPFS so the contract can be verified later.
  const ipfsHash = await deployMetadata.pushMetadataToIPFS("MockUSDT")
  console.log(`  metadata  ${ipfsHash}`)

  const factory = new quais.ContractFactory(
    Artifact.abi,
    Artifact.bytecode,
    wallet,
    ipfsHash, // 4th arg — without this the contract can never be verified
  )

  // No constructor args: minting is open, so there is no owner to set.
  const token = await factory.deploy()
  console.log(`  tx        ${token.deploymentTransaction().hash}`)

  await token.waitForDeployment()
  const address = await token.getAddress()

  console.log(`\n  MockUSDT deployed to ${address}`)

  if (!address.toLowerCase().startsWith("0x00")) {
    console.warn(`  WARNING: address is not in Cyprus-1 — quais grinding did not apply`)
  }

  // Record it where the backend can import it. Never resolve a token by symbol: impostor
  // contracts exist, so addresses are pinned per network.
  const dir = path.join(__dirname, "..", "deployments")
  fs.mkdirSync(dir, { recursive: true })

  const file = path.join(dir, `${chainId}.json`)
  const record = {
    network: chainId === 15000 ? "orchard" : chainId === 9 ? "mainnet" : String(chainId),
    chainId,
    rpc: url,
    contracts: {
      MockUSDT: {
        address,
        decimals: 6,
        symbol: "mUSDT",
        openMint: true,
        ipfsMetadata: ipfsHash,
        deploymentTx: token.deploymentTransaction().hash,
      },
    },
  }
  fs.writeFileSync(file, `${JSON.stringify(record, null, 2)}\n`)

  console.log(`  recorded in deployments/${chainId}.json`)
  console.log(`\n  Verify:`)
  console.log(`    curl https://ipfs.qu.ai/ipfs/${ipfsHash} > ipfsMeta.json`)
  console.log(`    then upload it at https://orchard.quaiscan.io/contract-verification\n`)
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
