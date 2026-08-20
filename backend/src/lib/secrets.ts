import { randomBytes } from "node:crypto"
import { argon2id, argon2Verify } from "hash-wasm"

/**
 * argon2id for low-entropy secrets (PINs, OTP codes): memory-hard, so a leaked hash
 * resists the offline attack a 4-digit PIN would otherwise fall to instantly.
 *
 * Pure WebAssembly (hash-wasm) rather than the native `argon2` addon — the addon's
 * prebuilt binary needs a newer glibc than the shared host has, and compiling it
 * there on every deploy is not an option. Cost parameters match that library's
 * defaults (m=64 MiB, t=3, p=4, 32-byte tag), and both sides speak the standard
 * PHC string format, so hashes it already stored keep verifying unchanged.
 */
export async function hashSecret(value: string): Promise<string> {
  return argon2id({
    password: value,
    salt: randomBytes(16),
    parallelism: 4,
    iterations: 3,
    memorySize: 65536,
    hashLength: 32,
    outputType: "encoded",
  })
}

/** Constant-time compare inside; a malformed stored hash is a non-match, never a throw. */
export async function verifySecret(hash: string, value: string): Promise<boolean> {
  try {
    return await argon2Verify({ password: value, hash })
  } catch {
    return false
  }
}
