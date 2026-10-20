import { useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { useServerFn } from "@tanstack/react-start";
import { useAuth } from "@/lib/auth-context";
import { changeEmail, changePassword } from "@/lib/account-security";
import { changePasswordWithPolicy } from "@/lib/auth.functions";
import { PASSWORD_MIN_LENGTH, PASSWORD_MAX_LENGTH } from "@/lib/password-policy";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

/**
 * M94: in-app credential rotation (desktop). Two modes in one dialog:
 * change password (current password + new + confirm) and change email
 * (current password + new address). Both re-authenticate with the
 * current password first (see account-security.ts). Email change
 * sends a confirmation link to the NEW address — it only takes
 * effect when clicked. Mobile has its own inline views
 * (MobileChangePassword / MobileChangeEmail in mobile-shell.tsx).
 */
export function ChangeCredentialsDialog({
  open,
  onOpenChange,
  mode,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  mode: "password" | "email";
}) {
  const { user } = useAuth();
  const setPassword = useServerFn(changePasswordWithPolicy);
  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  const [confirm, setConfirm] = useState("");
  const [busy, setBusy] = useState(false);
  const [emailSent, setEmailSent] = useState(false);
  // Audit-4 L41: ref guard mirroring MobileChangePassword /
  // MobileChangeEmail (A6-N4/A6-N5) — `busy` state updates are
  // async, so a same-tick double-submit runs onSubmit twice
  // before the re-render disables the button (the second
  // changePassword re-auth lands after the first call's global
  // sign-out → spurious error toast after success; the second
  // changeEmail sends a duplicate confirmation link). Set
  // synchronously before the async work, cleared in finally.
  const busyRef = useRef(false);

  useEffect(() => {
    if (!open) {
      setCurrent("");
      setNext("");
      setConfirm("");
      setBusy(false);
      setEmailSent(false);
    }
  }, [open ]);

  const onSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!user) return;
    // Audit-4 L41: same-tick double-submit guard (see busyRef).
    if (busyRef.current) return;
    busyRef.current = true;
    setBusy(true);
    try {
      if (mode === "password") {
        // Audit-4 M1: the set goes through the server fn (policy
        // enforced server-side) — see account-security.ts.
        const { signedOutEverywhere } = await changePassword(user, current, next, confirm, (pw) =>
          setPassword({ data: { newPassword: pw } }),
        );
        // M7: the change revoked every session (global sign-out) — the
        // user re-logs in with the new password. If the revoke failed,
        // say so: other devices may still be signed in.
        toast.success(
          signedOutEverywhere
            ? "Password changed. You've been signed out everywhere — please sign in again."
            : "Password changed, but other devices could not be signed out.",
        );
      } else {
        await changeEmail(user, current, next);
        setEmailSent(true);
        toast.success("Confirmation link sent to your new email address.");
      }
      if (mode === "password") onOpenChange(false);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Could not save.");
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-sm">
        <DialogHeader>
          <DialogTitle>
            {mode === "password" ? "Change password" : "Change email address"}
          </DialogTitle>
          <DialogDescription>
            {mode === "password"
              ? "Enter your current password, then choose a new one."
              : "Enter your current password and the new email address. A confirmation link will be sent to the new address."}
          </DialogDescription>
        </DialogHeader>
        {emailSent ? (
          <p className="text-sm leading-relaxed text-muted-foreground">
            A confirmation link is on its way to <strong>{next.trim()}</strong>. Click it to
            complete the change — your email stays as-is until then.
          </p>
        ) : (
          <form onSubmit={onSubmit} className="space-y-4">
            <div className="space-y-1.5">
              <Label htmlFor="cc-current">Current password</Label>
              <Input
                id="cc-current"
                type="password"
                autoComplete="current-password"
                value={current}
                onChange={(e) => setCurrent(e.target.value)}
                required
              />
            </div>
            {mode === "password" ? (
              <>
                <div className="space-y-1.5">
                  <Label htmlFor="cc-new">New password</Label>
                  <Input
                    id="cc-new"
                    type="password"
                    autoComplete="new-password"
                    value={next}
                    onChange={(e) => setNext(e.target.value)}
                    minLength={PASSWORD_MIN_LENGTH}
                    maxLength={PASSWORD_MAX_LENGTH}
                    required
                  />
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="cc-confirm">Confirm new password</Label>
                  <Input
                    id="cc-confirm"
                    type="password"
                    autoComplete="new-password"
                    value={confirm}
                    onChange={(e) => setConfirm(e.target.value)}
                    minLength={PASSWORD_MIN_LENGTH}
                    maxLength={PASSWORD_MAX_LENGTH}
                    required
                  />
                </div>
              </>
            ) : (
              <div className="space-y-1.5">
                <Label htmlFor="cc-email">New email address</Label>
                <Input
                  id="cc-email"
                  type="email"
                  autoComplete="email"
                  value={next}
                  onChange={(e) => setNext(e.target.value)}
                  placeholder={user?.email ?? ""}
                  required
                />
              </div>
            )}
            <Button type="submit" disabled={busy} className="w-full">
              {busy
                ? "Saving…"
                : mode === "password"
                  ? "Change password"
                  : "Send confirmation link"}
            </Button>
          </form>
        )}
      </DialogContent>
    </Dialog>
  );
}
