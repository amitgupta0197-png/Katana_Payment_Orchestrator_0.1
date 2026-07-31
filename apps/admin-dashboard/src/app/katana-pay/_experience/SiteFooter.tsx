"use client";

import Link from "next/link";
import { Swords } from "lucide-react";

export function SiteFooter() {
  return (
    <footer className="relative z-10 border-t border-white/10 bg-black/40 backdrop-blur-xl">
      <div className="mx-auto flex max-w-6xl flex-col items-center justify-between gap-4 px-6 py-10 text-sm text-white/40 md:flex-row">
        <Link href="/katana-pay" className="inline-flex items-center gap-2 font-semibold text-white/80">
          <span className="grid h-7 w-7 place-items-center rounded-lg bg-gradient-to-br from-cyan-400 to-violet-600 text-white"><Swords className="h-4 w-4" /></span>
          Katana Pay
        </Link>
        <div className="flex flex-wrap items-center gap-x-6 gap-y-2">
          <Link href="/katana-pay/features" className="hover:text-white">Features</Link>
          <Link href="/katana-pay/api" className="hover:text-white">API</Link>
          <Link href="/katana-pay/pricing" className="hover:text-white">Pricing</Link>
          <Link href="/katana-pay/docs" className="hover:text-white">Docs</Link>
          <Link href="/login" className="hover:text-white">Console</Link>
        </div>
        <span>© 2026 Katana Pay</span>
      </div>
    </footer>
  );
}
