import net from "node:net"
import pg from "pg"
import { Pool as NeonPool } from "@neondatabase/serverless"

// Node gives each resolved address only 250 ms to finish a TCP handshake before moving on
// to the next one; on a high-latency route that surfaces as ETIMEDOUT against a perfectly
// reachable host. Give it a realistic budget.
net.setDefaultAutoSelectFamilyAttemptTimeout(2500)

/**
 * One place that decides how to reach Postgres.
 *
 * Neon is reached over its WebSocket proxy (TLS on 443) rather than raw 5432 — the shared
 * host the API runs on firewalls outbound Postgres, and 443 is open everywhere. Neon's
 * Pool subclasses pg.Pool, so Drizzle and every caller see a single type. Anything else
 * (local Docker Postgres) gets plain pg.
 */
export function createPool(connectionString: string): pg.Pool {
  const host = new URL(connectionString).hostname
  if (host.endsWith(".neon.tech")) {
    // Runtime-compatible (it extends pg's Pool), but the package bundles its own pg typings,
    // so the nominal types don't line up.
    return new NeonPool({ connectionString }) as unknown as pg.Pool
  }
  return new pg.Pool({ connectionString })
}
