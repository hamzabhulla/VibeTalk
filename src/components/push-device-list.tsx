import { useState } from "react";
import { useServerFn } from "@tanstack/react-start";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { MonitorSmartphone } from "lucide-react";

import { listPushSubscriptions, removePushSubscriptionById } from "@/lib/push.functions";
import { currentPushEndpoint } from "@/lib/push-client";

/**
 * Audit-4 L40: "Registered devices" — the per-device removal UI
 * the save-cap error points at. Lists the user's push
 * subscriptions (host + endpoint fingerprint, never the full
 * endpoint or keys) with a Remove button per row. The row for
 * THIS device is labelled and has no Remove button — toggling
 * notifications off removes it (the existing path); removing it
 * here would just confuse (the self-heal would re-save it).
 * Rendered by both Profile surfaces (mobile You + desktop
 * /profile) under the push diagnostics, gated by the parent on
 * `notifOn && pushStatus?.tableOk`. Returns null when the user
 * has no rows — nothing to remove, nothing to show.
 */
export function PushDeviceList({ variant }: { variant: "mobile" | "desktop" }) {
  const qc = useQueryClient();
  const listPush = useServerFn(listPushSubscriptions);
  const removePushById = useServerFn(removePushSubscriptionById);
  const [removingId, setRemovingId] = useState<string | null>(null);

  const { data, isLoading, isError } = useQuery({
    queryKey: ["my-push-subscriptions"],
    queryFn: async () => {
      const endpoint = await currentPushEndpoint().catch(() => null);
      return listPush({ data: { endpoint: endpoint ?? null } });
    },
  });

  const subs = data?.subscriptions ?? [];

  const removeOne = async (id: string, label: string) => {
    if (
      !window.confirm(
        `Remove this device's push subscription (${label})? You won't get background notifications on that device until you turn notifications on there again.`,
      )
    )
      return;
    setRemovingId(id);
    try {
      await removePushById({ data: { id } });
      toast.success("Device removed from push notifications.");
      await qc.invalidateQueries({ queryKey: ["my-push-subscriptions"] });
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Could not remove this device.");
    } finally {
      setRemovingId(null);
    }
  };

  if (isLoading) {
    return variant === "mobile" ? (
      <div style={{ padding: "8px 2px 10px", fontSize: 12, color: "#6B7280" }}>
        Loading registered devices…
      </div>
    ) : (
      <p className="rounded-[14px] border border-border bg-card p-[22px_24px] text-[13px] font-semibold text-muted-foreground shadow-sm">
        Loading registered devices…
      </p>
    );
  }
  if (isError) {
    return variant === "mobile" ? (
      <div style={{ padding: "8px 2px 10px", fontSize: 12, color: "#DC2626" }}>
        Couldn&apos;t load registered devices.
      </div>
    ) : (
      <p className="rounded-[14px] border border-border bg-card p-[22px_24px] text-[13px] font-semibold text-destructive shadow-sm">
        Couldn&apos;t load registered devices.
      </p>
    );
  }
  if (subs.length === 0) return null;

  // Desktop redesign (2026-10-20, approved mockup): the old desktop
  // rows printed the raw push host + fingerprint as one techy line
  // ("fcm.googleapis.com [4068af4a]") — Hamza called it old-type.
  // Desktop now renders a clean device card: friendly name (this
  // device from the real user agent; other devices from their push
  // service — no invented details), the host + fingerprint demoted
  // to a muted sub-line (still there to disambiguate two devices on
  // the same host), and a quiet Remove. Mobile keeps its existing
  // rendering untouched below. (The check reads a copy so TS does
  // not narrow `variant` itself.)
  const variantIsDesktop: boolean = variant === "desktop";
  if (variantIsDesktop) {
    const hostLabel = (host: string) =>
      host.includes("googleapis")
        ? "Chrome / Android device"
        : host.includes("apple")
          ? "Apple device"
          : host.includes("mozilla")
            ? "Firefox device"
            : host.includes("windows") || host.includes("notify")
              ? "Windows device"
              : "Push device";
    const thisDeviceLabel = () => {
      if (typeof navigator === "undefined") return "This device";
      const ua = navigator.userAgent;
      const browser = ua.includes("Edg/")
        ? "Edge"
        : ua.includes("OPR/") || ua.includes("Opera")
          ? "Opera"
          : ua.includes("Firefox/")
            ? "Firefox"
            : ua.includes("Brave") || (navigator as { brave?: unknown }).brave
              ? "Brave"
              : ua.includes("Chrome/")
                ? "Chrome"
                : ua.includes("Safari/")
                  ? "Safari"
                  : "Browser";
      const os = ua.includes("Android")
        ? "Android"
        : ua.includes("iPhone") || ua.includes("iPad")
          ? "iOS"
          : ua.includes("Windows")
            ? "Windows"
            : ua.includes("Mac OS")
              ? "macOS"
              : ua.includes("Linux")
                ? "Linux"
                : "";
      return os ? `${browser} on ${os}` : browser;
    };
    return (
      <div className="rounded-[14px] border border-border bg-card p-[22px_24px] shadow-sm">
        <h3 className="mb-1 text-[13px] font-extrabold uppercase tracking-[0.09em] text-[#93a498] dark:text-[#686f76]">
          Registered devices
        </h3>
        <p className="mb-1.5 mt-0.5 text-[13.5px] font-semibold text-muted-foreground">
          Each device you turned notifications on in. Remove a stale one to free a slot (max 20).
        </p>
        <div>
          {subs.map((s) => (
            <div
              key={s.id}
              className="flex items-center gap-[14px] border-b border-border py-[13px] first:pt-2 last:border-b-0 last:pb-1"
            >
              <span className="grid h-11 w-11 shrink-0 place-items-center rounded-[11px] border border-border bg-secondary text-muted-foreground">
                <MonitorSmartphone className="h-[22px] w-[22px]" />
              </span>
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center gap-[9px]">
                  <span className="truncate text-[14.5px] font-bold tracking-[-0.01em]">
                    {s.isThisDevice ? thisDeviceLabel() : hostLabel(s.endpointHost)}
                  </span>
                  {s.isThisDevice && (
                    <span className="shrink-0 rounded-md bg-accent px-2 py-[3px] text-[10px] font-extrabold uppercase leading-[1.5] tracking-[0.07em] text-accent-foreground">
                      This device
                    </span>
                  )}
                </div>
                <div className="mt-0.5 truncate text-[12.5px] font-semibold text-muted-foreground">
                  {s.endpointHost} · {s.endpointId}
                </div>
              </div>
              {!s.isThisDevice && (
                <button
                  type="button"
                  disabled={removingId === s.id}
                  onClick={() => void removeOne(s.id, `${s.endpointHost} [${s.endpointId}]`)}
                  className="ml-auto shrink-0 px-1 py-1.5 text-[13px] font-bold text-[#a83a49] underline-offset-[3px] hover:text-destructive hover:underline disabled:opacity-50 dark:text-[#c4707d]"
                >
                  {removingId === s.id ? "Removing…" : "Remove"}
                </button>
              )}
            </div>
          ))}
        </div>
      </div>
    );
  }

  // Audit-7 D-I6: this shared return is only ever reached with
  // variant === "mobile" (desktop returned early above), so the
  // desktop heading arm and every `variant === "desktop"` ternary
  // below were dead code — removed. The mobile rendering is
  // byte-identical to what those ternaries produced.
  const heading = (
    <>
      <div style={{ fontSize: 12, fontWeight: 700, color: "#374151" }}>Registered devices</div>
      <p style={{ margin: "2px 0 4px", fontSize: 12, color: "#6B7280" }}>
        Each device you turned notifications on in. Remove a stale one to free a slot (max 20).
      </p>
    </>
  );

  return (
    <div style={{ padding: "8px 2px 10px" }}>
      {heading}
      {subs.map((s) => (
        <div
          key={s.id}
          style={{ display: "flex", alignItems: "center", gap: 8, padding: "6px 0", fontSize: 12 }}
        >
          <span
            style={{
              flex: 1,
              minWidth: 0,
              overflow: "hidden",
              textOverflow: "ellipsis",
              whiteSpace: "nowrap",
            }}
          >
            {s.endpointHost} [{s.endpointId}]{s.isThisDevice ? " · This device" : ""}
          </span>
          {!s.isThisDevice && (
            <button
              type="button"
              disabled={removingId === s.id}
              onClick={() => void removeOne(s.id, `${s.endpointHost} [${s.endpointId}]`)}
              style={{ color: "#DC2626", fontWeight: 700 }}
            >
              {removingId === s.id ? "Removing…" : "Remove"}
            </button>
          )}
        </div>
      ))}
    </div>
  );
}
