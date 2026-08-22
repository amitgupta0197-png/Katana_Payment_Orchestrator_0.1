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
    /** Everything else the detail screen stated about this payment. */
    val details: Map<String, String>? = null,
    /** UPI ID the money was credited TO, when the app showed it — see RrnAccessibilityService. */
    val payeeVpa: String? = null,
    /** When the payment happened, as the screen stated it (ISO-8601 with offset). */
    val eventTime: String? = null,
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
    // Set of "rowKey|capturedAtMillis". A rowKey is the payments-list row's own text (time,
    // amount, payer) — the only identity a payment has BEFORE it is opened. See isRowCaptured.
    private const val KEY_ROWS = "seen_rows"
    private const val RETAIN_MS = 30L * 24 * 60 * 60 * 1000   // keep 30 days

    private var appCtx: Context? = null
    private val writtenRrns = HashSet<String>()
    private val capturedMasked = HashSet<String>()
    private val capturedRows = HashSet<String>()
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
        capturedRows.addAll(fresh(sp(ctx).getStringSet(KEY_ROWS, null)))
        loaded = true
        Log.d(TAG, "ledger loaded: ${writtenRrns.size} rrns, ${capturedMasked.size} masked")
        // Rewrite with fresh timestamps stripped of expired entries.
        persist()
    }

    // Entries keep the timestamp they were FIRST written with. Stamping `now` on every entry at
    // every persist — which is what this did — silently defeated RETAIN_MS: each new capture
    // refreshed the whole set, so nothing ever aged out and the ledger grew without bound for the
    // life of the install. The 30-day prune in load() was dead code.
    @Synchronized
    private fun persist() {
        val ctx = appCtx ?: return
        val now = System.currentTimeMillis()
        fun stamped(values: Set<String>, key: String): Set<String> {
            val old = sp(ctx).getStringSet(key, null).orEmpty()
                .mapNotNull { e ->
                    val i = e.lastIndexOf('|')
                    if (i < 0) null else e.substring(0, i) to e.substring(i + 1)
                }.toMap()
            return values.map { "$it|${old[it] ?: now}" }.toSet()
        }
        sp(ctx).edit()
            .putStringSet(KEY_RRNS, stamped(writtenRrns, KEY_RRNS))
            .putStringSet(KEY_MASKED, stamped(capturedMasked, KEY_MASKED))
            .putStringSet(KEY_ROWS, stamped(capturedRows, KEY_ROWS))
            .apply()
    }

    fun isMaskedCaptured(masked: String): Boolean = capturedMasked.contains(masked)

    /**
     * HAS THIS LIST ROW ALREADY BEEN DEALT WITH? Answered WITHOUT opening it.
     *
     * A payment's masked reference only exists on its detail screen, so the sweep could only ever
     * discover "already captured" by opening the row — about 4.5 seconds of screen driving to
     * learn nothing. On a 478-row backfill that is the whole cost: nearly forty minutes, almost
     * all of it re-reading payments already held (2026-08-22).
     *
     * The row's own text — time, amount, payer — is identity enough to recognise it from the
     * list, and it is already computed as the sweep's dedupe key. Recording it on the way past
     * turns the second and every later sweep over the same day into a scan rather than a re-read.
     *
     * Shares the ledger's retention window, so a row key cannot outlive the RRN it stands for
     * and start hiding a payment that would otherwise be re-captured.
     */
    fun isRowCaptured(rowKey: String): Boolean = capturedRows.contains(rowKey)

    /** Remember that this list row resolved to a payment we hold. No-op for a blank key. */
    @Synchronized
    fun recordRow(rowKey: String?) {
        if (rowKey.isNullOrBlank()) return
        if (capturedRows.add(rowKey)) persist()
    }

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
        appCtx?.let { Prefs.noteCapture(it); AlertUploader.sendCapture(it, rec) }
        return true
    }
}
