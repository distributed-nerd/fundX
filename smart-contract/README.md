# MockUSDT

The token FundX moves. A 6-decimal ERC-20 standing in for USDT on Quai.

There is no USDT on Orchard — Quai's docs carry no token address for any asset on the
testnet. So FundX deploys and mints its own, with minting open to anyone. Pointing
the product at real USDT later is a config change, not a code change, which is why this
matches USDT's shape exactly.

## Quickstart

```bash
npm install
node scripts/newAccount.js          # writes a Cyprus-1 key to .env (mode 600)
# fund the printed address with testnet QUAI
npx hardhat compile
npx hardhat test --network hardhat  # 12 tests
npx hardhat run scripts/deployMockUSDT.js --network cyprus1
```

Then:

```bash
TO=0x00... AMOUNT=25.00 npx hardhat run scripts/mint.js --network cyprus1   # anyone can
ADDRESS=0x00...          npx hardhat run scripts/inspect.js --network cyprus1
```

## Three things about the contract

**Six decimals, not eighteen.** Real USDT is 6, and so is `frontend/lib/money.ts`. Quai's
own sample deploy script calls `parseUnits(supply)` with no decimals argument and silently
produces an 18-decimal token; shipping that and later switching to real USDT would make
every amount in the system wrong by a factor of 10¹².

**Minting is open — anyone can call it.** No ERC-20 faucet exists on Orchard, so this token
is its own faucet: `mint(to, amount)` for anyone, or `mintTo(amount)` to fund yourself. The
contract has no owner and no privileged role.

That is fine here and unacceptable anywhere else. Supply is meaningless by design, so this
contract is a testnet fixture only — when FundX points at a real token, this one is left
behind rather than promoted. Note it solves *tokens*, not *gas*: deploying and transferring
still cost QUAI.

**Transfers cannot leave the shard.** Every Quai address encodes its location in its first
9 bits — 4 of region, 4 of zone, 1 of ledger. Send tokens to a Qi-prefixed address
(`0x008…`) or another zone and the transfer *succeeds*, crediting an address nobody here
controls. Funds gone, no error. This class of mistake doesn't exist on other EVM chains, so
generic tooling doesn't guard against it.

`_update` rejects it, which covers `transfer`, `transferFrom` and `mint` in one place:

```solidity
return (uint160(addr) >> 151) == (uint160(address(this)) >> 151);
```

Quai exposes an `isaddrinternal` opcode for exactly this, but it is **SolidityX-only** —
stock solc 0.8.20 fails with `DeclarationError: Function "isaddrinternal" not found`. The
arithmetic above is equivalent, compiles anywhere, and is verified against every worked
example in the protocol docs. Comparing against the contract's own prefix rather than a
hardcoded `0x00` keeps it correct if Quai ever activates another zone.

## Toolchain notes

Hardhat is the only documented option — `foundry`, `forge`, `truffle` and `remix` have zero
mentions across Quai's docs. But it is not vanilla Hardhat:

- **Deploy scripts use `quais`, not `ethers`.** There is no `hre.ethers.getContractFactory`;
  you build `new quais.ContractFactory(abi, bytecode, wallet, ipfsHash)` yourself.
- **The IPFS CID is the 4th argument** to `ContractFactory`, and it is load-bearing. It gets
  embedded in the bytecode and Quaiscan reads it back to fetch your source. Without it the
  contract deploys and can never be verified.
- **`usePathing: true`** on every provider — it's how the SDK routes to the right shard.
- **`evmVersion: 'london'` is mandatory.** Solidity 0.8.20 targets Shanghai by default and
  emits `PUSH0`, which Quai's EVM does not implement.
- **`metadata: { bytecodeHash: 'ipfs', useLiteralContent: true }`** — removing either breaks
  verification.
- **The Hardhat console does not work against Quai.** Interaction goes through the scripts
  in `scripts/`.
- **Don't use CREATE2.** `quais` grinds deployment addresses into the correct shard and
  cannot do so for CREATE2.

Tests run on Hardhat's built-in EVM (`--network hardhat`), which works only because the
contract contains no Quai-specific opcodes. Deployment and verification still need a real
network. Note that Hardhat's own accounts have arbitrary address prefixes, so the tests
impersonate addresses sharing the token's prefix — on Quai every Cyprus-1 address begins
`0x00` and this is automatic.

## Corrections to the published docs

Found while building this:

| Docs say | Actually |
|---|---|
| Faucet at `orchard.faucet.quai.network` | **No DNS record.** Neither does `faucet.quai.network`. The support article 404s. |
| `isaddrinternal` usable via inline assembly | SolidityX only; stock solc rejects it |
| SDK exports `getZoneFromAddress` | quais `1.0.0-alpha.56` exports **`getZoneForAddress`** only |
| Solidity ceiling is 0.8.19 (one page) / 0.8.20 (another) | 0.8.20 compiles |

## Verification on Quaiscan

The deploy pins a standard-JSON metadata bundle to IPFS and embeds its CID in the bytecode,
which is what an explorer reads back to find the source:

```bash
curl https://ipfs.qu.ai/ipfs/<CID> > ipfsMeta.json   # CID is in deployments/<chainId>.json
```

On a working explorer that file, the address, the SPDX licence and the compiler version are
all it takes. **Orchard's explorer is not a working explorer** — it has no compilers loaded
and cannot verify anything, by anyone. See *Not verified on Quaiscan* below for the
measurements, and *Verify it yourself* for the one command that does the same job without it.

## Deployments

### Orchard (chainId 15000) — live

```
MockUSDT   0x005fB6A2b1a807195D84E3CB04eBce10684352CB
deploy tx  0x002d0039206167981ecbc7a7255370315ec80c5b88f455b1999f6ecedbe72a63
deployer   0x002AEb3cb2c7E7DDd95Ebe447CDeae14dE577237
IPFS CID   Qmbzv6mwbGW3uPjef2wBTvVMfZzeSoKzhvdfhogu5UEyEX
```

Confirmed against the live chain, not just Hardhat: `decimals()` is 6, minting 1_000_000
base units reads back as $1.00, an in-zone transfer settles, and **a transfer to a `0x008…`
Qi address reverts** — the guard's whole reason for existing, exercised against a real Quai
node for the first time.

`deployments/<chainId>.json` records the address, decimals and IPFS CID per network, for the
backend to import. **Addresses are pinned per network and never resolved by symbol** —
impostor token contracts exist, and "the contract called USDT" is not a safe way to find the
one you mean.

### Not verified on Quaiscan, and not for want of trying

The contract is indexed — address, deploy transaction and bytecode all resolve — but the
source is not verified. The cause is the explorer, not this contract, and the comparison
with mainnet is what settles it:

| Check | Orchard | Mainnet |
|---|---|---|
| Solidity compilers offered by the verifier | **0** | 94 |
| Vyper compilers | **0** | 52 |
| `is_rust_verifier_microservice_enabled` | true | true |
| Verified contracts, by anyone | **0** | 5 |

The microservice is switched on but has no compiler storage attached. Every submission —
`standard-input` and `flattened-code`, v1 API and v2 — returns `Fail - Unable to verify`.
The decisive test: submitting `compilerversion=totally-not-a-compiler` fails *identically*
to the correct `v0.8.20+commit.a1b79de6`. A working verifier rejects an unknown compiler
with its own distinct error, so the request is never reaching a compiler at all.

An earlier note here claimed the EVM list stopped at `berlin`. That is no longer true —
`london` through `cancun` are all offered. The compiler list is the whole problem.

**A second obstacle waits behind the first.** Quai grinds contract addresses into the
correct shard by appending a 4-byte nonce to the init code — here `0x000000c3` — so the
on-chain creation bytecode is 4 bytes longer than solc emits. Blockscout reads trailing
excess as constructor arguments, but `MockUSDT`'s constructor takes none, so the match may
still fail once compilers exist. Passing the nonce as `constructorArguements` is the
obvious workaround and is already written down, but it cannot be tested until Orchard can
compile.

### Verify it yourself, without the explorer

Verification is just "recompile the source and compare it to the chain". That does not
need Quaiscan:

```bash
npx hardhat run scripts/verify.js --network cyprus1
```

It selects the build-info that matches the deployed code (there are several, from earlier
iterations of the contract — picking by filename would be guesswork), recompiles, and
compares. The runtime bytecode matches **byte for byte, including the metadata hash**. It
then reads `name`, `symbol`, `decimals` and `totalSupply` off the live contract, and prints
the grinding nonce rather than hiding it, since it is the one honest discrepancy between
source and chain.
