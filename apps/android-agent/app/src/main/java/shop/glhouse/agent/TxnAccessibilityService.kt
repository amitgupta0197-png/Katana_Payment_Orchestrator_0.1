package shop.glhouse.agent

import android.accessibilityservice.AccessibilityService
import android.graphics.Rect
import android.view.accessibility.AccessibilityEvent
import android.view.accessibility.AccessibilityNodeInfo

// Screen-reader capture: pulls the full RRN off the Paytm Business transaction-detail
// screen. Paytm renders the RRN with ellipsize=middle ("780...028908"), but the
// underlying accessibility node text carries the FULL 12-digit value — confirmed on
// device (fullRRN=YES). So a plain text read is enough; no clipboard automation needed.
//
// The detail screen is NOT a "credit alert" (it has no "received/credited" wording), so
// we do NOT reuse the SMS/notification credit parser here — we extract amount + RRN
// directly. Package confirmed: com.paytm.business (we still match any "paytm" package
// for safety / future rebrands).
class TxnAccessibilityService : AccessibilityService() {

    private var lastRootHash = 0
    private var lastScanAt = 0L
    private var loggedPkg = false

    private companion object {
        const val MIN_SCAN_GAP_MS = 700L
        const val MAX_NODES = 4000
        const val AUTO_TAP_COOLDOWN_MS = 15000L
        // Labelled RRN: "RRN … 686785270871" (allow the info-icon / spacing between).
        val RRN_LABELLED = Regex("(?:rrn|utr|upi\\s*ref(?:\\s*no)?)[^0-9]{0,24}([0-9]{12})", RegexOption.IGNORE_CASE)
        // Fallback: a bare 12-digit run (UPI RRN length). The detail screen has exactly
        // one such run (the RRN); the masked Transaction/Order IDs never form 12 digits.
        val RRN_BARE = Regex("\\b([0-9]{12})\\b")
        val AMOUNT = Regex("(?:₹|rs\\.?|inr)\\s*([0-9][0-9,]*(?:\\.[0-9]{1,2})?)", RegexOption.IGNORE_CASE)
        // Bare number + amount labels — Paytm renders the ₹ as an image, so the value
        // shows as "100" with no currency token; we anchor on the label instead.
        val NUM = Regex("([0-9][0-9,]*(?:\\.[0-9]{1,2})?)")
        val AMOUNT_LABELS = listOf("Payment Amount", "Amount Paid", "Amount received",
            "Amount to be settled", "Total Amount", "Amount", "Paid")
        // Payer name on the detail screen: "From Mr K B D" (masked initials, best-effort).
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

        val root = rootInActiveWindow ?: return
        val text = try { dumpText(root) } finally { root.recycle() }
        if (text.isBlank()) return

        val hash = text.hashCode()
        if (hash == lastRootHash) return
        lastRootHash = hash
        lastScanAt = now

        // Not the detail screen? If a payment just arrived (pending credit) and we're
        // on a Paytm list/home screen, auto-open the matching transaction so its RRN
        // screen appears on its own — the hands-free path for high volume.
        val isDetail = text.contains("RRN", ignoreCase = true) || text.contains("Transaction ID", ignoreCase = true)
        if (!isDetail) {
            maybeAutoOpenRow()
            return
        }

        val rrn = (RRN_LABELLED.find(text)?.groupValues?.get(1)) ?: RRN_BARE.find(text)?.groupValues?.get(1)
        if (rrn == null) {
            AlertStore.log(applicationContext, "${nowTag()} 🔎 detail-screen: RRN not readable")
            return
        }
        val amount = extractAmount(text)
        if (amount == null || amount <= 0.0) {
            AlertStore.log(applicationContext, "${nowTag()} 🔎 RRN $rrn but amount unreadable")
            return
        }

        // Dedup: same amount+RRN within the store's window is forwarded once.
        val key = "$amount|$rrn"
        if (AlertStore.seenRecently(applicationContext, key)) return

        val payer = extractPayer(text)
        val txn = ParsedTxn(amount = amount, utr = rrn, payerVpa = null, payerName = payer, bank = "PAYTM",
            raw = "PAYTM detail RRN=$rrn amt=$amount")
        AlertUploader.send(applicationContext, txn, "ACCESSIBILITY", pkg)
    }

    override fun onInterrupt() { /* no-op */ }

    // Once-per-amount guard so we don't tap the same row repeatedly (the list screen
    // fires many content-changed events).
    private val tappedAt = HashMap<String, Long>()

    // On a Paytm list/home screen right after a payment: find the transaction row whose
    // amount matches the just-arrived credit and tap it to open its detail (RRN) screen.
    // Gated by PendingCredit so it only navigates in response to a real payment.
    private fun maybeAutoOpenRow() {
        val amounts = PendingCredit.pendingAmounts()
        if (amounts.isEmpty()) return
        val now = System.currentTimeMillis()
        val root = rootInActiveWindow ?: return
        for (amt in amounts) {
            val key = amt.toString()
            if (now - (tappedAt[key] ?: 0L) < AUTO_TAP_COOLDOWN_MS) continue
            val row = findClickableRowForAmount(root, amt) ?: continue
            tappedAt[key] = now
            val ok = row.performAction(AccessibilityNodeInfo.ACTION_CLICK)
            AlertStore.log(applicationContext, "${nowTag()} ↳ auto-open ₹$amt ${if (ok) "tapped" else "tap-failed"}")
            return   // one tap per pass; the detail screen it opens triggers the capture
        }
    }

    // Find the clickable row (topmost = newest) whose subtree shows this ₹ amount.
    private fun findClickableRowForAmount(root: AccessibilityNodeInfo, amount: Double): AccessibilityNodeInfo? {
        val whole = amount == Math.floor(amount) && !amount.isInfinite()
        val amtStr = if (whole) amount.toLong().toString() else amount.toString()
        // amount with digit boundaries so ₹100 doesn't match inside ₹1000.
        val amtRx = Regex("(?<![0-9.])" + Regex.escape(amtStr) + "(?![0-9])")

        var best: AccessibilityNodeInfo? = null
        var bestTop = Int.MAX_VALUE
        var bestH = Int.MAX_VALUE
        var count = 0
        val stack = ArrayDeque<AccessibilityNodeInfo>()
        stack.addLast(root)
        val rect = Rect()
        while (stack.isNotEmpty() && count < MAX_NODES) {
            val node = stack.removeLast(); count++
            if (node.isClickable) {
                val sub = subtreeText(node)
                if (sub.contains("₹") && amtRx.containsMatchIn(sub)) {
                    node.getBoundsInScreen(rect)
                    val top = rect.top; val h = rect.height()
                    if (top < bestTop || (top == bestTop && h < bestH)) { best = node; bestTop = top; bestH = h }
                }
            }
            for (i in 0 until node.childCount) node.getChild(i)?.let { stack.addLast(it) }
        }
        return best
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

    private fun extractAmount(text: String): Double? {
        // 1) A payment the notification just saw (most reliable when available).
        PendingCredit.pendingAmounts().firstOrNull()?.let { if (it > 0) return it }
        // 2) A currency-tagged amount (₹/Rs/INR) anywhere.
        for (m in AMOUNT.findAll(text)) {
            val v = m.groupValues[1].replace(",", "").toDoubleOrNull()
            if (v != null && v > 0) return v
        }
        // 3) The number after an amount LABEL — Paytm draws the ₹ as an image, so the
        //    value shows as bare "100" with no currency token. Anchor on the label.
        for (label in AMOUNT_LABELS) {
            val idx = text.indexOf(label, ignoreCase = true)
            if (idx < 0) continue
            val start = idx + label.length
            val window = text.substring(start, minOf(text.length, start + 40))
            NUM.find(window)?.groupValues?.get(1)?.replace(",", "")?.toDoubleOrNull()
                ?.let { if (it > 0) return it }
        }
        return null
    }

    private fun extractPayer(text: String): String? {
        val m = PAYER.find(text) ?: return null
        val title = m.groupValues[1].trim()
        val core = m.groupValues[2].trim()
        if (core.isEmpty() || core.contains("@")) return null
        val name = (if (title.isNotEmpty()) "$title $core" else core).replace(Regex("\\s+"), " ").trim()
        return if (name.length < 3) null else name.take(120)
    }

    private fun dumpText(root: AccessibilityNodeInfo): String {
        val sb = StringBuilder()
        var count = 0
        val stack = ArrayDeque<AccessibilityNodeInfo>()
        stack.addLast(root)
        while (stack.isNotEmpty() && count < MAX_NODES) {
            val node = stack.removeLast()
            count++
            node.text?.let { if (it.isNotBlank()) sb.append(it).append(' ') }
            node.contentDescription?.let { if (it.isNotBlank()) sb.append(it).append(' ') }
            for (i in 0 until node.childCount) node.getChild(i)?.let { stack.addLast(it) }
            if (node !== root) node.recycle()
        }
        return sb.toString()
    }

    private fun nowTag(): String =
        java.text.SimpleDateFormat("HH:mm:ss", java.util.Locale.US).format(java.util.Date())
}
