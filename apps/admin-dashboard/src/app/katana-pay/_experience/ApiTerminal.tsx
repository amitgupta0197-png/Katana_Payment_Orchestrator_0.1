"use client";

// Futuristic terminal window. When it scrolls into view (Framer Motion useInView), a
// JSON payload types itself out character-by-character, then resolves to a syntax-
// highlighted block. Glassmorphic chassis, neon top-edge, traffic-light dots.

import { useEffect, useRef, useState } from "react";
import { motion, useInView } from "framer-motion";
import { Terminal } from "lucide-react";

const PAYLOAD = `POST /api/v1/katana-pay/order
{
  "key": "mk_live_9e8dc9f96eb6",
  "txnid": "ORDER-10294",
  "amount": "2499.00",
  "productinfo": "Pro subscription",
  "email": "buyer@acme.in",
  "hash": "e3b0c44298fc1c149afbf4c8996fb924…",
  "notify_url": "https://acme.in/api/katana/callback"
}

← 200 OK
{
  "pay_url": "https://katanapay.co/pay/8f2a…",
  "status": "CREATED"
}`;

// Lightweight JSON-ish highlighter for the fully-typed text. Keys → cyan, strings →
// emerald, HTTP verbs/status → violet, punctuation → slate.
function highlight(text: string) {
  return text.split("\n").map((line, i) => {
    const parts: React.ReactNode[] = [];
    // key: "value"
    const kv = line.match(/^(\s*)"([^"]+)"(\s*:\s*)(.*)$/);
    if (kv) {
      parts.push(kv[1]);
      parts.push(<span key="k" className="text-cyan-300">&quot;{kv[2]}&quot;</span>);
      parts.push(<span key="c" className="text-white/40">{kv[3]}</span>);
      parts.push(<span key="v" className="text-emerald-300">{kv[4]}</span>);
    } else if (/^(POST|GET|←\s*200 OK)/.test(line.trim())) {
      parts.push(<span key="h" className="font-semibold text-violet-300">{line}</span>);
    } else {
      parts.push(<span key="p" className="text-white/70">{line}</span>);
    }
    return <div key={i}>{parts.length ? parts : " "}</div>;
  });
}

export function ApiTerminal() {
  const ref = useRef<HTMLDivElement>(null);
  const inView = useInView(ref, { once: true, amount: 0.4 });
  const [count, setCount] = useState(0);
  const done = count >= PAYLOAD.length;

  useEffect(() => {
    if (!inView) return;
    let raf = 0;
    let last = 0;
    let i = 0;
    const CPS = 90; // characters per second
    const step = (t: number) => {
      if (!last) last = t;
      i += ((t - last) / 1000) * CPS;
      last = t;
      setCount(Math.min(PAYLOAD.length, Math.floor(i)));
      if (i < PAYLOAD.length) raf = requestAnimationFrame(step);
    };
    raf = requestAnimationFrame(step);
    return () => cancelAnimationFrame(raf);
  }, [inView]);

  const typed = PAYLOAD.slice(0, count);

  return (
    <section id="api" className="relative mx-auto max-w-6xl px-6 py-32">
      <div className="grid gap-12 lg:grid-cols-2 lg:items-center">
        <motion.div
          initial={{ opacity: 0, x: -30 }}
          whileInView={{ opacity: 1, x: 0 }}
          viewport={{ once: true, amount: 0.5 }}
          transition={{ duration: 0.7, ease: [0.22, 1, 0.36, 1] }}
        >
          <div className="inline-flex items-center gap-2 rounded-full border border-white/10 bg-white/[0.03] px-3 py-1 text-xs text-violet-200 backdrop-blur-xl">
            <Terminal className="h-3.5 w-3.5" /> One request to charge
          </div>
          <h2 className="mt-6 text-4xl font-bold tracking-tight text-white md:text-5xl">Integrate in an afternoon.</h2>
          <p className="mt-4 max-w-md text-lg text-white/55">
            Sign the order with your per-branch Key + Salt, POST it, and redirect to the
            returned <code className="rounded bg-white/10 px-1.5 py-0.5 text-cyan-200">pay_url</code>. We handle UPI,
            reconciliation, and the signed status callback.
          </p>
          <ul className="mt-8 space-y-3 text-sm text-white/70">
            {["No card/bank rails to touch", "Signed requests + signed callbacks", "Idempotent, RRN-tracked, auditable"].map((t) => (
              <li key={t} className="flex items-center gap-3">
                <span className="h-1.5 w-1.5 rounded-full bg-cyan-400 shadow-[0_0_8px_2px_rgba(34,211,238,0.7)]" />{t}
              </li>
            ))}
          </ul>
        </motion.div>

        {/* Terminal chassis */}
        <motion.div
          ref={ref}
          initial={{ opacity: 0, y: 30, scale: 0.98 }}
          whileInView={{ opacity: 1, y: 0, scale: 1 }}
          viewport={{ once: true, amount: 0.4 }}
          transition={{ duration: 0.7, ease: [0.22, 1, 0.36, 1] }}
          className="relative overflow-hidden rounded-2xl border border-white/10 bg-slate-950/70 shadow-[0_30px_80px_-20px_rgba(34,211,238,0.25)] backdrop-blur-2xl"
        >
          {/* Neon top edge */}
          <div className="absolute inset-x-0 top-0 h-px bg-gradient-to-r from-transparent via-cyan-400 to-transparent" />
          {/* Title bar */}
          <div className="flex items-center gap-2 border-b border-white/10 px-4 py-3">
            <span className="h-3 w-3 rounded-full bg-red-400/80" />
            <span className="h-3 w-3 rounded-full bg-amber-400/80" />
            <span className="h-3 w-3 rounded-full bg-emerald-400/80" />
            <span className="ml-3 font-mono text-xs text-white/40">katana-pay · order.sh</span>
          </div>
          {/* Body */}
          <pre className="min-h-[22rem] overflow-x-auto p-5 font-mono text-[13px] leading-relaxed">
            <code>
              {done ? highlight(PAYLOAD) : <span className="text-white/70">{typed}</span>}
              {!done && <span className="ml-0.5 inline-block h-4 w-2 -translate-y-px animate-pulse bg-cyan-400 align-middle" />}
            </code>
          </pre>
        </motion.div>
      </div>
    </section>
  );
}
