"use client";

import { useDash } from "@/lib/dash/store";
import { LoginScreen } from "@/components/dash/login-screen";
import { DashboardShell } from "@/components/dash/dashboard-shell";

export default function Home() {
  const currentUser = useDash((s) => s.currentUser);

  if (!currentUser) {
    return <LoginScreen />;
  }
  return <DashboardShell />;
}
