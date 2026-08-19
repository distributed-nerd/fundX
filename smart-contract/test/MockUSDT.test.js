const { expect } = require("chai")
const { ethers } = require("hardhat")

/**
 * These run on Hardhat's built-in EVM, not on Quai.
 *
 * That is possible only because the shard guard is plain arithmetic rather than Quai's
 * `isaddrinternal` opcode — stock solc rejects that opcode, so the contract contains no
 * Quai-specific instructions and any EVM can execute it. Deployment and verification still
 * have to happen against Orchard; the logic does not.
 *
 * Run with:  npx hardhat test --network hardhat
 */

/** The 9 bits every Quai address uses to encode region, zone and ledger. */
const prefix9 = (addr) => BigInt(addr) >> 151n

/** Build an address carrying `prefix` in its top 9 bits and `suffix` below them. */
function addressWith(prefix, suffix) {
  const value = (BigInt(prefix) << 151n) | (BigInt(suffix) & ((1n << 151n) - 1n))
  return ethers.getAddress("0x" + value.toString(16).padStart(40, "0"))
}

/**
 * A usable signer whose address sits in the contract's shard.
 *
 * Hardhat's built-in accounts have arbitrary prefixes, so they are "out of zone" as far as
 * this contract is concerned. On Quai every Cyprus-1 address begins 0x00, so holders share
 * the token's prefix by construction. Impersonating an address we choose reproduces that.
 */
async function inZoneSigner(prefix, suffix) {
  const addr = addressWith(prefix, suffix)
  await ethers.provider.send("hardhat_impersonateAccount", [addr])
  await ethers.provider.send("hardhat_setBalance", [addr, "0x56BC75E2D63100000"])
  return ethers.getSigner(addr)
}

describe("MockUSDT", () => {
  let token, owner, other, tokenPrefix, alice, bob

  beforeEach(async () => {
    ;[owner, other] = await ethers.getSigners()
    const Factory = await ethers.getContractFactory("MockUSDT")
    token = await Factory.deploy()
    await token.waitForDeployment()
    tokenPrefix = prefix9(await token.getAddress())

    alice = await inZoneSigner(tokenPrefix, 0xa11ce)
    bob = await inZoneSigner(tokenPrefix, 0xb0b)
  })

  describe("shape", () => {
    it("has six decimals, matching real USDT", async () => {
      // The whole point. Quai's sample script silently produces 18.
      expect(await token.decimals()).to.equal(6)
    })

    it("names itself as a stand-in, not as USDT", async () => {
      expect(await token.symbol()).to.equal("mUSDT")
      expect(await token.name()).to.equal("FundX Mock USD")
    })
  })

  describe("minting", () => {
    it("treats 1_000_000 base units as $1.00", async () => {
      const to = addressWith(tokenPrefix, 0xa11ce)
      await token.mint(to, 1_000_000n)

      expect(await token.balanceOf(to)).to.equal(1_000_000n)
      expect(ethers.formatUnits(await token.balanceOf(to), 6)).to.equal("1.0")
    })

    it("is open — anyone can mint, because this token is its own faucet", async () => {
      const to = addressWith(tokenPrefix, 0xb0b)

      // `other` holds no privileged role. On a real token this would be unthinkable; here
      // it is the point, since the QUAI faucet hands out no ERC-20s.
      await expect(token.connect(other).mint(to, 1_000_000n)).to.not.be.reverted
      expect(await token.balanceOf(to)).to.equal(1_000_000n)
    })

    it("lets a caller mint to itself", async () => {
      await token.connect(alice).mintTo(7_500_000n)
      expect(await token.balanceOf(alice.address)).to.equal(7_500_000n)
    })
  })

  describe("the shard guard", () => {
    it("accepts an address in the contract's own shard", async () => {
      const to = addressWith(tokenPrefix, 0xa11ce)
      expect(await token.isInZone(to)).to.equal(true)
      await expect(token.mint(to, 5_000_000n)).to.not.be.reverted
    })

    it("rejects the Qi ledger — the lowest prefix bit", async () => {
      // Flipping bit 8 is exactly the 0x00 -> 0x008 case: same zone, wrong ledger.
      // Qi is a UTXO ledger with no contracts, so tokens sent there are unrecoverable.
      const qi = addressWith(tokenPrefix ^ 1n, 0xa11ce)

      expect(await token.isInZone(qi)).to.equal(false)
      await expect(token.mint(qi, 1_000_000n))
        .to.be.revertedWithCustomError(token, "OutOfZone")
        .withArgs(qi)
    })

    it("rejects another zone", async () => {
      const elsewhere = addressWith(tokenPrefix ^ 0b100000000n, 0xa11ce)

      expect(await token.isInZone(elsewhere)).to.equal(false)
      await expect(token.mint(elsewhere, 1_000_000n)).to.be.revertedWithCustomError(
        token,
        "OutOfZone",
      )
    })

    it("guards transfer, not just mint", async () => {
      await token.mint(alice.address, 10_000_000n)
      const qi = addressWith(tokenPrefix ^ 1n, 0xdead)

      await expect(
        token.connect(alice).transfer(qi, 1_000_000n),
      ).to.be.revertedWithCustomError(token, "OutOfZone")
    })

    it("guards transferFrom too", async () => {
      await token.mint(alice.address, 10_000_000n)
      await token.connect(alice).approve(bob.address, 10_000_000n)
      const qi = addressWith(tokenPrefix ^ 1n, 0xdead)

      await expect(
        token.connect(bob).transferFrom(alice.address, qi, 1_000_000n),
      ).to.be.revertedWithCustomError(token, "OutOfZone")
    })
  })

  describe("transfers", () => {
    it("moves exact base units", async () => {
      await token.mint(alice.address, 40_000_000n) // $40.00

      await token.connect(alice).transfer(bob.address, 12_500_000n) // $12.50

      expect(await token.balanceOf(alice.address)).to.equal(27_500_000n) // $27.50
      expect(await token.balanceOf(bob.address)).to.equal(12_500_000n)
    })

    it("will not overdraw", async () => {
      await token.mint(alice.address, 1_000_000n)

      await expect(
        token.connect(alice).transfer(bob.address, 2_000_000n),
      ).to.be.revertedWithCustomError(token, "ERC20InsufficientBalance")
    })
  })
})
