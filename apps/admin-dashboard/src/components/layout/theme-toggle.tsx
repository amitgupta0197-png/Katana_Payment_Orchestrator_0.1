"use client";

// Light (white/purple) <-> Dark (violet) theme switch. Driven by next-themes,
// which toggles the `dark` class on <html>; globals.css re-themes every token.

import { useEffect, useState } from "react";
import { useTheme } from "next-themes";
import { Moon, Sun } from "lucide-react";
import { Button } from "@/components/ui/button";

export function ThemeToggle() {
  const { resolvedTheme, setTheme } = useTheme();
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);

  const isDark = (resolvedTheme ?? "dark") === "dark";
  return (
    <Button
      variant="ghost"
      size="icon"
      aria-label={isDark ? "Switch to light theme" : "Switch to dark theme"}
      title={isDark ? "Switch to light theme" : "Switch to dark theme"}
      onClick={() => setTheme(isDark ? "light" : "dark")}
    >
      {/* Render a stable icon pre-hydration to avoid a mismatch flash. */}
      {mounted ? (isDark ? <Sun /> : <Moon />) : <Sun />}
    </Button>
  );
}
