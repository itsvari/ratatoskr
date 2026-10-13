import { useCallback, useEffect, useState } from "react";

export const APPEARANCES = ["dark", "light", "system"] as const;

export type Appearance = (typeof APPEARANCES)[number];

type ColorScheme = Exclude<Appearance, "system">;

const DEFAULT_APPEARANCE: Appearance = "dark";
const STORAGE_KEY = "ratatoskr:appearance";
const LIGHT_SCHEME_QUERY = "(prefers-color-scheme: light)";
const THEME_COLORS: Readonly<Record<ColorScheme, string>> = {
  dark: "#000000",
  light: "#ffffff",
};

function isAppearance(value: unknown): value is Appearance {
  return typeof value === "string" && (APPEARANCES as readonly string[]).includes(value);
}

// storage can be missing or throw in private modes and locked-down browsers
function readStoredAppearance(): Appearance {
  try {
    const stored = window.localStorage.getItem(STORAGE_KEY);
    return isAppearance(stored) ? stored : DEFAULT_APPEARANCE;
  } catch {
    return DEFAULT_APPEARANCE;
  }
}

function storeAppearance(appearance: Appearance): void {
  try {
    window.localStorage.setItem(STORAGE_KEY, appearance);
  } catch {
    // the choice still applies for this page; it just will not survive a reload
  }
}

function lightSchemeQuery(): MediaQueryList | null {
  return typeof window.matchMedia === "function" ? window.matchMedia(LIGHT_SCHEME_QUERY) : null;
}

function resolveColorScheme(appearance: Appearance): ColorScheme {
  if (appearance !== "system") return appearance;
  return lightSchemeQuery()?.matches === true ? "light" : "dark";
}

function currentAppearance(): Appearance {
  const applied = document.documentElement.dataset.appearance;
  return isAppearance(applied) ? applied : DEFAULT_APPEARANCE;
}

function applyAppearance(appearance: Appearance): void {
  const colorScheme = resolveColorScheme(appearance);
  document.documentElement.dataset.appearance = appearance;
  // tailwind dark variants key off this class so system mode follows the resolved scheme
  document.documentElement.classList.toggle("dark", colorScheme === "dark");
  const themeColor = document.querySelector<HTMLMetaElement>('meta[name="theme-color"]');
  if (themeColor !== null) themeColor.content = THEME_COLORS[colorScheme];
}

export function applyStoredAppearance(): void {
  applyAppearance(readStoredAppearance());
}

export function useAppearance(): readonly [Appearance, (appearance: Appearance) => void] {
  const [appearance, setAppearanceState] = useState<Appearance>(currentAppearance);

  const setAppearance = useCallback((next: Appearance) => {
    applyAppearance(next);
    storeAppearance(next);
    setAppearanceState(next);
  }, []);

  useEffect(() => {
    const onStorage = (event: StorageEvent): void => {
      if (event.key !== STORAGE_KEY) return;
      const next = isAppearance(event.newValue) ? event.newValue : DEFAULT_APPEARANCE;
      applyAppearance(next);
      setAppearanceState(next);
    };
    window.addEventListener("storage", onStorage);
    return () => window.removeEventListener("storage", onStorage);
  }, []);

  useEffect(() => {
    if (appearance !== "system") return;
    const query = lightSchemeQuery();
    if (query === null) return;
    const onChange = (): void => applyAppearance("system");
    query.addEventListener("change", onChange);
    return () => query.removeEventListener("change", onChange);
  }, [appearance]);

  return [appearance, setAppearance];
}
