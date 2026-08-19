import type { Request, Response } from "express"
import { eq } from "drizzle-orm"
import { config } from "../../config.js"
import { db } from "../../db/index.js"
import { ussdSessions } from "../../db/schema.js"
import { normalizePhone } from "../../lib/identity.js"
import * as accounts from "../../services/accounts.js"
import { START, step, type SessionState } from "./machine.js"

/**
 * The Africa's Talking callback.
 *
 * The gateway POSTs `application/x-www-form-urlencoded` with `sessionId`, `serviceCode`,
 * `phoneNumber` and `text`, and expects `text/plain` beginning `CON ` (keep the session
 * open) or `END ` (close it).
 *
 * `text` accumulates across hops — "", "1", "1*chidi", "1*chidi*12.50" — and it is tempting
 * to treat it as the state. It cannot be: two flows at the same depth are indistinguishable,
 * and a retried hop replays whatever side effect that depth performs. So `text` supplies
 * only the latest input, and the position lives in `ussd_sessions`.
 *
 * ## Where this is mounted
 *
 * `POST /` — the bare root, matching the reference implementation
 * (`app.post('/', africasTalking.ussdAccess)`). That is the whole route surface: the URL you
 * paste into the Africa's Talking dashboard is just the host, with nothing to append.
 *
 * Worth knowing rather than discovering later: this endpoint moves money on the strength of
 * a `phoneNumber` field in a POST body, and an open root means anyone holding the URL can
 * claim to be any subscriber. What keeps that from being a drain path here is the PIN —
 * argon2id, constant-time, with an attempt counter and a lockout. The reference stores its
 * PIN as a plaintext INTEGER compared with `!=` and rate-limits nothing, which is what turns
 * the same open route into an exhaustible 4-digit search. In production, put an Africa's
 * Talking IP allowlist in front of this.
 */

export async function handleUssd(req: Request, res: Response) {
  const sessionId = String(req.body?.sessionId ?? "").trim()
  const rawPhone = String(req.body?.phoneNumber ?? "").trim()
  const text = String(req.body?.text ?? "")

  const phone = normalizePhone(rawPhone)
  if (!sessionId || !phone) {
    return res.type("text/plain").send("END Sorry, we could not start your session.")
  }

  const existing = await loadSession(sessionId)

  /**
   * Replay protection.
   *
   * If this exact `text` was already handled for this session, return the stored reply
   * without re-running the step. Gateways retry, and the last hop of a send flow moves
   * money — re-executing it is a double-spend, which is precisely what happens when
   * `sessionId` is ignored.
   */
  if (existing && existing.lastText === text && existing.lastResponse) {
    return res.type("text/plain").send(existing.lastResponse)
  }

  const user = await accounts.findByPhone(phone)

  // Only the newest segment matters; the rest is history we already acted on.
  const segments = text === "" ? [] : text.split("*")
  const input = segments.length ? (segments[segments.length - 1] ?? "") : ""

  const stored: SessionState | null = existing
    ? {
        flow: existing.flow as SessionState["flow"],
        step: existing.step,
        payload: existing.payload as Record<string, unknown>,
      }
    : null

  // A first hop always starts at the root menu, even if a stale row survives an earlier call.
  const state = text === "" ? START : (stored ?? START)

  let result
  try {
    result = await step({ phone, user, sessionId }, state, input)
  } catch (error) {
    console.error("[ussd] step failed", {
      sessionId,
      // Never the input: it may be a PIN.
      error: error instanceof Error ? error.message : String(error),
    })
    await clearSession(sessionId)
    return res
      .type("text/plain")
      .send("END Something went wrong. Nothing was taken from your balance.")
  }

  const body = `${result.kind} ${result.text}`

  // Keep an ended session briefly so a retry of the final hop replays rather than re-executes.
  const ttl = result.kind === "END" ? 2 : config.USSD_SESSION_TTL_MINUTES
  await saveSession(sessionId, phone, result.next, text, body, ttl)

  return res.type("text/plain").send(body)
}

async function loadSession(sessionId: string) {
  const [row] = await db.select().from(ussdSessions).where(eq(ussdSessions.sessionId, sessionId))
  if (!row) return null
  if (row.expiresAt < new Date()) {
    await clearSession(sessionId)
    return null
  }
  return row
}

async function saveSession(
  sessionId: string,
  phone: string,
  next: SessionState,
  lastText: string,
  lastResponse: string,
  ttlMinutes: number,
) {
  const expiresAt = new Date(Date.now() + ttlMinutes * 60_000)

  await db
    .insert(ussdSessions)
    .values({
      sessionId,
      phone,
      flow: next.flow,
      step: next.step,
      payload: next.payload,
      lastText,
      lastResponse,
      expiresAt,
    })
    .onConflictDoUpdate({
      target: ussdSessions.sessionId,
      set: {
        flow: next.flow,
        step: next.step,
        payload: next.payload,
        lastText,
        lastResponse,
        expiresAt,
        updatedAt: new Date(),
      },
    })
}

async function clearSession(sessionId: string) {
  await db.delete(ussdSessions).where(eq(ussdSessions.sessionId, sessionId))
}
