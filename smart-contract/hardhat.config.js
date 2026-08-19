/**
 * @type import('hardhat/config').HardhatUserConfig
 *
 * Follows the config documented at docs.qu.ai/guides/development/solidity — NOT the one in
 * the NFT dApp guide, which omits the `metadata` block and silently breaks verification.
 */

require('@nomicfoundation/hardhat-toolbox')
require('@quai/hardhat-deploy-metadata')

const dotenv = require('dotenv')
dotenv.config()

module.exports = {
  defaultNetwork: 'cyprus1',

  networks: {
    // Cyprus-1 is the only zone running on either network today.
    cyprus1: {
      url: process.env.RPC_URL || 'https://orchard.rpc.quai.network',
      accounts: process.env.CYPRUS1_PK ? [process.env.CYPRUS1_PK] : [],
      chainId: Number(process.env.CHAIN_ID || 15000),
    },
  },

  solidity: {
    // Pinned exactly. The docs disagree with themselves on the ceiling (0.8.19 in one
    // place, 0.8.20 in another); 0.8.20 is what the shipped example compiles.
    version: '0.8.20',
    settings: {
      optimizer: { enabled: true, runs: 1000 },

      // Required by @quai/hardhat-deploy-metadata. Removing either breaks Quaiscan
      // verification — the contract still deploys, it just can never be verified.
      metadata: { bytecodeHash: 'ipfs', useLiteralContent: true },

      // Not a formality: 0.8.20 targets Shanghai by default and emits PUSH0, which Quai's
      // London-level EVM does not implement.
      evmVersion: 'london',
    },
  },

  paths: {
    sources: './contracts',
    cache: './cache',
    artifacts: './artifacts',
  },

  mocha: { timeout: 20000 },
}
