import type { Transfer, User } from "@/lib/types";

/**
 * Mock persistence.
 *
 * Stands in for Postgres + the chain until the backend exists. Everything here
 * is replaced wholesale later; nothing outside `lib/api` should import it.
 */

const KEY = "fundx.state.v1";

export type Persisted = {
  user: User;
  /** Base units as a string. */
  balance: string;
  transfers: Transfer[];
  /** Mock only. The real PIN is Argon2-hashed server-side and never leaves it. */
  pin: string;
};

/** Other people on FundX, so recipient lookup has something to find. */
export const DIRECTORY: Array<{
  username: string;
  displayName: string;
  phone: string;
}> = [
  { username: "bola", displayName: "Bola Adeyemi", phone: "+2348031234567" },
  { username: "chidi", displayName: "Chidi Okonkwo", phone: "+2347065554433" },
  { username: "amaka", displayName: "Amaka Nwosu", phone: "+2348122223344" },
  { username: "tunde", displayName: "Tunde Bakare", phone: "+2349087654321" },
  { username: "ify", displayName: "Ifeoma Eze", phone: "+2348055512345" },
];

const RESERVED = new Set([
  "fundx",
  "admin",
  "support",
  "help",
  "root",
  "me",
  "you",
  "team",
]);

export function isReserved(username: string): boolean {
  return RESERVED.has(username.toLowerCase());
}

function hex(length: number): string {
  const chars = "0123456789abcdef";
  let out = "";
  for (let i = 0; i < length; i += 1) {
    out += chars[Math.floor(Math.random() * chars.length)];
  }
  return out;
}

/**
 * A plausible Cyprus-1 Quai address. The first 9 bits encode region, zone and
 * ledger, so a Cyprus-1 Quai address always begins "0x00" — the real backend
 * derives these from the master mnemonic via BIP-44.
 */
export function mockAddress(): string {
  return `0x00${hex(38)}`;
}

export function mockTxHash(): string {
  return `0x${hex(64)}`;
}

export function read(): Persisted | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = window.localStorage.getItem(KEY);
    return raw ? (JSON.parse(raw) as Persisted) : null;
  } catch {
    return null;
  }
}

export function write(state: Persisted): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(KEY, JSON.stringify(state));
  } catch {
    /* storage full or blocked — the demo continues in memory */
  }
}

export function clear(): void {
  if (typeof window === "undefined") return;
  window.localStorage.removeItem(KEY);
}

function minutesAgo(n: number): string {
  return new Date(Date.now() - n * 60_000).toISOString();
}

/**
 * Seed a new account with a small history.
 *
 * A brand-new account with an empty screen makes it impossible to see how the
 * product reads in use, so the demo account arrives looking lived-in. The last
 * entry is an external deposit — the "money arrived from abroad" case the
 * Receive screen exists for.
 */
export function seed(user: User, pin: string): Persisted {
  const transfers: Transfer[] = [
    {
      id: "t_5",
      direction: "in",
      counterparty: { username: "chidi", displayName: "Chidi Okonkwo" },
      amount: "12000000",
      memo: "Balance for the fabric",
      status: "confirmed",
      txHash: mockTxHash(),
      createdAt: minutesAgo(140),
    },
    {
      id: "t_4",
      direction: "out",
      counterparty: { username: "amaka", displayName: "Amaka Nwosu" },
      amount: "4000000",
      memo: null,
      status: "confirmed",
      txHash: mockTxHash(),
      createdAt: minutesAgo(1_500),
    },
    {
      id: "t_3",
      direction: "out",
      counterparty: { username: "tunde", displayName: "Tunde Bakare" },
      amount: "23500000",
      memo: "Rent — August",
      status: "confirmed",
      txHash: mockTxHash(),
      createdAt: minutesAgo(2_900),
    },
    {
      id: "t_2",
      direction: "in",
      counterparty: { username: "bola", displayName: "Bola Adeyemi" },
      amount: "8500000",
      memo: null,
      status: "confirmed",
      txHash: mockTxHash(),
      createdAt: minutesAgo(4_320),
    },
    {
      id: "t_1",
      direction: "in",
      counterparty: { username: null, displayName: "Received from outside FundX", external: true },
      amount: "50000000",
      memo: null,
      status: "confirmed",
      txHash: mockTxHash(),
      createdAt: minutesAgo(7_200),
    },
  ];

  return { user, balance: "40000000", transfers, pin };
}
