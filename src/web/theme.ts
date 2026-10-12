// Theme toggle: light, dark or system. The choice is a per-viewer convenience in localStorage (guarded).
export type Theme = "light" | "dark" | "system";

export function readTheme(): Theme {
  try {
    const t = window.localStorage.getItem("ss-theme");
    return t === "light" || t === "dark" ? t : "system";
  } catch {
    return "system";
  }
}

export function applyTheme(t: Theme): void {
  const root = document.documentElement;
  if (t === "system") delete root.dataset.theme;
  else root.dataset.theme = t;
  try {
    window.localStorage.setItem("ss-theme", t);
  } catch {
    // storage unavailable: the theme still applies for this page
  }
}

export function effectiveDark(t: Theme): boolean {
  return t === "dark" || (t === "system" && window.matchMedia("(prefers-color-scheme: dark)").matches);
}
