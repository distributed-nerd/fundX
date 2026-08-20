/**
 * Money handling for FundX.
 *
 * Every amount in this app is a bigint in *base units* — the smallest indivisible
 * piece of the token. mockUSDT is 6-decimal (matching real USDT), so $1.00 is
 * 1_000_000n. Amounts are parsed from strings at the input boundary and formatted
 * back to strings at the display boundary; they are never JavaScript numbers in
 * between.
 *
 * This is not fussiness. `0.1 + 0.2 === 0.30000000000000004` is not a rounding
 * detail in a payments product — it is a balance that disagrees with the chain.
 */

export const DECIMALS = 6;
const UNIT = 10n ** BigInt(DECIMALS);

/**
 * Naira per dollar, last resort only.
 *
 * The live rate arrives with the balance (`GET /api/balance` -> `ngnRate`) and from
 * `GET /api/rate`. This constant exists so a screen rendering before the first response has
 * something to show, and is deliberately not what any quote is built on — it was 1560 for a
 * while, roughly 15% away from the market, which on a ₦100,000 payout is ₦15,000 of
 * somebody's money.
 */
export const NGN_RATE_FALLBACK = 1350;

/** Display precision for USD. Users enter and read cents, not micro-dollars. */
const USD_DP = 2;

/**
 * Parse user input into base units. Returns null for anything not a clean
 * non-negative amount, so callers can treat null as "not payable yet" rather than
 * guessing at a partial entry like "12." mid-typing.
 */
export function parseAmount(input: string): bigint | null {
  const cleaned = input.trim().replace(/,/g, "");
  if (cleaned === "") return null;
  if (!/^\d*(\.\d*)?$/.test(cleaned)) return null;

  const [whole = "", frac = ""] = cleaned.split(".");
  if (whole === "" && frac === "") return null;
  if (frac.length > DECIMALS) return null;

  const padded = frac.padEnd(DECIMALS, "0");
  return BigInt(whole || "0") * UNIT + BigInt(padded || "0");
}

/** Group an integer-valued string with thousands separators. */
function group(digits: string): string {
  return digits.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
}

/**
 * Format base units as a plain decimal string: 40500000n -> "40.50".
 * Truncates rather than rounds — never show a user more money than they have.
 */
export function formatAmount(value: bigint, dp: number = USD_DP): string {
  const negative = value < 0n;
  const abs = negative ? -value : value;

  const whole = abs / UNIT;
  const frac = abs % UNIT;

  const fracStr = frac.toString().padStart(DECIMALS, "0").slice(0, dp);
  const body = dp > 0 ? `${group(whole.toString())}.${fracStr}` : group(whole.toString());

  return negative ? `-${body}` : body;
}

/** "$40.50" */
export function formatUSD(value: bigint, dp: number = USD_DP): string {
  const negative = value < 0n;
  const body = formatAmount(negative ? -value : value, dp);
  return `${negative ? "-" : ""}$${body}`;
}

/**
 * Naira equivalent, computed in bigint so the conversion is exact.
 * Shown to the whole naira — kobo is not meaningful at these amounts.
 */
export function toNGN(value: bigint, rate: number = NGN_RATE_FALLBACK): bigint {
  // The rate is fractional (1343.53), so scale to hundredths before multiplying. Doing this
  // in floating point would put rounding error straight into an amount someone is paid.
  const hundredths = BigInt(Math.round(rate * 100));
  return (value * hundredths) / (UNIT * 100n);
}

/** "₦62,400" */
export function formatNGN(value: bigint, rate: number = NGN_RATE_FALLBACK): string {
  const naira = toNGN(value, rate);
  const negative = naira < 0n;
  const body = group((negative ? -naira : naira).toString());
  return `${negative ? "-" : ""}₦${body}`;
}

/** "₦1,343.53/$" — the rate itself, always shown beside a converted figure. */
export function formatRate(rate: number = NGN_RATE_FALLBACK): string {
  const whole = Math.trunc(rate);
  const kobo = Math.round((rate - whole) * 100);
  return `₦${group(String(whole))}${kobo ? `.${String(kobo).padStart(2, "0")}` : ""}/$`;
}

/**
 * Constrain raw keystrokes in an amount field: digits, one dot, at most two
 * decimal places. Returns the corrected string so the input stays controlled.
 */
export function sanitizeAmountInput(raw: string): string {
  let next = raw.replace(/[^\d.]/g, "");

  const firstDot = next.indexOf(".");
  if (firstDot !== -1) {
    next =
      next.slice(0, firstDot + 1) + next.slice(firstDot + 1).replace(/\./g, "");
  }

  const [whole, frac] = next.split(".");
  if (frac !== undefined) {
    return `${whole.slice(0, 9)}.${frac.slice(0, USD_DP)}`;
  }
  return whole.slice(0, 9);
}
