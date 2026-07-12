"use client";

// Ecosystem. Katana Pay isn't merchant-only — it serves every actor in the payments
// chain. Each audience gets a glassmorphic card listing what the platform gives them,
// followed by the referral-partner call to action. Same motion + neon language as
// Features so the home page reads as one continuous surface.

import { motion, type Variants } from "framer-motion";
import { Store, Landmark, Code2, Network, Gift, ArrowRight, type LucideIcon } from "lucide-react";

interface Audience { icon: LucideIcon; title: string; blurb: string; items: string[] }

const AUDIENCES: Audience[] = [
  {
    icon: Store,
    title: "For Merchants",
    blurb: "Accept payments on every rail your customers use.",
    items: ["Accept Payments", "UPI", "Cards", "Net Banking", "Wallets", "Smart Routing"],
  },
  {
    icon: Landmark,
    title: "For Banking Partners",
    blurb: "Collection, settlement and escrow rails, orchestrated.",
    items: ["Collection Accounts", "Settlement Banking", "Escrow Support", "Nodal Accounts", "API Banking"],
  },
  {
    icon: Code2,
    title: "For Technology Providers",
    blurb: "Ship payments inside your own product, fully branded.",
    items: ["White Label Gateway", "API Integration", "Custom Checkout", "Embedded Payments"],
  },
  {
    icon: Network,
    title: "For Payment Partners",
    blurb: "Plug your rails into a growing orchestration network.",
    items: ["Payment Aggregators", "Payment Gateways", "PSPs", "Acquiring Banks"],
  },
];

const card: Variants = {
  hidden: { y: 40, opacity: 0 },
  show: (i: number) => ({ y: 0, opacity: 1, transition: { duration: 0.6, delay: i * 0.07, ease: [0.22, 1, 0.36, 1] } }),
};

export function Ecosystem() {
  return (
    <section id="ecosystem" className="relative mx-auto max-w-6xl px-6 py-32">
      <motion.div
        initial={{ opacity: 0, y: 20 }}
        whileInView={{ opacity: 1, y: 0 }}
        viewport={{ once: true, amount: 0.5 }}
        transition={{ duration: 0.6 }}
        className="max-w-2xl"
      >
        <p className="text-xs font-medium uppercase tracking-[0.35em] text-cyan-300/80">Ecosystem</p>
        <h2 className="mt-4 text-4xl font-semibold tracking-tight text-white md:text-5xl">
          Built for the entire<br /><span className="text-cyan-300">payments ecosystem.</span>
        </h2>
        <p className="mt-4 text-lg font-light text-white/50">
          One orchestration layer connecting merchants, banks, technology providers and payment networks.
        </p>
      </motion.div>

      <div className="mt-14 grid gap-5 sm:grid-cols-2">
        {AUDIENCES.map((a, i) => (
          <motion.div
            key={a.title}
            custom={i}
            variants={card}
            initial="hidden"
            whileInView="show"
            viewport={{ once: true, amount: 0.3 }}
            className="group relative overflow-hidden rounded-2xl border border-white/10 bg-slate-950/50 p-7 backdrop-blur-2xl transition-all hover:border-cyan-400/50 hover:shadow-[0_0_34px_-10px_rgba(34,211,238,0.45)]"
          >
            <div className="pointer-events-none absolute -right-10 -top-10 h-24 w-24 rounded-full bg-cyan-400/0 blur-2xl transition-colors duration-500 group-hover:bg-cyan-400/20" />
            <div className="flex items-center gap-3">
              <div className="grid h-11 w-11 place-items-center rounded-xl border border-white/10 bg-gradient-to-br from-cyan-400/20 to-violet-500/20 text-cyan-200">
                <a.icon className="h-5 w-5" />
              </div>
              <div>
                <h3 className="text-lg font-semibold text-white">{a.title}</h3>
              </div>
            </div>
            <p className="mt-4 text-sm leading-relaxed text-white/55">{a.blurb}</p>
            <ul className="mt-5 flex flex-wrap gap-2">
              {a.items.map((it) => (
                <li key={it} className="rounded-full border border-white/10 bg-white/5 px-3 py-1 text-xs font-light text-white/70">
                  {it}
                </li>
              ))}
            </ul>
          </motion.div>
        ))}
      </div>

      {/* Referral & Affiliate — a call to action rather than a capability list. */}
      <motion.div
        initial={{ opacity: 0, y: 24 }}
        whileInView={{ opacity: 1, y: 0 }}
        viewport={{ once: true, amount: 0.4 }}
        transition={{ duration: 0.6 }}
        className="group relative mt-5 overflow-hidden rounded-2xl border border-cyan-400/25 bg-gradient-to-br from-cyan-500/10 via-slate-950/50 to-violet-500/10 p-8 backdrop-blur-2xl sm:p-10"
      >
        <div className="pointer-events-none absolute -right-16 -top-16 h-48 w-48 rounded-full bg-cyan-400/10 blur-3xl" />
        <div className="relative flex flex-col items-start justify-between gap-6 sm:flex-row sm:items-center">
          <div className="max-w-xl">
            <div className="flex items-center gap-2 text-cyan-300/80">
              <Gift className="h-4 w-4" />
              <p className="text-xs font-medium uppercase tracking-[0.35em]">Referral &amp; Affiliate Partners</p>
            </div>
            <h3 className="mt-3 text-2xl font-semibold tracking-tight text-white md:text-3xl">Become a Katana Partner</h3>
            <p className="mt-2 text-base font-light text-white/55">Earn recurring revenue by referring merchants to Katana Pay.</p>
          </div>
          <a
            href="mailto:partners@katanapay.co?subject=Katana%20Partner%20Program"
            className="inline-flex shrink-0 items-center gap-2 rounded-full border border-cyan-400/40 bg-cyan-400/10 px-6 py-3 text-sm font-medium text-cyan-100 transition-all hover:border-cyan-300 hover:bg-cyan-400/20 hover:shadow-[0_0_28px_-8px_rgba(34,211,238,0.6)]"
          >
            Become a Partner
            <ArrowRight className="h-4 w-4 transition-transform group-hover:translate-x-0.5" />
          </a>
        </div>
      </motion.div>
    </section>
  );
}
