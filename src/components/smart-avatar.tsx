import { useServerFn } from "@tanstack/react-start";
import { useQuery } from "@tanstack/react-query";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { signAvatar } from "@/lib/chat.functions";
import { initialsOf } from "@/lib/initials";

/** Avatar that shows the user's uploaded picture when one exists, else initials. */
export function SmartAvatar({
  userId,
  name,
  className,
  fallbackClassName,
}: {
  userId: string;
  name: string;
  className?: string;
  fallbackClassName?: string;
}) {
  const sign = useServerFn(signAvatar);
  // Audit-3 A1-L29: a failed sign request must not retry (React Query
  // defaults) and must fall back to initials, never a broken image.
  const { data, isError } = useQuery({
    queryKey: ["avatar", userId],
    queryFn: () => sign({ data: { userId } }),
    // Audit-4 L46: cache 5 min, HALF the 10-min signed-URL TTL
    // (signAvatar) — a cached URL always has >= 5 min of validity
    // left at cache expiry, so it can never expire mid-cache.
    // ProfileDialog uses the same key + staleTime (same invariant).
    staleTime: 5 * 60 * 1000,
    retry: false,
    // Skip the server call for empty ids (orphaned DM rows pass "").
    enabled: userId.length > 0,
  });
  return (
    <Avatar className={className}>
      {!isError && data?.url && <AvatarImage src={data.url} alt={name} />}
      <AvatarFallback className={fallbackClassName}>{initialsOf(name)}</AvatarFallback>
    </Avatar>
  );
}
