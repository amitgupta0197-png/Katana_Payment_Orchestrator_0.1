"use client";

// Shared shell for the Katana Pay marketing site. The nebula canvas + floating nav +
// footer live here so they PERSIST across route changes (Next keeps a layout mounted when
// navigating between its child pages) — the background never re-mounts or flashes as you
// move between Features / API / Pricing / Docs. Each page just supplies its own content.

import dynamic from "next/dynamic";
import { useEffect } from "react";
import { FloatingNav } from "./_experience/FloatingNav";
import { SiteFooter } from "./_experience/SiteFooter";
import { SplashScreen } from "./_experience/SplashScreen";
import { scrollState } from "./_experience/cameraStore";

const Scene = dynamic(() => import("./_experience/Scene"), { ssr: false });

export default function KatanaPayLayout({ children }: { children: React.ReactNode }) {
  // Drive the nebula's scroll-zoom from window scroll (no GSAP needed now that pages are
  // short and separate).
  useEffect(() => {
    const onScroll = () => {
      const max = document.documentElement.scrollHeight - window.innerHeight;
      scrollState.progress = max > 0 ? Math.min(1, Math.max(0, window.scrollY / max)) : 0;
    };
    onScroll();
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => window.removeEventListener("scroll", onScroll);
  }, []);

  return (
    <div className="relative min-h-screen text-white antialiased">
      {/* One-time intro video on first visit (self-dismisses; localStorage-gated). */}
      <SplashScreen />
      {/* Opaque fallback behind the canvas (shows if WebGL is unavailable). */}
      <div className="fixed inset-0 -z-10 bg-[#020207]" />
      <Scene />
      <FloatingNav />
      <main className="relative z-10 flex min-h-screen flex-col">
        <div className="flex-1">{children}</div>
        <SiteFooter />
      </main>
    </div>
  );
}
