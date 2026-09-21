"use client";

import { useState } from "react";
import { useDash } from "@/lib/dash/store";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Lock, User as UserIcon } from "lucide-react";
import { toast } from "sonner";

export function LoginScreen() {
  const login = useDash((s) => s.login);
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [submitting, setSubmitting] = useState(false);

  function handleLogin(e?: React.FormEvent) {
    e?.preventDefault();
    if (username.trim().length === 0 || password.trim().length === 0) {
      toast.error("Username and password required");
      return;
    }
    setSubmitting(true);
    setTimeout(() => {
      // Prototype: accept any non-empty credential pair
      login(username.trim());
      setSubmitting(false);
    }, 400);
  }

  return (
    <div className="min-h-screen flex items-center justify-center bg-background p-6">
      <form onSubmit={handleLogin} className="w-full max-w-sm space-y-6">
        <div className="flex flex-col items-center gap-3 text-center">
          <div className="size-12 rounded-xl bg-gradient-to-br from-blue-500 to-blue-700 grid place-items-center shadow-lg shadow-blue-500/30">
            <span className="font-bold text-xl tracking-tight text-white">N</span>
          </div>
          <div>
            <div className="font-semibold tracking-tight text-lg">news-market-ai</div>
            <div className="text-xs text-muted-foreground tracking-wide uppercase">operations ledger</div>
          </div>
        </div>

        <div className="space-y-4 rounded-xl border border-border bg-card p-6">
          <div className="space-y-2">
            <Label htmlFor="username" className="flex items-center gap-2">
              <UserIcon className="size-3.5" /> Username
            </Label>
            <Input
              id="username"
              type="text"
              autoFocus
              autoComplete="username"
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              placeholder="Username"
              className="h-11"
            />
          </div>

          <div className="space-y-2">
            <Label htmlFor="password" className="flex items-center gap-2">
              <Lock className="size-3.5" /> Password
            </Label>
            <Input
              id="password"
              type="password"
              autoComplete="current-password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder="Password"
              className="h-11"
            />
          </div>

          <Button type="submit" disabled={submitting} className="w-full h-11" size="lg">
            {submitting ? "Logging in…" : "Log in"}
          </Button>
        </div>
      </form>
    </div>
  );
}
