import { NGN_RATE_FALLBACK } from "@/lib/money";
import type {
  AccountResolution,
  Balance,
  Bank,
  Payout,
  PayoutResult,
  PublicUser,
  ResolveResult,
  SendResult,
  Transfer,
  User,
} from "@/lib/types";
import { BANKS, clear } from "./store";

/**
 * Mock API client.
 *
 * Every function here matches an endpoint the Node backend will expose, with the
 * same arguments and the same return shape. When the backend lands, the bodies
 * become fetch calls and nothing above this layer changes.
 */

/** Small artificial latency so loading states are real rather than theoretical. */
const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * A GET against the API that returns `fallback` rather than throwing.
 *
 * Read paths are all "show what we have"; a network blip should render an empty list, not
 * unmount the screen. Writes deliberately do NOT use this — a send that may or may not have
 * happened must surface as a failure the user can see.
 */
async function get<T>(path: string, fallback: T): Promise<T> {
  try {
    const res = await fetch(`${API_BASE}/api${path}`, { credentials: "include" });
    if (!res.ok) return fallback;
    return (await res.json()) as T;
  } catch {
    return fallback;
  }
}

/**
 * Handles must start with a letter. That is not cosmetic: an all-digit handle is
 * indistinguishable from a phone number, and both are valid ways to address a
 * payment. Requiring a leading letter keeps the two namespaces disjoint.
 */
export const USERNAME_RULE = /^[a-z][a-z0-9_]{2,15}$/;

/** Handles are shown as `suleiman.fundX` and stored as the bare label. */
export const HANDLE_SUFFIX = ".fundX";

export function formatHandle(username: string): string {
  return `${username}${HANDLE_SUFFIX}`;
}

/**
 * Accept a handle the forgiving way — "suleiman.fundX", "suleiman.FUNDX",
 * "suleiman", or "@suleiman" — and return the canonical bare label, or null.
 * Lenient on input, canonical on display.
 */
export function parseHandle(input: string): string | null {
  const label = input
    .trim()
    .toLowerCase()
    .replace(/^@/, "")
    .replace(/\.fundx$/, "");
  return USERNAME_RULE.test(label) ? label : null;
}

/** True when the input is made only of characters a phone number can contain. */
function looksLikePhone(input: string): boolean {
  return /^[\d+\s()-]+$/.test(input.trim());
}

export function normalizePhone(input: string): string | null {
  const digits = input.replace(/[^\d+]/g, "");

  // Nigerian numbers, in the forms people actually type them.
  if (/^\+234\d{10}$/.test(digits)) return digits;
  if (/^234\d{10}$/.test(digits)) return `+${digits}`;
  if (/^0\d{10}$/.test(digits)) return `+234${digits.slice(1)}`;
  if (/^\d{10}$/.test(digits)) return `+234${digits}`;

  // Anything else with a country code, loosely.
  if (/^\+\d{8,15}$/.test(digits)) return digits;

  return null;
}

/** "+2348031234567" -> "+234 803 123 4567" */
export function prettyPhone(e164: string): string {
  if (/^\+234\d{10}$/.test(e164)) {
    const n = e164.slice(4);
    return `+234 ${n.slice(0, 3)} ${n.slice(3, 6)} ${n.slice(6)}`;
  }
  return e164;
}

// ---------------------------------------------------------------- onboarding

/**
 * Ask the backend to text a one-time code.
 *
 * Real: this reaches Termii. `devCode` comes back only when nothing was actually sent —
 * an unconfigured provider, or a number the dev allowlist blocked — so the flow stays
 * testable without ever handing out a code that was genuinely delivered.
 */
export async function requestOtp(phone: string): Promise<{
  sent: boolean;
  delivered?: boolean;
  devCode?: string;
  /** The number already has an account — no code was sent, and none would help. */
  registered?: boolean;
  /** Too many attempts from this address. */
  limited?: boolean;
}> {
  try {
    const res = await fetch(`${API_BASE}/api/auth/otp/request`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      credentials: "include",
      body: JSON.stringify({ phone }),
    });
    if (res.status === 429) return { sent: false, limited: true };
    if (!res.ok) return { sent: false };
    return await res.json();
  } catch {
    return { sent: false };
  }
}

/**
 * Check the code.
 *
 * On success the backend returns a short-lived signup token — its own record that this
 * number was proven. Signup requires it, because the client cannot be trusted to assert
 * that it verified anything.
 */
export async function verifyOtp(
  phone: string,
  code: string,
): Promise<{ ok: boolean; signupToken?: string; registered?: boolean }> {
  try {
    const res = await fetch(`${API_BASE}/api/auth/otp/verify`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      credentials: "include",
      body: JSON.stringify({ phone, code }),
    });
    if (!res.ok) return { ok: false };
    return await res.json();
  } catch {
    return { ok: false };
  }
}

/** Is the handle free? Answered by the backend, which owns the reserved list. */
export async function checkUsername(
  username: string,
): Promise<{ available: boolean; reason?: "taken" | "reserved" | "invalid" }> {
  // Cheap local rejection first, so a half-typed handle never becomes a request.
  if (!USERNAME_RULE.test(username.toLowerCase())) {
    return { available: false, reason: "invalid" };
  }

  try {
    const res = await fetch(
      `${API_BASE}/api/auth/username/check?username=${encodeURIComponent(username)}`,
      { credentials: "include" },
    );
    if (!res.ok) return { available: false, reason: "invalid" };
    return await res.json();
  } catch {
    return { available: false, reason: "invalid" };
  }
}

export type SignupResult =
  | { ok: true; user: User }
  | {
      ok: false;
      /**
       * `registered` means this phone number already has an account — the user meant to
       * sign in. It is deliberately distinct from `taken`, which is about a handle: telling
       * an existing user their handle was taken sent them back to invent another one
       * forever, since the handle was never the problem.
       */
      reason: "taken" | "reserved" | "invalid" | "unauthorized" | "unavailable" | "registered";
    };

/**
 * Create the account for real.
 *
 * The backend derives a genuine Cyprus-1 address, hashes the PIN with argon2 and sets a
 * session cookie. The phone number comes from the signup token rather than the request, so
 * a client cannot claim a number it has not proven.
 *
 * Local state is still written afterwards because balance, transfers and send are all still
 * mocked — the account is real, the money is not yet.
 */
export async function createAccount(input: {
  phone: string;
  username: string;
  displayName: string;
  pin: string;
  signupToken: string;
}): Promise<SignupResult> {
  try {
    const res = await fetch(`${API_BASE}/api/auth/signup`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      credentials: "include",
      body: JSON.stringify({
        signupToken: input.signupToken,
        username: input.username,
        displayName: input.displayName,
        pin: input.pin,
      }),
    });

    const body = await res.json().catch(() => null);

    if (!res.ok) {
      const reason = body?.error;
      if (res.status === 401) return { ok: false, reason: "unauthorized" };
      return {
        ok: false,
        reason: ["taken", "reserved", "invalid", "registered"].includes(reason)
          ? reason
          : "invalid",
      };
    }

    /**
     * Nothing is persisted locally.
     *
     * This used to seed a mock store with the user and their PIN in plaintext, which the
     * mock API then read back. Every one of those reads is a server call now, so the copy
     * was written and never used — a plaintext PIN in localStorage serving no purpose.
     */
    const user = body.user as User;
    return { ok: true, user };
  } catch {
    return { ok: false, reason: "unavailable" };
  }
}

// ------------------------------------------------------------------- account

/**
 * Who is signed in, according to the server.
 *
 * The session is the `HttpOnly` cookie the backend sets, not the localStorage blob — so a
 * revoked or expired session logs the user out properly rather than leaving the UI showing
 * an account whose requests all 401.
 */
/**
 * Sign in an account that already exists.
 *
 * Phone and PIN, with no OTP. Texting a code on every sign-in would cost real money per
 * login and buy little: the PIN is the second factor, argon2id-hashed server-side, and the
 * server locks the account after repeated wrong attempts.
 *
 * The server answers identically for an unknown number and a wrong PIN, deliberately, so
 * this cannot be used to find out who has an account. That means `wrong_pin` here honestly
 * covers both, and the message must not claim to know which.
 */
export async function login(
  phone: string,
  pin: string,
): Promise<
  | { ok: true; user: User }
  | { ok: false; reason: "wrong_pin" | "locked" | "unavailable" }
> {
  try {
    const res = await fetch(`${API_BASE}/api/auth/login`, {
      method: "POST",
      credentials: "include",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ phone, pin }),
    });

    const body = await res.json().catch(() => null);
    if (!res.ok) {
      return { ok: false, reason: body?.error === "locked" ? "locked" : "wrong_pin" };
    }
    return { ok: true, user: body.user as User };
  } catch {
    return { ok: false, reason: "unavailable" };
  }
}

export async function getSession(): Promise<User | null> {
  try {
    const res = await fetch(`${API_BASE}/api/me`, { credentials: "include" });
    if (!res.ok) return null;
    const body = await res.json();
    return body ?? null;
  } catch {
    return null;
  }
}

/**
 * The user's balance, read from the MockUSDT contract on Orchard.
 *
 * Not from localStorage and not from a database column — the backend calls `balanceOf` on
 * the deployed token for this user's derived address, and that number is what appears on
 * screen. If someone mints or sends tokens to that address by any other route, this reflects
 * it, because there is nothing in between to disagree with.
 */
export async function getBalance(): Promise<Balance> {
  try {
    const res = await fetch(`${API_BASE}/api/balance`, { credentials: "include" });
    if (!res.ok) return { usd: "0", ngnRate: await liveRate() };
    return await res.json();
  } catch {
    return { usd: "0", ngnRate: await liveRate() };
  }
}

/** The live USD/NGN rate from the backend, with the last-resort constant if it is down. */
export async function liveRate(): Promise<number> {
  try {
    const res = await fetch(`${API_BASE}/api/rate`);
    if (!res.ok) return NGN_RATE_FALLBACK;
    const body = (await res.json()) as { rate?: number };
    return typeof body.rate === "number" ? body.rate : NGN_RATE_FALLBACK;
  } catch {
    return NGN_RATE_FALLBACK;
  }
}

export async function getTransfers(): Promise<Transfer[]> {
  return get<Transfer[]>("/transfers", []);
}

export async function getTransfer(id: string): Promise<Transfer | null> {
  return get<Transfer | null>(`/transfers/${encodeURIComponent(id)}`, null);
}

/**
 * Poll a transfer until it stops being pending.
 *
 * Orchard confirmations were measured at ~36s against a ~27s block interval, well past the
 * backend's confirm budget, so a send that worked perfectly still comes back `pending`. The
 * receipt shows that state honestly and settles itself here rather than making the user
 * wait on a spinner before they see anything.
 *
 * Seven minutes is for a bad node rather than a slow chain: against a healthy RPC a transfer
 * settled in 34s, but Orchard's public endpoint was measured refusing 7 of 10 calls, and an
 * unreachable node reads as "pending" by design. The balance on the home screen comes from
 * the token contract, so it updates on the real timescale regardless — this poll only
 * settles the word on the receipt.
 *
 * Returns the last known state on timeout — pending is a real answer, not a failure.
 */
export async function watchTransfer(
  id: string,
  onUpdate: (t: Transfer) => void,
  { every = 6_000, timeout = 420_000 }: { every?: number; timeout?: number } = {},
): Promise<void> {
  const deadline = Date.now() + timeout;

  while (Date.now() < deadline) {
    await delay(every);
    const latest = await getTransfer(id);
    if (!latest) continue;
    onUpdate(latest);
    if (latest.status !== "pending") return;
  }
}

export async function signOut(): Promise<void> {
  try {
    await fetch(`${API_BASE}/api/auth/signout`, {
      method: "POST",
      credentials: "include",
    });
  } catch {
    /* clearing local state still signs them out of this device */
  }
  // Still called: it removes state written by earlier builds, including that stored PIN.
  clear();
}

// ------------------------------------------------------------------ payments

/**
 * Resolve "@bola" or a phone number to a person.
 *
 * The result deliberately carries a name and handle and no address — the sender
 * confirms *who* they are paying, never a hex string.
 */
export async function resolveRecipient(query: string): Promise<ResolveResult> {
  const trimmed = query.trim();
  if (!trimmed) return { found: false, reason: "invalid" };

  /**
   * The server decides. It owns the user table, and it is the only place that can tell
   * "nobody has that handle" apart from "that handle is malformed" — the distinction the
   * sender actually needs before they retype a number.
   *
   * Both a handle and a phone number go through as-is: `GET /resolve` tries phone first,
   * because an all-digit string can never be a handle.
   */
  return get<ResolveResult>(
    `/resolve?q=${encodeURIComponent(trimmed)}`,
    // A lookup we could not perform is not a person who does not exist. Saying "not on
    // FundX" here would be a lie the sender might act on.
    { found: false, reason: "invalid" },
  );
}

/** The handful of people you've paid before, newest first. */
export async function getRecentRecipients(): Promise<PublicUser[]> {
  return get<PublicUser[]>("/recipients/recent", []);
}

export async function sendMoney(input: {
  recipient: string;
  amount: bigint;
  memo?: string;
  pin: string;
  /** Supplied by the caller so a retried submit cannot move money twice. */
  idempotencyKey?: string;
}): Promise<SendResult> {
  try {
    const res = await fetch(`${API_BASE}/api/transfers`, {
      method: "POST",
      credentials: "include",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        recipient: input.recipient,
        // Base units as a string. JSON has no bigint, and a float here would be a bug that
        // silently loses cents on large amounts.
        amount: input.amount.toString(),
        memo: input.memo?.trim() ? input.memo.trim() : undefined,
        pin: input.pin,
        idempotencyKey: input.idempotencyKey,
      }),
    });

    const body = await res.json().catch(() => null);

    if (!res.ok || !body?.ok) {
      const reason = body?.reason;
      // Only reasons the UI has a sentence for. Anything else is reported as a chain error
      // rather than guessed at, because the one thing we must not do is imply the money
      // moved when we do not know.
      const known = [
        "wrong_pin",
        "insufficient",
        "not_found",
        "self",
        "locked",
        "invalid",
        "chain_error",
      ] as const;
      type Known = (typeof known)[number];
      return {
        ok: false,
        reason: known.includes(reason) ? (reason as Known) : "chain_error",
      };
    }

    return { ok: true, transfer: body.transfer as Transfer };
  } catch {
    /**
     * The request never completed, so we genuinely do not know whether it landed. Reported
     * as a chain error — never as a success, and never as "insufficient", which would tell
     * the user something false about their balance.
     */
    return { ok: false, reason: "chain_error" };
  }
}

// -------------------------------------------------------------------- bank payouts

/**
 * The banks a payout can be sent to.
 *
 * Becomes `GET /api/banks`. Mirrors the six the USSD menu can fit on one screen, so both
 * interfaces offer the same choices.
 */
export async function getBanks(): Promise<Bank[]> {
  return getBanksLive();
}

/** Ten digits — the NUBAN format every Nigerian bank uses. */
export function isValidAccountNumber(input: string): boolean {
  return /^\d{10}$/.test(input.trim());
}

/**
 * Send naira to a Nigerian bank account.
 *
 * Becomes `POST /api/payouts` with `kind: "fiat_transfer"`.
 *
 * ⚠️ No payout rail is connected. The quote and the dollar debit are real; the bank leg is
 * simulated, which is why the result comes back `status: "simulated"` and never `"paid"`.
 * Nothing in the UI should present it as settled.
 */
export async function sendToBank(input: {
  bankCode: string;
  accountNumber: string;
  /** Whole naira, as typed — this is the unit the recipient's bank will show them. */
  amountNgn: bigint;
  accountName?: string;
  pin: string;
  idempotencyKey?: string;
}): Promise<PayoutResult> {
  /**
   * The API settles in dollars, so the naira the user typed is converted here.
   *
   * Rounded up, so a rounding step never under-debits the balance for what is paid out.
   * Scaled to hundredths because the rate is fractional and `BigInt` of a float throws —
   * a crash this flow actually had once live rates replaced the fixed one.
   *
   * The server re-quotes the naira from this dollar figure at its own rate, so the amount
   * the recipient receives can differ from the typed figure by a naira. The confirmation
   * screen shows the server's number, which is the one that settles.
   */
  const rate = await liveRate();
  const hundredths = BigInt(Math.round(rate * 100));
  const amountUsd = (input.amountNgn * 100_000_000n + hundredths - 1n) / hundredths;

  try {
    const res = await fetch(`${API_BASE}/api/payouts`, {
      method: "POST",
      credentials: "include",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        kind: "fiat_transfer",
        amount: amountUsd.toString(),
        bankAccountNumber: input.accountNumber,
        bankCode: input.bankCode,
        accountName: input.accountName?.trim() || undefined,
        pin: input.pin,
        idempotencyKey: input.idempotencyKey,
      }),
    });

    const body = await res.json().catch(() => null);

    if (!res.ok || !body?.ok) {
      const reason = body?.reason;
      const known = ["wrong_pin", "insufficient", "invalid"] as const;
      return {
        ok: false,
        reason: known.includes(reason) ? (reason as (typeof known)[number]) : "invalid",
      };
    }

    return { ok: true, payout: body.payout as Payout };
  } catch {
    return { ok: false, reason: "invalid" };
  }
}

/**
 * Where the backend lives.
 *
 * Exported so there is exactly one of these. `lib/rate.tsx` used to repeat the expression,
 * which meant two defaults that could drift apart silently.
 *
 * Point somewhere else with `NEXT_PUBLIC_API_BASE` — a `.env.local` holding
 * `NEXT_PUBLIC_API_BASE=http://localhost:4000` is the way to work against a backend running
 * on your own machine. Note that `NEXT_PUBLIC_` values are inlined at *build* time, not read
 * at runtime, so a deployment needs the variable set before `next build`, not after.
 *
 * The trailing slash is stripped because every call here appends `/api/...`, and
 * `https://host//api/balance` is not the same URL to every proxy.
 */
export const API_BASE = (
  process.env.NEXT_PUBLIC_API_BASE ?? "https://fundxapi.blockfuselabs.com"
).replace(/\/+$/, "");

/**
 * Account number + bank code -> the name on the account.
 *
 * This one is NOT mocked. It calls the backend, which asks Paystack, which asks the bank.
 * There is no honest way to fake it: a name is the single check a human can perform before
 * sending money that cannot be reversed, and a name we invented is worse than no name —
 * the user reads it, believes it, and sends anyway.
 *
 * If the backend is down or has no Paystack key, this reports `unavailable` and the UI says
 * so plainly.
 */
export async function resolveAccount(
  accountNumber: string,
  bankCode: string,
): Promise<AccountResolution> {
  if (!isValidAccountNumber(accountNumber)) return { ok: false, reason: "invalid" };

  try {
    const url = `${API_BASE}/api/banks/resolve?account_number=${encodeURIComponent(accountNumber)}&bank_code=${encodeURIComponent(bankCode)}`;
    const res = await fetch(url, { credentials: "include" });
    if (!res.ok) return { ok: false, reason: "unavailable" };

    const body = (await res.json()) as AccountResolution;
    return body?.ok ? { ok: true, accountName: body.accountName } : body;
  } catch {
    return { ok: false, reason: "unavailable" };
  }
}

/**
 * The banks a payout can go to.
 *
 * Prefers the backend, which serves Paystack's canonical list. Falls back to the bundled
 * list if the backend is unreachable — a stale bank *name* cannot cost anyone money, unlike
 * a fabricated account holder.
 */
export async function getBanksLive(): Promise<Bank[]> {
  try {
    const res = await fetch(`${API_BASE}/api/banks`);
    if (!res.ok) throw new Error(String(res.status));
    const body = (await res.json()) as Bank[];
    return Array.isArray(body) && body.length > 0 ? body : BANKS;
  } catch {
    return BANKS;
  }
}

export async function getPayouts(): Promise<Payout[]> {
  return get<Payout[]>("/payouts", []);
}
