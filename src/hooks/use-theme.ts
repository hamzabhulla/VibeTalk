import { useSyncExternalStore } from "react";

type Theme = "light" | "dark";

const STORAGE_KEY = "theme";

function readInitialTheme(): Theme {
  if (typeof window === "undefined") return "dark";
  const stored = window.localStorage.getItem(STORAGE_KEY);
  if (stored === "light" || stored === "dark") return stored;
  return window.matchMedia("(prefers-color-scheme: light)").matches ? "light" : "dark";
}

// Single module-level theme store (H21). Previously every useTheme()
// call owned its own useState("dark") — three live instances (AppShell,
// ProfilePage, MobileYou) drifted apart: toggling in Profile/You left
// AppShell's Sun/Moon icon stale until remount, and each instance's
// mount effect wrote its own (possibly stale) theme over localStorage
// (transient clobber: initial "dark" overwrote a stored "light" before
// the read effect ran). Now all instances share one value and
// re-render together, the initial theme is read synchronously from
// localStorage (no dark flash, no clobber), and the DOM + localStorage
// write happens in exactly one place.
let currentTheme: Theme = readInitialTheme();
const listeners = new Set<() => void>();

function applyTheme(theme: Theme) {
  currentTheme = theme;
  if (typeof document !== "undefined") {
    document.documentElement.classList.toggle("dark", theme === "dark");
    // Audit-3 A3-07: keep colorScheme in sync with the class (the boot
    // script sets it once; without this, scrollbars/form controls keep
    // the pre-toggle scheme until reload).
    document.documentElement.style.colorScheme = theme;
  }
  if (typeof window !== "undefined") {
    window.localStorage.setItem(STORAGE_KEY, theme);
  }
  for (const listener of listeners) listener();
}

// Apply the initial theme to the DOM at module load (before first paint).
if (typeof document !== "undefined") {
  document.documentElement.classList.toggle("dark", currentTheme === "dark");
  document.documentElement.style.colorScheme = currentTheme;
}

// Cross-tab sync: a theme change in another tab updates this tab too.
if (typeof window !== "undefined") {
  window.addEventListener("storage", (e) => {
    if (e.key === STORAGE_KEY && (e.newValue === "light" || e.newValue === "dark")) {
      if (e.newValue !== currentTheme) applyTheme(e.newValue);
    }
  });
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

function getSnapshot(): Theme {
  return currentTheme;
}

export function useTheme() {
  const theme = useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
  return {
    theme,
    // Same shape as the old useState setter (value or updater fn).
    setTheme: (next: Theme | ((t: Theme) => Theme)) => {
      const resolved =
        typeof next === "function" ? (next as (t: Theme) => Theme)(currentTheme) : next;
      if (resolved !== currentTheme) applyTheme(resolved);
    },
    toggle: () => applyTheme(currentTheme === "dark" ? "light" : "dark"),
  };
}
