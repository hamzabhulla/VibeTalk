import { useEffect, useRef, useState, type ReactNode } from "react";
import { useServerFn } from "@tanstack/react-start";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { getMe, updateProfile } from "@/lib/auth.functions";
import { signAvatar, deleteOwnAttachmentFile } from "@/lib/chat.functions";
import { uploadAvatar } from "@/lib/upload";
import { initialsOf } from "@/lib/initials";
import { useObjectUrl } from "@/lib/use-object-url";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Switch } from "@/components/ui/switch";
import { Camera, Bell, Eye } from "lucide-react";
import { toast } from "sonner";
import {
  getNotificationPermission,
  isNotificationSupported,
  isNotificationsEnabled,
  requestNotificationPermission,
  setNotificationsEnabled,
  type NotifPermission,
} from "@/lib/notifications";
import {
  pushSupported,
  subscribeToPush,
  unsubscribeFromPush,
  type PushKeys,
} from "@/lib/push-client";
import {
  savePushSubscription,
  getVapidPublicKey,
  removePushSubscription,
  checkPushEndpoint,
} from "@/lib/push.functions";

// Audit-4 M23: the last-synced server values, for the dirty-check
// and the save diff. Bio/status are stored raw (the server trims
// on save, so the stored values are already trimmed).
type ProfileSnapshot = {
  displayName: string;
  bio: string;
  customStatus: string;
  isPublic: boolean;
  privacy: {
    isAvatarPublic: boolean;
    isNamePublic: boolean;
    isBioPublic: boolean;
    isStatusPublic: boolean;
  };
};
type ProfileRow = {
  display_name?: string | null;
  bio?: string | null;
  custom_status?: string | null;
  is_public?: boolean;
  is_avatar_public?: boolean;
  is_name_public?: boolean;
  is_bio_public?: boolean;
  is_status_public?: boolean;
};
function snapshotOf(p: ProfileRow): ProfileSnapshot {
  return {
    displayName: p.display_name ?? "",
    bio: p.bio ?? "",
    customStatus: p.custom_status ?? "",
    isPublic: p.is_public ?? true,
    privacy: {
      isAvatarPublic: p.is_avatar_public ?? true,
      isNamePublic: p.is_name_public ?? true,
      isBioPublic: p.is_bio_public ?? true,
      isStatusPublic: p.is_status_public ?? true,
    },
  };
}
function hydrateState(snap: ProfileSnapshot) {
  return {
    displayName: snap.displayName,
    bio: snap.bio,
    customStatus: snap.customStatus,
    isPublic: snap.isPublic,
    privacy: { ...snap.privacy },
  };
}

export function ProfileDialog({ children }: { children: ReactNode }) {
  const [open, setOpen] = useState(false);
  const me = useServerFn(getMe);
  const update = useServerFn(updateProfile);
  const sign = useServerFn(signAvatar);
  const deleteOwnFile = useServerFn(deleteOwnAttachmentFile);
  const qc = useQueryClient();

  const { data } = useQuery({ queryKey: ["me"], queryFn: () => me(), enabled: open });

  const [displayName, setDisplayName] = useState("");
  const [bio, setBio] = useState("");
  const [customStatus, setCustomStatus] = useState("");
  const [isPublic, setIsPublic] = useState(true);
  const [privacy, setPrivacy] = useState({
    isAvatarPublic: true,
    isNamePublic: true,
    isBioPublic: true,
    isStatusPublic: true,
  });
  const [avatarFile, setAvatarFile] = useState<File | null>(null);
  const [avatarPreview, setAvatarPreview] = useState<string | null>(null);
  // M80: object-URL lifecycle (revoke on replace + close + unmount).
  const avatarPreviewUrl = useObjectUrl();
  const [saving, setSaving] = useState(false);
  // Audit-3 A4-N15: double-submit ref guard for onSave.
  const savingRef = useRef(false);
  // Audit-4 M23: dirty flag + last-synced server snapshot. The
  // [data] sync used to overwrite in-progress edits on every
  // refetch (window-focus refetch has no staleTime), and save sent
  // the FULL object — a stale-cache save reverted a privacy change
  // made in another tab. Now: sync only while clean, and save
  // sends only fields that differ from the snapshot (undefined =
  // untouched, per updateProfile's partial semantics).
  const dirtyRef = useRef(false);
  const snapshotRef = useRef<ProfileSnapshot | null>(null);
  const markDirty = () => {
    dirtyRef.current = true;
  };
  const [notifPermission, setNotifPermission] = useState<NotifPermission>(() =>
    getNotificationPermission(),
  );
  const [notifOn, setNotifOn] = useState(() => isNotificationsEnabled());
  const fileRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    // Audit-4 M23: dirty-check — skip the sync while the user has
    // unsaved edits. A window-focus refetch used to overwrite
    // in-progress edits unconditionally.
    if (data?.profile && !dirtyRef.current) {
      const snap = snapshotOf(data.profile as ProfileRow);
      const h = hydrateState(snap);
      setDisplayName(h.displayName);
      setBio(h.bio);
      setCustomStatus(h.customStatus);
      setIsPublic(h.isPublic);
      setPrivacy(h.privacy);
      snapshotRef.current = snap;
    }
  }, [data]);

  useEffect(() => {
    if (!open) {
      setAvatarFile(null);
      avatarPreviewUrl.clear();
      setAvatarPreview(null);
      // M80: discard unsaved edits on close — reopening used to show
      // the stale edited values (the [data] sync only fires when
      // data changes, not on reopen).
      if (data?.profile) {
        const snap = snapshotOf(data.profile as ProfileRow);
        const h = hydrateState(snap);
        setDisplayName(h.displayName);
        setBio(h.bio);
        setCustomStatus(h.customStatus);
        setIsPublic(h.isPublic);
        setPrivacy(h.privacy);
        snapshotRef.current = snap;
      }
      // Audit-4 M23: edits are discarded, so the form is clean again.
      dirtyRef.current = false;
    }
  }, [open, data]);

  const userId = data?.userId;
  const { data: avatarSigned } = useQuery({
    queryKey: ["avatar", userId],
    queryFn: () => sign({ data: { userId: userId! } }),
    enabled: open && !!userId && !avatarFile,
    // Audit-4 L46: same 5-min staleTime as SmartAvatar (same
    // cache entry) — half the 10-min signed-URL TTL, so a cached
    // URL always has >= 5 min of validity left at cache expiry.
    staleTime: 5 * 60 * 1000,
  });

  const onPick = (e: React.ChangeEvent<HTMLInputElement>) => {
    const f = e.target.files?.[0];
    if (e.target) e.target.value = "";
    if (!f) return;
    if (!f.type.startsWith("image/")) {
      toast.error("Please choose an image file.");
      return;
    }
    // Audit-3 A4-N16: reject oversized picks at pick time (same 5 MB
    // the server enforces at Save) instead of failing after preview.
    if (f.size > 5 * 1024 * 1024) {
      toast.error("Avatar must be under 5 MB.");
      return;
    }
    setAvatarFile(f);
    setAvatarPreview(avatarPreviewUrl.set(URL.createObjectURL(f)));
    markDirty();
  };

  const onSave = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!userId) return;
    if (!displayName.trim()) {
      toast.error("Display name is required.");
      return;
    }
    // Audit-3 A4-N15: ref guard (same pattern as onSend/onFiles) — a
    // rapid double-Save used to upload two avatars, orphaning the first.
    if (savingRef.current) return;
    // Audit-4 M23: send ONLY changed fields. The old code sent the
    // full object from possibly-stale cache — a save here reverted
    // a privacy change made in another tab. Untouched fields stay
    // undefined (updateProfile leaves them alone). Nothing changed
    // and no new avatar → close without a server call.
    const snap = snapshotRef.current;
    const nextBio = bio.trim() || null;
    const nextStatus = customStatus.trim() || null;
    const diff: {
      displayName?: string;
      bio?: string | null;
      customStatus?: string | null;
      isPublic?: boolean;
      isAvatarPublic?: boolean;
      isNamePublic?: boolean;
      isBioPublic?: boolean;
      isStatusPublic?: boolean;
    } = {};
    if (!snap || displayName.trim() !== snap.displayName) diff.displayName = displayName.trim();
    if (!snap || nextBio !== (snap.bio.trim() || null)) diff.bio = nextBio;
    if (!snap || nextStatus !== (snap.customStatus.trim() || null)) diff.customStatus = nextStatus;
    if (!snap || isPublic !== snap.isPublic) diff.isPublic = isPublic;
    if (!snap || privacy.isAvatarPublic !== snap.privacy.isAvatarPublic)
      diff.isAvatarPublic = privacy.isAvatarPublic;
    if (!snap || privacy.isNamePublic !== snap.privacy.isNamePublic)
      diff.isNamePublic = privacy.isNamePublic;
    if (!snap || privacy.isBioPublic !== snap.privacy.isBioPublic) diff.isBioPublic = privacy.isBioPublic;
    if (!snap || privacy.isStatusPublic !== snap.privacy.isStatusPublic)
      diff.isStatusPublic = privacy.isStatusPublic;
    if (Object.keys(diff).length === 0 && !avatarFile) {
      setOpen(false);
      return;
    }
    savingRef.current = true;
    setSaving(true);
    // M80: hoisted so the catch can clean up the uploaded avatar.
    let avatarPath: string | undefined;
    try {
      if (avatarFile) {
        avatarPath = await uploadAvatar(avatarFile, userId);
      }
      const res = await update({
        data: {
          ...diff,
          // H41: null = clear the field (partial semantics: undefined
          // would leave the old value in place, so a cleared bio/status
          // must be sent as null, not undefined).
          ...(avatarPath ? { avatarPath } : {}),
        },
      });
      toast.success("Profile updated");
      if (res.warning) toast.warning(res.warning);
      qc.invalidateQueries({ queryKey: ["me"] });
      qc.invalidateQueries({ queryKey: ["avatar", userId] });
      qc.invalidateQueries({ queryKey: ["users"] });
      setOpen(false);
    } catch (err) {
      // M80: the avatar upload already landed — delete the orphan so
      // a failed save doesn't leave a stray file in storage.
      if (avatarPath) {
        try {
          // Audit-3 A8-N17: storage deletes go through the server
          // fn (client DELETE policy dropped).
          await deleteOwnFile({ data: { path: avatarPath } });
        } catch {
          console.warn("[profile] orphan avatar cleanup failed:", avatarPath);
        }
      }
      toast.error(err instanceof Error ? err.message : "Could not save profile");
    } finally {
      savingRef.current = false;
      setSaving(false);
    }
  };

  const previewSrc = avatarPreview ?? avatarSigned?.url ?? null;
  // Audit-7 D2: the shared letters-only initialsOf — this inline
  // copy took every word's first CHARACTER, so "HAMZA (Admin)"
  // rendered as "H(".
  const initials = initialsOf(displayName || data?.profile?.display_name || "U");

  const savePush = useServerFn(savePushSubscription);
  const getVapidKey = useServerFn(getVapidPublicKey);
  const removePush = useServerFn(removePushSubscription);
  const checkEndpoint = useServerFn(checkPushEndpoint);

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
    // Register Web Push so notifications arrive even when the browser is
    // backgrounded or closed. Falls back to in-tab notifications otherwise.
    if (pushSupported()) {
      try {
        const keys = await subscribeToPush((sub: PushKeys) => savePush({ data: sub }), () => getVapidKey());
        if (keys) {
          toast.success("Notifications enabled — you'll be pinged even with the app closed.");
        } else {
          // M30: mirror the desktop profile toggle — a falsy keys
          // result means push was NOT set up, so don't claim success.
          toast.warning(
            "Notifications on, but background push could not be set up on this device.",
          );
        }
      } catch (err) {
        // M30: mirror the desktop profile toggle — the old catch
        // showed the SAME success toast as the happy path, swallowing
        // the failure. Surface the real reason instead.
        toast.error(
          `Notifications on, but push setup failed: ${err instanceof Error ? err.message : "unknown error"}`,
          { duration: 8000 },
        );
      }
    } else {
      toast.success("Notifications enabled. You'll be pinged for new messages.");
    }
  };

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>{children}</DialogTrigger>
      {/* Mockup dialog spec (2026-10-20): 584px wide, radius 16,
          fixed header + scrolling body + fixed footer. The shared
          DialogContent base has no height bound, so this tall form
          overflowed the viewport and its header was clipped
          off-screen on desktop (Hamza's screenshot) — the form body
          now scrolls internally, header always reachable. */}
      <DialogContent className="vt-desktop vt-edit-dialog flex max-h-[calc(100dvh-2rem)] w-full max-w-[584px] flex-col gap-0 overflow-hidden rounded-[16px] p-0 [&>button]:rounded-[11px] [&>button]:bg-secondary [&>button]:p-2 [&>button]:opacity-100">
        <DialogHeader className="flex-none space-y-0 border-b border-border px-6 py-[19px] text-left">
          <DialogTitle className="text-[19px] font-extrabold">Edit profile</DialogTitle>
          <DialogDescription className="mt-0.5 text-[13px] font-semibold">
            How you appear to other people on VibeTalk.
          </DialogDescription>
        </DialogHeader>
        <form onSubmit={onSave} className="flex min-h-0 flex-1 flex-col">
          <div className="space-y-4 overflow-y-auto px-6 pb-2 pt-5">
          <div className="flex items-center gap-4">
            <div className="relative shrink-0">
              <Avatar className="h-[66px] w-[66px] rounded-2xl">
                {previewSrc && <AvatarImage src={previewSrc} alt={displayName} />}
                <AvatarFallback className="rounded-2xl bg-accent text-base text-accent-foreground">
                  {initials}
                </AvatarFallback>
              </Avatar>
              <input
                ref={fileRef}
                type="file"
                accept="image/*"
                onChange={onPick}
                className="hidden"
              />
            </div>
            <div>
              <p className="text-[15px] font-extrabold">Profile photo</p>
              <p className="text-[13px] font-semibold text-muted-foreground">
                Shown next to your name in chats and People.
              </p>
              <button
                type="button"
                onClick={() => fileRef.current?.click()}
                className="mt-[9px] inline-flex items-center gap-1.5 rounded-[10px] border border-border bg-secondary px-[15px] py-2 text-[13px] font-bold transition-colors hover:bg-accent"
              >
                <Camera className="h-[15px] w-[15px]" />
                Change photo
              </button>
            </div>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="profile-name" className="text-[13px] font-extrabold">
              Display name
            </Label>
            <Input
              id="profile-name"
              className="h-auto rounded-[10px] px-[13px] py-[11px] text-[14.5px] font-semibold"
              value={displayName}
              onChange={(e) => {
                markDirty();
                setDisplayName(e.target.value);
              }}
              required
              maxLength={40}
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="profile-status" className="text-[13px] font-extrabold">
              Status
            </Label>
            <Input
              id="profile-status"
              className="h-auto rounded-[10px] px-[13px] py-[11px] text-[14.5px] font-semibold"
              value={customStatus}
              onChange={(e) => {
                markDirty();
                setCustomStatus(e.target.value);
              }}
              maxLength={60}
              placeholder="e.g. Heads down until 5pm"
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="profile-bio" className="text-[13px] font-extrabold">
              Bio
            </Label>
            <Textarea
              id="profile-bio"
              className="rounded-[10px] px-[13px] py-[11px] text-[14.5px] font-semibold"
              value={bio}
              onChange={(e) => {
                markDirty();
                setBio(e.target.value);
              }}
              maxLength={160}
              rows={3}
              placeholder="A line or two about you"
            />
          </div>
          <div className="flex items-center gap-[13px] rounded-[12px] border border-border bg-secondary p-[14px_16px]">
            <span className="grid h-[38px] w-[38px] shrink-0 place-items-center rounded-[10px] bg-accent text-accent-foreground dark:bg-card dark:text-muted-foreground">
              <Eye className="h-5 w-5" />
            </span>
            <div className="min-w-0 flex-1">
              <p className="text-[15px] font-extrabold">Profile visibility</p>
              <p className="text-[13px] font-semibold text-muted-foreground">
                {isPublic
                  ? "Public — anyone can find you in People."
                  : "Private — hidden from People. Existing chats keep working."}
              </p>
            </div>
            <Switch
              checked={isPublic}
              onCheckedChange={(v) => {
                markDirty();
                setIsPublic(v);
              }}
              aria-label="Toggle profile visibility"
              className="vt-switch shrink-0"
            />
          </div>
          <div>
            <p className="mb-1 text-[12.5px] font-extrabold uppercase tracking-[0.09em] text-[#93a498] dark:text-[#686f76]">
              Who can see what
            </p>
            <p className="mb-2 text-[13.5px] font-semibold text-muted-foreground">
              Turn a section off to hide it when someone opens your profile.
            </p>
            <div className="space-y-[9px]">
              {(
                [
                  ["isAvatarPublic", "Profile photo", "Your picture"],
                  ["isNamePublic", "Name", "Your display name"],
                  ["isBioPublic", "Bio", "A line or two about you"],
                  ["isStatusPublic", "Status", "What you're up to"],
                ] as const
              ).map(([key, title, sub]) => (
                <div
                  key={key}
                  className="flex items-center justify-between gap-3 rounded-[12px] border border-border px-[15px] py-3"
                >
                  <div>
                    <p className="text-[14.5px] font-extrabold">{title}</p>
                    <p className="text-[12.5px] font-semibold text-muted-foreground">
                      {privacy[key] ? "Public" : "Private"} · {sub}
                    </p>
                  </div>
                  <Switch
                    checked={privacy[key]}
                    onCheckedChange={(v) => {
                      markDirty();
                      setPrivacy((p) => ({ ...p, [key]: v }));
                    }}
                    aria-label={`Toggle ${title} visibility`}
                    className="vt-switch shrink-0"
                  />
                </div>
              ))}
            </div>
          </div>
          <div className="flex items-center justify-between gap-3 rounded-[12px] border border-border px-[15px] py-3">
            <div className="flex items-center gap-2.5">
              <Bell className="h-4 w-4 text-muted-foreground" />
              <div>
                <p className="text-[14.5px] font-extrabold">Message notifications</p>
                <p className="text-[12.5px] font-semibold text-muted-foreground">
                  {notifPermission === "unsupported"
                    ? "Not supported in this browser."
                    : notifPermission === "denied"
                      ? "Blocked — allow them in your browser settings."
                      : notifOn
                        ? "On — you'll be pinged for new messages."
                        : "Off — turn on to get pinged for new messages."}
                </p>
              </div>
            </div>
            <Button
              type="button"
              variant={notifOn ? "secondary" : "default"}
              size="sm"
              onClick={toggleNotifications}
              disabled={notifPermission === "unsupported"}
            >
              {notifOn ? "Turn off" : "Turn on"}
            </Button>
          </div>
          </div>
          <DialogFooter className="flex-none flex-row items-center justify-end gap-2.5 border-t border-border px-6 py-[15px] sm:justify-end">
            <Button
              type="button"
              variant="ghost"
              onClick={() => setOpen(false)}
              className="h-auto rounded-[10px] border border-border bg-secondary px-[18px] py-[10px] text-sm font-bold hover:bg-accent"
            >
              Cancel
            </Button>
            <Button
              type="submit"
              disabled={saving}
              className="h-auto rounded-[10px] bg-primary px-[18px] py-[10px] text-sm font-bold text-primary-foreground hover:bg-[#16a34a]"
            >
              {saving ? "Saving…" : "Save changes"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
