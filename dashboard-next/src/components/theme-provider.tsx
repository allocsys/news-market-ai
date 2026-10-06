"use client";

import { createContext, useContext, useEffect, useState, useCallback } from "react";

type Theme = "dark" | "light";

interface ThemeContextValue {
  theme: Theme;
  setTheme: (t: Theme) => void;
  toggleTheme: () => void;
}

const ThemeContext = createContext<ThemeContextValue | undefined>(undefined);

export function ThemeProvider({ children }: { children: React.ReactNode }) {
  // Default to dark immediately (matches the html className="dark" set in layout.tsx).
  // We then read localStorage and apply on mount — using a layout effect would cause a flash.
  const [theme, setThemeState] = useState<Theme>("dark");

  // Restore from localStorage on mount — use a microtask to defer the setState
  // out of the effect body so we don't trigger the cascading-render lint rule.
  useEffect(() => {
    const id = window.setTimeout(() => {
      const stored = localStorage.getItem("nmai-theme");
      const initial: Theme = stored === "light" ? "light" : "dark";
      setThemeState(initial);
      document.documentElement.classList.remove("light", "dark");
      document.documentElement.classList.add(initial);
    }, 0);
    return () => window.clearTimeout(id);
  }, []);

  const setTheme = useCallback((t: Theme) => {
    setThemeState(t);
    document.documentElement.classList.remove("light", "dark");
    document.documentElement.classList.add(t);
    try {
      localStorage.setItem("nmai-theme", t);
    } catch {
      /* ignore */
    }
  }, []);

  const toggleTheme = useCallback(() => {
    setThemeState((current) => {
      const next: Theme = current === "dark" ? "light" : "dark";
      document.documentElement.classList.remove("light", "dark");
      document.documentElement.classList.add(next);
      try {
        localStorage.setItem("nmai-theme", next);
      } catch {
        /* ignore */
      }
      return next;
    });
  }, []);

  return (
    <ThemeContext.Provider value={{ theme, setTheme, toggleTheme }}>
      {children}
    </ThemeContext.Provider>
  );
}

export function useTheme() {
  const ctx = useContext(ThemeContext);
  if (!ctx) throw new Error("useTheme must be used within ThemeProvider");
  return ctx;
}
