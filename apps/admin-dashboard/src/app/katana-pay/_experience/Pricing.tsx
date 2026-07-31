"use client";

import Link from "next/link";
import { motion } from "framer-motion";
import { ArrowRight, Check } from "lucide-react";

const PLANS = [
  { name: "Starter", price: "₹0", cadence: "setup", tagline: "One website, going live.", features: ["Hosted UPI checkout", "1 settling branch", "Standard reconciliation", "Email support"], highlight: false, cta: "Get started" },
  { name: "Growth", price: "Custom", cadence: "MDR", tagline: "Scaling merchants & providers.", features: ["Everything in Starter", "Multiple branches & providers", "Smart routing + priority rails", "Live settlement dashboard", "Priority support"], highlight: true, cta: "Talk to sales" },
  { name: "Enterprise", price: "Custom", cadence: "", tagline: "Platforms & high volume.", features: ["Everything in Growth", "Dedicated routing weights + SLAs", "Rolling reserve / holdback / TDS", "Custom settlement rules", "Success manager"], highlight: false, cta: "Talk to sales" },
];

export function Pricing() {
  return (
    <section className="relative mx-auto max-w-6xl px-6 pb-24 pt-36">
      <motion.div initial={{ opacity: 0, y: 20 }} whileInView={{ opacity: 1, y: 0 }} viewport={{ once: true, amount: 0.5 }} transition={{ duration: 0.6 }} className="max-w-2xl">
        <p className="text-xs font-medium uppercase tracking-[0.35em] text-cyan-300/80">Pricing</p>
        <h1 className="mt-4 text-4xl font-semibold tracking-tight md:text-5xl">Transparent by design.</h1>
        <p className="mt-4 text-lg text-white/50">Start free. Pay a clear MDR as you scale. No hidden gateway markup.</p>
      </motion.div>
      <div className="mt-14 grid gap-5 md:grid-cols-3">
        {PLANS.map((p, i) => (
          <motion.div
            key={p.name}
            initial={{ opacity: 0, y: 30 }}
            whileInView={{ opacity: 1, y: 0 }}
            viewport={{ once: true, amount: 0.3 }}
            transition={{ duration: 0.6, delay: i * 0.08 }}
            className={`flex flex-col rounded-2xl border p-6 backdrop-blur-2xl ${p.highlight ? "border-cyan-400/40 bg-slate-950/60 shadow-[0_0_50px_-10px_rgba(34,211,238,0.4)]" : "border-white/10 bg-slate-950/50"}`}
          >
            {p.highlight && <div className="mb-3 inline-flex w-fit rounded-full bg-gradient-to-r from-cyan-400 to-fuchsia-500 px-2.5 py-0.5 text-xs font-semibold text-slate-950">Most popular</div>}
            <h3 className="text-lg font-semibold">{p.name}</h3>
            <p className="mt-1 text-sm text-white/50">{p.tagline}</p>
            <div className="mt-5 flex items-baseline gap-1"><span className="text-3xl font-bold">{p.price}</span>{p.cadence && <span className="text-sm text-white/40">/ {p.cadence}</span>}</div>
            <ul className="mt-6 space-y-3 text-sm text-white/70">
              {p.features.map((f) => (<li key={f} className="flex gap-2.5"><Check className="mt-0.5 h-4 w-4 shrink-0 text-cyan-300" />{f}</li>))}
            </ul>
            <Link href="/login" className={`mt-8 inline-flex items-center justify-center gap-1.5 rounded-xl px-4 py-2.5 text-sm font-semibold ${p.highlight ? "bg-gradient-to-r from-cyan-400 to-fuchsia-500 text-slate-950" : "border border-white/15 text-white hover:bg-white/10"}`}>{p.cta} <ArrowRight className="h-4 w-4" /></Link>
          </motion.div>
        ))}
      </div>
    </section>
  );
}
