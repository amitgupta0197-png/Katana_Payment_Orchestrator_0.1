package shop.glhouse.agent

import android.accessibilityservice.AccessibilityService
import android.os.Handler
import android.os.Looper
import android.view.accessibility.AccessibilityEvent
import android.view.accessibility.AccessibilityNodeInfo

// Screen-reader RRN capture for Paytm Business with a notification-independent
// auto-sweep. Paytm does not reliably post a payment notification, so instead of
// waiting for one we WATCH the payments list: when a new transaction row appears we
// auto-open it, read the full RRN off the detail screen (Paytm ellipsize=middle hides
// it visually but the node text carries the full 12-digit value), then go back — fully
// hands-free as long as Paytm Business is left open on the payments list.
//
// Manual capture still works too: opening any transaction detail screen forwards its
// RRN regardless of the auto-sweep. Package: com.paytm.business.
class TxnAccessibilityService : AccessibilityService() {

    private val main = Handler(Looper.getMainLooper())
    private var lastScanAt = 0L
    private var lastDetailHash = 0
    private var loggedPkg = false

    // Auto-sweep state.
    private val seenRows = LinkedHashSet<String>()   // transaction rows already handled
    private var baselined = false                    // ignore the backlog present on first sight
    private var lastTapAt = 0L
    private var autoOpenedDetail = false             // we opened this detail (so we may go back)

    private companion object {
        const val MIN_SCAN_GAP_MS = 600L
        const val TAP_COOLDOWN_MS = 2500L            // pace row taps so navigation settles
        const val MAX_NODES = 4000
        const val MAX_SEEN = 600
        val RRN_LABELLED = Regex("(?:rrn|utr|upi\\s*ref(?:\\s*no)?)[^0-9]{0,24}([0-9]{12})", RegexOption.IGNORE_CASE)
        val RRN_BARE = Regex("\\b([0-9]{12})\\b")
        val AMOUNT = Regex("(?:₹|rs\\.?|inr)\\s*([0-9][0-9,]*(?:\\.[0-9]{1,2})?)", RegexOption.IGNORE_CASE)
        val NUM = Regex("([0-9][0-9,]*(?:\\.[0-9]{1,2})?)")
        val AMOUNT_LABELS = listOf("Payment Amount", "Amount Paid", "Amount received",
            "Amount to be settled", "Total Amount", "Amount", "Paid")
        // A payments-list row carries a clock time — used to tell rows from buttons.
        val ROW_TIME = Regex("\\b\\d{1,2}:\\d{2}\\s*[AP]M\\b", RegexOption.IGNORE_CASE)
        val PAYER = Regex("\\bfrom\\s+((?:mr|mrs|ms|dr|m/s)\\.?\\s+)?([a-z][a-z .&'-]{1,40}?)(?=\\s*(?:paid|using|via|·|\\||,|$))", RegexOption.IGNORE_CASE)
    }

    override fun onAccessibilityEvent(event: AccessibilityEvent?) {
        if (event == null) return
        if (!Prefs.enabled(applicationContext)) return
        val pkg = event.packageName?.toString() ?: return
        if (!pkg.contains("paytm", ignoreCase = true)) return

        if (!loggedPkg) {
            loggedPkg = true
            AlertStore.log(applicationContext, "${nowTag()} 👁 screen-reader active on $pkg")
        }

        val now = System.currentTimeMillis()
        if (now - lastScanAt < MIN_SCAN_GAP_MS) return
        lastScanAt = now

        val root = rootInActiveWindow ?: return
        val text = dumpText(root)
        if (text.isBlank()) return

        val isDetail = text.contains("RRN", ignoreCase = true) || text.contains("Transaction ID", ignoreCase = true)

        if (isDetail) {
            // De-dup identical detail screens so we don't re-send on every content event.
            val h = text.hashCode()
            if (h != lastDetailHash) {
                lastDetailHash = h
                captureDetail(text, pkg)
            }
            // If WE opened this via the sweep, return to the list to pick up the next row.
            if (autoOpenedDetail && Prefs.autoOpen(applicationContext)) {
                autoOpenedDetail = false
                main.postDelayed({ try { performGlobalAction(GLOBAL_ACTION_BACK) } catch (e: Exception) {} }, 900)
            }
            return
        }

        // List / home screen — auto-sweep only when enabled ("Auto-capture" toggle).
        if (Prefs.autoOpen(applicationContext)) sweepList(root)
    }

    override fun onInterrupt() { /* no-op */ }

    // Read amount + RRN off a transaction-detail screen and forward it.
    private fun captureDetail(text: String, pkg: String) {
        val rrn = RRN_LABELLED.find(text)?.groupValues?.get(1) ?: RRN_BARE.find(text)?.groupValues?.get(1) ?: return
        val amount = extractAmount(text)
        if (amount == null || amount <= 0.0) {
            AlertStore.log(applicationContext, "${nowTag()} 🔎 RRN $rrn but amount unreadable")
            return
        }
        val key = "$amount|$rrn"
        if (AlertStore.seenRecently(applicationContext, key)) return
        val payer = extractPayer(text)
        val txn = ParsedTxn(amount = amount, utr = rrn, payerVpa = null, payerName = payer, bank = "PAYTM",
            raw = "PAYTM detail RRN=$rrn amt=$amount")
        AlertUploader.send(applicationContext, txn, "ACCESSIBILITY", pkg)
    }

    // Watch the payments list; open the newest not-yet-handled transaction.
    private fun sweepList(root: AccessibilityNodeInfo) {
        val rows = findPaymentRows(root)
        if (rows.isEmpty()) return

        if (!baselined) {
            // First sight: treat the existing backlog as already-seen so we only capture
            // transactions that arrive from now on (email backfills anything older).
            rows.forEach { seenRows.add(it.first) }
            capSeen()
            baselined = true
            AlertStore.log(applicationContext, "${nowTag()} 👀 auto-capture watching — ${rows.size} existing skipped")
            return
        }

        val target = rows.firstOrNull { it.first !in seenRows } ?: return   // topmost new row
        val now = System.currentTimeMillis()
        if (now - lastTapAt < TAP_COOLDOWN_MS) return
        lastTapAt = now
        seenRows.add(target.first); capSeen()
        autoOpenedDetail = true
        val ok = target.second.performAction(AccessibilityNodeInfo.ACTION_CLICK)
        AlertStore.log(applicationContext, "${nowTag()} ↳ auto-capture ${if (ok) "opening" else "tap-failed"}: ${target.first.take(46)}")
    }

    // Clickable rows that look like a transaction (carry a clock time + an amount),
    // sorted top-to-bottom (newest first). Key = the row's normalised text.
    private fun findPaymentRows(root: AccessibilityNodeInfo): List<Pair<String, AccessibilityNodeInfo>> {
        val out = ArrayList<Triple<String, AccessibilityNodeInfo, Int>>()
        val seenKeys = HashSet<String>()
        val rect = android.graphics.Rect()
        var count = 0
        val stack = ArrayDeque<AccessibilityNodeInfo>()
        stack.addLast(root)
        while (stack.isNotEmpty() && count < MAX_NODES) {
            val node = stack.removeLast(); count++
            if (node.isClickable) {
                val sub = subtreeText(node).trim().replace(Regex("\\s+"), " ")
                if (sub.isNotEmpty() && ROW_TIME.containsMatchIn(sub) &&
                    (sub.contains("₹") || NUM.containsMatchIn(sub)) && seenKeys.add(sub)) {
                    node.getBoundsInScreen(rect)
                    out.add(Triple(sub, node, rect.top))
                }
            }
            for (i in 0 until node.childCount) node.getChild(i)?.let { stack.addLast(it) }
        }
        return out.sortedBy { it.third }.map { Pair(it.first, it.second) }
    }

    private fun extractAmount(text: String): Double? {
        for (m in AMOUNT.findAll(text)) {
            val v = m.groupValues[1].replace(",", "").toDoubleOrNull()
            if (v != null && v > 0) return v
        }
        for (label in AMOUNT_LABELS) {
            val idx = text.indexOf(label, ignoreCase = true)
            if (idx < 0) continue
            val start = idx + label.length
            val window = text.substring(start, minOf(text.length, start + 40))
            NUM.find(window)?.groupValues?.get(1)?.replace(",", "")?.toDoubleOrNull()?.let { if (it > 0) return it }
        }
        return null
    }

    private fun extractPayer(text: String): String? {
        val m = PAYER.find(text) ?: return null
        val core = m.groupValues[2].trim()
        if (core.isEmpty() || core.contains("@")) return null
        val name = ((m.groupValues[1].trim() + " " + core)).replace(Regex("\\s+"), " ").trim()
        return if (name.length < 3) null else name.take(120)
    }

    private fun capSeen() {
        while (seenRows.size > MAX_SEEN) {
            val it = seenRows.iterator(); if (it.hasNext()) { it.next(); it.remove() } else break
        }
    }

    private fun dumpText(root: AccessibilityNodeInfo): String {
        val sb = StringBuilder()
        var count = 0
        val stack = ArrayDeque<AccessibilityNodeInfo>()
        stack.addLast(root)
        while (stack.isNotEmpty() && count < MAX_NODES) {
            val node = stack.removeLast(); count++
            node.text?.let { if (it.isNotBlank()) sb.append(it).append(' ') }
            node.contentDescription?.let { if (it.isNotBlank()) sb.append(it).append(' ') }
            for (i in 0 until node.childCount) node.getChild(i)?.let { stack.addLast(it) }
        }
        return sb.toString()
    }

    private fun subtreeText(node: AccessibilityNodeInfo): String {
        val sb = StringBuilder()
        var count = 0
        val stack = ArrayDeque<AccessibilityNodeInfo>()
        stack.addLast(node)
        while (stack.isNotEmpty() && count < 400) {
            val n = stack.removeLast(); count++
            n.text?.let { if (it.isNotBlank()) sb.append(it).append(' ') }
            n.contentDescription?.let { if (it.isNotBlank()) sb.append(it).append(' ') }
            for (i in 0 until n.childCount) n.getChild(i)?.let { stack.addLast(it) }
        }
        return sb.toString()
    }

    private fun nowTag(): String =
        java.text.SimpleDateFormat("HH:mm:ss", java.util.Locale.US).format(java.util.Date())
}
