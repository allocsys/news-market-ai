"use client";

import { useState, useEffect, Suspense } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { Loader2, AlertTriangle, Lock } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Wordmark } from "@/components/dashboard/shell";
import { useAuth } from "@/components/auth-provider";
import { useLogin } from "@/lib/api";
import { useTheme } from "@/components/theme-provider";
import { Moon, Sun } from "lucide-react";

/** Only follow same-origin relative paths; anything else falls back to "/". */
function safeFrom(raw: string | null): string {
  if (raw && raw.startsWith("/") && !raw.startsWith("//") && !raw.startsWith("/\\")) {
    return raw;
  }
  return "/";
}

export default function LoginPage() {
  return (
    <Suspense fallback={null}>
      <LoginForm />
    </Suspense>
  );
}

function LoginForm() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const { user, loading } = useAuth();
  const { theme, toggleTheme } = useTheme();
  const login = useLogin();

  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);

  // If already logged in, jump to where we came from (or overview)
  useEffect(() => {
    if (!loading && user) {
      const from = safeFrom(searchParams.get("from"));
      router.replace(from);
    }
  }, [user, loading, router, searchParams]);

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    login.mutate(
      { username, password },
      {
        onSuccess: () => {
          const from = safeFrom(searchParams.get("from"));
          router.replace(from);
          // Hard reload to ensure the auth cookie is picked up by the next fetch
          setTimeout(() => window.location.reload(), 50);
        },
        onError: (err: Error) => {
          setError(err.message);
        },
      },
    );
  };

  return (
    <div className="flex min-h-screen flex-col items-center justify-center bg-background px-4 py-10">
      <div className="absolute right-4 top-4">
        <Button
          variant="ghost"
          size="icon"
          onClick={toggleTheme}
          className="h-9 w-9"
          aria-label={`Switch to ${theme === "dark" ? "light" : "dark"} theme`}
        >
          {theme === "dark" ? <Sun className="h-4 w-4" /> : <Moon className="h-4 w-4" />}
        </Button>
      </div>

      <div className="w-full max-w-sm">
        <div className="mb-8 flex flex-col items-center gap-3">
          <Wordmark />
          <p className="text-center text-sm text-muted-foreground">
            Sign in to the operations dashboard.
          </p>
        </div>

        <form
          onSubmit={handleSubmit}
          className="space-y-4 rounded-2xl border border-border bg-card p-6 card-hairline"
        >
          <div className="space-y-1.5">
            <Label htmlFor="username">Username</Label>
            <Input
              id="username"
              type="text"
              autoComplete="username"
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              required
              autoFocus
              className="font-mono"
              placeholder="operator"
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="password">Password</Label>
            <Input
              id="password"
              type="password"
              autoComplete="current-password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              required
              className="font-mono"
              placeholder="••••••••"
            />
          </div>

          {error && (
            <div
              role="alert"
              className="flex items-start gap-2 rounded-md border border-[color:var(--short)]/30 bg-[color:var(--short)]/8 px-3 py-2 text-sm"
            >
              <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0 text-[color:var(--short)]" aria-hidden />
              <p className="text-[color:var(--short)]">{error}</p>
            </div>
          )}

          <Button
            type="submit"
            className="w-full"
            disabled={login.isPending || !username || !password}
          >
            {login.isPending ? (
              <>
                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                Signing in…
              </>
            ) : (
              <>
                <Lock className="mr-2 h-4 w-4" />
                Sign in
              </>
            )}
          </Button>
        </form>

        <p className="mt-6 text-center text-[11px] text-muted-foreground">
          Session expires in 24 hours. Server-side proxy holds the cookie.
        </p>
      </div>
    </div>
  );
}
