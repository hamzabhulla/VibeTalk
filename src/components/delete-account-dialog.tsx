import { useEffect, useRef, useState } from "react";
import { useServerFn } from "@tanstack/react-start";
import { toast } from "sonner";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/lib/auth-context";
import { deleteMyAccount } from "@/lib/chat.functions";
import { useResendCooldown } from "@/lib/use-cooldown";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

type Step = "confirm" | "code" | "verified";

// Audit-2 L18: the server accepts an OTP entry < 600s old (ITS clock).
// The client counts down a 570s window instead — the 30s grace covers
// client/server clock skew (a client running behind must never present
// a verification the server already considers stale) plus the delete
// request's own travel time. The server bound is never loosened.
const VERIFIED_WINDOW_S = 570;

/**
 * Delete-account flow, shared by desktop Settings and mobile You:
 *  1. Warning + "Send verification code" — Supabase sends a one-time code
 *     to the account email (its own reauthentication email).
 *  2. Enter the 6-digit code — verified via Supabase OTP.
 *  3. Final explicit confirm — the account is permanently deleted.
 * The server additionally requires a fresh OTP entry in the JWT, so the
 * code step cannot be skipped by calling the server directly.
 */
export function DeleteAccountDialog({
  open,
  onOpenChange,
  onDeleted,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onDeleted: () => void | Promise<void>;
}) {
  const { user } = useAuth();
  const runDelete = useServerFn(deleteMyAccount);
  const [step, setStep] = useState<Step>("confirm");
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  // Audit-6 A6-INFO-6: synchronous re-entry guard for verifyCode.
  const verifyingRef = useRef(false);
  const deletingRef = useRef(false);
  // M58: the server requires an OTP entry < 600s old in the JWT.
  // Track when verification succeeded so the "verified" step can
  // show a countdown and auto-reset on expiry (instead of sitting
  // indefinitely and then failing with "Please verify first").
  const [verifiedAt, setVerifiedAt] = useState<number | null>(null);
  const [secondsLeft, setSecondsLeft] = useState(VERIFIED_WINDOW_S);
  // M62: resend cooldown (60s) — the resend button used to be
  // spammable until Supabase throttled it with a cryptic error.
  const resendCooldown = useResendCooldown(60);

  const reset = () => {
    setStep("confirm");
    setCode("");
    setBusy(false);
    setVerifiedAt(null);
    setSecondsLeft(VERIFIED_WINDOW_S);
  };

  // M58: 10-minute verification window — countdown + auto-reset to
  // the code step on expiry (user re-verifies without close/reopen).
  useEffect(() => {
    if (step !== "verified" || !verifiedAt) return;
    const tick = () => {
      const left = Math.max(0, Math.ceil((verifiedAt + VERIFIED_WINDOW_S * 1000 - Date.now()) / 1000));
      setSecondsLeft(left);
      if (left <= 0) {
        setStep("code");
        setCode("");
        setVerifiedAt(null);
        toast.error("Verification expired — enter the code again, or request a new one if it doesn't work.");
      }
    };
    tick();
    const id = setInterval(tick, 1000);
    return () => clearInterval(id);
  }, [step, verifiedAt]);

  const handleOpenChange = (next: boolean) => {
    if (!next) reset();
    onOpenChange(next);
  };

  // Audit-2 L19: the 60s cooldown is UX only (stops accidental
  // double-sends). An attacker with a stolen session can call
  // supabase.auth.reauthenticate() directly — the app cannot throttle
  // that; GoTrue's server-side OTP throttle is the real control (see
  // AGENTS.md "Threat model").
  const sendCode = async () => {
    if (!resendCooldown.tryReserve()) return;
    setBusy(true);
    try {
      const { error } = await supabase.auth.reauthenticate();
      if (error) throw error;
      setStep("code");
      resendCooldown.start();
      toast.success(`Verification code sent to ${user?.email ?? "your email"}.`);
    } catch (err) {
      toast.error(
        err instanceof Error ? err.message : "Could not send the verification code.",
      );
    } finally {
      resendCooldown.release();
      setBusy(false);
    }
  };

  const verifyCode = async () => {
    const token = code.trim();
    if (token.length < 6) {
      toast.error("Enter the 6-digit code from the email.");
      return;
    }
    if (!user?.email) {
      toast.error("No email on this account.");
      return;
    }
    // Audit-6 A6-INFO-6: handler-level re-entry guard — the busy
    // STATE does not paint within a tick, so a double-Enter fired
    // two verifyOtp calls (success + error toasts racing). The ref
    // is set synchronously, like the INFO-7 cooldown gates.
    if (verifyingRef.current) return;
    verifyingRef.current = true;
    setBusy(true);
    try {
      const { error } = await supabase.auth.verifyOtp({
        email: user.email,
        token,
        type: "reauthentication",
      });
      if (error) throw error;
      setStep("verified");
      setVerifiedAt(Date.now());
      setSecondsLeft(VERIFIED_WINDOW_S);
      toast.success("Email verified.");
    } catch (err) {
      toast.error(
        err instanceof Error ? err.message : "Invalid or expired code.",
      );
    } finally {
      verifyingRef.current = false;
      setBusy(false);
    }
  };

  const deleteNow = async () => {
    // Audit-7 A2: deleteNow lacked the re-entry ref guard its
    // sibling verifyCode got in Audit-6 (A6-INFO-6) — a double-fire
    // before the busy state painted ran runDelete twice; the server
    // fails the second call closed, so a success toast and an error
    // toast raced. Same synchronous ref pattern.
    if (deletingRef.current) return;
    deletingRef.current = true;
    setBusy(true);
    try {
      const res = await runDelete();
      const failures = (res as { cleanupFailures?: string[] } | null)?.cleanupFailures ?? [];
      if (failures.length > 0) {
        toast.success(
          `Your account has been deleted. Note: could not clean up: ${failures.join(", ")}.`,
        );
      } else {
        toast.success("Your account has been deleted.");
      }
      handleOpenChange(false);
      await onDeleted();
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Could not delete the account.";
      // Audit-2 L18: the server rejected a stale verification (e.g. the
      // client's clock ran behind the server's) — leaving the dialog on
      // "verified" strands the user on a Delete button that keeps
      // failing. Send them back to the code step to re-verify. Any
      // OTHER error (network, …) keeps the verification — retrying the
      // delete is still valid.
      if (/verify.*code first/i.test(msg)) {
        setStep("code");
        setCode("");
        setVerifiedAt(null);
        setSecondsLeft(VERIFIED_WINDOW_S);
        toast.error(
          "Verification expired — enter the code again, or request a new one if it doesn't work.",
        );
      } else {
        toast.error(msg);
      }
    } finally {
      deletingRef.current = false;
      setBusy(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle className="text-destructive">Delete account</DialogTitle>
          <DialogDescription>
            This permanently deletes your VibeTalk account. This cannot be undone.
          </DialogDescription>
        </DialogHeader>

        {step === "confirm" && (
          <div className="space-y-4">
            <p className="text-sm leading-relaxed text-muted-foreground">
              Your profile, room memberships, push subscriptions, call
              history, and messages will be deleted, and you will be
              signed out. Replies to your messages are deleted too.
              Rooms you created pass to their oldest remaining member
              and keep existing. Files or images you sent stay in
              shared conversations.
            </p>
            <p className="text-sm leading-relaxed text-muted-foreground">
              To confirm it&apos;s really you, we&apos;ll send a one-time
              verification code to <strong className="text-foreground">{user?.email ?? "your email"}</strong>.
            </p>
            <Button
              className="w-full bg-destructive text-destructive-foreground hover:bg-destructive/90"
              onClick={() => void sendCode()}
              disabled={busy || resendCooldown.coolingDown}
            >
              {busy
                ? "Sending…"
                : resendCooldown.coolingDown
                  ? `Send again in ${resendCooldown.remaining}s`
                  : "Send verification code"}
            </Button>
          </div>
        )}

        {step === "code" && (
          <div className="space-y-4">
            <p className="text-sm leading-relaxed text-muted-foreground">
              Enter the 6-digit code we sent to{" "}
              <strong className="text-foreground">{user?.email ?? "your email"}</strong>.
            </p>
            <Input
              inputMode="numeric"
              autoComplete="one-time-code"
              placeholder="123456"
              maxLength={6}
              value={code}
              onChange={(e) => setCode(e.target.value.replace(/[^0-9]/g, ""))}
              onKeyDown={(e) => {
                if (e.key === "Enter") void verifyCode();
              }}
            />
            <Button className="w-full" onClick={() => void verifyCode()} disabled={busy}>
              {busy ? "Verifying…" : "Verify code"}
            </Button>
            <button
              type="button"
              className="w-full text-center text-xs font-semibold text-primary hover:underline"
              onClick={() => void sendCode()}
              disabled={busy || resendCooldown.coolingDown}
            >
              {resendCooldown.coolingDown
                ? `Resend code in ${resendCooldown.remaining}s`
                : "Resend code"}
            </button>
          </div>
        )}

        {step === "verified" && (
          <div className="space-y-4">
            <p className="text-sm leading-relaxed text-muted-foreground">
              Email verified ✓. This is your last chance — deleting your
              account is <strong className="text-foreground">permanent</strong>.
            </p>
            <p className="text-sm leading-relaxed text-muted-foreground">
              Verification expires in{" "}
              <strong className="text-foreground">
                {Math.floor(secondsLeft / 60)}:{String(secondsLeft % 60).padStart(2, "0")}
              </strong>
              {" "}— delete within this window, or enter the code again (request a new one if it fails).
            </p>
            <Button
              className="w-full bg-destructive text-destructive-foreground hover:bg-destructive/90"
              onClick={() => void deleteNow()}
              disabled={busy}
            >
              {busy ? "Deleting…" : "Delete my account permanently"}
            </Button>
            <Button
              variant="outline"
              className="w-full"
              onClick={() => handleOpenChange(false)}
              disabled={busy}
            >
              Keep my account
            </Button>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
