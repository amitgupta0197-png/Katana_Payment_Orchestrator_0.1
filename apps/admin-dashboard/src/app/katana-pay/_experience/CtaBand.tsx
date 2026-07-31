"use client";

import Link from "next/link";
import { motion } from "framer-motion";
import { ArrowRight } from "lucide-react";

export function CtaBand() {
  return (
    <section className="relative px-6 py-32 text-center">
      <div aria-hidden className="pointer-events-none absolute inset-0 [background:radial-gradient(50%_60%_at_50%_50%,rgba(4,4,12,0.7),transparent_75%)]" />
      <motion.h2 initial={{ opacity: 0, y: 20 }} whileInView={{ opacity: 1, y: 0 }} viewport={{ once: true }} transition={{ duration: 0.7 }} className="relative mx-auto max-w-4xl text-4xl font-semibold tracking-tight md:text-6xl">
        Ready to <span className="bg-gradient-to-r from-cyan-300 to-fuchsia-400 bg-clip-text text-transparent">start collecting?</span>
      </motion.h2>
      <p className="relative mx-auto mt-5 max-w-lg text-lg text-white/60">Get your API keys, drop the checkout on your site, and watch payments reconcile in real time.</p>
      <div className="relative mt-9 flex flex-wrap justify-center gap-3">
        <Link href="/login" className="inline-flex items-center gap-2 rounded-xl bg-gradient-to-r from-cyan-400 to-fuchsia-500 px-6 py-3 text-sm font-semibold text-slate-950 shadow-[0_0_30px_-6px_rgba(217,70,239,0.65)]">Get started <ArrowRight className="h-4 w-4" /></Link>
        <Link href="/katana-pay/docs" className="inline-flex items-center gap-2 rounded-xl border border-white/15 bg-white/[0.04] px-6 py-3 text-sm font-semibold text-white backdrop-blur-xl hover:bg-white/10">Read the docs</Link>
      </div>
    </section>
  );
}
