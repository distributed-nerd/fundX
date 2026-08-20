/**
 * Reproducible verification of the deployed MockUSDT.
 *
 * Quaiscan cannot do this for us: the Orchard explorer's verifier microservice is
 * enabled but has zero Solidity compilers loaded (mainnet Quaiscan has 94), so every
 * submission returns "Fail - Unable to verify" — including one naming a compiler that
 * does not exist, which is how we know the request never reaches a compiler at all.
 *
 * So we do what verification actually is: compile the source, fetch the deployed code,
 * and compare the bytes. Anyone can run this and reach their own conclusion without
 * trusting us or the explorer.
 *
 *   npx hardhat run scripts/verify.js --network cyprus1
 */
const fs = require("fs");
const path = require("path");
const { quais } = require("quais");

const DEPLOYMENT = path.join(__dirname, "..", "deployments", "15000.json");
const BUILD_INFO = path.join(__dirname, "..", "artifacts", "build-info");

async function main() {
  const record = JSON.parse(fs.readFileSync(DEPLOYMENT, "utf8"));
  const { address } = record.contracts.MockUSDT;

  // The build-info whose output matches the chain — there may be several from earlier
  // iterations of the contract, and picking by filename would be guesswork.
  let match = null;
  const provider = new quais.JsonRpcProvider(record.rpc, undefined, { usePathing: true });
  const onchainRuntime = await provider.getCode(address);

  for (const file of fs.readdirSync(BUILD_INFO)) {
    const info = JSON.parse(fs.readFileSync(path.join(BUILD_INFO, file), "utf8"));
    const out = info.output?.contracts?.["contracts/MockUSDT.sol"]?.MockUSDT;
    if (!out) continue;
    if ("0x" + out.evm.deployedBytecode.object === onchainRuntime) {
      match = { file, info, out };
      break;
    }
  }

  const line = (k, v) => console.log(`  ${k.padEnd(22)} ${v}`);

  console.log("\nFundX MockUSDT — reproducible verification\n");
  line("address", address);
  line("chain", `${record.network} (${record.chainId})`);

  if (!match) {
    console.log("\n  RUNTIME BYTECODE DOES NOT MATCH ANY LOCAL BUILD.\n");
    process.exitCode = 1;
    return;
  }

  const { info, out } = match;
  line("solc", info.solcLongVersion);
  line("optimizer", JSON.stringify(info.input.settings.optimizer));
  line("evmVersion", info.input.settings.evmVersion);
  line("sources", Object.keys(info.input.sources).length);

  console.log("\n  runtime bytecode");
  line("on-chain", `${(onchainRuntime.length - 2) / 2} bytes`);
  line("recompiled", `${out.evm.deployedBytecode.object.length / 2} bytes`);
  line("identical", "yes — byte for byte, including the metadata hash");

  // Creation code differs by the grinding nonce, which is expected and worth showing
  // rather than hiding, since it is the one honest discrepancy.
  const compiledCreation = "0x" + out.evm.bytecode.object;
  const nonce = (record.contracts.MockUSDT.grindingNonce || "").replace(/^0x/, "");
  if (nonce) {
    console.log("\n  creation bytecode");
    line("compiler emitted", `${(compiledCreation.length - 2) / 2} bytes`);
    line("grinding nonce", `0x${nonce} (${nonce.length / 2} bytes appended by Quai)`);
  }

  console.log("\n  Behaviour confirmed on-chain (not just on Hardhat's EVM):");
  const token = new quais.Contract(
    address,
    JSON.parse(fs.readFileSync(
      path.join(__dirname, "..", "artifacts", "contracts", "MockUSDT.sol", "MockUSDT.json"),
      "utf8",
    )).abi,
    provider,
  );
  const [name, symbol, decimals, supply] = await Promise.all([
    token.name(), token.symbol(), token.decimals(), token.totalSupply(),
  ]);
  line("name / symbol", `${name} / ${symbol}`);
  line("decimals", decimals);
  line("totalSupply", `${quais.formatUnits(supply, decimals)} ${symbol}`);
  console.log("");
}

main().catch((e) => { console.error(e); process.exitCode = 1; });
