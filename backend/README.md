# FundX backend

One API, two front doors: the Next.js web app and an Africa's Talking USSD flow.

See `ARCHITECTURE.md` for why it's shaped this way.

## Running it

```bash
npm install
npm run db:up          # Postgres 18 in Docker, on 5433
npm run db:migrate
npm run dev            # :4000
```

`.env` is generated on first run with a dev mnemonic and secrets (mode 600, gitignored).
`CHAIN_ADAPTER=mock` by default — balances live in Postgres and no chain is contacted.

```bash
curl localhost:4000/health
# {"ok":true,"chain":"mock","addressesReady":24,"ussd":"POST /"}
```

## Tests

Both run against a live server (`npm run dev` in another terminal):

```bash
node test/api.e2e.mjs     # 38 checks — web signup, login, send, idempotency, history
node test/ussd.e2e.mjs    # 65 checks — menu, register, balance, crypto+fiat, PIN, retry safety
```

The USSD test speaks the real Africa's Talking wire format: form-encoded `sessionId` /
`serviceCode` / `phoneNumber` / `text`, with `text` accumulating across hops exactly as the
gateway sends it.

## The rule this codebase is built around

`http/api` and `http/ussd` contain **no business rules and no chain calls**. Each parses its
own format, calls the same service function, and formats the result.

```
POST /api/transfers ─┐
                     ├─→ transfers.send({ from, recipient, amount, pin, idempotencyKey })
POST /  (USSD)      ─┘
```

Every option on the handset has a web endpoint too — `POST /api/payouts` for off-ramp and
fiat, `POST /api/auth/pin` for the PIN change — so neither door can quietly grow a capability
the other lacks.

That is the one lesson worth taking from `shaaibu7/FundX`, which does the opposite: all of
its logic lives inside a single Express handler, so `createUser`, `getBalance` and `transfer`
don't exist as callable functions and a web API would mean writing everything twice.

A consequence worth noticing: a user who signs up on a feature phone can log in on the web
with the same PIN, and their USSD transfer shows up in the web history. Both e2e suites
assert it.

## Menu

```
CON Welcome to FundX Wallet
1. Create an account      name -> passcode (handle generated from the name)
2. Check wallet balance   one hop, no PIN — the SIM is the authentication for a read
3. Transfer               1. Crypto (FundX user)  2. Fiat (bank account)
4. Change PIN             current -> new -> confirm
```

There is no separate off-ramp option. Withdrawing to your own bank is Transfer → Fiat with
your own account number, and a fifth line that differed only in intent would cost every
caller screen space they pay for.

Fiat transfers resolve the account name through Paystack before any amount is entered, and
the rate comes from a live feed — see below.

### ⚠️ The naira legs are simulated

Option 3→2 quotes a rate, debits the dollar balance and writes a `payouts` row — but
**no payout rail is connected**, so nothing reaches a bank. Rows land as `status:
"simulated"`, deliberately not `"paid"`, so nothing downstream can mistake a demo for a
settled transfer. Connecting Paystack, Flutterwave or Monnify means replacing `dispatch()`
in `services/payouts.ts` and nothing else.

The dollar debit is real even so. A demo where the balance never moves teaches the wrong
thing about what an off-ramp costs.

## Keys

```
user #42's key = HDNodeWallet.fromMnemonic(MASTER_MNEMONIC, "m/44'/994'/0'/0").deriveChild(42)
```

**Nothing derived is ever stored.** Postgres holds `derivation_index` and the address; the
key is reconstructed in memory to sign and then discarded. A database dump leaks who the
users are — a real privacy incident — but leaks no funds. Losing the database is survivable
too: the seed plus a rescan rebuilds every address.

For contrast, the reference implementation AES-encrypts each private key using the first half
of that same key, and stores the key beside the ciphertext in the same column. Anyone with
read access to `users` can decrypt every wallet with the repo's own function.

### What measurement changed

Three things about Quai derivation that the docs don't tell you, each found by testing:

**The path is `m/44'/994'/0'/0/i`** — coin type 994. Verified by reproducing
`QuaiHDWallet.addAddress(0, i)` exactly.

**Most indices are unusable, and `addAddress` throws for them** — 39 of the first 40, with
"Failed to derive a valid address zone". When it does succeed it may hand back a different
zone: index 0 of a fresh seed came back Paxos-1.

**Checking `address.startsWith("0x00")` is wrong, and fails dangerously.** Over 3,137 indices,
10 addresses matched that prefix and only **5 were usable** — the rest were Cyprus-1 on the
*Qi* ledger, a UTXO ledger with no contracts where tokens are unrecoverable. A 50%
false-positive rate silently handing users an address that eats their money. The correct test
is all nine leading bits, the same predicate MockUSDT enforces on-chain:

```ts
BigInt(address) >> 151n === 0n
```

### Why there's an address pool

Finding a Cyprus-1 address costs **~566ms of blocking CPU** — roughly 512 derivations. In a
single-threaded runtime that would stall every other request, so a background filler keeps
`address_pool` stocked and signup claims a row with `FOR UPDATE SKIP LOCKED`.

## USSD

`text` accumulates across hops — `""`, `"1"`, `"1*chidi"`, `"1*chidi*12.50"`. It is tempting
to derive the menu position from `text.split("*").length`, and that is what the reference
implementation does. It cannot work: two flows at the same depth are indistinguishable, and a
retried hop replays whatever side effect that depth performs.

So `text` supplies **only the latest input**, and position lives in `ussd_sessions` keyed by
`sessionId`. Three rules follow, each a bug in the implementation this was modelled on:

| Rule | Their behaviour |
|---|---|
| Identical `text` replays the stored reply without re-executing | `sessionId` destructured and never used — a retried final hop sends money twice |
| Every state has a default that re-prompts | Falls through every branch, `response` stays `undefined`, handset shows a blank failure |
| Validation failures re-prompt with `CON` | `END` on a bad amount or wrong PIN — one mistyped digit means redialling |

Screens are budgeted to ~160 characters, with interpolated names truncated rather than
allowed to overflow.

### Settling inside the session

Quai finalises in ~5s and a USSD session lasts ~20s, so a confirmed receipt on the handset is
usually achievable — that is the specific reason this product can exist here. But it can't be
assumed. The adapter waits on a bounded budget (`CONFIRM_BUDGET_MS`, default 8s): confirmed
inside it, the handset shows the new balance; past it, the session ends with "we'll text you"
and SMS carries the result. The reference implementation calls `await tx.wait()` with no
bound, which times its own sessions out.

### Callback security

The callback is `POST /` — the bare root, matching the reference. It moves money on the
strength of a `phoneNumber` in a POST body, so anyone holding the URL can claim to be any
subscriber.

What keeps that from being a drain path is the PIN: argon2id, constant-time, with an attempt
counter and a lockout. The reference stores its PIN as a plaintext `INTEGER` compared with
`!=` and rate-limits nothing, which is what turns the same open route into an exhaustible
10,000-guess search. **An Africa's Talking IP allowlist still belongs in front of this in
production** — that is the real mitigation.

## Chain

`ChainAdapter` with two implementations, chosen by `CHAIN_ADAPTER`:

- **`mock`** — balances in Postgres. Enforces the same shard guard, so code that works here
  works there. What it cannot do is produce a transaction anyone can verify, which is the
  product's central claim — so it is temporary by design.
- **`quai`** — `quais` against Orchard. Written against the ABI the contract tests exercise.

**Not yet exercisable.** Every Quai faucet hostname is dead — `orchard.faucet.quai.network`,
`faucet.quai.network` and `faucet.qu.ai` have no DNS record and the official support article
404s, while the RPC and explorer both return 200. So the deployer has no gas, MockUSDT is not
deployed, and `mock` is the only adapter that can run. Switching is `CHAIN_ADAPTER=quai` plus
`MOCK_USDT_ADDRESS` once there is gas.

## Still to do

- **Chain indexer** — tail `Transfer` events into Postgres. Quai ships no indexer
  (`subgraph` and `indexer` are zero hits across its docs), so this database *is* the indexer.
  Needed for external deposits and for the "we'll text you" path to ever fire.
- **Frontend wiring** — replace the mock bodies in `lib/api/index.ts` with `fetch`, add a
  login screen, handle 401, thread `balance.ngnRate` through instead of the hardcoded default.
- **Rate limiting** per MSISDN and per IP.
