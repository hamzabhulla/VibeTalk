import { supabase } from "@/integrations/supabase/client";
import { passwordPolicyError } from "@/lib/password-policy";

/**
 * M94: authenticated credential rotation (change password / change
 * email from inside the app). Supabase's updateUser does NOT verify
 * the current password, so both flows re-authenticate with it first
 * (signInWithPassword) — a stolen session alone must not rotate
 * credentials. The re-auth refreshes the session; the subsequent
 * updateUser runs on the fresh session.
 */
async function reauthenticate(email: string | undefined, currentPassword: string): Promise<void> {
  if (!email) throw new Error("This account has no email address.");
  // Audit-2 L20: a blank current password used to reach Supabase and
  // come back as "Current password is incorrect." — misleading (the
  // field was empty, not wrong). Guard here, once, for every caller
  // (desktop form + mobile) instead of in each UI.
  if (!currentPassword.trim()) throw new Error("Enter your current password.");
  const { error } = await supabase.auth.signInWithPassword({
    email,
    password: currentPassword,
  });
  if (!error) return;
  // Audit-2 L13: EVERY signIn error used to surface as "Current password
  // is incorrect" — a network failure or rate limit sent the user off to
  // reset a password that was never wrong. Only invalid credentials get
  // that message; anything else surfaces as-is (rate limit, network,
  // email-not-confirmed), with a generic fallback for a messageless error.
  const code = (error as { code?: unknown }).code;
  const msg = error.message ?? "";
  const invalidCredentials =
    code === "invalid_credentials" ||
    /invalid login credentials/i.test(msg) ||
    /invalid (email|password)/i.test(msg);
  if (invalidCredentials) throw new Error("Current password is incorrect.");
  if (msg) throw error;
  throw new Error("Could not verify — try again.");
}

export async function changePassword(
  user: { email?: string },
  currentPassword: string,
  newPassword: string,
  confirmPassword: string,
  // Audit-4 M1: the password SET goes through this injected server
  // fn (changePasswordWithPolicy), which enforces the policy
  // server-side. The old client updateUser let a console/curl call
  // bypass min-8, the blocklist, and the 72-byte cap. Injected
  // (rather than imported) because this file runs in the browser
  // and server fns are invoked via useServerFn in components.
  setPassword: (newPassword: string) => Promise<unknown>,
): Promise<{ signedOutEverywhere: boolean }> {
  const pwError = passwordPolicyError(newPassword);
  if (pwError) throw new Error(pwError);
  if (newPassword !== confirmPassword) throw new Error("New passwords do not match.");
  // Audit-2 L24: new == current used to "succeed" (reauth + updateUser
  // + global sign-out) while changing nothing — a no-op that signed
  // the user out everywhere. Fail fast, before any network call.
  if (newPassword === currentPassword) {
    throw new Error("New password must be different from your current password.");
  }
  await reauthenticate(user.email, currentPassword);
  // Audit-4 M1: server-enforced policy (see setPassword param).
  await setPassword(newPassword);
  // Audit-2 M7: updateUser alone leaves every OTHER device's refresh
  // token valid — a stolen session survives the password change. Global
  // sign-out revokes ALL refresh tokens (including this one), so the
  // user re-logs in with the new password everywhere. On failure, at
  // least clear this session locally and report false — the caller
  // warns that other devices may still be signed in.
  const { error: signOutError } = await supabase.auth.signOut({ scope: "global" });
  if (signOutError) {
    await supabase.auth.signOut({ scope: "local" }).catch(() => null);
    return { signedOutEverywhere: false };
  }
  return { signedOutEverywhere: true };
}

export async function changeEmail(
  user: { email?: string },
  currentPassword: string,
  newEmailRaw: string,
): Promise<void> {
  const newEmail = newEmailRaw.trim();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(newEmail)) {
    throw new Error("Enter a valid email address.");
  }
  if (user.email && newEmail.toLowerCase() === user.email.toLowerCase()) {
    throw new Error("This is already your email address.");
  }
  await reauthenticate(user.email, currentPassword);
  // Sends a confirmation link to the NEW address; the change only
  // takes effect when the user clicks it. (Delivery depends on the
  // app's SMTP setup — same honest limit as the other email flows.)
  // Audit-3 A2-N5: explicit emailRedirectTo — this was the only
  // email-link flow that omitted it, so GoTrue fell back to the
  // dashboard Site URL (standing localhost problem) and the link
  // landed where no handler exists. The callback accepts the landing
  // via isEmailChangeSession (same file) — without that path the
  // A2-N1 provenance check would destroy the freshly exchanged
  // session and the change would appear to fail.
  const { error } = await supabase.auth.updateUser(
    { email: newEmail },
    { emailRedirectTo: `${window.location.origin}/auth/callback` },
  );
  if (error) {
    // Audit-2 M14: a GoTrue "already in use" error would tell an
    // authenticated attacker the target email is registered
    // (enumeration oracle). Masking the message alone is NOT enough —
    // success vs failure itself would still distinguish taken from
    // free — so the taken case takes the SAME success path as a real
    // send: the callers show "Confirmation link sent" for taken and
    // free addresses alike. The change never takes effect for a taken
    // address (GoTrue sent nothing), so this is a display-only
    // equivalence, not a bypass. Other errors (rate limit, transport)
    // surface honestly — they reveal nothing about the target.
    const code = (error as { code?: unknown }).code;
    const msg = error.message ?? "";
    const alreadyInUse =
      code === "email_exists" || /already.*(in use|registered|exists)/i.test(msg);
    if (!alreadyInUse) throw error;
  }
}
