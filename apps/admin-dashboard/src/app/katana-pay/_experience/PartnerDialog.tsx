"use client";

// "Become a Katana Partner" contact form. A glassmorphic modal over the nebula: the
// visitor fills their details, we POST to the public /api/v1/partner-inquiry endpoint,
// and the submission lands in the admin panel (/partner-inquiries). Self-contained —
// renders its own trigger button so it drops straight into the Ecosystem CTA.

import { useEffect, useState } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { ArrowRight, X, CheckCircle2, Loader2 } from "lucide-react";

const PARTNER_TYPES = [
  "Referral & Affiliate",
  "Merchant",
  "Banking Partner",
  "Technology Provider",
  "Payment Partner",
  "Other",
];

const inputCls =
  "w-full rounded-xl border border-white/10 bg-white/5 px-4 py-2.5 text-sm text-white placeholder-white/30 outline-none transition-colors focus:border-cyan-400/60 focus:bg-white/[0.07]";

export function PartnerDialog({ label = "Become a Partner" }: { label?: string }) {
  const [open, setOpen] = useState(false);
  const [sending, setSending] = useState(false);
  const [done, setDone] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [form, setForm] = useState({
    name: "", email: "", phone: "", company: "", partner_type: PARTNER_TYPES[0], message: "", website: "",
  });

  // Close on Escape; lock body scroll while open.
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") setOpen(false); };
    window.addEventListener("keydown", onKey);
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => { window.removeEventListener("keydown", onKey); document.body.style.overflow = prev; };
  }, [open]);

  const set = (k: keyof typeof form) => (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>) =>
    setForm((f) => ({ ...f, [k]: e.target.value }));

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setSending(true);
    try {
      const r = await fetch("/api/v1/partner-inquiry", {
        method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(form),
      });
      const d = await r.json().catch(() => null);
      if (!r.ok) throw new Error((d && d.error) || "Something went wrong. Please try again.");
      setDone(true);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setSending(false);
    }
  }

  function close() {
    setOpen(false);
    // reset a moment later so the closing animation isn't disrupted
    setTimeout(() => { setDone(false); setError(null); setForm({ name: "", email: "", phone: "", company: "", partner_type: PARTNER_TYPES[0], message: "", website: "" }); }, 250);
  }

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="group inline-flex shrink-0 items-center gap-2 rounded-full border border-cyan-400/40 bg-cyan-400/10 px-6 py-3 text-sm font-medium text-cyan-100 transition-all hover:border-cyan-300 hover:bg-cyan-400/20 hover:shadow-[0_0_28px_-8px_rgba(34,211,238,0.6)]"
      >
        {label}
        <ArrowRight className="h-4 w-4 transition-transform group-hover:translate-x-0.5" />
      </button>

      <AnimatePresence>
        {open && (
          <motion.div
            className="fixed inset-0 z-[100] flex items-center justify-center p-4"
            initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
          >
            <div className="absolute inset-0 bg-black/70 backdrop-blur-sm" onClick={close} />
            <motion.div
              role="dialog" aria-modal="true" aria-label="Become a Katana Partner"
              initial={{ opacity: 0, y: 24, scale: 0.98 }}
              animate={{ opacity: 1, y: 0, scale: 1 }}
              exit={{ opacity: 0, y: 24, scale: 0.98 }}
              transition={{ duration: 0.25, ease: [0.22, 1, 0.36, 1] }}
              className="relative w-full max-w-lg overflow-hidden rounded-2xl border border-white/10 bg-slate-950/80 p-7 shadow-2xl backdrop-blur-2xl sm:p-8"
            >
              <div className="pointer-events-none absolute -right-20 -top-20 h-52 w-52 rounded-full bg-cyan-400/10 blur-3xl" />
              <button type="button" onClick={close} aria-label="Close" className="absolute right-4 top-4 text-white/40 transition-colors hover:text-white">
                <X className="h-5 w-5" />
              </button>

              {done ? (
                <div className="relative flex flex-col items-center py-8 text-center">
                  <CheckCircle2 className="h-12 w-12 text-cyan-300" />
                  <h3 className="mt-4 text-xl font-semibold text-white">Thanks — we&apos;ll be in touch.</h3>
                  <p className="mt-2 text-sm text-white/50">Your details reached the Katana team. We&apos;ll reach out shortly.</p>
                  <button type="button" onClick={close} className="mt-6 rounded-full border border-white/15 px-5 py-2 text-sm text-white/80 transition-colors hover:border-white/30 hover:text-white">Done</button>
                </div>
              ) : (
                <div className="relative">
                  <p className="text-xs font-medium uppercase tracking-[0.35em] text-cyan-300/80">Partner with us</p>
                  <h3 className="mt-2 text-2xl font-semibold tracking-tight text-white">Become a Katana Partner</h3>
                  <p className="mt-1.5 text-sm font-light text-white/50">Tell us about you and we&apos;ll get back to you.</p>

                  <form onSubmit={submit} className="mt-6 space-y-3">
                    {/* Honeypot — hidden from humans, catches bots. */}
                    <input type="text" name="website" tabIndex={-1} autoComplete="off" value={form.website} onChange={set("website")} className="hidden" aria-hidden="true" />

                    <div className="grid gap-3 sm:grid-cols-2">
                      <input className={inputCls} placeholder="Full name *" value={form.name} onChange={set("name")} required maxLength={120} />
                      <input className={inputCls} type="email" placeholder="Email *" value={form.email} onChange={set("email")} required maxLength={160} />
                    </div>
                    <div className="grid gap-3 sm:grid-cols-2">
                      <input className={inputCls} placeholder="Phone" value={form.phone} onChange={set("phone")} maxLength={40} />
                      <input className={inputCls} placeholder="Company" value={form.company} onChange={set("company")} maxLength={160} />
                    </div>
                    <select className={inputCls + " appearance-none"} value={form.partner_type} onChange={set("partner_type")}>
                      {PARTNER_TYPES.map((t) => <option key={t} value={t} className="bg-slate-900">{t}</option>)}
                    </select>
                    <textarea className={inputCls + " min-h-[90px] resize-y"} placeholder="How would you like to partner?" value={form.message} onChange={set("message")} maxLength={4000} />

                    {error && <p className="text-sm text-rose-400">{error}</p>}

                    <button
                      type="submit" disabled={sending}
                      className="mt-1 inline-flex w-full items-center justify-center gap-2 rounded-full border border-cyan-400/40 bg-cyan-400/15 px-6 py-3 text-sm font-medium text-cyan-100 transition-all hover:border-cyan-300 hover:bg-cyan-400/25 hover:shadow-[0_0_28px_-8px_rgba(34,211,238,0.6)] disabled:cursor-not-allowed disabled:opacity-60"
                    >
                      {sending ? <><Loader2 className="h-4 w-4 animate-spin" /> Sending…</> : <>Submit <ArrowRight className="h-4 w-4" /></>}
                    </button>
                  </form>
                </div>
              )}
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>
    </>
  );
}
