"use client";

// Glassmorphic floating navigation. Heavy backdrop blur, translucent obsidian fill,
// hairline neon border. Drops in from the top on mount (Framer Motion). On mobile the
// links collapse into a hamburger dropdown.

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useState } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { ArrowUpRight, Menu, X } from "lucide-react";

const LINKS = [
  { href: "/katana-pay/features", label: "Features" },
  { href: "/katana-pay/api", label: "API" },
  { href: "/katana-pay/pricing", label: "Pricing" },
  { href: "/katana-pay/docs", label: "Docs" },
];

export function FloatingNav() {
  const pathname = usePathname();
  const [open, setOpen] = useState(false);

  // Close the mobile menu whenever the route changes.
  useEffect(() => { setOpen(false); }, [pathname]);

  return (
    <motion.header
      initial={{ y: -80, opacity: 0 }}
      animate={{ y: 0, opacity: 1 }}
      transition={{ duration: 0.7, ease: [0.22, 1, 0.36, 1] }}
      className="pointer-events-none fixed inset-x-0 top-4 z-50 flex justify-center px-4"
    >
      <div className="pointer-events-auto w-full max-w-4xl">
        <nav className="flex items-center justify-between gap-4 rounded-2xl border border-cyan-400/15 bg-black/40 px-4 py-2.5 shadow-[0_8px_40px_-12px_rgba(0,0,0,0.95),0_0_30px_-12px_rgba(34,211,238,0.5)] backdrop-blur-2xl">
          <Link href="/katana-pay" className="flex items-center">
            {/* Bright-on-black logo → screen blend drops the black bg over the nebula. */}
            <img src="/katana-logo.png" alt="Katana Pay" className="h-7 w-auto mix-blend-screen sm:h-8" />
          </Link>

          {/* Desktop links */}
          <div className="hidden items-center gap-6 text-sm md:flex">
            {LINKS.map((l) => {
              const active = pathname === l.href;
              return (
                <Link key={l.href} href={l.href} className={`transition-colors ${active ? "text-white" : "text-white/60 hover:text-white"}`}>{l.label}</Link>
              );
            })}
          </div>

          <div className="flex items-center gap-2">
            {/* Console — always visible */}
            <Link
              href="/login"
              className="group inline-flex items-center gap-1.5 rounded-xl border border-cyan-400/30 bg-cyan-400/10 px-3.5 py-1.5 text-sm font-medium text-cyan-200 transition-colors hover:bg-cyan-400/20"
            >
              Console <ArrowUpRight className="h-3.5 w-3.5 transition-transform group-hover:translate-x-0.5 group-hover:-translate-y-0.5" />
            </Link>
            {/* Mobile hamburger */}
            <button
              type="button"
              onClick={() => setOpen((v) => !v)}
              aria-label={open ? "Close menu" : "Open menu"}
              aria-expanded={open}
              className="grid h-9 w-9 place-items-center rounded-xl border border-white/10 text-white/80 transition-colors hover:bg-white/10 md:hidden"
            >
              {open ? <X className="h-5 w-5" /> : <Menu className="h-5 w-5" />}
            </button>
          </div>
        </nav>

        {/* Mobile dropdown */}
        <AnimatePresence>
          {open && (
            <motion.div
              initial={{ opacity: 0, y: -8 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -8 }}
              transition={{ duration: 0.18 }}
              className="mt-2 overflow-hidden rounded-2xl border border-cyan-400/15 bg-black/60 p-2 shadow-[0_8px_40px_-12px_rgba(0,0,0,0.95)] backdrop-blur-2xl md:hidden"
            >
              {LINKS.map((l) => {
                const active = pathname === l.href;
                return (
                  <Link
                    key={l.href}
                    href={l.href}
                    onClick={() => setOpen(false)}
                    className={`block rounded-xl px-4 py-3 text-sm transition-colors ${active ? "bg-white/10 text-white" : "text-white/70 hover:bg-white/5 hover:text-white"}`}
                  >
                    {l.label}
                  </Link>
                );
              })}
            </motion.div>
          )}
        </AnimatePresence>
      </div>
    </motion.header>
  );
}
