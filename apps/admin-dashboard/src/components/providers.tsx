"use client";

import { useState } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { ThemeProvider } from "next-themes";
import { Toaster } from "sonner";
import { CommandPalette } from "@/components/world-class/command-palette";

export function Providers({ children }: { children: React.ReactNode }) {
  const [qc] = useState(() => new QueryClient({
    defaultOptions: {
      queries: { staleTime: 30_000, refetchOnWindowFocus: false, retry: 1 },
      mutations: { retry: 0 },
    },
  }));
  return (
    <ThemeProvider attribute="class" defaultTheme="dark" enableSystem={false} themes={["light", "dark"]} disableTransitionOnChange>
      <QueryClientProvider client={qc}>
        {children}
        <CommandPalette />
        <Toaster richColors closeButton position="top-right" />
      </QueryClientProvider>
    </ThemeProvider>
  );
}
