import { NGN_RATE } from "@/lib/money";
import type {
  Balance,
  PublicUser,
  ResolveResult,
  SendResult,
  Transfer,
  User,
} from "@/lib/types";
import {
  DIRECTORY,
  clear,
  isReserved,
  mockAddress,
  mockTxHash,
  read,
  seed,
  write,
} from "./store";

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

export async function requestOtp(_phone: string): Promise<{ sent: true }> {
  await delay(600);
  return { sent: true };
}

export async function verifyOtp(
  _phone: string,
  code: string,
): Promise<{ ok: boolean }> {
  await delay(500);
  // The mock accepts any six digits. The real backend checks a one-time code.
  return { ok: /^\d{6}$/.test(code) };
}

export async function checkUsername(
  username: string,
): Promise<{ available: boolean; reason?: "taken" | "reserved" | "invalid" }> {
  await delay(280);
  const handle = username.toLowerCase();

  if (!USERNAME_RULE.test(handle)) return { available: false, reason: "invalid" };
  if (isReserved(handle)) return { available: false, reason: "reserved" };
  if (DIRECTORY.some((d) => d.username === handle)) {
    return { available: false, reason: "taken" };
  }
  return { available: true };
}

export async function createAccount(input: {
  phone: string;
  username: string;
  displayName: string;
  pin: string;
}): Promise<{ user: User }> {
  await delay(700);

  const user: User = {
    id: `u_${Date.now()}`,
    phone: input.phone,
    username: input.username.toLowerCase(),
    displayName: input.displayName.trim() || `@${input.username.toLowerCase()}`,
    address: mockAddress(),
  };

  write(seed(user, input.pin));
  return { user };
}

// ------------------------------------------------------------------- account

export async function getSession(): Promise<User | null> {
  const state = read();
  return state?.user ?? null;
}

export async function getBalance(): Promise<Balance> {
  await delay(200);
  const state = read();
  return { usd: state?.balance ?? "0", ngnRate: NGN_RATE };
}

export async function getTransfers(): Promise<Transfer[]> {
  await delay(260);
  return read()?.transfers ?? [];
}

export async function getTransfer(id: string): Promise<Transfer | null> {
  await delay(160);
  return read()?.transfers.find((t) => t.id === id) ?? null;
}

export async function signOut(): Promise<void> {
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
  await delay(340);

  const trimmed = query.trim();
  if (!trimmed) return { found: false, reason: "invalid" };

  const self = read()?.user;
  const found = (d: (typeof DIRECTORY)[number]): ResolveResult => ({
    found: true,
    user: { username: d.username, displayName: d.displayName },
  });

  // Phone first. A digits-only string can never be a handle (handles start with
  // a letter), so testing the handle pattern first would swallow phone numbers.
  if (looksLikePhone(trimmed)) {
    const phone = normalizePhone(trimmed);
    if (!phone) return { found: false, reason: "invalid" };
    if (self && phone === self.phone) return { found: false, reason: "invalid" };

    const hit = DIRECTORY.find((d) => d.phone === phone);
    return hit ? found(hit) : { found: false, reason: "not_found" };
  }

  const label = parseHandle(trimmed);
  if (!label) return { found: false, reason: "invalid" };
  if (self && label === self.username) return { found: false, reason: "invalid" };

  const hit = DIRECTORY.find((d) => d.username === label);
  return hit ? found(hit) : { found: false, reason: "not_found" };
}

/** The handful of people you've paid before, newest first. */
export async function getRecentRecipients(): Promise<PublicUser[]> {
  await delay(140);
  const transfers = read()?.transfers ?? [];
  const seen = new Set<string>();
  const out: PublicUser[] = [];

  for (const t of transfers) {
    const handle = t.counterparty.username;
    if (!handle || seen.has(handle)) continue;
    seen.add(handle);
    out.push({ username: handle, displayName: t.counterparty.displayName });
    if (out.length === 4) break;
  }
  return out;
}

export async function sendMoney(input: {
  recipient: string;
  amount: bigint;
  memo?: string;
  pin: string;
}): Promise<SendResult> {
  const state = read();
  if (!state) return { ok: false, reason: "not_found" };

  await delay(400);
  if (input.pin !== state.pin) return { ok: false, reason: "wrong_pin" };

  const balance = BigInt(state.balance);
  if (input.amount > balance) return { ok: false, reason: "insufficient" };

  const label = parseHandle(input.recipient);
  const hit = label ? DIRECTORY.find((d) => d.username === label) : undefined;
  if (!hit) return { ok: false, reason: "not_found" };

  // Stand-in for broadcasting and awaiting a receipt on Cyprus-1.
  await delay(1_400);

  const transfer: Transfer = {
    id: `t_${Date.now()}`,
    direction: "out",
    counterparty: { username: hit.username, displayName: hit.displayName },
    amount: input.amount.toString(),
    memo: input.memo?.trim() ? input.memo.trim() : null,
    status: "confirmed",
    txHash: mockTxHash(),
    createdAt: new Date().toISOString(),
  };

  write({
    ...state,
    balance: (balance - input.amount).toString(),
    transfers: [transfer, ...state.transfers],
  });

  return { ok: true, transfer };
}
