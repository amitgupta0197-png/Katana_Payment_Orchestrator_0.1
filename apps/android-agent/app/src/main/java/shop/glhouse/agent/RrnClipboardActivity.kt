package shop.glhouse.agent

import android.app.Activity
import android.content.ClipboardManager
import android.content.Context
import android.os.Bundle

// Invisible focused trampoline that reads the FULL RRN off the clipboard.
//
// Paytm Business masks the RRN on its receipt ("209…975768"); the full 12-digit value is
// only obtainable by tapping the receipt's "Copy" button — which puts it on the clipboard.
// Android 10+ only lets the FOCUSED app read the clipboard, so TxnAccessibilityService taps
// the Copy button and then launches THIS activity: it comes to the foreground for ~0.3s,
// reads the clipboard on window-focus, validates the value against the on-screen mask
// fingerprints, forwards it through our normal pipe (AlertUploader → glhouse.shop), then
// vanishes (~0.3s translucent blip).
class RrnClipboardActivity : Activity() {

    private var pendingCapture = false
    private var capAmount = 0.0
    private var capOrderRef: String? = null
    private var capPkg: String? = null
    private var capPayer: String? = null
    private var capHints: String? = null

    private companion object {
        val RRN = Regex("(?<![0-9])[0-9]{12}(?![0-9])")
        // RRNs already forwarded this process — the multi-Copy sweep blips this activity once
        // per Copy click, so guard against double-posting the same reference.
        val SENT = java.util.Collections.synchronizedSet(HashSet<String>())
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        overridePendingTransition(0, 0) // no launch animation → minimise the visible blip
        val i = intent
        if (i != null && i.getBooleanExtra("captureRrn", false)) {
            capAmount = i.getDoubleExtra("amount", 0.0)
            capOrderRef = i.getStringExtra("orderRef")
            capPkg = i.getStringExtra("pkg")
            capPayer = i.getStringExtra("payer")
            capHints = i.getStringExtra("hints")
            pendingCapture = true   // read + post in onWindowFocusChanged (needs focus)
            return
        }
        finish()
    }

    override fun onWindowFocusChanged(hasFocus: Boolean) {
        super.onWindowFocusChanged(hasFocus)
        if (!hasFocus || !pendingCapture) return
        pendingCapture = false
        val clip = readClip()
        val rrn = clip?.let { RRN.find(it)?.value }
        // Layout-agnostic guard: the sweep taps EVERY masked-value Copy, so the clipboard may
        // hold an Order-ID / Transaction-ID we don't want. Accept the 12-digit value only if it
        // matches one of the on-screen mask fingerprints ("lead|trail").
        val matches = rrn != null && matchesHint(rrn, capHints)
        AlertStore.log(applicationContext,
            "${nowTag()} 📋 clipboard RRN=${rrn ?: "none"} match=$matches")
        if (rrn != null && matches && capAmount > 0.0 && SENT.add(rrn)) {
            val key = "$capAmount|$rrn"
            if (!AlertStore.seenRecently(applicationContext, key)) {
                val txn = ParsedTxn(
                    amount = capAmount, utr = rrn, payerVpa = null, payerName = capPayer,
                    bank = "PAYTM", raw = "PAYTM masked-RRN copy=$rrn amt=$capAmount", orderRef = capOrderRef,
                )
                AlertUploader.send(applicationContext, txn, "ACCESSIBILITY", capPkg ?: "com.paytm.business")
            }
            // Tell the scraper we succeeded so its capture session stops retrying immediately.
            runCatching { TxnAccessibilityService.noteCaptured() }
        }
        finish()
    }

    // True if the 12-digit value starts+ends with one of the comma-joined "lead|trail" mask
    // fingerprints the receipt showed (e.g. "209|975768"). No hints → accept any (best effort).
    private fun matchesHint(rrn: String, hints: String?): Boolean {
        if (hints.isNullOrEmpty()) return true
        for (h in hints.split(",")) {
            val bar = h.indexOf('|')
            if (bar <= 0) continue
            val lead = h.substring(0, bar)
            val trail = h.substring(bar + 1)
            if (rrn.startsWith(lead) && rrn.endsWith(trail)) return true
        }
        return false
    }

    private fun readClip(): String? = try {
        val cm = getSystemService(Context.CLIPBOARD_SERVICE) as ClipboardManager
        val c = cm.primaryClip
        if (c != null && c.itemCount > 0) c.getItemAt(0).text?.toString() else null
    } catch (e: Exception) { null }

    private fun nowTag(): String =
        java.text.SimpleDateFormat("HH:mm:ss", java.util.Locale.US).format(java.util.Date())
}
