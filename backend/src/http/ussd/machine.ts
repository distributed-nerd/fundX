import { formatHandle, isWeakPin } from "../../lib/identity.js"
import { formatNGN, formatUSD, parseAmount } from "../../lib/money.js"
import { getRate } from "../../services/pricing.js"
import * as accounts from "../../services/accounts.js"
import { attemptsLeft, changePin, verifyPin } from "../../services/auth.js"
import * as banksService from "../../services/banks.js"
import * as payoutsService from "../../services/payouts.js"
import * as transfersService from "../../services/transfers.js"
import { messages, sendSms } from "../../sms/index.js"
import type { UserRow } from "../../db/schema.js"

/**
 * The USSD state machine.
 *
 * Pure with respect to transport: it takes the caller, their session state and the single
 * thing they just typed, and returns a reply plus the next state. The Express handler deals
 * with parsing, persistence and replay.
 *
 * The tree follows the reference implementation (shaaibu7/FundX) — a root menu shown to
 * everyone, account creation as option 1, a handle generated from the name — extended with
 * off-ramp, change PIN, and a crypto/fiat split under Transfer.
 *
 *   ""              CON 1. Create an account  2. Check wallet balance
 *                       3. Transfer  4. Change PIN
 *
 *   1               name -> passcode -> END account created
 *   2               END balance
 *   3               CON 1. Crypto  2. Fiat
 *   3*1             recipient -> amount -> PIN -> END sent
 *   3*2             account no -> bank -> amount (₦) -> PIN -> END sent
 *   4               current PIN -> new PIN -> confirm -> END changed
 *
 * There is no separate off-ramp entry: withdrawing to your own bank is Transfer -> Fiat with
 * your own account number, and a fifth option earning its keep only through intent would
 * cost every caller a line of screen they pay for.
 *
 * Three rules that differ from the reference, each because of a defect there:
 *
 *   1. **Every state has a default.** Unrecognised input re-prompts. Theirs falls through
 *      every branch, leaves `response` undefined, and sends an empty body.
 *
 *   2. **Validation failures re-prompt with CON, they don't hang up.** Theirs ENDs on a bad
 *      amount or a wrong PIN, so one mistyped digit means redialling.
 *
 *   3. **Nothing waits on a chain confirmation indefinitely.** The budget lives in the chain
 *      adapter; past it the caller is told an SMS is coming.
 *
 * Screens are budgeted to ~160 characters, with interpolated names truncated rather than
 * allowed to overflow — a name is user-controlled and a screen is not elastic.
 */

export type Flow = "menu" | "register" | "send" | "fiat" | "pin"

export type SessionState = {
  flow: Flow
  step: string
  payload: Record<string, unknown>
}

export type Reply = { kind: "CON" | "END"; text: string; next: SessionState }

const con = (text: string, next: SessionState): Reply => ({ kind: "CON", text, next })
const end = (text: string, next: SessionState): Reply => ({ kind: "END", text, next })

/** Names are user-controlled; screens are not elastic. */
const short = (name: string, max = 16) =>
  name.length <= max ? name : `${name.slice(0, max - 1)}…`

export const START: SessionState = { flow: "menu", step: "root", payload: {} }
export const REGISTER_START = START

const MENU =
  "Welcome to FundX Wallet\n1. Create an account\n2. Check wallet balance\n3. Transfer\n4. Change PIN"

/**
 * Banks, six to a screen.
 *
 * There are ~36 once the fintechs are included, and a USSD screen holds about 160
 * characters. Paging keeps the common case — OPay, Moniepoint, PalmPay, Kuda are first —
 * on the very first page, so most callers never page at all.
 */
const BANKS_PER_PAGE = 6

async function bankPage(page: number): Promise<{ text: string; banks: banksService.Bank[] }> {
  const all = await banksService.listBanks()
  const pages = Math.ceil(all.length / BANKS_PER_PAGE)
  const safe = ((page % pages) + pages) % pages
  const banks = all.slice(safe * BANKS_PER_PAGE, safe * BANKS_PER_PAGE + BANKS_PER_PAGE)

  const lines = banks.map((b, i) => `${i + 1}. ${short(b.name, 22)}`).join("\n")
  return { text: `Select bank (${safe + 1}/${pages})\n${lines}\n0. More banks`, banks }
}

const noAccount = () => "You do not have an account. Please create one."

export type Context = { phone: string; user: UserRow | null; sessionId: string }

/**
 * Advance one step.
 *
 * `input` is only what the caller typed on this hop — the accumulated `text` is parsed by
 * the transport, and position comes from stored state rather than from counting asterisks.
 * Counting conflates "which branch" with "how deep" and cannot survive a retry.
 */
export async function step(ctx: Context, state: SessionState, input: string): Promise<Reply> {
  if (state.flow === "register") return register(ctx, state, input)
  if (state.flow === "menu") return menu(ctx, state, input)

  // Everything past this point needs an account.
  if (!ctx.user) return end(noAccount(), START)

  switch (state.flow) {
    case "send":
      return send(ctx, ctx.user, state, input)
    case "fiat":
      return fiat(ctx, ctx.user, state, input)
    case "pin":
      return pinChange(ctx, ctx.user, state, input)
    default:
      return con(MENU, START)
  }
}

// -------------------------------------------------------------------------------- menu

async function menu(ctx: Context, state: SessionState, input: string): Promise<Reply> {
  if (state.step !== "root" || input === "") return con(MENU, START)

  switch (input) {
    case "1":
      if (ctx.user) return end("You already have an account.", START)
      return con("Enter full name", { flow: "register", step: "name", payload: {} })

    case "2": {
      if (!ctx.user) return end(noAccount(), START)
      const amount = await transfersService.balanceOf(ctx.user)
      const { rate } = await getRate()
      return end(
        `Your wallet balance: ${formatUSD(amount)}\n(about ${formatNGN(amount, rate)})`,
        START,
      )
    }

    case "3":
      if (!ctx.user) return end(noAccount(), START)
      return con("Transfer\n1. Crypto (FundX user)\n2. Fiat (bank account)", {
        flow: "send",
        step: "kind",
        payload: {},
      })

    case "4":
      if (!ctx.user) return end(noAccount(), START)
      return con("Enter your current PIN", { flow: "pin", step: "current", payload: {} })

    // Never fall through to an empty response.
    default:
      return con(`Please choose 1-4.\n${MENU}`, START)
  }
}

// ------------------------------------------------------------------------ registration

/**
 * Sign-up on a feature phone: a name and a passcode.
 *
 * The whole thesis in two screens. The number comes from the telco rather than being typed,
 * so it is already proven and no OTP is needed; the handle is generated from the name, which
 * is why this is shorter than the web flow.
 */
async function register(ctx: Context, state: SessionState, input: string): Promise<Reply> {
  const payload = state.payload as { name?: string }

  switch (state.step) {
    case "name": {
      const name = input.trim()
      if (name.length < 2) {
        return con("Please enter your full name", { flow: "register", step: "name", payload: {} })
      }
      return con("Enter your passcode (4 digits)", {
        flow: "register",
        step: "pin",
        payload: { name },
      })
    }

    case "pin": {
      if (!/^\d{4}$/.test(input)) return con("Passcode must be 4 digits.\nEnter your passcode", state)
      if (isWeakPin(input)) return con("Too easy to guess.\nEnter your passcode", state)

      const name = payload.name ?? ""
      const created = await accounts.createAccount({
        phone: ctx.phone,
        username: await accounts.generateHandle(name),
        displayName: name,
        pin: input,
      })

      if (!created.ok) {
        return end("Sorry, we could not finish signing you up. Please try again.", START)
      }

      const handle = formatHandle(created.value.username)
      void sendSms(ctx.phone, messages.welcome(handle))
      return end(`Account created.\nYour name is ${handle}\nShare it to get paid.`, START)
    }

    default:
      return con("Enter full name", { flow: "register", step: "name", payload: {} })
  }
}

// ------------------------------------------------------------------------ crypto send

type SendPayload = { recipient?: string; recipientName?: string; amount?: string }

async function send(ctx: Context, user: UserRow, state: SessionState, input: string): Promise<Reply> {
  const payload = state.payload as SendPayload

  switch (state.step) {
    case "kind": {
      if (input === "1") {
        return con("Enter recipient username or phone number", {
          flow: "send",
          step: "recipient",
          payload: {},
        })
      }
      if (input === "2") {
        return con("Enter recipient's 10-digit account number", {
          flow: "fiat",
          step: "account",
          payload: {},
        })
      }
      return con("Please choose 1 or 2.\nTransfer\n1. Crypto (FundX user)\n2. Fiat (bank account)", state)
    }

    case "recipient": {
      const resolved = await accounts.resolveRecipient(input, user.id)
      if (!resolved.ok) {
        // Same three outcomes the web app names, worded for a 182-character screen.
        const why =
          resolved.reason === "not_found"
            ? "Not on FundX yet."
            : resolved.reason === "self"
              ? "That is your own number."
              : "Enter a FundX name or phone number."
        return con(`${why}\nEnter recipient username or phone number`, {
          flow: "send",
          step: "recipient",
          payload: {},
        })
      }
      const to = resolved.value.user
      return con(`Enter amount to transfer to ${short(to.displayName)}`, {
        flow: "send",
        step: "amount",
        payload: { recipient: to.username, recipientName: to.displayName },
      })
    }

    case "amount": {
      const amount = parseAmount(input)
      if (amount === null || amount <= 0n) return con("Please enter a valid amount, like 12.50", state)

      const available = await transfersService.balanceOf(user)
      if (amount > available) {
        return con(`Balance is ${formatUSD(available)}.\nEnter amount to transfer`, state)
      }

      return con("Enter your PIN to confirm transfer", {
        flow: "send",
        step: "pin",
        payload: { ...payload, amount: amount.toString() },
      })
    }

    case "pin": {
      const amount = BigInt(payload.amount ?? "0")

      const result = await transfersService.send({
        from: user,
        recipient: payload.recipient ?? "",
        amount,
        pin: input,
        idempotencyKey: ctx.sessionId,
      })

      if (!result.ok) {
        switch (result.reason) {
          case "wrong_pin":
            return con("Incorrect PIN.\nEnter your PIN to confirm transfer", state)
          case "locked":
            return end("Too many wrong PINs. Your account is locked for a while.", START)
          case "insufficient":
            return end("USDT balance insufficient.", START)
          case "not_found":
            return end("Recipient not found.", START)
          default:
            return end("Could not process transfer. Nothing was taken.", START)
        }
      }

      const { counterparty, confirmed } = result.value
      const who = short(counterparty.displayName)
      const sent = formatUSD(amount)

      if (!confirmed) {
        void sendSms(ctx.phone, messages.settling(sent, who))
        return end("Transfer initiated. You will receive an SMS confirmation.", START)
      }

      const remaining = await transfersService.balanceOf(user)
      void sendSms(ctx.phone, messages.sent(sent, who, formatUSD(remaining)))
      void sendSms(counterparty.phone, messages.received(sent, short(user.displayName)))
      return end(`Sent ${sent} to ${who}.\nBalance: ${formatUSD(remaining)}`, START)
    }

    default:
      return con("Transfer\n1. Crypto (FundX user)\n2. Fiat (bank account)", {
        flow: "send",
        step: "kind",
        payload: {},
      })
  }
}

// ------------------------------------------------------------------------- fiat send

type BankPayload = {
  account?: string
  bankCode?: string
  amount?: string
  accountName?: string
  page?: number
}

/** Pay someone else's Nigerian bank account. The naira leg is simulated — see payouts.ts. */
async function fiat(ctx: Context, user: UserRow, state: SessionState, input: string): Promise<Reply> {
  const payload = state.payload as BankPayload

  switch (state.step) {
    case "account": {
      if (!banksService.isValidAccountNumber(input)) {
        return con("Account number must be 10 digits.\nEnter recipient's account number", state)
      }
      const { text } = await bankPage(0)
      return con(text, { flow: "fiat", step: "bank", payload: { account: input.trim(), page: 0 } })
    }

    case "bank": {
      const page = Number(payload.page ?? 0)

      if (input === "0") {
        const next = await bankPage(page + 1)
        return con(next.text, { flow: "fiat", step: "bank", payload: { ...payload, page: page + 1 } })
      }

      const { text, banks } = await bankPage(page)
      const bank = banks[Number(input) - 1]
      if (!bank) return con(`Please choose 1-${banks.length}, or 0 for more.\n${text}`, state)

      /**
       * Show whose account it is before any money is named.
       *
       * Ten digits cannot be eyeballed and a wrong transfer is irreversible. The name is
       * folded into the amount prompt rather than given its own screen, because every USSD
       * screen costs the caller money — and it appears again at the PIN step, so there are
       * two chances to catch a mistake.
       */
      const resolved = await banksService.resolveAccount(payload.account ?? "", bank.code)
      if (!resolved.ok) {
        const why =
          resolved.reason === "not_found"
            ? "No account found with those details."
            : "Could not check that account right now."
        return con(`${why}\nEnter recipient's account number`, {
          flow: "fiat",
          step: "account",
          payload: {},
        })
      }

      return con(
        `To ${short(resolved.accountName, 20)}\n${short(bank.name, 18)} ${payload.account}\nEnter amount in naira`,
        {
          flow: "fiat",
          step: "amount",
          payload: { ...payload, bankCode: bank.code, accountName: resolved.accountName },
        },
      )
    }

    case "amount": {
      // Entered in naira here, because that is the unit the recipient's bank will show.
      const naira = Number(input.replace(/[^\d]/g, ""))
      if (!Number.isInteger(naira) || naira <= 0) return con("Enter a valid amount in naira", state)

      const { rate } = await getRate()

      /**
       * Convert to base units, rounding up so we never under-debit for what we pay out.
       *
       * Scaled to hundredths first: the live rate is fractional (1343.53) and `BigInt()`
       * throws outright on a non-integer, which is how this crashed the whole flow the
       * moment the hardcoded 1560 was replaced with a real one.
       */
      const hundredths = BigInt(Math.round(rate * 100))
      const amountUsd = (BigInt(naira) * 100_000_000n + hundredths - 1n) / hundredths

      const available = await transfersService.balanceOf(user)
      if (amountUsd > available) {
        return con(`Balance is ${formatUSD(available)}.\nEnter amount in naira`, state)
      }

      return con(
        `Send ₦${naira.toLocaleString("en-NG")}\nto ${short(payload.accountName ?? "", 20)}\nCost ${formatUSD(amountUsd)}\nEnter PIN`,
        { flow: "fiat", step: "pin", payload: { ...payload, amount: amountUsd.toString() } },
      )
    }

    case "pin": {
      const result = await payoutsService.createPayout({
        user,
        kind: "fiat_transfer",
        amountUsd: BigInt(payload.amount ?? "0"),
        bankAccountNumber: payload.account ?? "",
        bankCode: payload.bankCode ?? "",
        accountName: payload.accountName,
        pin: input,
        idempotencyKey: ctx.sessionId,
      })

      if (!result.ok) return payoutFailure(result.reason, state, "Enter PIN")

      const p = result.value
      const remaining = await transfersService.balanceOf(user)
      return end(
        `Sent ₦${p.amountNgn.toLocaleString("en-NG")} to ${short(p.accountName ?? p.bankName, 20)}.\nBalance: ${formatUSD(remaining)}`,
        START,
      )
    }

    default:
      return con("Enter recipient's 10-digit account number", {
        flow: "fiat",
        step: "account",
        payload: {},
      })
  }
}

function payoutFailure(reason: string, state: SessionState, prompt: string): Reply {
  switch (reason) {
    case "wrong_pin":
      return con(`Incorrect PIN.\n${prompt}`, state)
    case "locked":
      return end("Too many wrong PINs. Your account is locked for a while.", START)
    case "insufficient":
      return end("Balance insufficient.", START)
    default:
      return end("Could not process that. Nothing was taken.", START)
  }
}

// ------------------------------------------------------------------------- change PIN

type PinPayload = { current?: string; next?: string }

async function pinChange(ctx: Context, user: UserRow, state: SessionState, input: string): Promise<Reply> {
  const payload = state.payload as PinPayload

  switch (state.step) {
    case "current": {
      if (!/^\d{4}$/.test(input)) return con("PIN must be 4 digits.\nEnter your current PIN", state)

      /**
       * Verified here, at the point of entry.
       *
       * Collecting it and only checking after two more screens means someone who mistypes
       * one digit answers three prompts before being told, and the session ends rather than
       * re-prompting. On a feature phone that is a redial and another billed session.
       *
       * Verifying twice costs nothing: a correct PIN resets the attempt counter, so the
       * second check at `changePin` never consumes one.
       */
      const check = await verifyPin(user, input)
      if (!check.ok) {
        if (check.reason === "locked") {
          return end("Too many wrong PINs. Your account is locked for a while.", START)
        }
        // Re-read to report the count accurately — verifyPin has just incremented it.
        const fresh = await accounts.findById(user.id)
        const left = fresh ? attemptsLeft(fresh) : 0
        return con(
          `Incorrect PIN. ${left} ${left === 1 ? "try" : "tries"} left.\nEnter your current PIN`,
          state,
        )
      }

      return con("Enter your new 4-digit PIN", {
        flow: "pin",
        step: "new",
        payload: { current: input },
      })
    }

    case "new": {
      if (!/^\d{4}$/.test(input)) return con("PIN must be 4 digits.\nEnter your new PIN", state)
      if (isWeakPin(input)) return con("Too easy to guess.\nEnter your new PIN", state)
      if (input === payload.current) {
        return con("New PIN must be different from your current one.\nEnter your new PIN", state)
      }
      return con("Enter your new PIN again", {
        flow: "pin",
        step: "confirm",
        payload: { ...payload, next: input },
      })
    }

    case "confirm": {
      if (input !== payload.next) {
        return con("PINs did not match.\nEnter your new 4-digit PIN", {
          flow: "pin",
          step: "new",
          payload: { current: payload.current },
        })
      }

      const result = await changePin(user, payload.current ?? "", payload.next ?? "")
      if (!result.ok) {
        switch (result.reason) {
          case "wrong_pin":
            return con("Incorrect PIN.\nEnter your current PIN", {
              flow: "pin",
              step: "current",
              payload: {},
            })
          case "locked":
            return end("Too many wrong PINs. Your account is locked for a while.", START)
          default:
            return end("Could not change your PIN. Try again.", START)
        }
      }

      void sendSms(ctx.phone, messages.pinChanged())
      return end("Your PIN has been changed.", START)
    }

    default:
      return con("Enter your current PIN", { flow: "pin", step: "current", payload: {} })
  }
}
