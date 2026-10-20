import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { useServerFn } from "@tanstack/react-start";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useAuth } from "@/lib/auth-context";
import { useTheme } from "@/hooks/use-theme";
import { getMe, updateProfile } from "@/lib/auth.functions";
import {
  savePushSubscription,
  removePushSubscription,
  checkPushSetup,
  sendTestPush,
  checkPushEndpoint,
  getVapidPublicKey,
} from "@/lib/push.functions";
import { SmartAvatar } from "@/components/smart-avatar";
import { MobileShell, MobileYou } from "@/components/mobile-shell";
import { useIsDesktop } from "@/hooks/use-is-desktop";
import { ProfileDialog } from "@/components/profile-dialog";
import { PushDeviceList } from "@/components/push-device-list";
import { DeleteAccountDialog } from "@/components/delete-account-dialog";
import { ChangeCredentialsDialog } from "@/components/change-credentials-dialog";
import { Skeleton } from "@/components/ui/skeleton";
import { Switch } from "@/components/ui/switch";
import { Button } from "@/components/ui/button";
import { Bell, SunMoon, Pencil, LogOut, Eye, EyeOff, Trash2, KeyRound, Mail, Radio, CheckCircle2 } from "lucide-react";
import { listPushSubscriptions } from "@/lib/push.functions";
import { toast } from "sonner";
import { isUserOnline } from "@/lib/presence";
import { getTurnStatus } from "@/lib/calls";
import {
  isNotificationSupported,
  isNotificationsEnabled,
  getNotificationPermission,
  requestNotificationPermission,
  setNotificationsEnabled,
  type NotifPermission,
} from "@/lib/notifications";
import {
  pushSupported,
  subscribeToPush,
  unsubscribeFromPush,
  currentPushEndpoint,
  type PushKeys,
} from "@/lib/push-client";
import { usePushHealFailure, clearPushHealFailure } from "@/lib/push-heal";

export const Route = createFileRoute("/_app/profile")({
  component: ProfilePage,
  // Audit-4 L80: this route consumes no search keys.
  validateSearch: () => ({}),
  head: () => ({
    meta: [
      { title: "Your profile — VibeTalk" },
      { name: "description", content: "Presence, notifications and account." },
      { property: "og:title", content: "Your profile — VibeTalk" },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary" },
    ],
  }),
});

function ProfilePage() {
  // H44: the wrapper runs NO queries/effects. The desktop-only
  // ["me"], ["push-setup"] queries + device-check effect live in
  // DesktopProfile, so mobile doesn't run them (MobileYou has its own
  // ["me"] query + useTheme).
  const isDesktop = useIsDesktop();
  // Audit-2 M17: breakpoint unknown (SSR / pre-hydration) — render a
  // query-free placeholder, not a branch (the server renders the
  // same tree, so there is no hydration mismatch).
  if (isDesktop === null) {
    return <div className="h-full min-h-0" />;
  }
  if (!isDesktop) {
    return (
      <MobileShell view="you">
        <MobileYou />
      </MobileShell>
    );
  }
  return <DesktopProfile />;
}

function DesktopProfile() {
  const { user, signOut } = useAuth();
  const { theme, toggle } = useTheme();
  const navigate = useNavigate();
  const qc = useQueryClient();
  const getProfile = useServerFn(getMe);
  const update = useServerFn(updateProfile);
  const [deleteOpen, setDeleteOpen] = useState(false);
  // M94: in-app credential rotation.
  const [credMode, setCredMode] = useState<"password" | "email" | null>(null);
  const [visSaving, setVisSaving] = useState(false);
  const savePush = useServerFn(savePushSubscription);
  const getVapidKey = useServerFn(getVapidPublicKey);
  const removePush = useServerFn(removePushSubscription);
  const pushCheck = useServerFn(checkPushSetup);
  const testPush = useServerFn(sendTestPush);
  const checkEndpoint = useServerFn(checkPushEndpoint);
  const [testing, setTesting] = useState(false);

  const [notifOn, setNotifOn] = useState(false);
  const [notifPermission, setNotifPermission] = useState<NotifPermission>("default");
  // M99: self-heal failure, surfaced in the diagnostics below.
  const healFailure = usePushHealFailure();

  // Per-DEVICE status: the account-level count can be >0 from another
  // browser, so verify THIS browser's endpoint is actually registered.
  const [deviceRegistered, setDeviceRegistered] = useState<boolean | null>(null);
  const [deviceCheckId, setDeviceCheckId] = useState(0);
  useEffect(() => {
    if (!notifOn) {
      setDeviceRegistered(null);
      return;
    }
    let alive = true;
    (async () => {
      try {
        const ep = await currentPushEndpoint();
        if (!ep) {
          if (alive) setDeviceRegistered(false);
          return;
        }
        const { registered } = await checkEndpoint({ data: { endpoint: ep } });
        if (alive) setDeviceRegistered(registered);
      } catch {
        if (alive) setDeviceRegistered(false);
      }
    })();
    return () => {
      alive = false;
    };
    // deviceCheckId lets the toggle handler force a re-check after
    // subscribeToPush completes (the effect would otherwise run too early,
    // before the push-service roundtrip finishes, and show a false red).
  }, [notifOn, checkEndpoint, deviceCheckId]);

  const {
    data: pushStatus,
    // Audit-2 L59: same gap as mobile — a checkPushSetup failure
    // rendered nothing; surface it with a retry.
    isError: pushStatusError,
    refetch: refetchPushStatus,
  } = useQuery({
    queryKey: ["push-setup"],
    queryFn: () => pushCheck(),
    enabled: notifOn,
  });

  const { data: meData, isLoading } = useQuery({
    queryKey: ["me"],
    queryFn: () => getProfile(),
    enabled: !!user,
  });
  const profile = meData?.profile ?? null;

  useEffect(() => {
    setNotifOn(isNotificationsEnabled());
    setNotifPermission(getNotificationPermission());
  }, []);

  const toggleNotifications = async () => {
    if (!isNotificationSupported()) {
      toast.error("Notifications are not supported in this browser.");
      return;
    }
    if (notifOn) {
      // M31: don't claim OFF until the server row is verified gone —
      // a failed delete leaves the row, and the server keeps pushing
      // to a browser whose user turned notifications OFF.
      try {
        // Audit-4 L22: only attempt the push removal when push is
        // supported — a browser that never supported push has no
        // row to remove (unsubscribeFromPush throws when
        // unsupported); the OFF claim below is then local-only.
        if (pushSupported()) {
          await unsubscribeFromPush(
            (endpoint) => removePush({ data: { endpoint } }),
            (endpoint) => checkEndpoint({ data: { endpoint } }),
          );
        }
        setNotificationsEnabled(false);
        setNotifOn(false);
        // M99: notifications off makes a stale heal failure moot.
        clearPushHealFailure();
        // Audit-4 L40: the removed row must drop out of the
        // Registered devices list.
        void qc.invalidateQueries({ queryKey: ["my-push-subscriptions"] });
      } catch {
        // OFF didn't take effect — leave the toggle ON and say so.
        setNotificationsEnabled(true);
        setNotifOn(true);
        toast.error("Couldn't turn notifications off — please try again.");
      }
      return;
    }
    let perm = getNotificationPermission();
    if (perm === "default") perm = await requestNotificationPermission();
    setNotifPermission(perm);
    if (perm !== "granted") {
      toast.error(
        perm === "denied"
          ? "Notifications are blocked. Allow them in your browser settings, then try again."
          : "Notification permission was not granted.",
      );
      return;
    }
    setNotificationsEnabled(true);
    setNotifOn(true);
    if (pushSupported()) {
      try {
        const keys = await subscribeToPush((sub: PushKeys) => savePush({ data: sub }), () => getVapidKey());
        // Re-check device status now that the subscription roundtrip finished.
        setDeviceCheckId((n) => n + 1);
        if (keys) {
          // M99: manual re-subscribe succeeded — the heal failure is stale.
          clearPushHealFailure();
          // Audit-4 L40: the newly saved row must appear in the
          // Registered devices list.
          void qc.invalidateQueries({ queryKey: ["my-push-subscriptions"] });
          toast.success("Notifications enabled — you'll be pinged even with the app closed.");
        } else {
          toast.warning(
            "Notifications on, but background push could not be set up on this device.",
          );
        }
      } catch (err) {
        // Surface the real reason (e.g. the push_subscriptions table is missing).
        toast.error(
          `Notifications on, but push setup failed: ${err instanceof Error ? err.message : "unknown error"}`,
          { duration: 8000 },
        );
      }
    } else {
      toast.success("Notifications enabled. You'll be pinged for new messages.");
    }
  };

  const displayName =
    profile?.display_name ?? user?.user_metadata?.display_name ?? user?.email ?? "You";
  // M36: derive presence like every other view — the old header
  // hardcoded "Member · Online" (and an always-green dot), so the
  // user looked online even with the tab suspended for hours.
  const online = isUserOnline(profile?.last_seen_at);

  const onSignOut = async () => {
    // M47: only navigate on success.
    try {
      await signOut();
      navigate({ to: "/", replace: true });
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Could not sign out — please try again.");
    }
  };

  // Audit-2 M8: global sign-out — revokes the session on EVERY device
  // (a copied refresh token dies too) and stops pushes everywhere.
  const onSignOutEverywhere = async () => {
    // M47: only navigate on success.
    try {
      await signOut({ everywhere: true });
      navigate({ to: "/", replace: true });
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Could not sign out — please try again.");
    }
  };

  // Profile visibility: public = anyone can find you in People; private =
  // hidden from People (existing chats keep working).
  const isPublic = (profile as { is_public?: boolean } | null)?.is_public ?? true;
  const toggleVisibility = async (next: boolean) => {
    setVisSaving(true);
    try {
      // H41: send ONLY the field being toggled (partial update).
      const res = await update({
        data: {
          isPublic: next,
        },
      });
      qc.invalidateQueries({ queryKey: ["me"] });
      qc.invalidateQueries({ queryKey: ["users"] });
      toast.success(next ? "Profile is public" : "Profile is private");
      // Audit-4 H6: surface the warning — the old code discarded the
      // result, so pre-SQL (privacy columns missing) the server
      // returned { ok: true, warning: "privacy settings need
      // vibetalk-profile-privacy.sql..." } and the user still got
      // "Profile is private" while staying Public.
      if (res.warning) toast.warning(res.warning);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Could not save");
    } finally {
      setVisSaving(false);
    }
  };

  // Per-section privacy: each profile section can be Public or Private.
  // Private sections are hidden when someone else opens your profile.
  const privacyProfile = profile as {
    is_avatar_public?: boolean;
    is_name_public?: boolean;
    is_bio_public?: boolean;
    is_status_public?: boolean;
  } | null;
  const toggleSection = async (
    key: "isAvatarPublic" | "isNamePublic" | "isBioPublic" | "isStatusPublic",
    next: boolean,
  ) => {
    setVisSaving(true);
    try {
      // H41: send ONLY the section being toggled (partial update) — the
      // old code re-sent displayName/bio/customStatus with a metadata
      // fallback, overwriting the name if the profile hadn't loaded.
      const sectionPatch: {
        isAvatarPublic?: boolean;
        isNamePublic?: boolean;
        isBioPublic?: boolean;
        isStatusPublic?: boolean;
      } = {};
      sectionPatch[key] = next;
      const res = await update({ data: sectionPatch });
      qc.invalidateQueries({ queryKey: ["me"] });
      qc.invalidateQueries({ queryKey: ["users"] });
      toast.success(next ? "Section is public" : "Section is private");
      if (res.warning) toast.warning(res.warning);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Could not save");
    } finally {
      setVisSaving(false);
    }
  };

  // Audit-2 L70: lock-screen privacy — previews off means
  // notifications show only "New message" (push + in-app).
  const previewsOn = (profile as { show_notification_previews?: boolean } | null)
    ?.show_notification_previews ?? true;
  const togglePreviews = async (next: boolean) => {
    setVisSaving(true);
    try {
      const res = await update({ data: { showNotificationPreviews: next } });
      qc.invalidateQueries({ queryKey: ["me"] });
      qc.invalidateQueries({ queryKey: ["users"] });
      qc.invalidateQueries({ queryKey: ["my-preview-pref"] });
      toast.success(next ? "Message previews on" : "Message previews off — notifications show “New message” only");
      if (res.warning) toast.warning(res.warning);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Could not save");
    } finally {
      setVisSaving(false);
    }
  };

  // Mockup id-card fact: registered-device count, read through the
  // SAME query PushDeviceList uses (cache-shared, one fetch). Only
  // enabled under the same gate that mounts the device list.
  const listPushCount = useServerFn(listPushSubscriptions);
  const { data: pushSubsData } = useQuery({
    queryKey: ["my-push-subscriptions"],
    queryFn: async () => {
      const endpoint = await currentPushEndpoint().catch(() => null);
      return listPushCount({ data: { endpoint: endpoint ?? null } });
    },
    enabled: notifOn && !!pushStatus?.tableOk,
  });
  const deviceCount = pushSubsData?.subscriptions?.length;
  // Fully-healthy push state drives the mockup's green banner; every
  // other state keeps the detailed diagnostic lines inside the
  // Preferences card below.
  const pushHealthy =
    notifOn &&
    !!pushStatus &&
    !pushStatus.tableMissing &&
    !pushStatus.probeError &&
    pushStatus.vapidConfigured &&
    pushStatus.serviceRoleConfigured &&
    deviceRegistered === true;

  return (
    <div className="h-full w-full overflow-y-auto px-[38px] pb-[38px] pt-[30px]">
      <h1 className="text-[28px] font-extrabold tracking-[-0.03em]">Your profile</h1>
      <p className="mt-1 text-[14.5px] font-semibold text-muted-foreground">
        Presence, notifications and account.
      </p>

      {/* Mockup layout: 348px identity card + settings stack. */}
      <div className="mt-6 grid items-start gap-5 lg:grid-cols-[348px_minmax(0,1fr)]">
        <div className="rounded-[14px] border border-border bg-card p-[28px_24px_22px] text-center shadow-sm">
          {isLoading || !user?.id ? (
            <Skeleton className="mx-auto h-[88px] w-[88px] rounded-[20px]" />
          ) : (
            <div className="relative mx-auto h-[88px] w-[88px]">
              <SmartAvatar
                userId={user.id}
                name={displayName}
                className="h-[88px] w-[88px] rounded-[20px] text-[28px]"
                fallbackClassName="rounded-[20px] bg-accent text-[28px] text-accent-foreground"
              />
              <span
                className={`absolute -bottom-[3px] -right-[3px] h-[17px] w-[17px] rounded-full border-[2.5px] border-card ${
                  online ? "bg-[#22c55e]" : "bg-[#a7b5aa]"
                }`}
              />
            </div>
          )}
          <h2 className="mt-4 truncate text-[21px] font-extrabold">
            {isLoading ? <Skeleton className="mx-auto h-5 w-32" /> : displayName}
          </h2>
          <div className="mt-[3px] flex items-center justify-center gap-[7px] text-[13.5px] font-bold text-muted-foreground">
            <span
              className={`h-[9px] w-[9px] rounded-full ${online ? "bg-[#22c55e]" : "bg-[#a7b5aa]"}`}
            />
            {isLoading ? <Skeleton className="h-3.5 w-24" /> : `Member · ${online ? "Online" : "Offline"}`}
          </div>
          <ProfileDialog>
            <button
              type="button"
              className="mt-5 flex h-[42px] w-full items-center justify-center gap-2 rounded-[10px] bg-primary text-sm font-bold text-primary-foreground transition-colors hover:bg-[#16a34a]"
            >
              <Pencil className="h-[17px] w-[17px]" />
              Edit profile
            </button>
          </ProfileDialog>
          <div className="mt-5 border-t border-border pt-1.5 text-left">
            <div className="flex items-center justify-between px-0.5 py-[9px] text-[13.5px]">
              <span className="font-bold text-muted-foreground">Profile visibility</span>
              <b className="font-extrabold">{isPublic ? "Public" : "Private"}</b>
            </div>
            <div className="flex items-center justify-between px-0.5 py-[9px] text-[13.5px]">
              <span className="font-bold text-muted-foreground">Registered devices</span>
              <b className="font-extrabold">{deviceCount ?? "—"}</b>
            </div>
            <div className="flex items-center justify-between px-0.5 py-[9px] text-[13.5px]">
              <span className="font-bold text-muted-foreground">Signed in as</span>
              <b className="font-extrabold">Desktop · This PC</b>
            </div>
          </div>
        </div>

        <div className="flex min-w-0 flex-col gap-5">
          {pushHealthy && (
            <div className="flex items-center gap-[13px] rounded-[14px] border border-border bg-card p-[15px_18px] shadow-sm">
              <span className="grid h-[38px] w-[38px] shrink-0 place-items-center rounded-[10px] bg-accent text-accent-foreground">
                <CheckCircle2 className="h-[21px] w-[21px]" />
              </span>
              <div className="text-[14.5px] font-bold">
                Push notifications are set up correctly
                <small className="mt-[1px] block text-[12.5px] font-semibold text-muted-foreground">
                  Messages and calls will ring on this device.
                </small>
              </div>
            </div>
          )}
          <div className="rounded-[14px] border border-border bg-card p-[22px_24px] shadow-sm">
            <h3 className="mb-1 text-[13px] font-extrabold uppercase tracking-[0.09em] text-[#93a498] dark:text-[#686f76]">
              Preferences
            </h3>
            <div className="flex items-center gap-[15px] border-b border-border py-[15px]">
          <span className="grid h-[42px] w-[42px] shrink-0 place-items-center rounded-[11px] bg-accent text-accent-foreground dark:bg-secondary dark:text-muted-foreground">
            <Bell className="h-[22px] w-[22px]" />
          </span>
          <div className="min-w-0 flex-1">
            <p className="text-[15.5px] font-extrabold">Message notifications</p>
            <p className="mt-px text-[13px] font-semibold text-muted-foreground">
              {notifPermission === "unsupported"
                ? "Not supported in this browser."
                : notifPermission === "denied"
                  ? "Blocked — allow them in your browser settings."
                  : notifOn
                    ? "On — rooms and direct messages."
                    : "Rooms and direct messages."}
            </p>
          </div>
          <Switch
            checked={notifOn}
            onCheckedChange={toggleNotifications}
            disabled={notifPermission === "unsupported"}
            aria-label="Toggle message notifications"
            className="vt-switch shrink-0"
          />
        </div>
        {notifOn && healFailure && !pushHealthy && (
          // Audit-7 D-I2: this gate lacked !pushHealthy — a STALE
          // heal failure (recorded earlier, never cleared) rendered
          // under the green "push healthy" banner at the same time.
          <p className="pt-2 text-[11px] leading-5 text-destructive">
            Push repair failed ({healFailure.message})
          </p>
        )}
        {notifOn && pushStatusError && (
          <p className="pt-2 text-[11px] leading-5">
            <span className="text-destructive">Couldn&apos;t check push setup — </span>
            <button
              type="button"
              className="font-semibold text-primary"
              onClick={() => void refetchPushStatus()}
            >
              tap to retry
            </button>
          </p>
        )}
        {notifOn && pushStatus && !pushHealthy && (
          <p className="pt-2 text-[11px] leading-5 text-muted-foreground">
            {pushStatus.tableMissing ? (
              <span className="text-destructive">
                Push database table missing — the push_subscriptions table has not been created
                in Supabase yet (migration 20261006090435_push_subscriptions), then turn
                notifications off and on again.
              </span>
            ) : pushStatus.probeError ? (
              // Audit-4 L34: the probe failed for a reason OTHER than
              // a missing table (RLS/permission/policy) — don't tell
              // the user to run SQL that cannot help.
              <span className="text-destructive">
                Push status check failed — the database couldn&apos;t be reached. Try again later.
              </span>
            ) : !pushStatus.vapidConfigured ? (
              <span className="text-destructive">
                Server push keys not configured — contact support.
              </span>
            ) : !pushStatus.serviceRoleConfigured ? (
              <span className="text-destructive">
                Server service key missing — messages send, but background push never fires.
                Contact support.
              </span>
            ) : deviceRegistered === false ? (
              <span className="text-destructive">
                This browser is not registered for background push — turn notifications off and on
                again.
              </span>
            ) : deviceRegistered === null ? (
              <span>Checking this browser's registration…</span>
            ) : null}
            {/* Audit-7 D-I1: the final else ("Background push active
                on this device ✓") was unreachable — falling through
                every branch above means deviceRegistered === true
                with all checks green, which IS pushHealthy, and this
                block is gated on !pushHealthy. The healthy state is
                announced by the banner at the top of the card. */}
          </p>
        )}
        {notifOn && pushStatus?.tableOk && pushStatus.vapidConfigured && (
          <div className="pt-2">
            <Button
              variant="outline"
              size="sm"
              className="h-8 rounded-lg text-xs font-bold"
              disabled={testing}
              onClick={async () => {
                setTesting(true);
                try {
                  const r = await testPush();
                  // Audit-2 L71: surface WHICH device failed, not
                  // just the count — the server now returns
                  // per-device results. Audit-4 L25: endpointId
                  // disambiguates devices that share a push host
                  // (two Chrome devices both report fcm.googleapis.com).
                  const failed = (r.results ?? []).filter((d) => !d.ok);
                  toast.success(
                    r.sent > 0
                      ? `Test sent to ${r.sent}/${r.total} device(s) — check your notifications.` +
                        (failed.length > 0
                          ? ` Failed: ${failed.map((d) => `${d.endpointHost} [${d.endpointId}] (${d.status})`).join(", ")}.`
                          : "")
                      : "Test push failed on all devices.",
                  );
                } catch (err) {
                  toast.error(err instanceof Error ? err.message : "Test failed");
                } finally {
                  setTesting(false);
                }
              }}
            >
              {testing ? "Sending…" : "Send test notification"}
            </Button>
          </div>
        )}
        {/* Audit-2 L70: lock-screen privacy. */}
        <div className="flex items-center gap-[15px] border-b border-border py-[15px]">
          <span className="grid h-[42px] w-[42px] shrink-0 place-items-center rounded-[11px] bg-accent text-accent-foreground dark:bg-secondary dark:text-muted-foreground">
            <Eye className="h-[22px] w-[22px]" />
          </span>
          <div className="min-w-0 flex-1">
            <p className="text-[15.5px] font-extrabold">Show message previews</p>
            <p className="mt-px text-[13px] font-semibold text-muted-foreground">
              {previewsOn
                ? "On — notifications show the message text."
                : "Off — notifications show “New message” only. Good for a shared or visible lock screen."}
            </p>
          </div>
          <Switch
            checked={previewsOn}
            onCheckedChange={(v) => void togglePreviews(v)}
            disabled={visSaving || !profile}
            aria-label="Toggle message previews in notifications"
            className="vt-switch shrink-0"
          />
        </div>
        {(() => {
          // Audit-2 L45: TURN status surfaced in Preferences — a partial
          // config used to fail calls silently (STUN-only, no clue).
          const turn = getTurnStatus();
          return (
            <div className="flex items-center gap-[15px] border-b border-border py-[15px]">
              <span className="grid h-[42px] w-[42px] shrink-0 place-items-center rounded-[11px] bg-accent text-accent-foreground dark:bg-secondary dark:text-muted-foreground">
                <Radio className="h-[22px] w-[22px]" />
              </span>
              <div className="min-w-0 flex-1">
                <p className="text-[15.5px] font-extrabold">Call relay (TURN)</p>
                <p className="mt-px text-[13px] font-semibold text-muted-foreground">
                  {turn.configured ? (
                    "On — calls can use the TURN relay."
                  ) : turn.partial ? (
                    <span className="text-destructive">
                      Partially configured ({turn.missing.join(", ")} missing) — calls run STUN-only.
                      Set all three TURN vars or none.
                    </span>
                  ) : (
                    "Off — direct connections only (STUN)."
                  )}
                </p>
              </div>
            </div>
          );
        })()}
        <div className="flex items-center gap-[15px] border-b border-border py-[15px]">
          <span className="grid h-[42px] w-[42px] shrink-0 place-items-center rounded-[11px] bg-accent text-accent-foreground dark:bg-secondary dark:text-muted-foreground">
            <SunMoon className="h-[22px] w-[22px]" />
          </span>
          <div className="min-w-0 flex-1">
            <p className="text-[15.5px] font-extrabold">Appearance</p>
            <p className="mt-px text-[13px] font-semibold text-muted-foreground">
              Currently {theme === "dark" ? "dark" : "light"} mode.
            </p>
          </div>
          <Switch
            checked={theme === "dark"}
            onCheckedChange={toggle}
            aria-label="Toggle dark mode"
            className="vt-switch shrink-0"
          />
        </div>
        <div className="flex items-center gap-[15px] py-[15px]">
          <span className="grid h-[42px] w-[42px] shrink-0 place-items-center rounded-[11px] bg-accent text-accent-foreground dark:bg-secondary dark:text-muted-foreground">
            {isPublic ? (
              <Eye className="h-[22px] w-[22px]" />
            ) : (
              <EyeOff className="h-[22px] w-[22px]" />
            )}
          </span>
          <div className="min-w-0 flex-1">
            <p className="text-[15.5px] font-extrabold">Profile visibility</p>
            <p className="mt-px text-[13px] font-semibold text-muted-foreground">
              {isPublic
                ? "Public — anyone can find you in People."
                : "Private — hidden from People. Existing chats keep working."}
            </p>
          </div>
          <Switch
            checked={isPublic}
            onCheckedChange={(v) => void toggleVisibility(v)}
            // H41: disabled until the profile loads — the toggle's state
            // is unknown before then.
            disabled={visSaving || !profile}
            aria-label="Toggle profile visibility"
            className="vt-switch shrink-0"
          />
        </div>
          </div>

          <div className="rounded-[14px] border border-border bg-card p-[22px_24px] shadow-sm">
            <h3 className="mb-1 text-[13px] font-extrabold uppercase tracking-[0.09em] text-[#93a498] dark:text-[#686f76]">
              Who can see what
            </h3>
            <p className="mb-1.5 mt-0.5 text-[13.5px] font-semibold text-muted-foreground">
              Turn a section off to hide it when someone opens your profile.
            </p>
        {(
          [
            ["isAvatarPublic", "is_avatar_public", "Profile photo", "Your picture"],
            ["isNamePublic", "is_name_public", "Name", "Your display name"],
            ["isBioPublic", "is_bio_public", "Bio", "A line or two about you"],
            ["isStatusPublic", "is_status_public", "Status", "What you're up to"],
          ] as const
        ).map(([key, col, title, sub]) => {
          const checked = (privacyProfile?.[col] ?? true) as boolean;
          return (
            <div
              key={key}
              className="flex items-center gap-[15px] border-b border-border py-[15px] last:border-b-0 last:pb-0.5"
            >
              <div className="min-w-0 flex-1">
                <p className="text-[15.5px] font-extrabold">{title}</p>
                <p className="mt-px text-[13px] font-semibold text-muted-foreground">
                  {checked ? "Public" : "Private"} · {sub}
                </p>
              </div>
              <Switch
                checked={checked}
                onCheckedChange={(v) => void toggleSection(key, v)}
                // H41: disabled until the profile loads.
                disabled={visSaving || !profile}
                aria-label={`Toggle ${title} visibility`}
                className="vt-switch shrink-0"
              />
            </div>
          );
        })}
          </div>

          {/* Registered devices — own card (mockup), same gate as
              before (Audit-4 L40). */}
          {notifOn && pushStatus?.tableOk && <PushDeviceList variant="desktop" />}

          <div className="rounded-[14px] border border-border bg-card p-[22px_24px] shadow-sm">
            <h3 className="mb-1 text-[13px] font-extrabold uppercase tracking-[0.09em] text-[#93a498] dark:text-[#686f76]">
              Account
            </h3>
        <button
          type="button"
          onClick={onSignOut}
          className="flex w-full items-center gap-[15px] border-b border-border py-[15px] text-left"
        >
          <span className="grid h-[42px] w-[42px] shrink-0 place-items-center rounded-[11px] bg-[#f7e9eb] text-[#9d2235] dark:bg-[#2a171b] dark:text-[#c4707d]">
            <LogOut className="h-[22px] w-[22px]" />
          </span>
          <span className="min-w-0 flex-1">
            <span className="block text-[15.5px] font-extrabold text-destructive">Sign out</span>
            <span className="mt-px block text-[13px] font-semibold text-muted-foreground">
              Only this device — other devices stay signed in.
            </span>
          </span>
        </button>
        <button
          type="button"
          onClick={onSignOutEverywhere}
          className="flex w-full items-center gap-[15px] border-b border-border py-[15px] text-left"
        >
          <span className="grid h-[42px] w-[42px] shrink-0 place-items-center rounded-[11px] bg-[#f7e9eb] text-[#9d2235] dark:bg-[#2a171b] dark:text-[#c4707d]">
            <LogOut className="h-[22px] w-[22px]" />
          </span>
          <span className="min-w-0 flex-1">
            <span className="block text-[15.5px] font-extrabold text-destructive">Sign out everywhere</span>
            <span className="mt-px block text-[13px] font-semibold text-muted-foreground">
              This device and every other device. Use this on a shared or lost device.
            </span>
          </span>
        </button>
        <button
          type="button"
          onClick={() => setCredMode("password")}
          className="flex w-full items-center gap-[15px] border-b border-border py-[15px] text-left"
        >
          <span className="grid h-[42px] w-[42px] shrink-0 place-items-center rounded-[11px] bg-accent text-accent-foreground dark:bg-secondary dark:text-muted-foreground">
            <KeyRound className="h-[22px] w-[22px]" />
          </span>
          <span className="min-w-0 flex-1">
            <span className="block text-[15.5px] font-extrabold">Change password</span>
            <span className="mt-px block text-[13px] font-semibold text-muted-foreground">
              Requires your current password.
            </span>
          </span>
        </button>
        <button
          type="button"
          onClick={() => setCredMode("email")}
          className="flex w-full items-center gap-[15px] py-[15px] pb-0.5 text-left"
        >
          <span className="grid h-[42px] w-[42px] shrink-0 place-items-center rounded-[11px] bg-accent text-accent-foreground dark:bg-secondary dark:text-muted-foreground">
            <Mail className="h-[22px] w-[22px]" />
          </span>
          <span className="min-w-0 flex-1">
            <span className="block text-[15.5px] font-extrabold">Change email address</span>
            <span className="mt-px block text-[13px] font-semibold text-muted-foreground">
              Confirmation link goes to the new address.
            </span>
          </span>
        </button>
          </div>

          <div className="rounded-[14px] border border-[#e9ccd1] bg-card p-[22px_24px] shadow-sm dark:border-[#432027]">
            <h3 className="mb-1 text-[13px] font-extrabold uppercase tracking-[0.09em] text-destructive">
              Danger zone
            </h3>
            <div className="flex items-center gap-[15px] pt-2">
              <span className="grid h-[42px] w-[42px] shrink-0 place-items-center rounded-[11px] bg-[#f7e9eb] text-[#9d2235] dark:bg-[#2a171b] dark:text-[#b03044]">
                <Trash2 className="h-[22px] w-[22px]" />
              </span>
              <div className="min-w-0 flex-1">
                <p className="text-[15.5px] font-extrabold">Delete account</p>
                <p className="mt-px text-[13px] font-semibold text-muted-foreground">
                  Permanently deletes your account after email verification. This cannot be undone.
                </p>
              </div>
              <button
                type="button"
                onClick={() => setDeleteOpen(true)}
                className="shrink-0 rounded-[10px] bg-destructive px-[18px] py-[10px] text-sm font-bold text-destructive-foreground transition-colors hover:bg-[#7e1a2b] dark:hover:bg-[#93222f]"
              >
                Delete account
              </button>
            </div>
          </div>
        </div>
      </div>

      <DeleteAccountDialog
        open={deleteOpen}
        onOpenChange={setDeleteOpen}
        onDeleted={async () => {
          // The account is already deleted server-side — sign out is
          // best-effort (a failure leaves a session for a deleted
          // account, which is useless). Always navigate away.
          try {
            await signOut();
          } catch {
            // ignore — account is gone
          }
          navigate({ to: "/", replace: true });
        }}
      />
      {credMode && (
        <ChangeCredentialsDialog
          open
          onOpenChange={(o) => {
            if (!o) setCredMode(null);
          }}
          mode={credMode}
        />
      )}
    </div>
  );
}
