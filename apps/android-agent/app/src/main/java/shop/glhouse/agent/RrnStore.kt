package shop.glhouse.agent

import android.content.Context
import android.util.Log

/** One captured Paytm transaction. Everything except [rrn] is best-effort. */
data class RrnRecord(
    val rrn: String,
    val capturedAt: Long,
    val amount: String,
    val payer: String,
    val upiId: String,
    val paidAt: String,
    val maskedRef: String,
)

/**
 * In-memory capture ledger for the accessibility engine. Tracks which RRNs / masked
 * references we've already handled (so the auto-sweep knows where "new" ends and a
 * duplicate isn't forwarded twice) and hands each fresh capture to [AlertUploader],
 * which posts it to the Katana orchestrator (/api/v1/txn-alert) tagged with the
 * merchant code. Dedup is best-effort/session-scoped — the server also dedups by UTR.
 */
object RrnStore {

    private const val TAG = "RRNCAP"
    private var appCtx: Context? = null
    private val writtenRrns = HashSet<String>()
    private val capturedMasked = HashSet<String>()

    fun init(context: Context) {
        appCtx = context.applicationContext
    }

    fun isMaskedCaptured(masked: String): Boolean = capturedMasked.contains(masked)

    /** @return true if newly recorded, false if a duplicate RRN. */
    fun record(rec: RrnRecord): Boolean {
        capturedMasked.add(rec.maskedRef)
        if (!writtenRrns.add(rec.rrn)) {
            Log.d(TAG, "duplicate RRN ${rec.rrn}, skipping")
            return false
        }
        Log.d(TAG, "captured RRN ${rec.rrn} amount=${rec.amount} payer=${rec.payer}")
        appCtx?.let { AlertUploader.sendCapture(it, rec) }
        return true
    }
}
