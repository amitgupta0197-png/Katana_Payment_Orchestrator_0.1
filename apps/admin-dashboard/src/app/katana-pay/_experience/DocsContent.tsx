"use client";

// Katana Pay developer docs — a styled, on-brand replacement for the raw Swagger page.
// Quickstart, endpoints, signing, and the status callback, in glass panels over the sky.

import { motion } from "framer-motion";
import Link from "next/link";
import { ArrowRight, KeyRound, Plug, Terminal, Webhook } from "lucide-react";

function CodeBlock({ children }: { children: string }) {
  return (
    <pre className="overflow-x-auto rounded-xl border border-white/10 bg-slate-950/70 p-4 font-mono text-[13px] leading-relaxed text-white/85 backdrop-blur-xl">
      <code>{children}</code>
    </pre>
  );
}

function Panel({ icon: Icon, title, children }: { icon: typeof Plug; title: string; children: React.ReactNode }) {
  return (
    <motion.section
      initial={{ opacity: 0, y: 24 }}
      whileInView={{ opacity: 1, y: 0 }}
      viewport={{ once: true, amount: 0.2 }}
      transition={{ duration: 0.5 }}
      className="rounded-2xl border border-white/10 bg-slate-950/50 p-6 backdrop-blur-2xl md:p-8"
    >
      <div className="mb-4 flex items-center gap-3">
        <span className="grid h-9 w-9 place-items-center rounded-lg border border-white/10 bg-gradient-to-br from-cyan-400/20 to-violet-500/20 text-cyan-200"><Icon className="h-4 w-4" /></span>
        <h2 className="text-lg font-semibold text-white">{title}</h2>
      </div>
      <div className="space-y-4 text-sm leading-relaxed text-white/65">{children}</div>
    </motion.section>
  );
}

export function DocsContent() {
  return (
    <div className="mx-auto max-w-4xl px-6 pb-24 pt-36">
      <motion.div initial={{ opacity: 0, y: 20 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.6 }} className="mb-12">
        <p className="text-xs font-medium uppercase tracking-[0.35em] text-cyan-300/80">Documentation</p>
        <h1 className="mt-4 text-4xl font-semibold tracking-tight md:text-5xl">Integrate in an afternoon.</h1>
        <p className="mt-4 max-w-2xl text-lg text-white/50">Any language that can sign a request and read a callback can take payments with Katana Pay. Here&apos;s the whole flow.</p>
      </motion.div>

      <div className="space-y-5">
        <Panel icon={KeyRound} title="1 · Credentials (Key + Salt)">
          <p>Generate a per-banker <b>Key</b> and <b>Salt</b> from your merchant console under <span className="font-mono text-cyan-200">Developers</span>. The Key goes in every request; the Salt signs the hash and is shown only once — store it server-side.</p>
        </Panel>

        <Panel icon={Plug} title="2 · Endpoints">
          <ul className="space-y-2">
            <li><span className="text-white/40">Create order (POST)</span><br /><span className="font-mono text-cyan-200">https://katanapay.co/api/v1/katana-pay/order</span></li>
            <li><span className="text-white/40">Hosted payment page</span><br /><span className="font-mono text-cyan-200">https://katanapay.co/pay/{"{order_id}"}</span></li>
            <li><span className="text-white/40">Status enquiry (GET)</span><br /><span className="font-mono text-cyan-200">https://katanapay.co/api/pay-status/{"{order_id}"}</span></li>
          </ul>
        </Panel>

        <Panel icon={Terminal} title="3 · Create the order">
          <p>Server-side. Returns a <span className="font-mono text-cyan-200">pay_url</span> you redirect the customer to.</p>
          <CodeBlock>{`curl -X POST https://katanapay.co/api/v1/katana-pay/order \\
  -H "Content-Type: application/json" \\
  -d '{
    "key": "mk_your_key",
    "txnid": "ORDER-1001",
    "amount": "100.00",
    "productinfo": "Order 1001",
    "email": "buyer@example.com",
    "hash": "<computed: see signing>",
    "return_url": "https://your-site.com/payment/return",
    "notify_url": "https://your-site.com/api/katana/callback"
  }'

# → { "pay_url": "https://katanapay.co/pay/<id>", ... }`}</CodeBlock>
          <p>Sign the request with your Key + Salt:</p>
          <CodeBlock>{`// HMAC_SHA256
data = txnid + "|" + amount + "|" + productinfo + "|" + email
hash = HMAC_SHA256( key = (KEY + SALT), message = data )   // lowercase hex`}</CodeBlock>
        </Panel>

        <Panel icon={Webhook} title="4 · Receive the status callback">
          <p>We POST the terminal status to your <span className="font-mono text-cyan-200">notify_url</span>. Verify the HASH with your Salt, then mark the order paid and reply HTTP 200.</p>
          <CodeBlock>{`{ "ORDER_ID":"ORDER-1001", "STATUS":"Captured", "RESPONSE_CODE":"000",
  "RRN":"...", "HASH":"<uppercase sha256>" }

// verify: sort fields (except HASH) ascending, join KEY=value with "~",
// append your SALT, SHA256 -> hex -> UPPERCASE  ==  HASH
// STATUS="Captured" & RESPONSE_CODE="000"  =>  paid`}</CodeBlock>
        </Panel>
      </div>

      <div className="mt-10 flex flex-wrap gap-3">
        <Link href="/login" className="inline-flex items-center gap-2 rounded-xl bg-gradient-to-r from-cyan-400 to-fuchsia-500 px-6 py-3 text-sm font-semibold text-slate-950 shadow-[0_0_30px_-6px_rgba(217,70,239,0.65)]">Get your API keys <ArrowRight className="h-4 w-4" /></Link>
        <a href="/katana-pay-integration.html" target="_blank" rel="noopener" className="inline-flex items-center gap-2 rounded-xl border border-white/15 bg-white/[0.04] px-6 py-3 text-sm font-semibold text-white backdrop-blur-xl hover:bg-white/10">Full guide (PDF-style)</a>
      </div>
    </div>
  );
}
