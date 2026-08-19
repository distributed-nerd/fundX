import "dotenv/config"
import { z } from "zod"

/**
 * Configuration, validated once at boot.
 *
 * Anything missing or malformed stops the process here rather than surfacing as a confusing
 * failure three layers down when someone tries to send money.
 */

const schema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  PORT: z.coerce.number().int().positive().default(4000),

  DATABASE_URL: z.string().min(1),

  /** "mock" keeps balances in Postgres; "quai" signs real transactions on Orchard. */
  CHAIN_ADAPTER: z.enum(["mock", "quai"]).default("mock"),
  CHAIN_ID: z.coerce.number().int().default(15000),
  RPC_URL: z.string().url().default("https://orchard.rpc.quai.network"),
  MOCK_USDT_ADDRESS: z.string().optional(),

  /**
   * The seed every user key derives from. Nothing derived from it is ever written down.
   * Required for the quai adapter; optional under mock, where no signing happens.
   */
  MASTER_MNEMONIC: z.string().optional(),
  TREASURY_PK: z.string().optional(),

  SESSION_SECRET: z.string().min(16),

  AT_USERNAME: z.string().default("sandbox"),
  AT_API_KEY: z.string().optional(),
  AT_SENDER_ID: z.string().optional(),

  /** Wrong-PIN attempts before an account locks, and for how long. */
  PIN_MAX_ATTEMPTS: z.coerce.number().int().positive().default(5),
  PIN_LOCKOUT_MINUTES: z.coerce.number().int().positive().default(15),

  OTP_TTL_MINUTES: z.coerce.number().int().positive().default(10),
  SESSION_TTL_DAYS: z.coerce.number().int().positive().default(30),

  /**
   * How long a USSD request waits for a transaction receipt before giving up and promising
   * an SMS instead. Quai finalises in ~5s and a USSD session lasts ~20s, so a confirmed
   * receipt on the handset is usually achievable — but it cannot be assumed.
   */
  CONFIRM_BUDGET_MS: z.coerce.number().int().positive().default(8000),

  /** USSD sessions are short-lived; the gateway abandons them long before this. */
  USSD_SESSION_TTL_MINUTES: z.coerce.number().int().positive().default(5),
})

const parsed = schema.safeParse(process.env)

if (!parsed.success) {
  const issues = parsed.error.issues
    .map((i) => `  ${i.path.join(".") || "(root)"}: ${i.message}`)
    .join("\n")
  console.error(`Invalid configuration:\n${issues}\n\nSee .env.example.`)
  process.exit(1)
}

export const config = parsed.data

if (config.CHAIN_ADAPTER === "quai") {
  if (!config.MASTER_MNEMONIC) {
    console.error("CHAIN_ADAPTER=quai requires MASTER_MNEMONIC.")
    process.exit(1)
  }
  if (!config.MOCK_USDT_ADDRESS) {
    console.error("CHAIN_ADAPTER=quai requires MOCK_USDT_ADDRESS — deploy the token first.")
    process.exit(1)
  }
}

export const isProduction = config.NODE_ENV === "production"
