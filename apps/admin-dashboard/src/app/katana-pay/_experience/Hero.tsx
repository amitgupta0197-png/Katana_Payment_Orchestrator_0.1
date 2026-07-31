"use client";

// Hero. Sits over the pulled-back monolith. Staggered Framer Motion reveal; a soft
// scroll cue hints the dive. Text is real DOM (SSR'd) so it's crawlable.

import Link from "next/link";
import { motion, type Variants } from "framer-motion";
import { ArrowRight, ChevronDown, Code2 } from "lucide-react";

const container: Variants = {
  hidden: {},
  show: { transition: { staggerChildren: 0.12, delayChildren: 0.2 } },
};
const item: Variants = {
  hidden: { y: 24, opacity: 0 },
  show: { y: 0, opacity: 1, transition: { duration: 0.7, ease: [0.22, 1, 0.36, 1] } },
};

export function Hero() {
  return (
    <section id="hero" className="relative flex min-h-screen items-center">
      {/* Legibility scrim: softly darkens the centre so the headline stays crisp over the
          dense core, while the nebula still glows through at the edges. */}
      <div aria-hidden className="pointer-events-none absolute inset-0 [background:radial-gradient(55%_50%_at_50%_44%,rgba(3,4,10,0.72),rgba(3,4,10,0.25)_60%,transparent_80%)]" />
      <motion.div variants={container} initial="hidden" animate="show" className="relative mx-auto w-full max-w-5xl px-6 text-center">
        <motion.div variants={item} className="mx-auto inline-flex items-center gap-2.5 text-[11px] font-medium uppercase tracking-[0.4em] text-cyan-300/80">
          <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-cyan-400 shadow-[0_0_8px_2px_rgba(34,211,238,0.8)]" />
          Payment Orchestration
        </motion.div>

        <motion.h1 variants={item} className="mx-auto mt-8 max-w-4xl text-balance text-5xl font-semibold leading-[1.04] tracking-[-0.01em] text-white [text-shadow:0_0_40px_rgba(0,229,255,0.25)] md:text-[5.5rem]">
          Move money like<br />
          <span className="bg-gradient-to-r from-cyan-300 via-sky-300 to-fuchsia-400 bg-clip-text text-transparent [-webkit-text-fill-color:transparent] drop-shadow-[0_0_28px_rgba(217,70,239,0.35)]">it&apos;s frictionless.</span>
        </motion.h1>

        <motion.p variants={item} className="mx-auto mt-8 max-w-xl text-lg font-light leading-relaxed text-white/55">
          Hosted UPI checkout, real-time reconciliation, smart multi-provider routing, and
          fast branch settlements — behind one signed API, in any language.
        </motion.p>

        <motion.div variants={item} className="mt-10 flex flex-wrap items-center justify-center gap-3">
          <Link href="/login" className="group inline-flex items-center gap-2 rounded-xl bg-gradient-to-r from-cyan-400 to-fuchsia-500 px-6 py-3 text-sm font-semibold text-slate-950 shadow-[0_0_36px_-4px_rgba(217,70,239,0.65)] transition-transform hover:scale-[1.03]">
            Get started <ArrowRight className="h-4 w-4 transition-transform group-hover:translate-x-0.5" />
          </Link>
          <Link href="/katana-pay/docs" className="inline-flex items-center gap-2 rounded-xl border border-cyan-400/25 bg-cyan-400/[0.06] px-6 py-3 text-sm font-semibold text-cyan-100 backdrop-blur-xl transition-colors hover:bg-cyan-400/[0.12] hover:shadow-[0_0_24px_-6px_rgba(34,211,238,0.5)]">
            <Code2 className="h-4 w-4" /> View API docs
          </Link>
        </motion.div>

        <motion.div variants={item} className="mt-16 flex items-center justify-center gap-2 text-xs uppercase tracking-widest text-white/40">
          <ChevronDown className="h-4 w-4 animate-bounce" /> Scroll to dive in
        </motion.div>
      </motion.div>
    </section>
  );
}
