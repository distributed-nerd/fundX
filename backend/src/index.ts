import express from "express"
import cookieParser from "cookie-parser"
import { config } from "./config.js"
import * as transfersService from "./services/transfers.js"
import { api } from "./http/api/index.js"
import { handleUssd } from "./http/ussd/index.js"
import { chain } from "./chain/index.js"
import { fillPool, unclaimedCount } from "./services/pool.js"
import { warm } from "./services/pricing.js"

const app = express()

// Behind Apache/Passenger in production: without this, req.ip is the proxy's
// 127.0.0.1 and the per-IP rate limiter collapses into a single shared bucket.
app.set("trust proxy", 1)

app.use(express.json())
// Africa's Talking posts form-encoded, so both parsers are needed.
app.use(express.urlencoded({ extended: true }))
app.use(cookieParser())

/**
 * CORS for the Next.js app.
 *
 * An allowlist rather than `*`, because the API sets a session cookie and credentialed
 * requests are not permitted against a wildcard origin — nor should they be.
 */
app.use((req, res, next) => {
  const origin = req.headers.origin
  if (origin && config.WEB_ORIGINS.includes(origin)) {
    res.setHeader("Access-Control-Allow-Origin", origin)
    res.setHeader("Access-Control-Allow-Credentials", "true")
    res.setHeader("Vary", "Origin")
    res.setHeader("Access-Control-Allow-Headers", "content-type")
    res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS")
  }
  if (req.method === "OPTIONS") return res.status(204).end()
  next()
})

/**
 * The USSD callback, at the bare root — the same route as the reference implementation's
 * `app.post('/', africasTalking.ussdAccess)`. The callback URL is just the host.
 */
app.post("/", handleUssd)

app.get("/", (_req, res) => {
  res.type("text/plain").send("FundX — USSD callback. POST here from Africa's Talking.")
})

app.get("/health", async (_req, res) => {
  const adapter = await chain()
  res.json({
    ok: true,
    chain: adapter.kind,
    addressesReady: await unclaimedCount(),
    ussd: "POST /",
  })
})

/**
 * Two front doors onto one set of services.
 *
 * Neither router contains a business rule or a chain call — each parses its own format,
 * calls the same service function and formats the result. That is the whole point: a rule
 * that changes, changes once, and USSD can never quietly drift from the web app.
 */
app.use("/api", api)

app.use((_req, res) => res.status(404).json({ error: "not_found" }))

/**
 * Anything that escaped a route handler.
 *
 * Express's default handler answers with an HTML page containing the stack trace. A JSON
 * client parsing that gets an exception instead of an error, which is how a flaky RPC turned
 * into an unreadable crash rather than "we couldn't reach the network" — observed when the
 * Orchard node started refusing calls mid-request.
 *
 * `chain_error` because that is overwhelmingly what reaches here: a `balanceOf` or a
 * broadcast that the node would not answer. It is the same reason string the send path
 * already returns, and the one the UI knows how to phrase.
 */
app.use((error: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  console.error("unhandled:", error)
  if (res.headersSent) return
  res.status(502).json({ ok: false, error: "chain_error", reason: "chain_error" })
})

/**
 * Settle transfers nobody is watching.
 *
 * Every 30s, not every second: the work is a chain read per pending transfer, and the thing
 * being waited on takes ~30s at best. `void` because a sweep failing is not fatal — the next
 * one picks up the same rows.
 */
const SWEEP_MS = 30_000
let sweeping = false
setInterval(() => {
  if (sweeping) return // a slow chain must not stack sweeps on top of each other
  sweeping = true
  void transfersService
    .sweepPending()
    .catch((error) => console.error("sweep failed:", error))
    .finally(() => {
      sweeping = false
    })
}, SWEEP_MS).unref()

const server = app.listen(config.PORT, () => {
  console.log(`FundX backend on :${config.PORT}  (chain: ${config.CHAIN_ADAPTER})`)
  console.log("USSD callback: POST /")

  // Fetch the rate now so the first user does not wait on it.
  void warm()

  // Deriving a Cyprus-1 address is ~566ms of blocking CPU, so the pool is stocked in the
  // background rather than on a signup request.
  void fillPool().then(async () => {
    console.log(`address pool ready: ${await unclaimedCount()} unclaimed`)
  })
})

/**
 * A bad node must not be able to kill the service.
 *
 * Observed: Orchard's RPC returned 502 to `quai_getTransactionReceipt`, quais surfaced it as
 * a rejection nobody had awaited, and Node's default for that is to terminate the process.
 * The whole backend — sessions, USSD, everything — went down because one read failed.
 *
 * Logged rather than swallowed silently: these should be rare and each one is a bug worth
 * seeing. But staying up through a transient upstream failure is the correct behaviour for
 * a service holding people's money, and the alternative is not "safer", it is offline.
 */
process.on("unhandledRejection", (reason) => {
  console.error("unhandled rejection (staying up):", reason)
})

process.on("uncaughtException", (error) => {
  console.error("uncaught exception (staying up):", error)
})

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    server.close(() => process.exit(0))
  })
}
