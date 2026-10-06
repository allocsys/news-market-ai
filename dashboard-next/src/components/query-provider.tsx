"use client";

import { useState, useMemo } from "react";
import {
  QueryClient,
  QueryClientProvider,
  QueryCache,
  MutationCache,
} from "@tanstack/react-query";
import { toast } from "sonner";

export function QueryProvider({ children }: { children: React.ReactNode }) {
  // One toast per error key (per path) so a flaky endpoint doesn't spam.
  const [toastKeys] = useState<Set<string>>(new Set());

  const [client] = useState(
    () =>
      new QueryClient({
        queryCache: new QueryCache({
          onError: (err, query) => {
            // 401 → global auth provider will redirect. Skip toast.
            if ((err as Error & { status?: number }).status === 401) return;
            const key = JSON.stringify(query.queryKey);
            if (toastKeys.has(key)) return;
            toastKeys.add(key);
            toast.error(`Query failed: ${err.message}`);
            // auto-expire the dedupe key after 5s so retries can show again
            setTimeout(() => toastKeys.delete(key), 5_000);
          },
        }),
        mutationCache: new MutationCache({
          onError: (err, _vars, _ctx, mutation) => {
            if ((err as Error & { status?: number }).status === 401) return;
            toast.error(`${mutation.options.mutationKey?.[0] ?? "Action"} failed: ${err.message}`);
          },
        }),
        defaultOptions: {
          queries: {
            staleTime: 15_000,
            refetchOnWindowFocus: true,
            retry: 1,
          },
        },
      }),
  );

  // useMemo keeps the client stable across HMR
  const value = useMemo(() => client, [client]);

  return (
    <QueryClientProvider client={value}>{children}</QueryClientProvider>
  );
}
