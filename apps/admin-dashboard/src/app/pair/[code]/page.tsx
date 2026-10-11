// /pair/{code}: what the pairing QR opens. On a phone with the Katana Agent, Android opens the
// agent directly (App Link, public/.well-known/assetlinks.json) and this page is never seen. Without
// it, the page says how to install the agent and shows the code to type in. Public; shows nothing
// about the banker.

import { normalisePairCode, showPairCode } from "@/lib/agent-pair";

export const dynamic = "force-dynamic";

export default async function PairPage({ params }: { params: Promise<{ code: string }> }) {
  const code = normalisePairCode((await params).code);
  return (
    <main style={{ fontFamily: "system-ui, sans-serif", maxWidth: 420, margin: "48px auto", padding: "0 20px", color: "#0f172a" }}>
      <h1 style={{ fontSize: 24, marginBottom: 8 }}>Pair this phone with Katana</h1>
      {code ? (<>
        <p style={{ color: "#475569", lineHeight: 1.5 }}>
          Open the <b>Katana Agent</b> app on this phone, tap <b>Pair with a code</b> and enter:
        </p>
        <div style={{ fontSize: 34, letterSpacing: 4, fontWeight: 700, background: "#f1f5f9", borderRadius: 12, padding: "16px 0", textAlign: "center", margin: "16px 0" }}>
          {showPairCode(code)}
        </div>
        <p style={{ color: "#475569", lineHeight: 1.5 }}>The code works once, for 15 minutes.</p>
      </>) : <p style={{ color: "#b91c1c" }}>This pairing link isn&apos;t valid. Ask for a new one.</p>}
      <p style={{ color: "#475569", lineHeight: 1.5, marginTop: 24 }}>
        No Katana Agent yet? <a href="/katana-agent.apk" style={{ color: "#1d4ed8", fontWeight: 600 }}>Download it</a>, install it,
        then scan the QR again.
      </p>
    </main>
  );
}
