const BASE = "http://localhost:4000"

let pass = 0, fail = 0
const check = (label, cond, extra = "") => {
  if (cond) { pass++; console.log(`  ok    ${label}`) }
  else { fail++; console.log(`  FAIL  ${label}  ${extra}`) }
}

/**
 * Posts to the bare root — the only USSD route, matching the reference implementation's
 * `app.post('/', africasTalking.ussdAccess)`. This is the exact URL Africa's Talking is
 * given, so the shape under test is the shape in production.
 */
async function hop(sessionId, phoneNumber, text) {
  const res = await fetch(`${BASE}/`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ sessionId, serviceCode: "*384*7777#", phoneNumber, text }),
  })
  return { status: res.status, body: await res.text() }
}

/** A handset: accumulates `text` across hops exactly as the gateway does. */
function handset(phone, sessionId) {
  let text = ""
  return {
    async dial() { return hop(sessionId, phone, "") },
    async type(input) {
      text = text === "" ? input : `${text}*${input}`
      return hop(sessionId, phone, text)
    },
    async replay() { return hop(sessionId, phone, text) },
  }
}

const stamp = Date.now() % 100000

/** Current balance in base units, read through the web API. */
async function balanceNow() {
  const res = await fetch(`${BASE}/api/balance`, { headers: { cookie: login.cookie } })
  return BigInt((await res.json()).usd)
}
const carolPhone = `+23481${String(stamp).padStart(8, "4")}`
const davePhone = `+23481${String(stamp + 1).padStart(8, "5")}`

console.log("\n== the callback route ==")
const root = await hop(`ATUid_root_${stamp}`, carolPhone, "")
check("POST / responds", root.body.startsWith("CON"), root.body)
const gone = await fetch(`${BASE}/api/ussd/anything`, { method: "POST" })
check("no secondary USSD route exists", gone.status === 404, `got ${gone.status}`)

console.log("\n== root menu ==")
const c = handset(carolPhone, `ATUid_menu_${stamp}`)
let r = await c.dial()
check("menu shown on dial", r.body.includes("Welcome to FundX Wallet"), r.body)
check("lists 1. Create an account", r.body.includes("1. Create an account"))
check("lists 2. Check wallet balance", r.body.includes("2. Check wallet balance"))
check("lists 3. Transfer", r.body.includes("3. Transfer"))
check("lists 4. Off-ramp", r.body.includes("4. Off-ramp"))
check("lists 5. Change PIN", r.body.includes("5. Change PIN"))
check("menu fits a feature phone", r.body.length <= 164, `${r.body.length} chars`)

console.log("\n== guards for a caller with no account ==")
const g1 = handset(carolPhone, `ATUid_g1_${stamp}`)
await g1.dial(); r = await g1.type("2")
check("balance without an account is refused", /do not have an account/i.test(r.body), r.body)
const g2 = handset(carolPhone, `ATUid_g2_${stamp}`)
await g2.dial(); r = await g2.type("3")
check("transfer without an account is refused", /do not have an account/i.test(r.body), r.body)
const g3 = handset(carolPhone, `ATUid_g3_${stamp}`)
await g3.dial(); r = await g3.type("9")
check("unknown option re-prompts, never blank", r.body.startsWith("CON") && r.body.includes("1. Create"), r.body)

console.log("\n== 1. Create an account ==")
const reg = handset(carolPhone, `ATUid_reg_${stamp}`)
await reg.dial()
r = await reg.type("1")
check("asks for full name", /Enter full name/i.test(r.body), r.body)
r = await reg.type("C")
check("one-letter name re-prompts", r.body.startsWith("CON") && /full name/i.test(r.body), r.body)

const reg2 = handset(carolPhone, `ATUid_reg2_${stamp}`)
await reg2.dial(); await reg2.type("1")
r = await reg2.type("Carol Mensah")
check("asks for the passcode", /passcode/i.test(r.body), r.body)
r = await reg2.type("12")
check("short passcode re-prompts", r.body.startsWith("CON") && /passcode/i.test(r.body), r.body)
r = await reg2.type("1111")
check("weak passcode refused with a reason", r.body.startsWith("CON") && /guess/i.test(r.body), r.body)
r = await reg2.type("5309")
check("account created", r.body.startsWith("END") && /Account created/i.test(r.body), r.body)
check("handle generated from the name", /carolmensah[a-z0-9]*\.fundX/.test(r.body), r.body)

const dup = handset(carolPhone, `ATUid_dup_${stamp}`)
await dup.dial(); r = await dup.type("1")
check("existing user cannot create again", /already have an account/i.test(r.body), r.body)

console.log("\n== 2. Check wallet balance ==")
// Fund through the web API so USSD has something to report.
const api = async (path, body, cookie) => {
  const res = await fetch(`${BASE}/api${path}`, {
    method: "POST", headers: { "content-type": "application/json", ...(cookie ? { cookie } : {}) },
    body: JSON.stringify(body),
  })
  const set = res.headers.getSetCookie?.() ?? []
  return { body: await res.json().catch(() => null),
           cookie: set.map((x) => x.split(";")[0]).find((x) => x.startsWith("fundx_session=")) }
}
const login = await api("/auth/login", { phone: carolPhone, pin: "5309" })
check("USSD-registered user can log in on the web", Boolean(login.cookie), JSON.stringify(login.body))
await api("/dev/fund", { amount: "40000000" }, login.cookie)

const bal = handset(carolPhone, `ATUid_bal_${stamp}`)
await bal.dial()
r = await bal.type("2")
check("balance is one hop, no sub-menu", r.body.startsWith("END"), r.body)
check("balance shown in dollars and naira", r.body.includes("$40.00") && r.body.includes("₦"), r.body)

console.log("\n== 3. Transfer ==")
const d = handset(davePhone, `ATUid_dave_${stamp}`)
await d.dial(); await d.type("1"); await d.type("Dave Okoro")
r = await d.type("7412")
check("second user registered", r.body.startsWith("END"), r.body)
const daveHandle = r.body.match(/([a-z0-9]+)\.fundX/)?.[1]

const s = handset(carolPhone, `ATUid_send_${stamp}`)
await s.dial()
await s.type("3")
r = await s.type("1") // 1 = Crypto
check("asks for recipient", /Enter recipient/i.test(r.body), r.body)
r = await s.type("nobody999")
check("unknown recipient re-prompts", r.body.startsWith("CON") && /not found/i.test(r.body), r.body)
r = await s.type(`${daveHandle}.fundX`)
check("asks for the amount, naming the recipient", /Enter amount to transfer to Dave/i.test(r.body), r.body)
r = await s.type("abc")
check("bad amount re-prompts", r.body.startsWith("CON") && /valid amount/i.test(r.body), r.body)
r = await s.type("999")
check("over balance re-prompts with the real balance", r.body.includes("$40.00"), r.body)
r = await s.type("12.50")
check("asks for the PIN", /Enter your PIN to confirm transfer/i.test(r.body), r.body)
r = await s.type("0000")
check("wrong PIN re-prompts rather than ending", r.body.startsWith("CON") && /Incorrect PIN/i.test(r.body), r.body)
r = await s.type("5309")
check("transfer completes", r.body.startsWith("END") && /Sent \$12\.50/.test(r.body), r.body)
check("shows the new balance", r.body.includes("$27.50"), r.body)

console.log("\n== a gateway retry must not send twice ==")
const replayed = await s.replay()
check("replaying the final hop returns the identical reply", replayed.body === r.body,
  `${replayed.body} vs ${r.body}`)
const after = handset(carolPhone, `ATUid_after_${stamp}`)
await after.dial()
r = await after.type("2")
check("retry did NOT move money twice", r.body.includes("$27.50"), r.body)

console.log("\n== 3. Transfer -> crypto / fiat ==")
const sub = handset(carolPhone, `ATUid_sub_${stamp}`)
await sub.dial()
r = await sub.type("3")
check("transfer offers crypto and fiat", /1\. Crypto/.test(r.body) && /2\. Fiat/.test(r.body), r.body)
r = await sub.type("9")
check("bad sub-choice re-prompts", r.body.startsWith("CON") && /choose 1 or 2/i.test(r.body), r.body)

console.log("\n== 3*2 fiat transfer to a bank ==")
const fi = handset(carolPhone, `ATUid_fiat_${stamp}`)
await fi.dial(); await fi.type("3")
r = await fi.type("2")
check("asks for the account number", /10-digit account number/i.test(r.body), r.body)
r = await fi.type("12345")
check("short account number re-prompts", r.body.startsWith("CON") && /10 digits/i.test(r.body), r.body)
r = await fi.type("0123456789")
check("lists banks", /1\. GTBank/.test(r.body), r.body)
r = await fi.type("99")
check("bad bank choice re-prompts", r.body.startsWith("CON") && /GTBank/.test(r.body), r.body)
r = await fi.type("1")
check("asks for naira amount", /amount in naira/i.test(r.body), r.body)
r = await fi.type("15000")
check("quote shows naira, bank and dollar cost", /₦15,000/.test(r.body) && /GTBank/.test(r.body) && /\$/.test(r.body), r.body)
const beforeFiat = await balanceNow()
r = await fi.type("5309")
check("fiat transfer completes", r.body.startsWith("END") && /Sent ₦15,000/.test(r.body), r.body)
const afterFiat = await balanceNow()
check("dollars actually debited", afterFiat < beforeFiat, `${beforeFiat} -> ${afterFiat}`)

console.log("\n== 4. Off-ramp ==")
const off = handset(carolPhone, `ATUid_off_${stamp}`)
await off.dial()
r = await off.type("4")
check("asks for your account number", /account number/i.test(r.body), r.body)
r = await off.type("9876543210")
check("lists banks", /2\. Access Bank/.test(r.body), r.body)
r = await off.type("2")
check("asks for dollar amount", /amount in dollars/i.test(r.body), r.body)
r = await off.type("10")
check("quote shows naira and the rate", /₦15,600/.test(r.body) && /Rate ₦1560/.test(r.body), r.body)
r = await off.type("5309")
check("withdrawal completes", r.body.startsWith("END") && /Withdrawal of ₦15,600/.test(r.body), r.body)

const off2 = handset(carolPhone, `ATUid_off2_${stamp}`)
await off2.dial()
r = await off2.type("4")
check("bank is remembered on the next withdrawal", /amount in dollars/i.test(r.body), r.body)

console.log("\n== 5. Change PIN ==")
const pc = handset(carolPhone, `ATUid_pin_${stamp}`)
await pc.dial()
r = await pc.type("5")
check("asks for the current PIN", /current PIN/i.test(r.body), r.body)

// The wrong current PIN must be caught here, not three screens later.
r = await pc.type("0000")
check("wrong current PIN says so immediately", r.body.startsWith("CON") && /Incorrect PIN/i.test(r.body), r.body)
check("wrong current PIN re-prompts, does not hang up", /Enter your current PIN/i.test(r.body), r.body)
check("shows attempts remaining", /\d tries? left/.test(r.body), r.body)

r = await pc.type("5309")
check("correct current PIN moves on", /new 4-digit PIN/i.test(r.body), r.body)
r = await pc.type("5309")
check("new PIN cannot equal the current one", r.body.startsWith("CON") && /must be different/i.test(r.body), r.body)
r = await pc.type("1111")
check("weak new PIN refused", r.body.startsWith("CON") && /guess/i.test(r.body), r.body)
r = await pc.type("2468")
check("asks to confirm", /again/i.test(r.body), r.body)
r = await pc.type("9999")
check("mismatch re-prompts for a new PIN", r.body.startsWith("CON") && /new 4-digit PIN/i.test(r.body), r.body)
r = await pc.type("2468")
check("asks to confirm again after the mismatch", /again/i.test(r.body), r.body)
r = await pc.type("2468")
check("PIN changed", r.body.startsWith("END") && /PIN has been changed/i.test(r.body), r.body)

const oldPin = await fetch(`${BASE}/api/auth/login`, {
  method: "POST", headers: { "content-type": "application/json" },
  body: JSON.stringify({ phone: carolPhone, pin: "5309" }),
})
check("old PIN no longer works", oldPin.status === 401, `got ${oldPin.status}`)
const newPin = await fetch(`${BASE}/api/auth/login`, {
  method: "POST", headers: { "content-type": "application/json" },
  body: JSON.stringify({ phone: carolPhone, pin: "2468" }),
})
check("new PIN works", newPin.status === 200, `got ${newPin.status}`)

console.log("\n== payouts are visible on the web, and honestly labelled ==")
const payoutList = await (await fetch(`${BASE}/api/payouts`, { headers: { cookie: login.cookie } })).json()
check("web sees both payouts", payoutList.length === 2, JSON.stringify(payoutList.map((p) => p.kind)))
check("status is 'simulated', not 'paid'", payoutList.every((p) => p.status === "simulated"),
  JSON.stringify(payoutList.map((p) => p.status)))
check("quoted rate recorded", payoutList.every((p) => p.rate === 1560))

console.log("\n== the two doors agree ==")
const hist = await (await fetch(`${BASE}/api/transfers`, { headers: { cookie: login.cookie } })).json()
check("web history shows the USSD transfer", hist[0]?.amount === "12500000", JSON.stringify(hist[0]))
check("counterparty is the USSD recipient", hist[0]?.counterparty?.username === daveHandle)

console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail === 0 ? 0 : 1)
