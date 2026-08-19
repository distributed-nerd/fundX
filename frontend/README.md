# FundX — web app

Send and receive money with a phone number or a `name.fundX` handle.

This is the web client. It is **not a dApp**: there is no wallet to connect, no
`window.pelagus`, no signing in the browser. FundX is custodial, so the backend holds
keys and signs; this app is an ordinary web client against that API.

## Running it

```bash
npm install
npm run dev        # http://localhost:3000
```

Everything runs on mock data — there is no backend yet. State lives in `localStorage`
under `fundx.state.v1`, so a refresh keeps you signed in. To start over, clear that key
or use **Sign out** on the Receive screen.

A fresh account is seeded with a $40.00 balance and a short history, including one
external deposit, so the screens can be read in use rather than empty.

## Layout

```
app/
  page.tsx              welcome
  phone/ verify/ pin/ username/    onboarding
  home/                 balance, send/receive, recent
  send/                 recipient → amount → PIN → receipt (one route, four steps)
  receive/              your handle, number, and deposit address
  activity/             history, grouped by day
  activity/[id]/        receipt

components/             hand-built; no component library
lib/
  api/                  mock client — swap for fetch when the backend lands
  money.ts              bigint base units, string boundaries
  types.ts              wire types shared with the backend
  session.tsx           session context
```

## Two rules worth keeping

**Money is bigint, never a float.** Amounts are base units (6-decimal, matching USDT)
and cross the API as strings, because JSON has no bigint. Parse with `BigInt()`, never
`Number()`. `0.1 + 0.2` is not a rounding detail in a payments product — it is a balance
that disagrees with the chain.

**A hex address appears in exactly one place**: the Receive screen, folded behind
"Receiving from outside FundX". Everywhere else a recipient is a person, with a name and
a handle. That is the product.

**Handles are stored bare, rendered suffixed.** The database (and later the registry
contract) holds `suleiman`; the UI shows `suleiman.fundX` via `formatHandle()`. Input is
lenient — `suleiman.fundX`, `suleiman`, `@suleiman` all resolve — and display is
canonical. Handles must start with a letter so they can never collide with a phone
number, since both are valid ways to address a payment.

## Design tokens

Defined in `app/globals.css`. Tailwind's default palette is cleared (`--color-*: initial`)
so nothing generic can leak in.

| Token | | Use |
|---|---|---|
| `paper` | `#faf8f5` | page background |
| `surface` | `#fffdfb` | cards, fields |
| `ink` | `#14110e` | primary text, debits |
| `muted` | `#6b635b` | secondary text |
| `faint` | `#7a7168` | tertiary text — still clears 4.5:1 |
| `hairline` | `#e5dfd7` | decorative rules only |
| `line` | `#9a8e83` | interactive borders — clears 3:1 |
| `green` | `#1b5e3f` | actions, credits, confirmation |
| `alert` | `#a03a2b` | failures only |

Type is **Instrument Serif** for display and **Public Sans** for UI. Every monetary
figure carries the `figure` utility (`font-variant-numeric: tabular-nums`) so columns of
money don't wobble.

Credits are green; **debits are ink, not red**. Spending money is not an error state.

## Checks

```bash
npx tsc --noEmit
npm run build
npm run lint
```

Contrast is verified against WCAG AA: all text ≥ 4.5:1 on its background, interactive
borders ≥ 3:1. Re-check if you touch the palette.
