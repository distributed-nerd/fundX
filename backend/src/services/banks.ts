import { config } from "../config.js"

/**
 * Nigerian banks, and turning an account number into a name.
 *
 * Two jobs, both of which Paystack does properly:
 *
 *   GET /bank?country=nigeria   — the canonical list, including the fintechs
 *   GET /bank/resolve           — account number + bank code -> account name
 *
 * Account-name resolution is the single most valuable validation in Nigerian payments.
 * Ten digits are easy to mistype and impossible to eyeball, and every bank app shows you
 * the name before you commit precisely because that is the only check a human can actually
 * perform. Sending to the wrong account is effectively irreversible.
 *
 * `PAYSTACK_SECRET_KEY` is required for name resolution — without it the endpoint reports
 * `unavailable` rather than guessing. The bank *list* still falls back to the static one
 * below, which is safe because a wrong bank name cannot cost anyone money.
 */

export type Bank = {
  code: string
  name: string
  /** Set for the mobile-money operators people actually use day to day. */
  fintech?: boolean
}

/**
 * Fallback list, used only when Paystack is unreachable.
 *
 * Paystack returns **279** Nigerian banks; this is the three dozen people actually use. The
 * codes were checked against the live endpoint — but they do change (Heritage Bank has since
 * left the list entirely), so `listBanks()` always prefers the live one.
 *
 * The fintechs are first on purpose: OPay, Moniepoint, PalmPay and Kuda are where an
 * enormous share of Nigerian personal accounts now live, and burying them under the
 * traditional banks would make the common case the slowest one.
 */
export const STATIC_BANKS: Bank[] = [
  // Mobile money / neobanks
  { code: "999992", name: "OPay", fintech: true },
  { code: "50515", name: "Moniepoint MFB", fintech: true },
  { code: "999991", name: "PalmPay", fintech: true },
  { code: "50211", name: "Kuda Bank", fintech: true },
  { code: "51318", name: "FairMoney MFB", fintech: true },
  { code: "565", name: "Carbon", fintech: true },
  { code: "51310", name: "Sparkle Microfinance Bank", fintech: true },
  { code: "50304", name: "Mint MFB", fintech: true },
  { code: "566", name: "VFD Microfinance Bank", fintech: true },
  { code: "100", name: "SunTrust Bank", fintech: true },

  // Commercial banks
  { code: "044", name: "Access Bank" },
  { code: "063", name: "Access Bank (Diamond)" },
  { code: "035", name: "Wema Bank" },
  { code: "050", name: "Ecobank Nigeria" },
  { code: "070", name: "Fidelity Bank" },
  { code: "011", name: "First Bank of Nigeria" },
  { code: "214", name: "First City Monument Bank" },
  { code: "058", name: "Guaranty Trust Bank" },
  { code: "082", name: "Keystone Bank" },
  { code: "076", name: "Polaris Bank" },
  { code: "101", name: "Providus Bank" },
  { code: "221", name: "Stanbic IBTC Bank" },
  { code: "068", name: "Standard Chartered Bank" },
  { code: "232", name: "Sterling Bank" },
  { code: "102", name: "Titan Trust Bank" },
  { code: "033", name: "United Bank For Africa" },
  { code: "032", name: "Union Bank of Nigeria" },
  { code: "215", name: "Unity Bank" },
  { code: "057", name: "Zenith Bank" },
  { code: "023", name: "Citibank Nigeria" },
  { code: "104", name: "Parallex Bank" },
  { code: "00103", name: "Globus Bank" },
  { code: "301", name: "Jaiz Bank" },
  { code: "302", name: "TAJBank" },
  { code: "303", name: "Lotus Bank" },
  { code: "125", name: "Rubies MFB" },
]

const PAYSTACK = "https://api.paystack.co"

/**
 * Paystack's test bank.
 *
 * Test keys are capped at **3 live bank resolves per day**; bank code `001` resolves any
 * account number, unlimited, returning "TEST ACCOUNT <number>". It is deliberately absent
 * from the `country=nigeria` list, so it has to be added.
 *
 * Only offered outside production — it exists so the send flow can be demonstrated without
 * spending the daily quota on the third try.
 */
const TEST_BANK: Bank = { code: "001", name: "Test Bank (Paystack sandbox)" }

/** Cached because the list is large, changes rarely, and USSD calls this per session. */
let cache: { banks: Bank[]; at: number } | null = null
const CACHE_MS = 6 * 60 * 60 * 1000

export function isConfigured(): boolean {
  return Boolean(config.PAYSTACK_SECRET_KEY)
}

export async function listBanks(): Promise<Bank[]> {
  if (cache && Date.now() - cache.at < CACHE_MS) return cache.banks
  if (!isConfigured()) return STATIC_BANKS

  try {
    const res = await fetch(`${PAYSTACK}/bank?country=nigeria&perPage=200`, {
      headers: { Authorization: `Bearer ${config.PAYSTACK_SECRET_KEY}` },
    })
    if (!res.ok) throw new Error(`paystack /bank ${res.status}`)

    const body = (await res.json()) as { status: boolean; data: Array<{ code: string; name: string; type?: string }> }
    if (!body.status || !Array.isArray(body.data)) throw new Error("paystack /bank malformed")

    const fintechCodes = new Set(STATIC_BANKS.filter((b) => b.fintech).map((b) => b.code))

    /**
     * Paystack's list contains duplicate codes — 5 of 279 at last check, including "Zenith
     * Bank" listed twice identically and several institutions appearing under both a short
     * and a long name. A payout is addressed by code, so two entries sharing one are
     * indistinguishable to us and merely confusing in a picker.
     *
     * Keep one per code, preferring the shorter name, which is reliably the human one:
     * "BANKIT MFB" over "BANKIT MICROFINANCE BANK LTD".
     */
    const byCode = new Map<string, { code: string; name: string; fintech: boolean }>()
    for (const b of body.data) {
      const existing = byCode.get(b.code)
      if (!existing || b.name.length < existing.name.length) {
        byCode.set(b.code, { code: b.code, name: b.name, fintech: fintechCodes.has(b.code) })
      }
    }

    const banks = [...byCode.values()]
      // Fintechs first — that is where most personal accounts now are.
      .sort((a, b) => Number(b.fintech) - Number(a.fintech) || a.name.localeCompare(b.name))

    const withTest = config.NODE_ENV === "production" ? banks : [TEST_BANK, ...banks]

    cache = { banks: withTest, at: Date.now() }
    return withTest
  } catch (error) {
    console.warn("[banks] falling back to the static list", {
      error: error instanceof Error ? error.message : String(error),
    })
    return STATIC_BANKS
  }
}

export async function findBank(code: string): Promise<Bank | undefined> {
  return (await listBanks()).find((b) => b.code === code)
}

/** Ten digits — the NUBAN format every Nigerian bank uses. */
export function isValidAccountNumber(input: string): boolean {
  return /^\d{10}$/.test(input.trim())
}

export type Resolution =
  | { ok: true; accountName: string; cached?: boolean }
  /**
   * `not_found` means the bank looked and there is no such account — the user must fix
   * something. `quota` and `unavailable` mean *we* could not look, which says nothing about
   * the account and must not be reported as if it did.
   */
  | { ok: false; reason: "not_found" | "invalid" | "unavailable" | "quota" }

/**
 * Resolved names, remembered.
 *
 * An account holder's name effectively never changes, and a test key allows only three live
 * resolves a day — so repeating a lookup is pure waste. Caching means demonstrating the same
 * account repeatedly costs one lookup instead of one per attempt, which is the difference
 * between the feature working all afternoon and dying after the third try.
 */
const resolved = new Map<string, { name: string; at: number }>()
const RESOLVE_CACHE_MS = 24 * 60 * 60 * 1000

/**
 * Account number + bank code -> the name on the account.
 *
 * Every name this returns came from the bank, via Paystack. Without a key it returns
 * `unavailable` rather than guessing — there is no such thing as a plausible stand-in for a
 * name someone is about to send irreversible money against.
 */
export async function resolveAccount(
  accountNumber: string,
  bankCode: string,
): Promise<Resolution> {
  if (!isValidAccountNumber(accountNumber)) return { ok: false, reason: "invalid" }
  if (!(await findBank(bankCode))) return { ok: false, reason: "invalid" }

  const cacheKey = `${bankCode}:${accountNumber}`
  const hit = resolved.get(cacheKey)
  if (hit && Date.now() - hit.at < RESOLVE_CACHE_MS) {
    return { ok: true, accountName: hit.name, cached: true }
  }

  /**
   * No key, no name.
   *
   * There is no honest way to produce an account name without asking the bank. Inventing
   * one that a user then trusts is worse than showing nothing: it is a name they will read,
   * believe, and send irreversible money against.
   */
  if (!isConfigured()) return { ok: false, reason: "unavailable" }

  try {
    const url = `${PAYSTACK}/bank/resolve?account_number=${encodeURIComponent(accountNumber)}&bank_code=${encodeURIComponent(bankCode)}`
    const res = await fetch(url, {
      headers: { Authorization: `Bearer ${config.PAYSTACK_SECRET_KEY}` },
    })

    /**
     * 429 is the test-mode quota, not a mistyped account.
     *
     * Paystack allows three live resolves a day on a test key. Reporting that as
     * "no account found" would send someone off to re-check digits that were correct —
     * so it is surfaced separately, and the UI says checks are unavailable.
     */
    if (res.status === 429) {
      console.warn("[banks] paystack resolve quota reached (test keys allow 3/day)")
      return { ok: false, reason: "quota" }
    }

    // 422 is Paystack's answer for an account it cannot find — a normal outcome here rather
    // than an error. Note its `code` says `invalid_bank_code` even when the bank code is
    // fine, so the message is not worth surfacing verbatim.
    if (res.status === 400 || res.status === 422) return { ok: false, reason: "not_found" }
    if (!res.ok) return { ok: false, reason: "unavailable" }

    const body = (await res.json()) as { status: boolean; data?: { account_name?: string } }
    const name = body.data?.account_name
    if (!body.status || !name) return { ok: false, reason: "not_found" }

    resolved.set(cacheKey, { name, at: Date.now() })
    return { ok: true, accountName: name }
  } catch (error) {
    console.warn("[banks] resolve failed", {
      error: error instanceof Error ? error.message : String(error),
    })
    return { ok: false, reason: "unavailable" }
  }
}

