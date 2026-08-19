// SPDX-License-Identifier: MIT
pragma solidity 0.8.20;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";

/**
 * @title MockUSDT
 * @notice A stand-in for USDT on Quai, used by FundX during development.
 *
 * There is no USDT on Orchard — Quai's docs carry no token address for any asset on the
 * testnet, and the QUAI faucet dispenses no ERC-20s. So FundX deploys and mints its own.
 * Pointing the product at real USDT later is a config change, not a code change, which is
 * why this matches USDT's shape exactly: six decimals, not eighteen.
 *
 * @dev ⚠️ MINTING IS OPEN. Anyone can call `mint` for any amount. That is deliberate — this
 * token *is* the faucet, so nobody has to hold a privileged key to get test funds, and the
 * supply is meaningless by design.
 *
 * It also means this contract must never be deployed to a network where its balances are
 * taken seriously. It is a testnet fixture. Real USDT has a controlled supply; when FundX
 * points at a real token, this contract is left behind entirely rather than promoted.
 *
 * Two other departures from a stock ERC-20:
 *
 *   1. `decimals()` returns 6. Quai's own sample deploy script calls `parseUnits(supply)`
 *      with no decimals argument and silently produces an 18-decimal token. Shipping at 18
 *      and later switching to real USDT at 6 would make every amount in the system wrong by
 *      a factor of 10^12.
 *
 *   2. Transfers are confined to this contract's own shard — see `_isInZone`.
 */
contract MockUSDT is ERC20 {
    /// @notice Recipient is outside this contract's shard, or on the Qi ledger.
    error OutOfZone(address to);

    constructor() ERC20("FundX Mock USD", "mUSDT") {}

    /// @dev USDT is a 6-decimal token. Match it, so swapping in the real one changes nothing.
    function decimals() public pure override returns (uint8) {
        return 6;
    }

    /**
     * @notice Mint tokens to any address. Unrestricted — this token is its own faucet.
     * @param to Must be in this contract's shard, on the Quai ledger.
     * @param amount Base units — 1_000_000 is $1.00.
     */
    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }

    /// @notice Mint to yourself. Convenience for the common case.
    function mintTo(uint256 amount) external {
        _mint(msg.sender, amount);
    }

    /**
     * @dev Is `addr` in this contract's shard, on the Quai ledger?
     *
     * Every Quai address encodes its location in its first 9 bits: 4 bits of region, 4 bits
     * of zone, then 1 bit of ledger (0 = Quai, 1 = Qi). Comparing those 9 bits against this
     * contract's own address answers both questions at once — a contract can only exist in
     * one shard, and only ever on the Quai ledger, so its prefix is exactly the prefix a
     * valid recipient must have.
     *
     * Quai exposes an `isaddrinternal` opcode for this, but it is only available to the
     * SolidityX compiler: stock solc 0.8.20 rejects it with "Function isaddrinternal not
     * found". The arithmetic below is equivalent and compiles anywhere. Verified against
     * every worked example in the protocol docs, including `0x008…` (Cyprus-1 but Qi
     * ledger), which must be rejected.
     */
    function _isInZone(address addr) private view returns (bool) {
        return (uint160(addr) >> 151) == (uint160(address(this)) >> 151);
    }

    /// @notice Whether this token can be sent to `addr`. Exposed so callers can check first.
    function isInZone(address addr) external view returns (bool) {
        return _isInZone(addr);
    }

    /**
     * @dev Every balance change routes through `_update`, so guarding here covers `transfer`,
     * `transferFrom` and `mint` in one place.
     *
     * Without this, sending to a Qi-prefixed (`0x008…`) or out-of-zone address *succeeds* and
     * credits an address nobody in this shard controls — funds gone, no error, no recourse.
     * This is a class of mistake that does not exist on other EVM chains, so no generic
     * tooling guards against it. Reverting is the entire point.
     *
     * `address(0)` is exempt: OpenZeppelin routes burns through it and does its own
     * zero-address validation.
     */
    function _update(address from, address to, uint256 value) internal override {
        if (to != address(0) && !_isInZone(to)) revert OutOfZone(to);
        super._update(from, to, value);
    }
}
