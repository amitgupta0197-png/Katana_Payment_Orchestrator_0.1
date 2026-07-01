package shop.glhouse.agent

import kotlin.math.abs

// Short-lived record of "a payment notification just arrived for ₹X". The notification
// carries the amount+payer but not the RRN; the Accessibility screen-reader carries the
// RRN. This holder lets the screen-reader confirm the RRN it scraped belongs to a REAL
// incoming payment (amount matches within a small window) rather than a transaction the
// user is merely browsing. In-memory only — a restart simply clears expectations.
object PendingCredit {
    private data class Item(val amount: Double, val payer: String?, val ts: Long)

    private const val WINDOW_MS = 120_000L      // a screen scrape must follow within 2 min
    private const val EPSILON = 0.01            // paise-level amount match
    private val items = ArrayList<Item>()

    // Notification listener calls this the moment it sees a credit.
    @Synchronized
    fun mark(amount: Double, payer: String?) {
        prune()
        items.add(Item(amount, payer, System.currentTimeMillis()))
    }

    // Accessibility service calls this before forwarding a scraped RRN.
    @Synchronized
    fun matches(amount: Double): Boolean {
        prune()
        return items.any { abs(it.amount - amount) < EPSILON }
    }

    // Amounts of payments that arrived recently (newest first) — used to drive the
    // auto-tap: after a payment lands, open the matching transaction row so the RRN
    // screen appears on its own.
    @Synchronized
    fun pendingAmounts(): List<Double> {
        prune()
        return items.sortedByDescending { it.ts }.map { it.amount }
    }

    private fun prune() {
        val now = System.currentTimeMillis()
        items.removeAll { now - it.ts > WINDOW_MS }
    }
}
