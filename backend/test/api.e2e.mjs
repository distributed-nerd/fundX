const BASE = "http://localhost:4000"
const API = `${BASE}/api`

let pass = 0
let fail = 0
const check = (label, cond, extra = "") => {
  if (cond) { pass++; console.log(`  ok    ${label}`) }
  else { fail++; console.log(`  FAIL  ${label}  ${extra}`) }
}

/** A cookie jar per user, so sessions don't bleed between them. */
function jar() {
  let cookie = ""
  return {
    async req(method, path, body) {
      const res = await fetch(`${API}${path}`, {
        method,
        headers: { "content-type": "application/json", ...(cookie ? { cookie } : {}) },
        body: body === undefined ? undefined : JSON.stringify(body),
      })
      const set = res.headers.getSetCookie?.() ?? []
      for (const c of set) {
        const [pair] = c.split(";")
        if (pair.startsWith("fundx_session=")) cookie = pair
      }
      const text = await res.text()
      let json = null
      try { json = text ? JSON.parse(text) : null } catch { json = text }
      return { status: res.status, body: json }
    },
  }
}

async function signup(phone, username, pin) {
  const j = jar()
  const otp = await j.req("POST", "/auth/otp/request", { phone })
  const verified = await j.req("POST", "/auth/otp/verify", { phone, code: otp.body.devCode })
  const created = await j.req("POST", "/auth/signup", {
    signupToken: verified.body.signupToken,
    username,
    displayName: username[0].toUpperCase() + username.slice(1),
    pin,
  })
  return { j, otp, verified, created }
}

/**
 * Wait for a transfer to stop being pending.
 *
 * Orchard's block interval measured ~26.7s against the backend's 8s confirmation budget, so
 * a send that worked perfectly still returns `pending` and the balances behind it move
 * later. Asserting immediately measured the chain's latency and called it a bug in our
 * logic. Against the mock adapter this returns on the first poll.
 *
 * The budget is generous because Orchard's public RPC is unreliable, not because settlement
 * is slow. Measured against a healthy node, a transfer moved money and had a receipt at 34s.
 * During an outage — 7 of 10 calls returning 502 — the same operation appeared to take 270s
 * or never to finish at all, because `statusOf` reports an unreachable node as "pending"
 * rather than risk calling a live transfer failed. The timeout covers the bad node, not the
 * good one.
 */
async function settle(j, id, timeoutMs = 420_000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const { body } = await j.req("GET", `/transfers/${id}`)
    if (body && body.status !== "pending") return body
    await new Promise((r) => setTimeout(r, 4_000))
  }
  return null
}

const stamp = Date.now() % 100000

console.log("\n== web signup ==")
const alicePhone = `+2349000${String(stamp).padStart(6, "1")}`
const bobPhone = `+2349000${String(stamp + 1).padStart(6, "2")}`

const alice = await signup(alicePhone, `alice${stamp}`.slice(0, 15), "4826")
check("otp issued", alice.otp.body?.sent === true)
check("otp verify returns a signup token", typeof alice.verified.body?.signupToken === "string")
check("signup returns 201", alice.created.status === 201, JSON.stringify(alice.created.body))
check("address is Cyprus-1 Quai", (BigInt(alice.created.body?.user?.address ?? "0x1") >> 151n) === 0n,
  alice.created.body?.user?.address)
check("handle stored bare (no .fundX)", !String(alice.created.body?.user?.username).includes(".fund"))

const bob = await signup(bobPhone, `bob${stamp}`.slice(0, 15), "7391")
check("second signup succeeds", bob.created.status === 201, JSON.stringify(bob.created.body))
check("second user gets a different address",
  alice.created.body?.user?.address !== bob.created.body?.user?.address)

console.log("\n== signup token is single-use ==")
const replay = await alice.j.req("POST", "/auth/signup", {
  signupToken: alice.verified.body.signupToken, username: `xx${stamp}`.slice(0, 15), displayName: "Xavier", pin: "4826",
})
check("replayed signup token rejected", replay.status === 401, `got ${replay.status}`)

console.log("\n== weak pin rejected ==")
const weakPhone = `+2349000${String(stamp + 2).padStart(6, "3")}`
const weak = await signup(weakPhone, `weak${stamp}`.slice(0, 15), "1111")
check("repeated-digit PIN refused", weak.created.status === 400, `got ${weak.created.status}`)

console.log("\n== session ==")
const me = await alice.j.req("GET", "/me")
check("/me returns the signed-in user", me.body?.username === alice.created.body.user.username)
const anon = await jar().req("GET", "/balance")
check("/balance without a session is 401", anon.status === 401, `got ${anon.status}`)

console.log("\n== funding and balance ==")
const funded = await alice.j.req("POST", "/dev/fund", { amount: "40000000" })
check("funding succeeded", funded.status === 200, JSON.stringify(funded.body))
const bal = await alice.j.req("GET", "/balance")
check("balance is $40.00 in base units", bal.body?.usd === "40000000", bal.body?.usd)
check("ngnRate present", typeof bal.body?.ngnRate === "number")

console.log("\n== resolve ==")
const byHandle = await alice.j.req("GET", `/resolve?q=${bob.created.body.user.username}.fundX`)
check("resolves a suffixed handle", byHandle.body?.found === true)
const byPhone = await alice.j.req("GET", `/resolve?q=${encodeURIComponent(bobPhone)}`)
check("resolves a phone number", byPhone.body?.found === true, JSON.stringify(byPhone.body))
const bareLocal = "0" + bobPhone.slice(4)
const byLocal = await alice.j.req("GET", `/resolve?q=${bareLocal}`)
check("resolves a local-format phone (0803…)", byLocal.body?.found === true, JSON.stringify(byLocal.body))
const self = await alice.j.req("GET", `/resolve?q=${alice.created.body.user.username}`)
check("refuses to resolve yourself", self.body?.found === false)
const missing = await alice.j.req("GET", "/resolve?q=nobody.fundX")
check("unknown handle -> not_found", missing.body?.reason === "not_found")
check("resolve never leaks an address", !JSON.stringify(byHandle.body).includes("0x"))

console.log("\n== send ==")
const wrongPin = await alice.j.req("POST", "/transfers", {
  recipient: bob.created.body.user.username, amount: "1000000", pin: "0000",
})
check("wrong PIN -> wrong_pin", wrongPin.body?.reason === "wrong_pin", JSON.stringify(wrongPin.body))

const tooMuch = await alice.j.req("POST", "/transfers", {
  recipient: bob.created.body.user.username, amount: "999000000", pin: "4826",
})
check("over balance -> insufficient", tooMuch.body?.reason === "insufficient", JSON.stringify(tooMuch.body))

const sent = await alice.j.req("POST", "/transfers", {
  recipient: `${bob.created.body.user.username}.fundX`,
  amount: "12500000", memo: "Fabric deposit", pin: "4826", idempotencyKey: `test-${stamp}`,
})
check("send succeeds", sent.body?.ok === true, JSON.stringify(sent.body))
check("transfer amount is base units", sent.body?.transfer?.amount === "12500000")
check("direction is out for the sender", sent.body?.transfer?.direction === "out")

const settled = sent.body?.transfer?.id ? await settle(alice.j, sent.body.transfer.id) : null
check("transfer confirms on chain", settled?.status === "confirmed", settled?.status ?? "never settled")

const afterSend = await alice.j.req("GET", "/balance")
check("sender debited exactly", afterSend.body?.usd === "27500000", afterSend.body?.usd)
const bobBal = await bob.j.req("GET", "/balance")
check("recipient credited exactly", bobBal.body?.usd === "12500000", bobBal.body?.usd)

console.log("\n== idempotency ==")
const repeat = await alice.j.req("POST", "/transfers", {
  recipient: bob.created.body.user.username,
  amount: "12500000", pin: "4826", idempotencyKey: `test-${stamp}`,
})
check("replayed key returns the same transfer", repeat.body?.transfer?.id === sent.body?.transfer?.id)
const stillBal = await alice.j.req("GET", "/balance")
check("replay did NOT move money twice", stillBal.body?.usd === "27500000", stillBal.body?.usd)

console.log("\n== history ==")

/**
 * Every check past here needs the send to have produced a transfer.
 *
 * Dereferencing it unguarded turned an ordinary failed assertion into a crash that took the
 * whole run with it — including the USSD suite chained after this one — so a flaky RPC read
 * as "no results" rather than "one thing failed". Bail loudly instead.
 */
const sentId = sent.body?.transfer?.id
if (!sentId) {
  check("send produced a transfer to inspect", false, JSON.stringify(sent.body))
  console.log(`\n${pass} passed, ${fail} failed  (stopped early: nothing to inspect)`)
  process.exit(1)
}

const hist = await alice.j.req("GET", "/transfers")
check("sender sees the transfer", hist.body?.[0]?.id === sentId)
check("memo preserved", hist.body?.[0]?.memo === "Fabric deposit")
const bobHist = await bob.j.req("GET", "/transfers")
check("recipient sees it as incoming", bobHist.body?.[0]?.direction === "in")
const detail = await alice.j.req("GET", `/transfers/${sentId}`)
check("detail fetch works", detail.body?.id === sentId)
const notMine = await jar().req("GET", `/transfers/${sentId}`)
check("other people cannot read it", notMine.status === 401, `got ${notMine.status}`)
const recents = await alice.j.req("GET", "/recipients/recent")
check("recent recipients include bob", recents.body?.[0]?.username === bob.created.body.user.username)

console.log("\n== login ==")
const fresh = jar()
const badLogin = await fresh.req("POST", "/auth/login", { phone: alicePhone, pin: "9999" })
check("wrong PIN login rejected", badLogin.status === 401)
const goodLogin = await fresh.req("POST", "/auth/login", { phone: alicePhone, pin: "4826" })
check("login succeeds", goodLogin.status === 200, JSON.stringify(goodLogin.body))
const meAgain = await fresh.req("GET", "/me")
check("login establishes a session", meAgain.body?.id === alice.created.body.user.id)
await fresh.req("POST", "/auth/signout")
const afterOut = await fresh.req("GET", "/me")
check("signout clears the session", afterOut.body === null)

console.log("\n== a returning user is sent to sign in, not through signup ==")

/**
 * The bug this covers: the web app had no sign-in door at all, so someone who already had
 * an account was walked through verification and asked to choose a handle, then told the
 * handle was taken. No handle would ever have worked, and there was no way out of the loop.
 */
const back = jar()

/**
 * The first thing they do is ask for a code. That is where they are told.
 *
 * Not after the code arrives and not after they have chosen a handle: this endpoint only
 * serves signing up, so an existing number cannot be here for a good reason, and sending a
 * text to say so costs money to deliver bad news.
 */
const backOtp = await back.req("POST", "/auth/otp/request", { phone: alicePhone })
check("asking for a signup code on a registered number says so", backOtp.body?.registered === true, JSON.stringify(backOtp.body))
check("and no code is sent for it", backOtp.body?.sent === false && !backOtp.body?.devCode, JSON.stringify(backOtp.body))
/**
 * The same fact, told twice more, at each later gate.
 *
 * A client can ignore the first answer, and a code can be issued a moment before the number
 * is claimed. Neither should get anyone into signup. Reproduced here by taking two codes for
 * a fresh number, spending the second to create the account, and then presenting the first —
 * a token that was legitimately issued and is now stale in exactly the way that matters.
 */
const spare = `+2349000${String((stamp + 7) % 1000000).padStart(6, "9")}`

const firstCode = await back.req("POST", "/auth/otp/request", { phone: spare })
const firstToken = await back.req("POST", "/auth/otp/verify", {
  phone: spare,
  code: firstCode.body.devCode,
})
check("verify flags an unknown number as not registered", firstToken.body?.registered === false, JSON.stringify(firstToken.body))

const secondCode = await back.req("POST", "/auth/otp/request", { phone: spare })
const secondToken = await back.req("POST", "/auth/otp/verify", {
  phone: spare,
  code: secondCode.body.devCode,
})
const claimed = await back.req("POST", "/auth/signup", {
  signupToken: secondToken.body.signupToken,
  username: `spare${stamp}`,
  displayName: "Spare Account",
  pin: "1357",
})
check("the spare number registers normally", claimed.status === 201, JSON.stringify(claimed.body))

// Now the number is taken, and the still-unused first token must not get past signup.
const dupe = await back.req("POST", "/auth/signup", {
  signupToken: firstToken.body.signupToken,
  username: `other${stamp}`,
  displayName: "Spare Again",
  pin: "2468",
})
check("signup on a registered number says 'registered', not 'taken'", dupe.body?.error === "registered", JSON.stringify(dupe.body))

// And asking for a code again now refuses, the way it did for alice.
const again = await back.req("POST", "/auth/otp/request", { phone: spare })
check("a number that just registered is now refused a signup code", again.body?.registered === true, JSON.stringify(again.body))

// Enumeration guard: login must not reveal whether a number exists.
const neverSeen = `+2349000${String((stamp + 11) % 1000000).padStart(6, "8")}`
const unknownLogin = await jar().req("POST", "/auth/login", { phone: neverSeen, pin: "0000" })
const wrongPinLogin = await jar().req("POST", "/auth/login", { phone: alicePhone, pin: "0000" })
check(
  "login cannot be used to find out who has an account",
  unknownLogin.status === wrongPinLogin.status &&
    JSON.stringify(unknownLogin.body) === JSON.stringify(wrongPinLogin.body),
  `${unknownLogin.status} ${JSON.stringify(unknownLogin.body)} vs ${wrongPinLogin.status} ${JSON.stringify(wrongPinLogin.body)}`,
)

console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail === 0 ? 0 : 1)
