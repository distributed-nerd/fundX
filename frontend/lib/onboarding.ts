/**
 * Onboarding draft.
 *
 * Held in sessionStorage rather than React state so a refresh mid-signup doesn't
 * drop someone back to the start. Cleared as soon as the account is created.
 *
 * The PIN passes through here in the mock. In the real flow it is posted straight
 * to the backend, hashed with Argon2, and never persisted on the device.
 */

const KEY = "fundx.onboarding";

export type Draft = {
  phone?: string;
  /**
   * The backend's own proof that this number was verified, issued by OTP check and consumed
   * by signup. It replaces a `verified: true` boolean, which was worthless — the client set
   * it, so the server could never trust it.
   */
  signupToken?: string;
  pin?: string;
  displayName?: string;
  username?: string;
};

export function getDraft(): Draft {
  if (typeof window === "undefined") return {};
  try {
    const raw = window.sessionStorage.getItem(KEY);
    return raw ? (JSON.parse(raw) as Draft) : {};
  } catch {
    return {};
  }
}

export function patchDraft(patch: Draft): Draft {
  const next = { ...getDraft(), ...patch };
  if (typeof window !== "undefined") {
    try {
      window.sessionStorage.setItem(KEY, JSON.stringify(next));
    } catch {
      /* ignore */
    }
  }
  return next;
}

export function clearDraft(): void {
  if (typeof window === "undefined") return;
  window.sessionStorage.removeItem(KEY);
}
