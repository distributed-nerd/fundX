import { desc, isNull, sql } from "drizzle-orm"
import { config } from "../config.js"
import { db } from "../db/index.js"
import { addressPool } from "../db/schema.js"
import { Deriver } from "../chain/derive.js"

/**
 * The pre-derived address pool.
 *
 * Finding a Cyprus-1 address costs ~566ms of blocking CPU, because only ~1 in 512 BIP-44
 * indices lands in the right shard on the right ledger. Doing that inside a signup request
 * would stall the event loop for every other caller, so a filler runs it in the background
 * and signup claims a ready row.
 */

const LOW_WATER = 8
const TARGET = 24

let deriver: Deriver | null = null
let filling = false

function getDeriver(): Deriver | null {
  if (!config.MASTER_MNEMONIC) return null
  deriver ??= new Deriver(config.MASTER_MNEMONIC)
  return deriver
}

export async function unclaimedCount(): Promise<number> {
  const [row] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(addressPool)
    .where(isNull(addressPool.claimedAt))
  return row?.n ?? 0
}

/**
 * Take one address out of the pool.
 *
 * `FOR UPDATE SKIP LOCKED` is what makes this safe under concurrency — two simultaneous
 * signups take different rows instead of blocking or, worse, both taking the same one.
 */
export async function claimAddress(): Promise<{ index: number; address: string }> {
  const claimed = await db.execute<{ derivation_index: number; address: string }>(sql`
    update ${addressPool}
       set claimed_at = now()
     where derivation_index = (
       select derivation_index
         from ${addressPool}
        where claimed_at is null
        order by derivation_index
        limit 1
          for update skip locked
     )
    returning derivation_index, address
  `)

  const row = claimed.rows[0]
  if (row) {
    void fillPool() // top up in the background; never awaited on the request path
    return { index: row.derivation_index, address: row.address }
  }

  // Pool ran dry. Derive synchronously rather than fail a signup — slow, but correct.
  const d = getDeriver()
  if (!d) throw new Error("MASTER_MNEMONIC is not configured")

  const next = await nextIndexToTry()
  const found = d.findNext(next)
  if (!found) throw new Error("could not derive a Cyprus-1 address")

  await db
    .insert(addressPool)
    .values({ derivationIndex: found.index, address: found.address, claimedAt: new Date() })
    .onConflictDoNothing()

  void fillPool()
  return found
}

/** The index to resume searching from: one past the highest we have already derived. */
async function nextIndexToTry(): Promise<number> {
  const [row] = await db
    .select({ index: addressPool.derivationIndex })
    .from(addressPool)
    .orderBy(desc(addressPool.derivationIndex))
    .limit(1)
  return row ? row.index + 1 : 0
}

/**
 * Keep the pool stocked.
 *
 * Deliberately serial and yielding between derivations: this is CPU-bound work in a
 * single-threaded runtime, and the point is to stay out of the way of requests.
 */
export async function fillPool(target = TARGET): Promise<void> {
  if (filling) return
  const d = getDeriver()
  if (!d) return

  const have = await unclaimedCount()
  if (have >= LOW_WATER && have >= target) return

  filling = true
  try {
    let cursor = await nextIndexToTry()

    for (let n = have; n < target; n++) {
      const found = d.findNext(cursor)
      if (!found) break

      await db
        .insert(addressPool)
        .values({ derivationIndex: found.index, address: found.address })
        .onConflictDoNothing()

      cursor = found.index + 1

      // Hand the loop back so requests are served between derivations.
      await new Promise((resolve) => setImmediate(resolve))
    }
  } finally {
    filling = false
  }
}
