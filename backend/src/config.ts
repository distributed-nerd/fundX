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

  /**
   * Paystack. With a key, bank lists and account-name resolution are live; without one the
   * static list is used and names come back marked unverified.
   */
  PAYSTACK_SECRET_KEY: z.string().optional(),

  /**
   * Last-resort USD/NGN, used only if every rate source fails AND nothing is stored. Not
   * the operating rate — that comes from `services/pricing.ts`.
   */
  NGN_RATE_FALLBACK: z.coerce.number().positive().default(1350),

  /** Browser origins allowed to call this API with credentials. Comma separated. */
  WEB_ORIGINS: z
    .string()
    .default("http://localhost:3000")
    .transform((v) => v.split(",").map((o) => o.trim()).filter(Boolean)),

  /**
   * SMS provider. Termii is the default for Nigeria — a local provider with direct carrier
   * routes, and one that handles NCC sender-ID registration. That registration is not
   * optional: Nigerian carriers filter unregistered alphanumeric senders, and a filtered OTP
   * does not bounce, it simply never arrives.
   */
  SMS_PROVIDER: z.enum(["termii", "africastalking", "none"]).default("termii"),

  /**
   * The sender ID that appears as the message's "from".
   *
   * Defaults to Termii's shared `N-Alert`, which is pre-approved and works on an account
   * with nothing of its own registered. A custom ID like "FundX" needs NCC registration
   * first — until that clears, Nigerian carriers filter the message silently.
   */
  SMS_SENDER_ID: z.string().default("N-Alert"),

  /**
   * Termii channel. `dnd` reaches numbers on the Do-Not-Disturb list — which most Nigerian
   * numbers are on by default, and which plain `generic` traffic cannot cross. Transactional
   * OTPs are exactly what it is for.
   */
  TERMII_CHANNEL: z.enum(["dnd", "generic", "whatsapp"]).default("dnd"),

  TERMII_API_KEY: z.string().optional(),

  /**
   * Numbers allowed to receive real SMS outside production. Comma separated, E.164.
   *
   * Outside production this is required for anything to actually send. That is deliberate:
   * a live key plus test data means texting strangers whose numbers happen to match the
   * placeholders, and paying for the privilege. An e2e run signs up several accounts, so
   * without this each run costs real money and delivers real OTPs to real people.
   *
   * `*` allows every number. Empty in production means no restriction — that is the point
   * of production.
   */
  SMS_ALLOWLIST: z
    .string()
    .default("")
    .transform((v) => v.split(",").map((n) => n.trim()).filter(Boolean)),

  /**
   * Numbers starting with this never receive a real SMS, whatever the allowlist says.
   *
   * The e2e suites sign up several accounts per run. With a wildcard allowlist that would be
   * real messages to whoever owns the invented fixture numbers, at real cost — so the
   * fixtures use a reserved prefix that is blocked here rather than relying on discipline.
   */
  SMS_TEST_PREFIX: z.string().default("+2349000"),

  /** Africa's Talking. The USSD callback uses this account too. */
  AT_USERNAME: z.string().default("sandbox"),
  AT_API_KEY: z.string().optional(),

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
