import { sql } from "drizzle-orm"
import { config, isProduction } from "../config.js"
import { db, pool } from "./index.js"

/**
 * Wipe all account data.
 *
 * Clears users and everything hanging off them, so the database holds no leftover test
 * accounts. Two things are deliberately kept:
 *
 *   - `fx_rates`, because a real cached rate is more useful than none and costs nothing.
 *   - `address_pool` rows, which are *released* rather than deleted. Each one cost roughly
 *     566ms of blocking CPU to derive — only ~1 in 512 BIP-44 indices lands in Cyprus-1 —
 *     and they carry no on-chain state, so throwing them away would mean paying that search
 *     again for nothing.
 *
 * Refuses to run in production. This deletes every user.
 */
async function reset() {
  if (isProduction) {
    console.error("refusing to run against NODE_ENV=production")
    process.exit(1)
  }

  const before = await counts()

  // CASCADE so foreign keys don't dictate the order; RESTART IDENTITY for any sequences.
  await db.execute(sql`
    truncate table
      transfers, payouts, ussd_sessions, web_sessions,
      otp_codes, signup_tokens, mock_balances, users
    restart identity cascade
  `)

  const released = await db.execute(sql`
    update address_pool set claimed_at = null where claimed_at is not null
  `)

  const after = await counts()

  console.log(`\n  database: ${config.DATABASE_URL.replace(/:[^:@]+@/, ":***@")}\n`)
  for (const [table, n] of Object.entries(before)) {
    console.log(`  ${table.padEnd(16)} ${String(n).padStart(5)} -> ${after[table] ?? 0}`)
  }
  console.log(`\n  released ${released.rowCount ?? 0} pool addresses back for reuse`)
  console.log(`  kept the cached FX rate\n`)

  await pool.end()
}

async function counts(): Promise<Record<string, number>> {
  const { rows } = await db.execute<{ t: string; n: string }>(sql`
    select 'users' t, count(*) n from users
    union all select 'transfers', count(*) from transfers
    union all select 'payouts', count(*) from payouts
    union all select 'ussd_sessions', count(*) from ussd_sessions
    union all select 'web_sessions', count(*) from web_sessions
    union all select 'otp_codes', count(*) from otp_codes
    union all select 'signup_tokens', count(*) from signup_tokens
    union all select 'mock_balances', count(*) from mock_balances
  `)
  return Object.fromEntries(rows.map((r) => [r.t, Number(r.n)]))
}

await reset()
