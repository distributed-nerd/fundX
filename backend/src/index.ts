import express from "express"
import cookieParser from "cookie-parser"
import { config } from "./config.js"
import { api } from "./http/api/index.js"
import { handleUssd } from "./http/ussd/index.js"
import { chain } from "./chain/index.js"
import { fillPool, unclaimedCount } from "./services/pool.js"

const app = express()

app.use(express.json())
// Africa's Talking posts form-encoded, so both parsers are needed.
app.use(express.urlencoded({ extended: true }))
app.use(cookieParser())

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

const server = app.listen(config.PORT, () => {
  console.log(`FundX backend on :${config.PORT}  (chain: ${config.CHAIN_ADAPTER})`)
  console.log("USSD callback: POST /")

  // Deriving a Cyprus-1 address is ~566ms of blocking CPU, so the pool is stocked in the
  // background rather than on a signup request.
  void fillPool().then(async () => {
    console.log(`address pool ready: ${await unclaimedCount()} unclaimed`)
  })
})

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    server.close(() => process.exit(0))
  })
}
