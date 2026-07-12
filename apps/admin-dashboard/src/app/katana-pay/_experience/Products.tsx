"use client";

// Products. The full Katana Pay surface area grouped into five families — pay-in,
// payout, banking APIs, verification and the settlement engine. Same glassmorphic card
// + chip language as Ecosystem so the two sections stack into one continuous page.

import { motion, type Variants } from "framer-motion";
import { ArrowDownToLine, Send, ShieldCheck, BadgeCheck, Scale, type LucideIcon } from "lucide-react";

interface ProductGroup { icon: LucideIcon; title: string; items: string[] }

const GROUPS: ProductGroup[] = [
  {
    icon: ArrowDownToLine,
    title: "Pay-In",
    items: ["UPI Intent", "UPI Collect", "Static QR", "Dynamic QR", "Hosted Checkout", "S2S API", "Payment Links", "Subscription", "Tokenization"],
  },
  {
    icon: Send,
    title: "Payout",
    items: ["IMPS", "NEFT", "RTGS", "UPI", "Bulk Payout", "Vendor Settlement", "Salary Disbursement", "Automated Settlement"],
  },
  {
    icon: ShieldCheck,
    title: "Banking APIs",
    items: ["Account Verification", "Penny Drop", "Name Match", "Balance Check", "Virtual Accounts", "Escrow APIs"],
  },
  {
    icon: BadgeCheck,
    title: "Business Verification",
    items: ["PAN", "GST", "CIN", "Aadhaar", "Bank Account", "UDYAM"],
  },
  {
    icon: Scale,
    title: "Settlement Engine",
    items: ["Merchant Settlement", "Vendor Settlement", "Split Settlement", "Commission Engine", "Rolling Reserve", "Escrow Logic"],
  },
];

const card: Variants = {
  hidden: { y: 40, opacity: 0 },
  show: (i: number) => ({ y: 0, opacity: 1, transition: { duration: 0.6, delay: i * 0.07, ease: [0.22, 1, 0.36, 1] } }),
};

export function Products() {
  return (
    <section id="products" className="relative mx-auto max-w-6xl px-6 py-32">
      <motion.div
        initial={{ opacity: 0, y: 20 }}
        whileInView={{ opacity: 1, y: 0 }}
        viewport={{ once: true, amount: 0.5 }}
        transition={{ duration: 0.6 }}
        className="max-w-2xl"
      >
        <p className="text-xs font-medium uppercase tracking-[0.35em] text-cyan-300/80">Products</p>
        <h2 className="mt-4 text-4xl font-semibold tracking-tight text-white md:text-5xl">
          Everything money needs<br /><span className="text-cyan-300">to move, in one stack.</span>
        </h2>
        <p className="mt-4 text-lg font-light text-white/50">
          Collect, pay out, verify and settle — each a first-class product behind one signed API.
        </p>
      </motion.div>

      <div className="mt-14 grid gap-5 sm:grid-cols-2 lg:grid-cols-3">
        {GROUPS.map((g, i) => (
          <motion.div
            key={g.title}
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
                <g.icon className="h-5 w-5" />
              </div>
              <h3 className="text-lg font-semibold text-white">{g.title}</h3>
            </div>
            <ul className="mt-5 flex flex-wrap gap-2">
              {g.items.map((it) => (
                <li key={it} className="rounded-full border border-white/10 bg-white/5 px-3 py-1 text-xs font-light text-white/70">
                  {it}
                </li>
              ))}
            </ul>
          </motion.div>
        ))}
      </div>
    </section>
  );
}
