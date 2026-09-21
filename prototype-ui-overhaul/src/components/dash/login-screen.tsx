"use client";

import { useState } from "react";
import { useDash } from "@/lib/dash/store";
import { USERS } from "@/lib/dash/mock-data";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { ShieldCheck, Lock, Sparkles, ChevronRight, ArrowLeft } from "lucide-react";
import { cn } from "@/lib/utils";
import { toast } from "sonner";

const HUES: Record<string, string> = {
  blue: "from-blue-500 to-blue-600",
  emerald: "from-emerald-500 to-emerald-600",
  amber: "from-amber-500 to-amber-600",
  purple: "from-purple-500 to-purple-600",
};

export function LoginScreen() {
  const login = useDash((s) => s.login);
  const appendAudit = useDash((s) => s.appendAudit);
  const [step, setStep] = useState<"select" | "password">("select");
  const [selected, setSelected] = useState<typeof USERS[number] | null>(null);
  const [password, setPassword] = useState("");
  const [submitting, setSubmitting] = useState(false);

  function handleSelect(u: typeof USERS[number]) {
    setSelected(u);
    setStep("password");
    setPassword("");
  }

  function handleLogin(e?: React.FormEvent) {
    e?.preventDefault();
    if (!selected) return;
    setSubmitting(true);
    setTimeout(() => {
      // Prototype: accept any non-empty password
      if (password.trim().length === 0) {
        toast.error("Password required", { description: `Enter the shared ops passphrase to continue as ${selected.displayName}.` });
        setSubmitting(false);
        return;
      }
      login(selected);
      appendAudit({
        action: "Login",
        target: `session created for ${selected.username} (${selected.role})`,
        ip: "10.0.4.22",
      });
      toast.success(`Signed in as ${selected.displayName}`, {
        description: selected.role === "admin" ? "Admin access — full trigger + user-management rights." : selected.role === "operator" ? "Operator access — trigger backfill & backtest." : "Viewer access — read-only.",
      });
      setSubmitting(false);
    }, 500);
  }

  return (
    <div className="min-h-screen flex flex-col lg:flex-row">
      {/* Left brand panel */}
      <div className="relative lg:w-[44%] lg:min-h-screen overflow-hidden bg-gradient-to-br from-[#0a1226] via-[#0d1320] to-[#131b2e] flex flex-col justify-between p-8 lg:p-12">
        <div className="absolute inset-0 pointer-events-none" aria-hidden>
          <div className="absolute -top-32 -left-32 size-96 rounded-full bg-blue-500/10 blur-3xl" />
          <div className="absolute -bottom-32 -right-32 size-96 rounded-full bg-purple-500/10 blur-3xl" />
        </div>

        <div className="relative flex items-center gap-3 text-foreground">
          <div className="size-10 rounded-xl bg-gradient-to-br from-blue-500 to-blue-700 grid place-items-center shadow-lg shadow-blue-500/30">
            <span className="font-bold text-lg tracking-tight text-white">N</span>
          </div>
          <div>
            <div className="font-semibold tracking-tight">news-market-ai</div>
            <div className="text-xs text-blue-300/80 tracking-wide uppercase">operations dashboard</div>
          </div>
        </div>

        <div className="relative max-w-md space-y-6 text-foreground">
          <div className="inline-flex items-center gap-2 text-xs px-3 py-1 rounded-full border border-blue-500/30 bg-blue-500/10 text-blue-300">
            <Sparkles className="size-3" />
            v2 redesign · multi-user · auto-refresh
          </div>
          <h2 className="text-2xl lg:text-3xl font-semibold tracking-tight leading-tight">
            One pane of glass for the entire pipeline.
          </h2>
          <p className="text-sm text-blue-200/80 leading-relaxed">
            Live trading decisions, ingestion health, backtest equity curves, and the
            full LLM audit trail — all in one keyboard-navigable dashboard that respects
            your night-trading dark theme and your presentation-screen light theme.
          </p>
          <ul className="space-y-2 text-sm text-blue-200/90">
            {[
              "Command-center overview fuses 4 data streams into one screen",
              "Global ticker search scopes every page to one symbol",
              "Visibility-API-aware auto-refresh (no battery drain in background)",
              "Per-user audit log for every trigger that spends API quota",
            ].map((line) => (
              <li key={line} className="flex items-start gap-2.5">
                <ShieldCheck className="size-4 mt-0.5 text-blue-400 shrink-0" />
                <span>{line}</span>
              </li>
            ))}
          </ul>
        </div>

        <div className="relative text-xs text-blue-300/60">
          allocsys · 2026 · <a className="underline hover:text-blue-200" href="https://github.com/allocsys/news-market-ai" target="_blank" rel="noreferrer">github.com/allocsys/news-market-ai</a>
        </div>
      </div>

      {/* Right login panel */}
      <div className="flex-1 flex items-center justify-center p-6 lg:p-12 bg-background">
        <div className="w-full max-w-md">
          {step === "select" && (
            <div className="space-y-5 animate-fade-in">
              <div>
                <h1 className="text-2xl font-semibold tracking-tight">Sign in</h1>
                <p className="text-sm text-muted-foreground mt-1.5">
                  Choose your operator profile. Each user has its own audit trail and trigger permissions.
                </p>
              </div>

              <div className="space-y-2">
                {USERS.map((u) => (
                  <button
                    key={u.id}
                    onClick={() => handleSelect(u)}
                    className={cn(
                      "group w-full flex items-center gap-3 p-3 rounded-xl border border-border bg-card",
                      "hover:border-foreground/30 hover:bg-muted/40 transition-colors text-left"
                    )}
                  >
                    <div
                      className={cn(
                        "size-10 rounded-full grid place-items-center text-white font-semibold text-sm shadow-md",
                        "bg-gradient-to-br",
                        HUES[u.hue]
                      )}
                    >
                      {u.initials}
                    </div>
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2 flex-wrap">
                        <span className="font-medium truncate">{u.displayName}</span>
                        <span className="text-[10px] uppercase tracking-wider px-1.5 py-0.5 rounded bg-muted text-muted-foreground">
                          {u.role}
                        </span>
                        {u.twoFactor && (
                          <span className="text-[10px] flex items-center gap-1 text-emerald-500">
                            <ShieldCheck className="size-3" /> 2FA
                          </span>
                        )}
                      </div>
                      <div className="text-xs text-muted-foreground mt-0.5 truncate">
                        @{u.username} · last active {u.lastActive}
                      </div>
                    </div>
                    <ChevronRight className="size-4 text-muted-foreground group-hover:translate-x-0.5 transition-transform shrink-0" />
                  </button>
                ))}
              </div>

              <p className="text-xs text-muted-foreground text-center pt-2">
                Demo prototype — pick any user. Password is any non-empty value.
              </p>
            </div>
          )}

          {step === "password" && selected && (
            <form onSubmit={handleLogin} className="space-y-5 animate-fade-in">
              <button
                type="button"
                onClick={() => setStep("select")}
                className="text-xs text-muted-foreground hover:text-foreground flex items-center gap-1.5"
              >
                <ArrowLeft className="size-3.5" /> Back to user list
              </button>

              <div className="flex items-center gap-3">
                <div className={cn("size-12 rounded-full grid place-items-center text-white font-semibold shadow-md bg-gradient-to-br", HUES[selected.hue])}>
                  {selected.initials}
                </div>
                <div className="min-w-0">
                  <div className="font-medium">{selected.displayName}</div>
                  <div className="text-xs text-muted-foreground">@{selected.username} · {selected.role}</div>
                </div>
              </div>

              <div className="space-y-2">
                <Label htmlFor="pw" className="flex items-center gap-2">
                  <Lock className="size-3.5" /> Password
                </Label>
                <Input
                  id="pw"
                  type="password"
                  autoFocus
                  autoComplete="current-password"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  placeholder="Enter shared ops passphrase"
                  className="h-11"
                />
              </div>

              {selected.twoFactor && (
                <div className="rounded-lg border border-emerald-500/30 bg-emerald-500/10 px-3 py-2.5 text-xs text-emerald-600 dark:text-emerald-400 flex items-start gap-2">
                  <ShieldCheck className="size-4 mt-0.5 shrink-0" />
                  <span>
                    2FA enabled — a 6-digit code from your authenticator will be required on next prompt.
                    <span className="text-emerald-500/70"> (skipped in this demo)</span>
                  </span>
                </div>
              )}

              <Button
                type="submit"
                disabled={submitting}
                className="w-full h-11"
                size="lg"
              >
                {submitting ? "Signing in…" : `Sign in as ${selected.displayName}`}
              </Button>
            </form>
          )}
        </div>
      </div>
    </div>
  );
}
