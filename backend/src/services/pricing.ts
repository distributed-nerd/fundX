import { eq } from "drizzle-orm"
import { config } from "../config.js"
import { db } from "../db/index.js"
import { fxRates } from "../db/schema.js"

/**
 * What a dollar is worth in naira.
 *
 * FundX holds USDT and pays out naira, so this number sits under every quote, every
 * off-ramp and every balance screen. Getting it wrong is not cosmetic: the hardcoded 1560
 * this replaces was about 15% away from the market, which on a ₦100,000 payout is ₦15,000
 * of somebody's money.
 *
 * Primary source is CoinGecko's tether→NGN price, deliberately rather than a USD→NGN feed.
 * The balance is USDT, not dollars, and what matters is what a USDT holder can actually get
 * — which is the crypto market rate, not the interbank one. They track closely today; they
 * have not always, and Nigeria is exactly the market where that gap reappears.
 *
 * A conventional FX feed is the fallback, and the last good rate is persisted so a restart
 * during an outage quotes something real rather than a number from a config file.
 */

export type Rate = {
  /** Naira per dollar, e.g. 1350.25. */
  rate: number
  source: "coingecko" | "er-api" | "cache" | "fallback"
  at: string
}

const COINGECKO = "https://api.coingecko.com/api/v3/simple/price?ids=tether&vs_currencies=ngn"
const ER_API = "https://open.er-api.com/v6/latest/USD"

/**
 * Five minutes.
 *
 * Long enough to stay well inside CoinGecko's free-tier limits under USSD load, short
 * enough that a quote is never meaningfully stale. Rates do not move far in five minutes;
 * rate limits bite immediately.
 */
const CACHE_MS = 5 * 60 * 1000

/** Anything outside this is a broken feed, not a market move. Refuse it. */
const PLAUSIBLE = { min: 100, max: 100_000 }

let memo: { value: Rate; at: number } | null = null
let inflight: Promise<Rate> | null = null

export async function getRate(): Promise<Rate> {
  if (memo && Date.now() - memo.at < CACHE_MS) return memo.value

  // Collapse concurrent callers onto one request — USSD and web can arrive together, and
  // three simultaneous refreshes would spend three times the rate limit for one answer.
  inflight ??= refresh().finally(() => {
    inflight = null
  })

  return inflight
}

async function refresh(): Promise<Rate> {
  for (const attempt of [fromCoinGecko, fromErApi]) {
    try {
      const rate = await attempt()
      if (rate && isPlausible(rate.rate)) {
        memo = { value: rate, at: Date.now() }
        void persist(rate)
        return rate
      }
    } catch (error) {
      console.warn("[pricing] source failed", {
        error: error instanceof Error ? error.message : String(error),
      })
    }
  }

  // Both feeds are down. A stale real rate beats a number someone typed into a config file
  // months ago, so the last good one is preferred over the configured floor.
  const stored = await lastGood()
  if (stored) {
    console.warn("[pricing] all sources failed, using the last known rate", stored)
    memo = { value: stored, at: Date.now() }
    return stored
  }

  const fallback: Rate = {
    rate: config.NGN_RATE_FALLBACK,
    source: "fallback",
    at: new Date().toISOString(),
  }
  console.error("[pricing] no source and no stored rate — quoting the configured fallback")
  return fallback
}

async function fromCoinGecko(): Promise<Rate | null> {
  const res = await fetch(COINGECKO, { signal: AbortSignal.timeout(6000) })
  if (!res.ok) throw new Error(`coingecko ${res.status}`)

  const body = (await res.json()) as { tether?: { ngn?: number } }
  const value = body.tether?.ngn
  if (typeof value !== "number") return null

  return { rate: value, source: "coingecko", at: new Date().toISOString() }
}

async function fromErApi(): Promise<Rate | null> {
  const res = await fetch(ER_API, { signal: AbortSignal.timeout(6000) })
  if (!res.ok) throw new Error(`er-api ${res.status}`)

  const body = (await res.json()) as { result?: string; rates?: Record<string, number> }
  const value = body.rates?.NGN
  if (body.result !== "success" || typeof value !== "number") return null

  return { rate: value, source: "er-api", at: new Date().toISOString() }
}

const isPlausible = (rate: number) =>
  Number.isFinite(rate) && rate >= PLAUSIBLE.min && rate <= PLAUSIBLE.max

/** Stored in hundredths, so a fractional rate survives an integer column exactly. */
async function persist(rate: Rate): Promise<void> {
  try {
    await db
      .insert(fxRates)
      .values({
        pair: "USD_NGN",
        rateHundredths: Math.round(rate.rate * 100),
        source: rate.source,
        updatedAt: new Date(),
      })
      .onConflictDoUpdate({
        target: fxRates.pair,
        set: {
          rateHundredths: Math.round(rate.rate * 100),
          source: rate.source,
          updatedAt: new Date(),
        },
      })
  } catch (error) {
    console.warn("[pricing] could not persist the rate", {
      error: error instanceof Error ? error.message : String(error),
    })
  }
}

async function lastGood(): Promise<Rate | null> {
  try {
    const [row] = await db.select().from(fxRates).where(eq(fxRates.pair, "USD_NGN"))
    if (!row) return null
    return {
      rate: row.rateHundredths / 100,
      source: "cache",
      at: row.updatedAt.toISOString(),
    }
  } catch {
    return null
  }
}

/** Warm the cache at boot so the first user does not pay the latency. */
export async function warm(): Promise<void> {
  const rate = await getRate()
  console.log(`FX USD/NGN ${rate.rate} (${rate.source})`)
}
