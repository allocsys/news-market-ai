"use client";

import { createContext, useContext, useEffect, useState, useCallback } from "react";
import { useRouter } from "next/navigation";

interface AuthUser {
  username: string;
}

interface AuthContextValue {
  user: AuthUser | null;
  mock: boolean;
  loading: boolean;
  logout: () => Promise<void>;
  refresh: () => Promise<void>;
}

const AuthContext = createContext<AuthContextValue | undefined>(undefined);

interface AuthState {
  user: AuthUser | null;
  /** undefined = leave the current mock flag unchanged */
  mock?: boolean;
}

async function fetchAuth(): Promise<AuthState> {
  try {
    const res = await fetch("/api/auth", { credentials: "same-origin" });
    if (!res.ok) return { user: null };
    const body = await res.json();
    if (body.authenticated) {
      return { user: body.user ?? { username: "operator" }, mock: Boolean(body.mock) };
    }
    return { user: null, mock: Boolean(body.mock) };
  } catch {
    return { user: null };
  }
}

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [user, setUser] = useState<AuthUser | null>(null);
  const [mock, setMock] = useState(false);
  const [loading, setLoading] = useState(true);
  const router = useRouter();

  const apply = useCallback((s: AuthState) => {
    setUser(s.user);
    if (s.mock !== undefined) setMock(s.mock);
    setLoading(false);
  }, []);

  const refresh = useCallback(async () => {
    apply(await fetchAuth());
  }, [apply]);

  // Initial load: state is only set from the promise callback, never
  // synchronously inside the effect body.
  useEffect(() => {
    let active = true;
    fetchAuth().then((s) => {
      if (active) apply(s);
    });
    return () => {
      active = false;
    };
  }, [apply]);

  const logout = useCallback(async () => {
    await fetch("/api/logout", { method: "POST", credentials: "same-origin" });
    setUser(null);
    router.push("/login");
  }, [router]);

  return (
    <AuthContext.Provider value={{ user, mock, loading, logout, refresh }}>
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth() {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error("useAuth must be used within AuthProvider");
  return ctx;
}
