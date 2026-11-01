export type ThemeMode = "auto" | "light" | "dark";

const MODES: readonly ThemeMode[] = ["auto", "light", "dark"];
const listeners = new Set<() => void>();
const system = matchMedia("(prefers-color-scheme: dark)");

function stored(): ThemeMode {
  try {
    const saved = localStorage.getItem("theme");
    return MODES.includes(saved as ThemeMode) ? (saved as ThemeMode) : "auto";
  } catch {
    return "auto";
  }
}

let mode = stored();

export const themeMode = (): ThemeMode => mode;

/** What is shown now: the chosen theme, or the system's when the choice is "auto". */
export const isDark = (): boolean => (mode === "auto" ? system.matches : mode === "dark");

function apply(): void {
  if (mode === "auto") document.documentElement.removeAttribute("data-theme");
  else document.documentElement.dataset.theme = mode;
  listeners.forEach((fn) => fn());
}

export function setTheme(next: ThemeMode): void {
  mode = next;
  try {
    localStorage.setItem("theme", next);
  } catch {
    /* the choice just won't be remembered */
  }
  apply();
}

/** Readers that draw their own colors follow the theme through this; returns the way to stop. */
export function onTheme(fn: () => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

system.addEventListener("change", () => mode === "auto" && listeners.forEach((fn) => fn()));
apply();
