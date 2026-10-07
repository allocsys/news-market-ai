"use client";

import { createContext, useContext, useEffect, useState, useCallback } from "react";
import { useRouter } from "next/navigation";

interface AuthUser {
  username: string;
}

interface AuthContextValue {
  user: AuthUser | null;
  loading: boolean;
  logout: () => Promise<void>;
  refresh: () => Promise<void>;
}

const AuthContext = createContext<AuthContextValue | undefined>(undefined);

async function fetchAuth(): Promise<AuthUser | null> {
  try {
    const res = await fetch("/api/auth", { credentials: "same-origin" });
    if (!res.ok) return null;
    const body = await res.json();
    if (body.authenticated) {
      return body.user ?? { username: "operator" };
    }
    return null;
  } catch {
    return null;
  }
}

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [user, setUser] = useState<AuthUser | null>(null);
  const [loading, setLoading] = useState(true);
  const router = useRouter();

  const apply = useCallback((u: AuthUser | null) => {
    setUser(u);
    setLoading(false);
  }, []);

  const refresh = useCallback(async () => {
    apply(await fetchAuth());
  }, [apply]);

  // Initial load: state is only set from the promise callback, never
  // synchronously inside the effect body.
  useEffect(() => {
    let active = true;
    fetchAuth().then((u) => {
      if (active) apply(u);
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
    <AuthContext.Provider value={{ user, loading, logout, refresh }}>
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth() {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error("useAuth must be used within AuthProvider");
  return ctx;
}
