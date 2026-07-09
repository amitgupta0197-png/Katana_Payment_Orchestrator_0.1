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
            RrnStore.record(
                RrnRecord(
                    rrn = full,
                    capturedAt = System.currentTimeMillis(),
                    amount = intent.getStringExtra("amount") ?: "",
                    payer = intent.getStringExtra("payer") ?: "",
                    upiId = intent.getStringExtra("upiId") ?: "",
                    paidAt = intent.getStringExtra("paidAt") ?: "",
                    maskedRef = masked
                )
            )
            done()
            return
        }
        // Copy JS may not have landed yet; retry briefly before giving up.
        if (attempts++ < 8) {
            main.postDelayed({ tryRead() }, 150)
        } else {
            Log.w(TAG, "clipboard did not match masked=$masked (got=$full); giving up")
            done()
        }
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
        finish()
        overridePendingTransition(0, 0)
    }
}
