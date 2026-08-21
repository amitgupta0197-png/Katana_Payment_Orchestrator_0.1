package shop.glhouse.agent

import android.app.Activity
import android.content.ClipboardManager
import android.content.Context
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.util.Log

/**
 * Invisible, one-shot activity whose only job is to read the clipboard while in
 * the foreground (the sole context Android 10+ permits) right after the service
 * copied an RRN, then hand it to [RrnStore] and vanish.
 *
 * Integrity check: the full clipboard value must match the masked reference the
 * service saw (same first 3 and last 6 digits). This rejects a stale clipboard
 * or a mis-fired copy, so we never store the wrong transaction's RRN.
 */
class ClipReaderActivity : Activity() {

    private val TAG = "RRNCAP"
    private val main = Handler(Looper.getMainLooper())
    private var attempts = 0

    companion object {
        // ~3s of polling. Paytm's Copy is near-instant when the phone is idle; under a burst of
        // back-to-back payments it is not, and the previous 1.2s budget was expiring before the
        // value arrived — silently, which is why it took a live 18-payment run to find.
        private const val MAX_READS = 20
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        overridePendingTransition(0, 0)
    }

    override fun onResume() {
        super.onResume()
        tryRead()
    }

    private fun tryRead() {
        val masked = intent.getStringExtra("masked") ?: run { done(); return }
        val full = readClipboard()
        if (full != null && matchesMask(full, masked)) {
            Prefs.bump(applicationContext, "capture_ok")
            RrnStore.record(
                RrnRecord(
                    rrn = full,
                    capturedAt = System.currentTimeMillis(),
                    amount = intent.getStringExtra("amount") ?: "",
                    payer = intent.getStringExtra("payer") ?: "",
                    upiId = intent.getStringExtra("upiId") ?: "",
                    paidAt = intent.getStringExtra("paidAt") ?: "",
                    maskedRef = masked,
                    // Everything the Paytm payment screen stated, snapshotted by the service before
                    // this activity took the foreground (which hides that screen from us).
                    details = parseDetails(intent.getStringExtra("details")),
                )
            )
            done()
            return
        }
        // Copy may not have landed yet; retry before giving up. The old budget was 8 × 150ms —
        // 1.2 seconds, which is generous on an idle phone and not nearly enough during a burst,
        // when the copy has to queue behind whatever the previous payment left running.
        if (attempts++ < MAX_READS) {
            main.postDelayed({ tryRead() }, 150)
        } else {
            // THE SILENT DROP THAT COST EIGHTEEN PAYMENTS. This branch used to log to logcat and
            // vanish: no counter, nothing sent, nothing on the dashboard. capture_try had already
            // been counted, capture_ok never was, capture_fail never was — so from the server a
            // phone losing every payment looked exactly like a phone with nothing to do. Four of
            // these in a row and RrnAccessibilityService abandons the payment for good.
            //
            // What the clipboard actually held is the whole diagnosis and it must travel: empty
            // means the Copy tap never landed, another payment's reference means the burst raced,
            // and a non-numeric value means Paytm's layout moved and we tapped the wrong control.
            Prefs.bump(applicationContext, "capture_noclip")
            val got = when {
                full == null -> "empty/non-numeric"
                else -> "a different reference"
            }
            AlertStore.log(applicationContext, "${nowTag()} ⚠️ copy did not reach the clipboard ($got)")
            if (!AlertStore.seenRecently(applicationContext, "noclip|$got")) {
                AlertUploader.sendAgentDebug(
                    applicationContext, "capture-noclip",
                    "the Copy tap fired but the clipboard never carried this payment's reference " +
                        "after ${MAX_READS * 150}ms — clipboard held $got",
                )
            }
            Log.w(TAG, "clipboard did not match masked=$masked (got=$full); giving up")
            done()
        }
    }

    private fun nowTag(): String =
        java.text.SimpleDateFormat("HH:mm:ss", java.util.Locale.US).format(java.util.Date())

    /** The service's JSON snapshot of the payment screen → the map stored with the capture. */
    private fun parseDetails(json: String?): Map<String, String>? {
        if (json.isNullOrBlank()) return null
        return runCatching {
            val o = org.json.JSONObject(json)
            val out = LinkedHashMap<String, String>()
            for (k in o.keys()) o.optString(k).takeIf { it.isNotBlank() }?.let { out[k] = it }
            out.ifEmpty { null }
        }.getOrNull()
    }

    private fun readClipboard(): String? {
        return runCatching {
            val cb = getSystemService(Context.CLIPBOARD_SERVICE) as ClipboardManager
            val clip = cb.primaryClip ?: return null
            if (clip.itemCount == 0) return null
            val raw = clip.getItemAt(0).coerceToText(this).toString().trim()
            Regex("\\d{12}").find(raw)?.value
        }.getOrNull()
    }

    /** full (12 digits) must share the masked value's visible prefix (3) and suffix (6). */
    private fun matchesMask(full: String, masked: String): Boolean {
        val m = Regex("(\\d{3})[.\\u2026]+(\\d{6})").find(masked) ?: return false
        val (pre, suf) = m.destructured
        return full.length == 12 && full.startsWith(pre) && full.endsWith(suf)
    }

    private fun done() {
        // THE PAYMENT IS FINISHED WITH HERE — captured or given up on. Saying so releases the
        // capture queue and leaves the payment screen immediately, instead of the engine waiting
        // out an eight-second deadline that assumed nothing would ever report completion. This is
        // the difference between draining a burst at about seven payments a minute and about
        // seventeen.
        RrnAccessibilityService.onPaytmCaptureDone(applicationContext)
        finish()
        overridePendingTransition(0, 0)
    }
}
