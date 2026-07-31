"use client";

// Features. Glassmorphic cards that rise + fade as they enter the viewport (Framer
// Motion whileInView). This is the section the camera "arrives" at after the dive.

import { motion, type Variants } from "framer-motion";
import { Globe, GitMerge, Workflow, Smartphone, Banknote, Code2, type LucideIcon } from "lucide-react";

interface Feature { icon: LucideIcon; title: string; body: string }

const FEATURES: Feature[] = [
  { icon: Globe, title: "Hosted checkout, any language", body: "POST a signed order, redirect to a hosted pay page. PHP, Node, Python, Go, WordPress — if it can send JSON, it can take payments." },
  { icon: GitMerge, title: "Real-time reconciliation", body: "Every UPI credit is captured, matched to its order, and reconciled — with RRN/UTR tracking so nothing slips through." },
  { icon: Workflow, title: "Smart multi-merchant routing", body: "Each payment scored across providers on success rate, latency, health and cost — routed to the best rail, live." },
  { icon: Smartphone, title: "On-device RRN capture", body: "When banks expose no API, our agent reads the 12-digit UPI reference on-device so collections always reconcile." },
  { icon: Banknote, title: "Fast banker settlements", body: "A full upline → Katana → branch settlement flow with immutable timelines, versioned commission rules, and USDT or bank payouts." },
  { icon: Code2, title: "Developer-first API", body: "Signed order API, hosted pay page, signed callbacks. Per-branch Key + Salt, live OpenAPI docs, copy-paste samples." },
];

const card: Variants = {
  hidden: { y: 40, opacity: 0 },
  show: (i: number) => ({ y: 0, opacity: 1, transition: { duration: 0.6, delay: i * 0.07, ease: [0.22, 1, 0.36, 1] } }),
};

export function Features() {
  return (
    <section id="features" className="relative mx-auto max-w-6xl px-6 py-32">
      <motion.div
        initial={{ opacity: 0, y: 20 }}
        whileInView={{ opacity: 1, y: 0 }}
        viewport={{ once: true, amount: 0.5 }}
        transition={{ duration: 0.6 }}
        className="max-w-2xl"
      >
        <p className="text-xs font-medium uppercase tracking-[0.35em] text-cyan-300/80">Platform</p>
        <h2 className="mt-4 text-4xl font-semibold tracking-tight text-white md:text-5xl">The whole stack, from<br /><span className="text-cyan-300">button to settled rupee.</span></h2>
        <p className="mt-4 text-lg font-light text-white/50">One platform for collection, reconciliation, routing, and settlement.</p>
      </motion.div>

      <div className="mt-14 grid gap-5 sm:grid-cols-2 lg:grid-cols-3">
        {FEATURES.map((f, i) => (
          <motion.div
            key={f.title}
            custom={i}
            variants={card}
            initial="hidden"
            whileInView="show"
            viewport={{ once: true, amount: 0.3 }}
            className="group relative overflow-hidden rounded-2xl border border-white/10 bg-slate-950/50 p-6 backdrop-blur-2xl transition-all hover:border-cyan-400/50 hover:shadow-[0_0_34px_-10px_rgba(34,211,238,0.45)]"
          >
            {/* Neon corner glow on hover */}
            <div className="pointer-events-none absolute -right-10 -top-10 h-24 w-24 rounded-full bg-cyan-400/0 blur-2xl transition-colors duration-500 group-hover:bg-cyan-400/20" />
            <div className="grid h-11 w-11 place-items-center rounded-xl border border-white/10 bg-gradient-to-br from-cyan-400/20 to-violet-500/20 text-cyan-200">
              <f.icon className="h-5 w-5" />
            </div>
            <h3 className="mt-5 text-lg font-semibold text-white">{f.title}</h3>
            <p className="mt-2 text-sm leading-relaxed text-white/55">{f.body}</p>
          </motion.div>
        ))}
      </div>
    </section>
  );
}
