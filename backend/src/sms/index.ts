import { config, isProduction } from "../config.js"

/**
 * Outbound SMS.
 *
 * Two jobs: delivering OTPs, and delivering results that outlived their USSD session. The
 * second is the important one — a USSD session lasts ~20s, and anything slower than that has
 * to reach the user out of band or not at all.
 *
 * Without credentials this logs instead of sending, so the whole flow is exercisable offline.
 */

type Sender = (to: string, message: string) => Promise<void>

let sender: Sender | null = null

async function getSender(): Promise<Sender> {
  if (sender) return sender

  if (!config.AT_API_KEY) {
    sender = async (to, message) => {
      console.log(`[sms:dev] -> ${to}: ${message}`)
    }
    return sender
  }

  const { default: AfricasTalking } = await import("africastalking")
  const client = AfricasTalking({ apiKey: config.AT_API_KEY, username: config.AT_USERNAME })

  sender = async (to, message) => {
    await client.SMS.send({
      to: [to],
      message,
      ...(config.AT_SENDER_ID ? { from: config.AT_SENDER_ID } : {}),
    })
  }
  return sender
}

/**
 * Send, and never let a failure take down the caller.
 *
 * A transfer that succeeded on-chain must not be reported as failed because a notification
 * didn't go out. The reference implementation calls its SMS helper unawaited, and that helper
 * throws — an unhandled rejection that can take the process down under recent Node.
 */
export async function sendSms(to: string, message: string): Promise<void> {
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
