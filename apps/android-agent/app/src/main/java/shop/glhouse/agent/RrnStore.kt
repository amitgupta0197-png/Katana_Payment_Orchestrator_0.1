package shop.glhouse.agent

import android.content.Context
import android.util.Log

/** One captured transaction. Everything except [rrn] is best-effort. */
data class RrnRecord(
    val rrn: String,
    val capturedAt: Long,
    val amount: String,
    val payer: String,
    val upiId: String,
    val paidAt: String,
    val maskedRef: String,
    val bank: String = "PAYTM",   // "PAYTM" (masked/copy) or "AIRTEL" (read full off screen)
)

/**
 * Capture ledger for the accessibility engine. Tracks which RRNs / masked references
 * we've already handled (so the auto-sweep knows where "new" ends and a duplicate isn't
 * forwarded twice) and hands each fresh capture to [AlertUploader], which posts it to
 * the Katana orchestrator (/api/v1/txn-alert) tagged with the merchant code.
 *
 * PERSISTENT (v2.33): the seen-set is written to SharedPreferences so it survives the
 * process being killed/restarted. Before this, the set was in-memory only, so every
 * restart re-uploaded the entire visible reports list — the root cause of the duplicate
 * floods. Entries older than [RETAIN_MS] are pruned on load so the store stays bounded.
 * The server still dedups by RRN as a backstop.
 */
object RrnStore {

    private const val TAG = "RRNCAP"
    private const val PREF = "rrn_ledger"
    private const val KEY_RRNS = "seen_rrns"        // set of "rrn|capturedAtMillis"
    private const val KEY_MASKED = "seen_masked"    // set of "masked|capturedAtMillis"
    private const val RETAIN_MS = 30L * 24 * 60 * 60 * 1000   // keep 30 days

    private var appCtx: Context? = null
    private val writtenRrns = HashSet<String>()
    private val capturedMasked = HashSet<String>()
    private var loaded = false

    fun init(context: Context) {
        appCtx = context.applicationContext
        load()
    }

    private fun sp(ctx: Context) = ctx.getSharedPreferences(PREF, Context.MODE_PRIVATE)

    // Load persisted sets, dropping entries older than RETAIN_MS (keeps the store from
    // growing without bound). Stored as "value|timestamp"; we keep only the value in memory.
    @Synchronized
    private fun load() {
        if (loaded) return
        val ctx = appCtx ?: return
        val cutoff = System.currentTimeMillis() - RETAIN_MS
        fun fresh(raw: Set<String>?): Set<String> =
            raw.orEmpty().mapNotNull { e ->
                val i = e.lastIndexOf('|')
                if (i < 0) return@mapNotNull e            // legacy entry, no timestamp — keep
                val ts = e.substring(i + 1).toLongOrNull() ?: return@mapNotNull e
                if (ts >= cutoff) e.substring(0, i) else null
            }.toSet()
        writtenRrns.addAll(fresh(sp(ctx).getStringSet(KEY_RRNS, null)))
        capturedMasked.addAll(fresh(sp(ctx).getStringSet(KEY_MASKED, null)))
        loaded = true
        Log.d(TAG, "ledger loaded: ${writtenRrns.size} rrns, ${capturedMasked.size} masked")
        // Rewrite with fresh timestamps stripped of expired entries.
        persist()
    }

    @Synchronized
    private fun persist() {
        val ctx = appCtx ?: return
        val now = System.currentTimeMillis()
        sp(ctx).edit()
            .putStringSet(KEY_RRNS, writtenRrns.map { "$it|$now" }.toSet())
            .putStringSet(KEY_MASKED, capturedMasked.map { "$it|$now" }.toSet())
            .apply()
    }

    fun isMaskedCaptured(masked: String): Boolean = capturedMasked.contains(masked)

    /** @return true if newly recorded, false if a duplicate RRN. */
    @Synchronized
    fun record(rec: RrnRecord): Boolean {
        val maskedNew = capturedMasked.add(rec.maskedRef)
        if (!writtenRrns.add(rec.rrn)) {
            if (maskedNew) persist()   // still note the masked ref we just saw
            Log.d(TAG, "duplicate RRN ${rec.rrn}, skipping")
            return false
        }
        persist()
        Log.d(TAG, "captured RRN ${rec.rrn} amount=${rec.amount} payer=${rec.payer}")
        appCtx?.let { AlertUploader.sendCapture(it, rec) }
        return true
    }
}
