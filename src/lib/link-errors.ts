/**
 * M51: PKCE verifier lives in the originating browser. If a
 * verification / reset link is opened on a different device or
 * browser than the one the request came from, the code exchange
 * fails with a cryptic verifier error. Detect that case and return
 * actionable device-mismatch guidance; return null for other errors.
 */
const PKCE_PATTERN = /verifier|pkce/i;

export function pkceDeviceMismatchMessage(raw: string, action: "verify" | "reset"): string | null {
  if (!PKCE_PATTERN.test(raw)) return null;
  return action === "verify"
    ? "This link was opened on a different device or browser than the one you signed up on, so it can't be verified here. Please open the email link on the same device and browser where you signed up — or sign up again from this device."
    : "This link was opened on a different device or browser than the one you requested the password reset on. Please open the reset link on the same device and browser — or request a new reset link from this device.";
}

/**
 * Audit-2 L22: `error_description` is attacker-controlled (anyone can
 * craft `?error=…&error_description=<…>`). Rendering it verbatim is
 * XSS-safe today (React text child, never dangerouslySetInnerHTML)
 * but still reflects arbitrary attacker text onto the page — a
 * phishing vector ("call 0300-… to unlock your account"). Map the
 * URL-derived description to an allowlist of known GoTrue link errors
 * and return the APP's own canonical message; anything else gets a
 * generic fallback. The attacker's text never reaches the page.
 * Apply ONLY at the ?error= throw site — the catch blocks still pass
 * through GoTrue API errors and app-owned messages unchanged.
 */
const LINK_ERROR_ALLOWLIST: Array<{ match: RegExp; message: string }> = [
  {
    match: /email link is invalid or has expired/i,
    message: "Email link is invalid or has expired.",
  },
  {
    match: /otp expired/i,
    message: "The code has expired — request a new one.",
  },
  {
    match: /token has expired or is invalid/i,
    message: "This link has expired or is invalid — request a new one.",
  },
];

export function safeLinkErrorMessage(
  desc: string | null,
  action: "verify" | "reset",
): string {
  if (desc) {
    for (const entry of LINK_ERROR_ALLOWLIST) {
      if (entry.match.test(desc)) return entry.message;
    }
  }
  return action === "verify"
    ? "Verification failed. The link may have expired."
    : "Password reset failed. The link may have expired.";
}
