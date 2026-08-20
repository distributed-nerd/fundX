import { config, isProduction } from "../config.js"

/**
 * Outbound SMS.
 *
 * Two jobs: delivering OTPs, and delivering results that outlived their USSD session. The
 * second is the important one — a USSD session lasts ~20s, and anything slower than that has
 * to reach the user out of band or not at all.
 *
 * Providers are chosen by `SMS_PROVIDER`. Termii is the default for Nigeria: it is a local
 * provider with direct routes to MTN, Glo, Airtel and 9mobile, and it handles NCC sender-ID
 * registration — which is not optional. Nigerian carriers filter unregistered alphanumeric
 * senders, and a filtered OTP does not bounce, it simply never arrives.
 *
 * With nothing configured this logs instead of sending, so the e2e suites and offline work
 * do not need a funded account or burn credit on every run.
 */

type Sender = (to: string, message: string) => Promise<void>

let sender: Sender | null = null

async function getSender(): Promise<Sender> {
  if (sender) return sender
  sender = await build()
  return sender
}

async function build(): Promise<Sender> {
  switch (config.SMS_PROVIDER) {
    case "termii":
      if (!config.TERMII_API_KEY) break
      return termii()

    case "africastalking":
      if (!config.AT_API_KEY) break
      return africasTalking()
  }

  console.warn(
    `[sms] no credentials for provider "${config.SMS_PROVIDER}" — logging instead of sending`,
  )
  return async (to, message) => {
    console.log(`[sms:dev] -> ${to}: ${message}`)
  }
}

/**
 * Termii.
 *
 * Two details decide whether anything arrives in Nigeria:
 *
 *   - The number must have no leading "+", so E.164 is stripped here rather than at the call
 *     site — everything else in the system stores and passes "+234…".
 *   - The `dnd` channel. Most Nigerian numbers sit on the Do-Not-Disturb list by default and
 *     `generic` traffic cannot cross it. An OTP sent on the wrong channel is accepted by the
 *     API and then quietly dropped by the carrier.
 */
function termii(): Sender {
  const endpoint = "https://api.ng.termii.com/api/sms/send"

  return async (to, message) => {
    const res = await fetch(endpoint, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        to: to.replace(/^\+/, ""),
        from: config.SMS_SENDER_ID,
        sms: message,
        type: "plain",
        channel: config.TERMII_CHANNEL,
        api_key: config.TERMII_API_KEY,
      }),
      signal: AbortSignal.timeout(15_000),
    })

    const body = (await res.json().catch(() => null)) as
      | { message_id?: string; message?: string; code?: string }
      | null

    // Termii answers 200 with an error message rather than a status code, so the body has to
    // be inspected — a non-ok HTTP check alone would report silent failures as successes.
    if (!res.ok || !body?.message_id) {
      throw new Error(`termii: ${body?.message ?? res.status}`)
    }
  }
}

function africasTalking(): Sender {
  let client: { SMS: { send(o: Record<string, unknown>): Promise<unknown> } } | null = null

  return async (to, message) => {
    if (!client) {
      const { default: AfricasTalking } = await import("africastalking")
      client = AfricasTalking({ apiKey: config.AT_API_KEY!, username: config.AT_USERNAME })
    }
    await client.SMS.send({
      to: [to],
      message,
      ...(config.SMS_SENDER_ID ? { from: config.SMS_SENDER_ID } : {}),
    })
  }
}

/** True when a real provider is configured. */
export function isLive(): boolean {
  if (config.SMS_PROVIDER === "termii") return Boolean(config.TERMII_API_KEY)
  if (config.SMS_PROVIDER === "africastalking") return Boolean(config.AT_API_KEY)
  return false
}

/**
 * May this number actually be texted?
 *
 * In production, yes — that is what production is. Outside it, only numbers on the allowlist,
 * because a live key combined with test data means sending real OTPs to whichever strangers
 * happen to own the numbers the fixtures invented, and paying per message to do it. That is
 * not hypothetical: it already happened once here, to +2348031234567, for ₦5.90.
 */
function mayDeliver(to: string): boolean {
  if (!isLive()) return false

  // Fixture numbers never send, regardless of anything else. A wildcard allowlist is a
  // convenience; texting strangers on every test run is not a trade worth making for it.
  if (config.SMS_TEST_PREFIX && to.startsWith(config.SMS_TEST_PREFIX)) return false

  if (isProduction) return true
  return config.SMS_ALLOWLIST.includes("*") || config.SMS_ALLOWLIST.includes(to)
}

/**
 * Send, and never let a failure take down the caller.
 *
 * A transfer that succeeded on-chain must not be reported as failed because a notification
 * didn't go out. The reference implementation calls its SMS helper unawaited, and that helper
 * throws — an unhandled rejection that can take the process down under recent Node.
 */
export async function sendSms(to: string, message: string): Promise<void> {
  if (!mayDeliver(to)) {
    console.log(`[sms:dev] -> ${to}: ${message}`)
    return
  }

  try {
    const send = await getSender()
    await send(to, message)
  } catch (error) {
    console.error("[sms] delivery failed", {
      to: isProduction ? redact(to) : to,
      error: error instanceof Error ? error.message : String(error),
    })
  }
}

/**
 * Send an OTP, and say whether it actually went.
 *
 * Unlike a notification, a failed OTP is not something to swallow: the user is staring at a
 * code entry screen waiting for a message that will never arrive. The caller needs to know.
 */
export async function sendOtp(to: string, code: string): Promise<{ delivered: boolean }> {
  const message = `${code} is your FundX code. It expires in ${config.OTP_TTL_MINUTES} minutes. Do not share it with anyone.`

  if (!mayDeliver(to)) {
    console.log(`[sms:dev] -> ${to}: ${message}`)
    return { delivered: false }
  }

  try {
    const send = await getSender()
    await send(to, message)
    return { delivered: true }
  } catch (error) {
    console.error("[sms] OTP delivery failed", {
      to: isProduction ? redact(to) : to,
      error: error instanceof Error ? error.message : String(error),
    })
    return { delivered: false }
  }
}

/** Message templates, kept together so tone and length stay consistent. */
export const messages = {
  sent: (amount: string, who: string, balance: string) =>
    `You sent ${amount} to ${who}. New balance: ${balance}.`,
  received: (amount: string, who: string) => `You received ${amount} from ${who}.`,
  settling: (amount: string, who: string) =>
    `Your ${amount} payment to ${who} is on its way. We'll text you when it lands.`,
  welcome: (handle: string) =>
    `Welcome to FundX. Your handle is ${handle} — share it to get paid.`,
  pinChanged: () =>
    "Your FundX PIN was changed. If this wasn't you, contact support immediately.",
  withdrawn: (naira: string, bank: string) =>
    `Withdrawal of ${naira} sent to your ${bank} account.`,
}

const redact = (phone: string) => `${phone.slice(0, 5)}…${phone.slice(-2)}`
