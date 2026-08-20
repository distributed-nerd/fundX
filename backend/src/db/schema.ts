import { sql } from "drizzle-orm"
import {
  bigint,
  boolean,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
} from "drizzle-orm/pg-core"

/**
 * FundX schema.
 *
 * Postgres is derivable, not authoritative. The chain is the source of truth for balances;
 * this database makes reads fast and holds the things that cannot go on-chain — PIN hashes,
 * raw phone numbers, session state. Dropping `transfers` and re-indexing from chain must
 * reproduce every balance exactly. If that stops being true, FundX is an ordinary fintech
 * with a blockchain sticker on it.
 */

export const users = pgTable(
  "users",
  {
    id: text("id").primaryKey(),

    /** E.164, e.g. "+2348031234567". The identity a telco can vouch for. */
    phone: text("phone").notNull(),

    /** Bare label — "suleiman". The ".fundX" suffix is presentation, never storage. */
    username: text("username").notNull(),

    displayName: text("display_name").notNull(),

    /**
     * BIP-44 index this user's key derives from. THE KEY ITSELF IS NEVER STORED — not
     * plaintext, not encrypted. It is re-derived in memory from the master mnemonic at
     * signing time and discarded. A dump of this table leaks who the users are, which is a
     * real privacy incident, but leaks no funds.
     *
     * Deriving is a search, not a calculation: a Quai address encodes its shard in its first
     * 9 bits, so only ~1 in 512 indices lands in Cyprus-1. Storing the index means paying
     * that search once, at signup.
     */
    derivationIndex: integer("derivation_index").notNull(),

    /** Cyprus-1 Quai address. Always starts 0x00. */
    address: text("address").notNull(),

    /** argon2id. Never the PIN itself, and never logged. */
    pinHash: text("pin_hash").notNull(),

    /** Consecutive failures. Reset on success. */
    pinAttempts: integer("pin_attempts").notNull().default(0),
    lockedUntil: timestamp("locked_until", { withTimezone: true }),

    /**
     * Linked Nigerian bank account.
     *
     * Currently unwritten: USSD no longer has a separate off-ramp step (withdrawing to your
     * own bank is Transfer -> Fiat with your own number), and the web has no off-ramp screen
     * yet. Kept because a "remembered bank" is the obvious next step for both — saving the
     * caller from typing ten digits on a keypad every time.
     */
    bankAccountNumber: text("bank_account_number"),
    bankCode: text("bank_code"),
    bankName: text("bank_name"),

    /** False disables the account without deleting the history. */
    active: boolean("active").notNull().default(true),

    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("users_phone_key").on(t.phone),
    uniqueIndex("users_username_key").on(t.username),
    uniqueIndex("users_derivation_index_key").on(t.derivationIndex),
    uniqueIndex("users_address_key").on(t.address),
  ],
)

export const transfers = pgTable(
  "transfers",
  {
    id: text("id").primaryKey(),

    fromUserId: text("from_user_id").references(() => users.id),
    toUserId: text("to_user_id").references(() => users.id),

    /** Kept alongside the user ids so history survives even for external counterparties. */
    fromAddress: text("from_address").notNull(),
    toAddress: text("to_address").notNull(),

    /**
     * Base units, 6 decimals — 1_000_000 is $1.00. Always positive; direction is derived
     * per-viewer from whether they are the sender or the recipient.
     *
     * BIGINT holds ~9.2e18, which at 6 decimals is about $9.2 trillion. Drizzle returns it
     * as a JS bigint (`mode: "bigint"`), never a float.
     */
    amount: bigint("amount", { mode: "bigint" }).notNull(),

    memo: text("memo"),

    /** pending | confirmed | failed */
    status: text("status").notNull().default("pending"),

    /** Null until broadcast. */
    txHash: text("tx_hash"),

    /**
     * Deduplication key. For USSD this is the gateway's sessionId; for the web API the
     * client supplies one. The unique index is what actually prevents a double-spend when a
     * gateway retries — not a check-then-insert, which races.
     */
    idempotencyKey: text("idempotency_key"),

    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("transfers_idempotency_key").on(t.idempotencyKey),
    index("transfers_from_user_idx").on(t.fromUserId, t.createdAt),
    index("transfers_to_user_idx").on(t.toUserId, t.createdAt),
    uniqueIndex("transfers_tx_hash_key").on(t.txHash),
  ],
)

/**
 * USSD session state.
 *
 * Africa's Talking resends the whole accumulated `text` on every hop, and it is tempting to
 * derive the menu position from `text.split("*").length`. That conflates "which branch" with
 * "how deep", and — more importantly — cannot survive a retried side effect. So `text` is
 * only the input source; position lives here, keyed by the gateway's sessionId.
 */
export const ussdSessions = pgTable("ussd_sessions", {
  sessionId: text("session_id").primaryKey(),
  phone: text("phone").notNull(),

  /** Which flow the caller is in: "menu" | "register" | "send" | "balance". */
  flow: text("flow").notNull(),
  step: text("step").notNull(),

  /** Partial input gathered so far — recipient, amount, a PIN attempt count. */
  payload: jsonb("payload").notNull().default({}),

  /**
   * The exact `text` and reply from the previous hop. If a request arrives with identical
   * text, we replay the stored response rather than re-running the step. This is what makes
   * a gateway retry harmless.
   */
  lastText: text("last_text"),
  lastResponse: text("last_response"),

  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
})

export const otpCodes = pgTable(
  "otp_codes",
  {
    id: text("id").primaryKey(),
    phone: text("phone").notNull(),
    /** Hashed — an OTP is a credential, and the table is as sensitive as a password store. */
    codeHash: text("code_hash").notNull(),
    attempts: integer("attempts").notNull().default(0),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    consumedAt: timestamp("consumed_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("otp_phone_idx").on(t.phone, t.createdAt)],
)

/**
 * Proof that a phone number was verified, issued by OTP verification and consumed by signup.
 *
 * The frontend keeps `verified: true` in sessionStorage, where the user controls it. The
 * server cannot trust that, so signup requires one of these instead.
 */
export const signupTokens = pgTable("signup_tokens", {
  tokenHash: text("token_hash").primaryKey(),
  phone: text("phone").notNull(),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  consumedAt: timestamp("consumed_at", { withTimezone: true }),
})

export const webSessions = pgTable(
  "web_sessions",
  {
    /** Only the hash is stored, so a database dump cannot be replayed as a live session. */
    tokenHash: text("token_hash").primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => users.id),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("web_sessions_user_idx").on(t.userId)],
)

/** How far the chain indexer has read. Quai ships no indexer, so this table is the indexer. */
export const indexerState = pgTable("indexer_state", {
  id: text("id").primaryKey(),
  // A bigint literal default cannot be serialised by drizzle-kit; express it as SQL.
  lastBlock: bigint("last_block", { mode: "bigint" }).notNull().default(sql`0`),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
})

export type UserRow = typeof users.$inferSelect
export type TransferRow = typeof transfers.$inferSelect
export type UssdSessionRow = typeof ussdSessions.$inferSelect

/**
 * Pre-derived Cyprus-1 addresses, waiting to be claimed at signup.
 *
 * Finding one is a search, not a calculation: a Quai address encodes region, zone and ledger
 * in its first 9 bits, so only ~1 in 512 BIP-44 indices lands in Cyprus-1 on the Quai ledger.
 * Measured cost is ~566ms of *blocking* CPU per address — unacceptable on a request path in a
 * single-threaded runtime, where it would stall every other request.
 *
 * So a background filler keeps this table stocked and signup claims a row instantly.
 */
export const addressPool = pgTable(
  "address_pool",
  {
    derivationIndex: integer("derivation_index").primaryKey(),
    address: text("address").notNull(),
    claimedAt: timestamp("claimed_at", { withTimezone: true }),

    /**
     * Set when an address must never be handed out again.
     *
     * An address that has belonged to someone cannot go back in the pool, however sure we
     * are that the account is gone. Its balance lives on chain, not in this database, so a
     * recycled address hands its tokens to whoever receives it next — measured here as 5 of
     * 25 "free" addresses still holding mUSDT after a user cleanup released them.
     *
     * Retiring costs a few hundred milliseconds of key-grinding to replace the address.
     * That is the entire price, and it buys the guarantee that no one is ever issued an
     * account with someone else's money in it.
     */
    retiredAt: timestamp("retired_at", { withTimezone: true }),

    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("address_pool_address_key").on(t.address),
    index("address_pool_unclaimed_idx").on(t.claimedAt),
  ],
)

/**
 * Balances for the mock chain adapter.
 *
 * This table stands in for on-chain state while no token is deployed. It is deliberately
 * separate from anything the domain reads directly — services always go through
 * `ChainAdapter`, so swapping to real Quai leaves this table orphaned rather than requiring
 * a migration of business data.
 */
export const mockBalances = pgTable("mock_balances", {
  address: text("address").primaryKey(),
  amount: bigint("amount", { mode: "bigint" }).notNull().default(sql`0`),
})


/**
 * Naira payouts — off-ramp to your own bank, and fiat transfers to someone else's.
 *
 * ⚠️ There is no payout rail connected. Nothing here moves real naira: the quote, the debit
 * and the record are real, and the bank leg is simulated. Wiring a provider (Paystack,
 * Flutterwave, Monnify) means giving `services/payouts.ts` a real `dispatch` and nothing
 * else in the system changes.
 *
 * Recorded separately from `transfers` because these are a different thing: a transfer moves
 * tokens between two addresses we control, a payout leaves the system entirely.
 */
export const payouts = pgTable(
  "payouts",
  {
    id: text("id").primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => users.id),

    /** "offramp" (to yourself) or "fiat_transfer" (to someone else). */
    kind: text("kind").notNull(),

    /** Debited from the balance, in 6-decimal base units. */
    amountUsd: bigint("amount_usd", { mode: "bigint" }).notNull(),
    /** Credited in whole naira, at the rate quoted when the user confirmed. */
    amountNgn: bigint("amount_ngn", { mode: "bigint" }).notNull(),
    /** The rate shown on screen before confirmation — quoted, not reconstructed later. */
    rate: integer("rate").notNull(),

    bankAccountNumber: text("bank_account_number").notNull(),
    bankCode: text("bank_code").notNull(),
    bankName: text("bank_name").notNull(),
    accountName: text("account_name"),

    /** pending | simulated | paid | failed */
    status: text("status").notNull().default("pending"),
    /** Provider reference once a real rail exists. */
    reference: text("reference"),

    idempotencyKey: text("idempotency_key"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("payouts_idempotency_key").on(t.idempotencyKey),
    index("payouts_user_idx").on(t.userId, t.createdAt),
  ],
)

export type PayoutRow = typeof payouts.$inferSelect


/**
 * The last known good FX rate.
 *
 * Persisted so a restart during an upstream outage quotes something real rather than a
 * number from a config file. Stored in hundredths — a rate is fractional (1350.25) and an
 * integer column keeps it exact.
 */
export const fxRates = pgTable("fx_rates", {
  pair: text("pair").primaryKey(),
  rateHundredths: integer("rate_hundredths").notNull(),
  source: text("source").notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
})
