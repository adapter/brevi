import { useEffect, useState } from "react";

export type ThemePref = "light" | "dark" | "system";

const STORAGE_KEY = "brevi.theme";

function readPref(): ThemePref {
  const saved = localStorage.getItem(STORAGE_KEY);
  return saved === "light" || saved === "dark" ? saved : "system";
}

function apply(pref: ThemePref) {
  const dark =
    pref === "dark" ||
    (pref === "system" && window.matchMedia("(prefers-color-scheme: dark)").matches);
  const root = document.documentElement;
  root.classList.toggle("dark", dark);
  root.classList.toggle("light", !dark);
}

/**
 * The operator's theme preference. "system" follows the OS and tracks live
 * changes; an explicit choice sticks in localStorage. index.html applies the
 * same resolution inline before first paint.
 */
export function useTheme(): [ThemePref, (pref: ThemePref) => void] {
  const [pref, setPref] = useState<ThemePref>(readPref);

  useEffect(() => {
    apply(pref);
    if (pref !== "system") return;
    const media = window.matchMedia("(prefers-color-scheme: dark)");
    const onChange = () => apply("system");
    media.addEventListener("change", onChange);
    return () => media.removeEventListener("change", onChange);
  }, [pref]);

  const set = (next: ThemePref) => {
    setPref(next);
    if (next === "system") localStorage.removeItem(STORAGE_KEY);
    else localStorage.setItem(STORAGE_KEY, next);
  };

  return [pref, set];
}
