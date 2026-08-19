/**
 * Money.
 *
 * Every amount is a bigint in base units. MockUSDT is 6-decimal, matching real USDT, so
 * $1.00 is 1_000_000n. Amounts are parsed from strings at the edge and formatted back to
 * strings at the edge; they are never JavaScript numbers in between, and never floats.
 *
 * The reference implementation passed the raw USSD string straight to `transfer()` with no
 * scaling, so typing "5" moved 0.000005 USDT. That is the failure this file exists to make
 * impossible.
 */

export const DECIMALS = 6
const UNIT = 10n ** BigInt(DECIMALS)

/** Naira per dollar. A fixed quote until a pricing feed exists. */
export const NGN_RATE = 1560

/** Parse a human amount ("12.50") into base units. Null for anything not clean and positive. */
export function parseAmount(input: string): bigint | null {
  const cleaned = input.trim().replace(/,/g, "")
  if (cleaned === "") return null
  if (!/^\d*(\.\d*)?$/.test(cleaned)) return null

  const [whole = "", frac = ""] = cleaned.split(".")
  if (whole === "" && frac === "") return null
  if (frac.length > DECIMALS) return null

  return BigInt(whole || "0") * UNIT + BigInt(frac.padEnd(DECIMALS, "0") || "0")
}

/** Parse base units off the wire. Rejects floats, signs and junk rather than coercing. */
export function parseBaseUnits(input: string): bigint | null {
  if (!/^\d+$/.test(input.trim())) return null
  try {
    return BigInt(input.trim())
  } catch {
    return null
  }
}

function group(digits: string): string {
  return digits.replace(/\B(?=(\d{3})+(?!\d))/g, ",")
}

/** Base units to a plain decimal string. Truncates — never show more money than exists. */
export function formatAmount(value: bigint, dp = 2): string {
  const negative = value < 0n
  const abs = negative ? -value : value
  const frac = (abs % UNIT).toString().padStart(DECIMALS, "0").slice(0, dp)
  const body = dp > 0 ? `${group((abs / UNIT).toString())}.${frac}` : group((abs / UNIT).toString())
  return negative ? `-${body}` : body
}

export function formatUSD(value: bigint, dp = 2): string {
  return `${value < 0n ? "-" : ""}$${formatAmount(value < 0n ? -value : value, dp)}`
}

/** Naira equivalent, computed in bigint so the conversion is exact. */
export function toNGN(value: bigint, rate: number = NGN_RATE): bigint {
  return (value * BigInt(rate)) / UNIT
}

export function formatNGN(value: bigint, rate: number = NGN_RATE): string {
  const naira = toNGN(value, rate)
  return `${naira < 0n ? "-" : ""}₦${group((naira < 0n ? -naira : naira).toString())}`
}
