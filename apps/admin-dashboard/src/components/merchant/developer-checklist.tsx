"use client";

// What a merchant's developer has to build, beside the Key + Salt (merchant portal /keys). Static and
// general: the banker's own endpoint, flow and webhook version are in its Starter Kit, shown under it.
// The signing code here is the rule lib/katana-order-api checks (HMAC-SHA256 of
// "txnid|amount|productinfo|email" keyed with Key + Salt), and the callback check is the v1 HASH.

import { useState } from "react";
import Link from "next/link";
import { Copy, ListChecks } from "lucide-react";
import { toast } from "sonner";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";

const LANGS = ["Node.js", "Python", "PHP", "Shell"] as const;
type Lang = (typeof LANGS)[number];

const SIGN: Record<Lang, string> = {
  "Node.js": `const crypto = require("crypto");
// On your SERVER. Never put the Salt in a web page or an app.
const hash = crypto.createHmac("sha256", KEY + SALT)
  .update([txnid, amount, productinfo, email].join("|"))
  .digest("hex");`,
  Python: `import hmac, hashlib
# On your SERVER. Never put the Salt in a web page or an app.
msg = "|".join([txnid, amount, productinfo, email])
hash = hmac.new((KEY + SALT).encode(), msg.encode(), hashlib.sha256).hexdigest()`,
  PHP: `<?php
// On your SERVER. Never put the Salt in a web page or an app.
$hash = hash_hmac('sha256', "$txnid|$amount|$productinfo|$email", $KEY . $SALT);`,
  Shell: `HASH=$(printf '%s' "$TXNID|$AMOUNT|$INFO|$EMAIL" | openssl dgst -sha256 -hmac "$KEY$SALT" | sed 's/^.*= //')`,
};

const CALLBACK: Record<Lang, string> = {
  "Node.js": `// Every field we POST except HASH, names sorted A to Z, as NAME=value joined with "~", then the Salt.
const { HASH, ...fields } = req.body;
const base = Object.keys(fields).sort().map((k) => \`\${k}=\${fields[k]}\`).join("~") + SALT;
const ok = crypto.createHash("sha256").update(base).digest("hex").toUpperCase() === HASH;`,
  Python: `fields = {k: v for k, v in request.form.items() if k != "HASH"}
base = "~".join(f"{k}={fields[k]}" for k in sorted(fields)) + SALT
ok = hashlib.sha256(base.encode()).hexdigest().upper() == request.form["HASH"]`,
  PHP: `<?php
$f = $_POST; $got = $f['HASH']; unset($f['HASH']); ksort($f, SORT_STRING);
$base = implode('~', array_map(fn($k) => "$k={$f[$k]}", array_keys($f))) . $SALT;
$ok = strtoupper(hash('sha256', $base)) === $got;`,
  Shell: `# Callbacks arrive at your server; check them there (Node.js, Python or PHP tabs).`,
};

function Code({ children }: { children: string }) {
  return (
    <div className="relative">
      <pre className="overflow-x-auto rounded-md border bg-[color:var(--color-surface-muted)] p-3 text-xs leading-relaxed"><code>{children}</code></pre>
      <button aria-label="Copy" onClick={() => { navigator.clipboard.writeText(children); toast.success("Copied"); }}
        className="absolute right-2 top-2 rounded-md border bg-[color:var(--color-surface)] p-1 opacity-70 hover:opacity-100"><Copy className="h-3 w-3" /></button>
    </div>
  );
}

function Step({ n, title, children }: { n: number; title: string; children: React.ReactNode }) {
  return (
    <li className="flex gap-3">
      <span className="mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-[color:var(--color-brand-muted)] text-xs font-semibold text-[color:var(--color-brand)]">{n}</span>
      <div className="min-w-0 flex-1 space-y-2 text-sm"><div className="font-medium">{title}</div>{children}</div>
    </li>
  );
}

export function DeveloperChecklist() {
  const [lang, setLang] = useState<Lang>("Node.js");
  const base = typeof window === "undefined" ? "https://katanapay.co" : window.location.origin;
  const c = (s: string) => <code className="rounded bg-[color:var(--color-surface-muted)] px-1 text-xs">{s}</code>;
  return (
    <Card className="mb-6">
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base"><ListChecks className="h-4 w-4" /> What your developer needs to build</CardTitle>
        <CardDescription>Six things, on your own server. Each banker&apos;s Starter Kit below has the exact address and a command to try for that banker.</CardDescription>
      </CardHeader>
      <CardContent>
        <div className="mb-4 flex flex-wrap gap-2">
          {LANGS.map((l) => (
            <Button key={l} size="sm" variant={l === lang ? "default" : "secondary"} onClick={() => setLang(l)}>{l}</Button>
          ))}
        </div>
        <ol className="space-y-5">
          <Step n={1} title="Keep the Key and Salt on your server">
            <p>Store them like a password, in your server&apos;s settings, never in a web page, an app or a public code repository. Our API does not accept calls from a browser, so the order must be created by your server.</p>
          </Step>
          <Step n={2} title="Sign each request">
            <p>The {c("hash")} is HMAC-SHA256 of {c("txnid|amount|productinfo|email")}, keyed with the Key and Salt joined together. Send the amount exactly as you signed it.</p>
            <Code>{SIGN[lang]}</Code>
          </Step>
          <Step n={3} title="Create the order and send the customer to pay">
            <p>POST {c(`${base}/api/v1/katana-pay/order`)} with {c("key")}, {c("txnid")}, {c("amount")}, {c("productinfo")}, {c("email")} and {c("hash")}. You get back {c("pay_url")}: send the customer there, or show {c("qr_payload")} as a QR. Sending the same {c("txnid")} again returns the same order, so a timeout is safe to retry.</p>
          </Step>
          <Step n={4} title="Receive the payment result">
            <p>We POST the result to your webhook URL (or the {c("notify_url")} you send with the order). Check its {c("HASH")} before trusting it, reply 200, and act on each order once: the same result can arrive more than once, and a Failed or Expired order can still turn Captured if the customer&apos;s payment lands late.</p>
            <Code>{CALLBACK[lang]}</Code>
            <p className="text-[color:var(--color-text-muted)]">Set the webhook URL and choose the callback version under <Link className="text-[color:var(--color-brand)] hover:underline" href="/merchant-portal/webhooks">Webhooks</Link>; it also sends test events.</p>
          </Step>
          <Step n={5} title="Check the status when in doubt">
            <p>If a result has not arrived, ask: {c(`GET ${base}/api/pay-status/{order.id}`)}. Use it as a backup, not instead of the webhook.</p>
          </Step>
          <Step n={6} title="Test, then go live">
            <p>With the test pair nothing real is charged: on the test pay page choose success or failure, or use amounts ending {c(".99")} (paid after a few seconds), {c(".13")} (failed) and {c(".11")} (expired). Test payouts: {c(".99")} succeeds at once, {c(".13")} fails. When everything works, request live mode; you then get a live Key + Salt (the Salt is shown once) and repeat one small real payment.</p>
          </Step>
        </ol>
      </CardContent>
    </Card>
  );
}
