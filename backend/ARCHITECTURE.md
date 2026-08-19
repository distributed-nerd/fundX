# FundX backend — architecture

One API, two front doors: the Next.js web app and an Africa's Talking USSD flow.

That is the whole constraint. **Anything the web can do, USSD must be able to do, through the
same code.** A feature that only works in one is a fork in the product.

---

## Structure

```
backend/
├── src/
│   ├── services/          domain logic — the ONLY place business rules live
│   │   ├── accounts.ts      register, resolve a recipient, handle availability
│   │   ├── auth.ts          OTP, PIN verification, sessions, lockout
│   │   ├── transfers.ts     send, history, idempotency
│   │   └── pricing.ts       NGN rate
│   ├── chain/
│   │   ├── adapter.ts       ChainAdapter interface
│   │   ├── quai.ts          quais SDK — derivation, gas drip, MockUSDT
│   │   └── mock.ts          in-database, for tests and offline work
│   ├── db/
│   │   ├── schema.ts        Drizzle schema
│   │   └── migrations/
│   ├── http/
│   │   ├── api/             JSON routes for Next.js
│   │   └── ussd/            Africa's Talking adapter
│   ├── sms/                 Africa's Talking SMS
│   └── index.ts
├── docker-compose.yml       Postgres on 5433
└── ARCHITECTURE.md
```

### The rule that makes it work

**`http/ussd` and `http/api` contain no business rules and no chain calls.** Each parses its
own input format, calls the same service function, and formats the result.

```
POST /api/transfers   ─┐
                       ├─→ transfers.send({ fromUserId, recipient, amount, pin, idempotencyKey })
POST /api/ussd/:secret ─┘
```

This is the one lesson worth taking from the reference implementation (`shaaibu7/FundX`),
which does the opposite: all of its logic sits inside a single Express handler, so
`createUser`, `getBalance` and `transfer` don't exist as callable functions. Adding a web API
there would mean writing everything twice.

---

## Stack

| | | Why |
|---|---|---|
| TypeScript | | Money handling needs types |
| Express 5 | | Matches the reference; nothing here needs more |
| Drizzle + Postgres 18 | Docker, port **5433** | SQL-first migrations, clean bigint. Leaves the local Postgres on 5432 alone |
| `quais` `1.0.0-alpha.56` | | Only SDK that can send Quai transactions |
| `argon2` | | PIN hashing |
| `zod` | | Request validation at both doors |
| `africastalking` | | USSD callback + SMS |

---

## Data model

```
users              id, phone_e164 (unique), username (unique, bare label),
                   display_name, derivation_index (unique), address,
                   pin_hash, pin_attempts, locked_until, status, created_at

transfers          id, from_user, to_user, from_address, to_address,
                   amount (BIGINT, base units), memo, status,
                   tx_hash, idempotency_key (unique), created_at

ussd_sessions      session_id (pk), phone, flow, step, payload jsonb,
                   last_text, last_response, expires_at

otp_codes          phone, code_hash, expires_at, attempts, consumed_at
web_sessions       token_hash, user_id, expires_at
indexer_state      last_indexed_block
```

`amount` is `BIGINT` — ample for a 6-decimal token (max ≈ $9.2 trillion).

**Postgres is derivable, not authoritative.** The chain is the source of truth; Postgres makes
it fast and holds what can't go on-chain (PIN hashes, raw phone numbers). Dropping the
transfers table and re-indexing must reproduce balances exactly. If that stops being true,
FundX is an ordinary fintech with a blockchain sticker on it.

---

## Auth

**Two doors, different trust.** On USSD the MSISDN comes from the telco and cannot be typed by
the caller. On web a phone number is an unverified string until an OTP proves it. Requests
carry which door they came through, and limits differ accordingly.

- **Web signup** — phone → OTP → *server-issued, short-lived signup token* → create account →
  `HttpOnly; Secure; SameSite=Lax` cookie. The frontend currently keeps `verified: true` in
  `sessionStorage`, which the user controls; the backend must not trust it.
- **Web login — does not exist yet**, backend or frontend. The app can create an account and
  has no way to sign back in. Needs building on both sides.
- **USSD** — identified by MSISDN, PIN per transaction.
- **PIN** — argon2id, constant-time compare, attempt counter, lockout window. Weak PINs
  (repeated digits, sequences) rejected server-side; the frontend check is client-only.

### Keys

```
user #42's key = QuaiHDWallet.fromMnemonic(MASTER_MNEMONIC).addAddress(0, 42)
```

- The master mnemonic lives in the environment or a secrets manager. **Never in Postgres,
  never in git, never in a log line or an error trace.**
- Postgres stores `derivation_index` and the derived address. **No key material, not even
  encrypted.** A database dump — the most likely breach — then leaks who the users are, which
  is a real privacy incident, but leaks no funds. Losing the database is also survivable: the
  seed plus a rescan rebuilds every address.
- Keys are derived in memory at signing time and discarded.

Two traps, both measured rather than assumed:

1. **`getNextAddress()` is stateful.** It walks a counter inside the wallet object, so a
   stateless server calling it after `fromMnemonic()` hands *every user* address #0. Use
   `addAddress(0, index)`.
2. **Derivation is a search, not a calculation.** A Quai address encodes its shard in its
   first 9 bits, so only ~1 in 512 keys lands in Cyprus-1 (measured: 10 of 4,096). Deriving a
   user's address costs hundreds of iterations. Do it once at signup and store the index.

For contrast, the reference implementation AES-encrypts each private key using the first half
of that same key, then stores the key beside the ciphertext in the same column — anyone with
read access to `users` can decrypt every wallet. Deriving instead of storing makes that class
of mistake unavailable.

---

## Endpoints

One-to-one with the 13 functions in `frontend/lib/api/index.ts`, so swapping the mock for
`fetch` changes that module and nothing else.

```
POST   /api/auth/otp/request      { phone }                        → { sent: true }
POST   /api/auth/otp/verify       { phone, code }                  → { ok, signupToken? }
GET    /api/auth/username/check   ?username=                       → { available, reason? }
POST   /api/auth/signup           { signupToken, username, displayName, pin }
                                                                   → { user } + cookie
POST   /api/auth/login            { phone, pin }                   → { user } + cookie   ← new
POST   /api/auth/signout                                           → 204
GET    /api/me                                                     → User | null
GET    /api/balance                                                → { usd, ngnRate }
GET    /api/transfers                                              → Transfer[] (newest first)
GET    /api/transfers/:id                                          → Transfer | null
GET    /api/recipients/recent                                      → PublicUser[] (max 4)
GET    /api/resolve               ?q=                              → ResolveResult
POST   /api/transfers             { recipient, amount, memo?, pin, idempotencyKey }
                                                                   → SendResult
POST   /api/ussd/:secret          (Africa's Talking callback)      → text/plain
```

Error `reason` strings must match what the UI already switches on: `wrong_pin`,
`insufficient`, `not_found`, `invalid`, `taken`, `reserved`. Precedence in the send path is
load-bearing: no session → `wrong_pin` → `insufficient` → unknown recipient.

`amount` crosses as a **decimal string in base units** — JSON has no bigint. It is the only
bigint in the frontend's signatures; keep the client-facing type as `bigint` and stringify
inside the fetch client so `app/send/page.tsx` is untouched.

Identity rules must match the frontend exactly: handles stored bare (`suleiman`), rendered
`suleiman.fundX`, `^[a-z][a-z0-9_]{2,15}$`, must start with a letter so they can never
collide with a phone number.

---

## USSD

### Menu

Registration is included, so someone can onboard entirely on a feature phone — no web app, no
wallet. That is the thesis, demonstrated.

```
New number                          Existing user
──────────                          ─────────────
CON Welcome to FundX                CON FundX
Choose a 4-digit PIN                1. Send money
  → Confirm PIN                     2. Balance
  → Choose your handle              3. My handle
  → END Welcome, suleiman.fundX

1 Send
  CON Who are you paying?           (handle or phone)
  CON Send to Chidi Okonkwo         (amount)
  CON Send $12.50 to Chidi          (PIN)
  END Sent $12.50 to Chidi. Balance $27.50.

2 Balance   → CON PIN → END Balance: $40.00 (₦62,400)
3 My handle → END suleiman.fundX · +234 803 123 4567
```

Four screens maximum per flow. Every screen costs money and loses users. Budget ~160
characters and truncate interpolated names rather than overflow.

### State

Africa's Talking POSTs form-encoded `sessionId`, `serviceCode`, `phoneNumber`, `text`, and
replies are `text/plain` prefixed `CON ` (continue) or `END ` (hang up). `text` accumulates
across hops: `""`, `"1"`, `"1*chidi"`, …

We use `text` as the **input source** — the last `*`-delimited segment is what the user just
typed — while **flow and step live in `ussd_sessions`**, keyed by `sessionId`. Deriving
position from `text.split("*").length` alone conflates "which branch" with "how deep" and
cannot survive a retried side effect.

Three rules the reference implementation gets wrong:

1. **Idempotency.** If `last_text` equals the incoming `text`, replay `last_response` verbatim
   without re-executing. A gateway retry must never send money twice. The transfer also
   carries `idempotencyKey = sessionId`, enforced by a unique index.
2. **Always a default branch.** Unrecognised input re-prompts; it never falls through to an
   empty response. (Theirs returns `undefined` and the handset shows a generic failure.)
3. **Validation failures re-prompt with `CON`, they don't hang up.** Wrong PIN counts an
   attempt until lockout. "Incorrect PIN → session terminated" is hostile on a feature phone.

### Settling inside the session

Quai finalises in ~5s and a USSD session lasts ~20s, so a confirmed receipt on the handset is
achievable — and it is the specific reason this product can exist on Quai. But it can't be
*assumed*: gas drips, nonce contention and RPC latency all intrude.

So: broadcast, then await the receipt on a **bounded budget (~8s)**. Confirmed inside it →
`END` with the new balance. Budget expires → `END` with "we'll text you when it lands", and
the indexer sends the SMS. Best case keeps the strong claim; worst case degrades to the
reference implementation's SMS pattern instead of timing the session out.

### Callback security

The endpoint moves money on the strength of a `phoneNumber` field in a POST body. Left open,
anyone can impersonate any subscriber — the reference implementation is wide open, and with
an unhashed 4-digit PIN and no rate limiting that is a complete wallet-drain path. Mitigations:
a secret path segment, an Africa's Talking IP allowlist, and per-MSISDN rate limiting.

---

## Chain layer

`ChainAdapter`, two implementations:

- **`QuaiChain`** — `quais` against Orchard. Derives per-user addresses, drips QUAI for gas,
  signs `MockUSDT.transfer()`, reads balances, tails `Transfer` events into Postgres. Quai has
  no indexer — `subgraph` and `indexer` are zero hits across the docs — so **Postgres is the
  indexer**.
- **`MockChain`** — in-database, for tests and offline development.

Provider needs `{ usePathing: true }`. Fees are effectively legacy `gasPrice`: `FeeData`
exposes only that, and `maxFeePerGas` appears nowhere in the docs.

**Gas is dripped at signup, not just-in-time.** A just-in-time drip means two sequential
transactions inside a ~20s session. A background job tops up user addresses from a treasury.

### Current status of the token

`smart-contract/` holds **MockUSDT**: 6 decimals, open mint (anyone can call), and a shard
guard in `_update` that reverts transfers to Qi-prefixed or out-of-zone addresses. 12 tests
pass on Hardhat's EVM.

**It is not deployed.** Every Quai faucet hostname is dead — `orchard.faucet.quai.network`,
`faucet.quai.network` and `faucet.qu.ai` have no DNS record, and the official support article
404s — while the RPC and explorer both return 200. The deployer
`0x001A204bAB1E892e70F9809A0e05a5A9DFc55F50` sits at 0 QUAI, so there is no gas to deploy or
transact with.

Until that resolves, `MockChain` is the working adapter and `QuaiChain` is written against the
tested ABI. Options: fund the deployer from any source, or run `quai-local-node` (Docker, real
go-quai, pre-funded accounts, chain 1337).

---

## Frontend changes this requires

- Replace the bodies in `lib/api/index.ts` with `fetch`; keep every signature identical.
- **Add a login screen** — none exists.
- Handle 401 as signed out. No api function currently throws and there is no error boundary.
- Thread `balance.ngnRate` into `formatNGN`/`formatRate`; the screens use the hardcoded module
  default, so a live rate would not show.

---

## Verification

1. `docker compose up` → migrations apply → server boots.
2. **Derivation:** create 3 users, assert 3 distinct addresses (catches the `getNextAddress`
   trap), and assert re-deriving from the seed reproduces them exactly.
3. **Web:** signup → login → send by handle *and* by phone → both in history with correct sign.
4. **USSD via the Africa's Talking sandbox simulator:** register a new number end to end, then
   send from it. Same API, same result as web.
5. **Idempotency:** replay the final USSD hop verbatim — identical response, exactly one
   transfer. Same for a repeated `idempotencyKey`.
6. **PIN lockout:** wrong PIN N times locks the account; the correct PIN still fails until the
   window expires.
7. **Rebuild:** drop the transfers table, re-index from chain, confirm balances and history
   return identical.
8. **Secret hygiene:** grep logs for the mnemonic, any derived key, and any PIN — all absent.
