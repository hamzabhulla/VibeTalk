import { useEffect, useRef } from "react";
import { Link, useNavigate, useRouterState } from "@tanstack/react-router";
import { toast } from "sonner";
import { useAuth } from "@/lib/auth-context";
import { useTheme } from "@/hooks/use-theme";
import { SmartAvatar } from "@/components/smart-avatar";
import { ProfileDialog } from "@/components/profile-dialog";
import {
  MessageCircle,
  Users,
  Phone,
  User,
  Sun,
  Moon,
  LogOut,
} from "lucide-react";
import type { ReactNode } from "react";

// No admin section: every user is a normal user.
const NAV_ITEMS = [
  { to: "/rooms", label: "Chats", icon: MessageCircle },
  { to: "/people", label: "People", icon: Users },
  { to: "/calls", label: "Calls", icon: Phone },
  { to: "/profile", label: "You", icon: User },
] as const;

export function AppShell({ children }: { children: ReactNode }) {
  const { user, signOut: authSignOut } = useAuth();
  const navigate = useNavigate();
  const pathname = useRouterState({ select: (s) => s.location.pathname });
  const { theme, toggle } = useTheme();

  const displayName = user?.user_metadata?.display_name ?? user?.email ?? "U";
  const items = NAV_ITEMS;
  // Audit-3 A6-N2: normalize trailing slashes once — "/people/" must
  // behave exactly like "/people" in isActive + hideMobileNav, or
  // AppShell renders its mobile-bottom-nav AND MobileShell renders its
  // own (double nav, ~110px, two "Main navigation" landmarks, and no
  // active item). Root "/" keeps its single slash.
  const clean = pathname.length > 1 ? pathname.replace(/\/+$/, "") : pathname;
  const isActive = (to: string) =>
    to === "/rooms" ? clean === "/rooms" || clean.startsWith("/rooms/") : clean === to;
  // Audit-3 A3-08: the AppShell mobile bottom nav was unreachable dead
  // code (MobileShell renders its own nav on every mobile route) —
  // deleted, along with the hideMobileNav gate that only served it.

  const signOut = async () => {
    // M47: only navigate on success — a failed sign-out must surface
    // an error, not leave the user on a "signed-out" UI with a live
    // session.
    try {
      await authSignOut();
      navigate({ to: "/", replace: true });
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Could not sign out — please try again.");
    }
  };

  // Audit-3 A3-10: route-change focus management — after client-side
  // navigation, move focus to the main landmark so keyboard/screen
  // -reader users land on the new page instead of a <body> fallback
  // when the focused element unmounted. Skipped on first mount.
  const mainRef = useRef<HTMLElement | null>(null);
  const firstRenderRef = useRef(true);
  useEffect(() => {
    if (firstRenderRef.current) {
      firstRenderRef.current = false;
      return;
    }
    mainRef.current?.focus({ preventScroll: true });
  }, [pathname]);

  return (
    <div className="vt-desktop flex h-dvh min-h-0 flex-col overflow-hidden bg-background md:flex-row">
      {/* Audit-3 A3-10: skip link — keyboard users jump straight to
          content instead of tabbing through the whole rail/nav. */}
      <a
        href="#main-content"
        className="sr-only focus:not-sr-only focus:absolute focus:z-50 focus:m-2 focus:rounded-lg focus:bg-primary focus:px-3 focus:py-2 focus:text-sm focus:font-semibold focus:text-primary-foreground"
      >
        Skip to content
      </a>
      {/* Desktop rail — mockup spec: 88px, logo tile 48px, labeled
          buttons 66px (icon 22px + 10.5px label), active = soft
          green wash + deep green text. */}
      <aside
        className="hidden w-[88px] shrink-0 flex-col items-center gap-1 border-r border-sidebar-border bg-sidebar pb-4 pt-[18px] md:flex"
        aria-label="Workspace navigation"
      >
        <Link
          to="/rooms"
          // Audit-7 D3: no `brand-mark` class here — the legacy
          // global rule (styles.css @layer utilities) sits after
          // the h-12/w-12 utilities in its layer and forced 40px +
          // shadow-md over the mockup's 48px flat mark. The utility
          // classes below already carry the full intended styling.
          className="mb-[18px] block h-12 w-12 overflow-hidden rounded-[13px]"
          aria-label="VibeTalk home"
        >
          <img src="/logo-mark.png" alt="" className="h-full w-full object-cover" />
        </Link>
        <nav className="flex flex-col gap-1" aria-label="Main navigation">
          {items.map((item) => (
            <Link
              key={item.to}
              to={item.to}
              aria-label={item.label}
              aria-current={isActive(item.to) ? "page" : undefined}
              className={`flex w-[66px] flex-col items-center gap-[3px] rounded-[12px] px-0 pb-[7px] pt-[9px] text-[10.5px] font-bold transition-colors ${
                isActive(item.to)
                  ? "bg-accent text-accent-foreground"
                  : "text-muted-foreground hover:bg-secondary hover:text-foreground"
              }`}
            >
              <item.icon className="h-[22px] w-[22px]" />
              <span>{item.label === "You" ? "Profile" : item.label}</span>
            </Link>
          ))}
        </nav>
        <div className="mt-auto flex flex-col items-center gap-1">
          <button
            type="button"
            onClick={toggle}
            aria-label="Toggle theme"
            aria-pressed={theme === "dark"}
            className="flex w-[66px] flex-col items-center gap-[3px] rounded-[12px] px-0 pb-[7px] pt-[9px] text-[10.5px] font-bold text-muted-foreground transition-colors hover:bg-secondary hover:text-foreground"
          >
            {theme === "dark" ? (
              <Sun className="h-[22px] w-[22px]" />
            ) : (
              <Moon className="h-[22px] w-[22px]" />
            )}
            <span>{theme === "dark" ? "Light" : "Dark"}</span>
          </button>
          <ProfileDialog>
            <button
              type="button"
              aria-label="Edit your profile"
              className="my-1.5 grid h-[46px] w-[46px] place-items-center overflow-hidden rounded-[12px] bg-accent transition-transform hover:scale-105"
            >
              {user?.id && (
                <SmartAvatar
                  userId={user.id}
                  name={displayName}
                  className="h-[46px] w-[46px] rounded-[12px]"
                  fallbackClassName="bg-accent text-sm text-accent-foreground"
                />
              )}
            </button>
          </ProfileDialog>
          <button
            type="button"
            onClick={signOut}
            aria-label="Sign out"
            className="flex w-[66px] flex-col items-center gap-[3px] rounded-[12px] px-0 pb-[7px] pt-[9px] text-[10.5px] font-bold text-muted-foreground transition-colors hover:bg-secondary hover:text-foreground"
          >
            <LogOut className="h-[22px] w-[22px]" />
            <span>Log out</span>
          </button>
        </div>
      </aside>

      <main
        id="main-content"
        ref={mainRef}
        tabIndex={-1}
        className="app-main min-h-0 min-w-0 flex-1 overflow-hidden focus:outline-none"
      >
        {children}
      </main>
    </div>
  );
}
