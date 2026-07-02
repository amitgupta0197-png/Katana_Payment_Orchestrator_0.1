package shop.glhouse.agent

import android.accessibilityservice.AccessibilityService
import android.accessibilityservice.GestureDescription
import android.graphics.Path
import android.graphics.Rect
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
    private var lastStatKey = ""                     // throttle the list-scan diagnostic
    private var lastScreen = "other"                 // other | list | detail — sweep state
    private var blindIndex = 0                       // next fixed position to blind-tap
    private var positions: List<Double> = emptyList() // tuned row tap positions (from Prefs)

    private companion object {
        const val MIN_SCAN_GAP_MS = 600L
        const val TAP_COOLDOWN_MS = 2500L            // pace row taps so navigation settles
        const val MAX_NODES = 4000
        const val MAX_SEEN = 600
        val RRN_LABELLED = Regex("(?:rrn|utr|upi\\s*ref(?:\\s*no)?)[^0-9]{0,24}([0-9]{12})", RegexOption.IGNORE_CASE)
        val RRN_BARE = Regex("\\b([0-9]{12})\\b")
        // Full Order ID after the "Order ID" label (only matches when Paytm renders the
        // full value in node text, not a masked "T26…749211" stub) — a unique merge key.
        val ORDER_ID = Regex("order\\s*id[:\\s#]*([A-Za-z0-9][A-Za-z0-9-]{9,39})", RegexOption.IGNORE_CASE)
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
        val text = dumpText(root)   // may be blank/sparse — Paytm's list is an opaque surface

        // Debug: upload the full node tree of each distinct Paytm screen while armed.
        if (System.currentTimeMillis() < Prefs.debugDumpUntil(applicationContext)) maybeDumpTree(root, text)

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

        // Not the detail screen. Auto-sweep only when enabled ("Auto-capture" toggle).
        if (!Prefs.autoOpen(applicationContext)) { lastScreen = "other"; return }

        // Decide if this is the payments list. The list is opaque, so its text is blank/
        // sparse; a rich, readable Paytm screen WITHOUT list markers is the home/menu and
        // is skipped (so we don't blind-tap random chrome). Opaque/sparse ⇒ treat as list.
        val looksList = isPaytmList(text) || text.length < 40
        if (!looksList) { lastScreen = "other"; return }

        // Fresh entry to the list (came from home) → start a new self-driving sweep pass.
        // Returning from a detail (lastScreen=="detail") continues the running pass.
        val fresh = (lastScreen == "other")
        lastScreen = "list"
        if (fresh) {
            blindIndex = 0
            positions = Prefs.rowPositions(applicationContext)   // snapshot the tuned taps
            AlertStore.log(applicationContext, "${nowTag()} 👀 on payments list — sweeping ${positions.size} rows")
            main.removeCallbacks(sweepTick)
            main.postDelayed(sweepTick, 600)
        }
    }

    // Self-driving blind sweep: taps each fixed row position in turn on a timer (doesn't
    // depend on sparse accessibility events). Pauses while a detail screen is open (that's
    // captured + backed out by onAccessibilityEvent), then resumes on the list.
    private val sweepTick = object : Runnable {
        override fun run() {
            if (!Prefs.enabled(applicationContext) || !Prefs.autoOpen(applicationContext)) return
            when (lastScreen) {
                "detail" -> main.postDelayed(this, 700)        // capture+back in progress; wait
                "list" -> {
                    if (blindIndex >= positions.size) return   // pass complete; re-enter list to redo
                    val (w, h) = realSize()
                    val x = w / 2
                    val y = (h * positions[blindIndex]).toInt()
                    autoOpenedDetail = true
                    val method = if (ShizukuTap.granted()) "shell" else "gesture"
                    val ok = tapAt(x, y)
                    AlertStore.log(applicationContext, "${nowTag()} ↳ blind tap ${blindIndex + 1}/${positions.size} @$x,$y [$method]${if (ok) "" else " failed"}")
                    blindIndex++
                    main.postDelayed(this, TAP_COOLDOWN_MS)
                }
                else -> return                                 // left the list → stop
            }
        }
    }

    // Full physical display size (INCLUDING system bars) — the coordinate space that
    // dispatchGesture taps use. resources.displayMetrics excludes the nav bar and made
    // taps land too high.
    private fun realSize(): Pair<Int, Int> {
        val wm = getSystemService(WINDOW_SERVICE) as android.view.WindowManager
        return if (android.os.Build.VERSION.SDK_INT >= android.os.Build.VERSION_CODES.R) {
            val b = wm.currentWindowMetrics.bounds
            Pair(b.width(), b.height())
        } else {
            val dm = android.util.DisplayMetrics()
            @Suppress("DEPRECATION") wm.defaultDisplay.getRealMetrics(dm)
            Pair(dm.widthPixels, dm.heightPixels)
        }
    }

    // Detect the Paytm payments list by its (readable) header text.
    private fun isPaytmList(text: String): Boolean =
        text.contains("Bank Settlement", ignoreCase = true) ||
            (text.contains("Payment", ignoreCase = true) &&
                (text.contains("Total", ignoreCase = true) || text.contains("Today", ignoreCase = true)))

    override fun onInterrupt() { /* no-op */ }

    private val dumpedHashes = HashSet<Int>()

    // Upload the full accessibility tree of a distinct Paytm screen (text + view-id +
    // class + bounds + flags) so the real structure can be inspected — especially the
    // list, to find a stable per-row selector instead of blind coordinate taps.
    private fun maybeDumpTree(root: AccessibilityNodeInfo, text: String) {
        val h = text.hashCode() * 31 + root.childCount
        if (!dumpedHashes.add(h)) return
        val label = when {
            text.contains("RRN", true) || text.contains("Transaction ID", true) -> "detail"
            isPaytmList(text) -> "list"
            else -> "other"
        }
        val sb = StringBuilder()
        dumpTree(root, sb, 0, intArrayOf(0))
        AlertUploader.uploadDebugTree(applicationContext, label, sb.toString().take(16000))
        AlertStore.log(applicationContext, "${nowTag()} 🧪 debug tree uploaded ($label)")
    }

    private fun dumpTree(node: AccessibilityNodeInfo, sb: StringBuilder, depth: Int, count: IntArray) {
        if (count[0] >= 1500) return
        count[0]++
        val rect = Rect(); node.getBoundsInScreen(rect)
        val cls = (node.className ?: "").toString().substringAfterLast('.')
        val id = (node.viewIdResourceName ?: "").substringAfterLast('/')
        val txt = (node.text ?: "").toString().replace("\n", " ").take(50)
        val cd = (node.contentDescription ?: "").toString().replace("\n", " ").take(40)
        val flags = buildString {
            if (node.isClickable) append("C"); if (node.isScrollable) append("S"); if (node.isFocusable) append("F")
        }
        sb.append("  ".repeat(depth)).append(cls)
        if (id.isNotEmpty()) sb.append(" #").append(id)
        if (txt.isNotEmpty()) sb.append(" '").append(txt).append("'")
        if (cd.isNotEmpty()) sb.append(" [").append(cd).append("]")
        sb.append(" ").append(rect.toShortString())
        if (flags.isNotEmpty()) sb.append(" {").append(flags).append("}")
        sb.append('\n')
        for (i in 0 until node.childCount) node.getChild(i)?.let { dumpTree(it, sb, depth + 1, count) }
    }

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
        val orderRef = ORDER_ID.find(text)?.groupValues?.get(1)   // full Order ID (merge key), if readable
        val txn = ParsedTxn(amount = amount, utr = rrn, payerVpa = null, payerName = payer, bank = "PAYTM",
            raw = "PAYTM detail RRN=$rrn amt=$amount", orderRef = orderRef)
        AlertUploader.send(applicationContext, txn, "ACCESSIBILITY", pkg)
    }

    // When Paytm DOES expose readable rows: tap the next un-captured one by coordinate.
    private fun tapReadableRow(rows: List<Row>) {
        val target = rows.firstOrNull { it.key !in seenRows } ?: return
        val now = System.currentTimeMillis()
        if (now - lastTapAt < TAP_COOLDOWN_MS) return
        lastTapAt = now
        seenRows.add(target.key); capSeen()
        autoOpenedDetail = true
        val ok = tapAt(target.x, target.y)
        AlertStore.log(applicationContext, "${nowTag()} ↳ row tap ${if (ok) "@${target.x},${target.y}" else "failed"}: ${target.key.take(40)}")
    }

    private data class Row(val key: String, val x: Int, val y: Int, val top: Int)

    // Tap a screen point. Prefer Shizuku (shell-level `input tap`, injected as a REAL
    // touch that Paytm accepts); fall back to an AccessibilityService gesture (which
    // Paytm rejects, but works on non-hostile screens).
    private fun tapAt(x: Int, y: Int): Boolean {
        if (ShizukuTap.granted() && ShizukuTap.tap(x, y)) return true
        val path = Path().apply { moveTo(x.toFloat(), y.toFloat()) }
        return try {
            dispatchGesture(
                GestureDescription.Builder()
                    .addStroke(GestureDescription.StrokeDescription(path, 0, 70)).build(),
                null, null,
            )
        } catch (e: Exception) { false }
    }

    // Find transaction rows by anchoring on a clock time ("12:56 PM"), then climbing to
    // the ancestor whose subtree also carries an amount (the row container). Returns each
    // row's centre point for a coordinate tap. Sorted top-to-bottom (newest first).
    private fun findPaymentRows(root: AccessibilityNodeInfo, stat: IntArray): List<Row> {
        val out = ArrayList<Row>()
        val seenKeys = HashSet<String>()
        val rect = Rect()
        var count = 0
        val stack = ArrayDeque<AccessibilityNodeInfo>()
        stack.addLast(root)
        while (stack.isNotEmpty() && count < MAX_NODES) {
            val node = stack.removeLast(); count++
            val own = (node.text?.toString() ?: "") + " " + (node.contentDescription?.toString() ?: "")
            if (ROW_TIME.containsMatchIn(own)) {
                stat[0]++
                // Climb until the subtree also has an amount → that's the whole row.
                var anc: AccessibilityNodeInfo? = node
                var hops = 0
                var rowNode: AccessibilityNodeInfo? = null
                var rowText = ""
                while (anc != null && hops < 8) {
                    val sub = subtreeText(anc).trim().replace(Regex("\\s+"), " ")
                    if (sub.contains("₹") || NUM.containsMatchIn(sub)) { rowNode = anc; rowText = sub; break }
                    anc = anc.parent; hops++
                }
                if (rowNode != null && seenKeys.add(rowText)) {
                    rowNode.getBoundsInScreen(rect)
                    if (rect.width() > 0 && rect.height() > 0) {
                        out.add(Row(rowText, rect.centerX(), rect.centerY(), rect.top))
                        stat[1]++
                        // Log each detected row once so I can see the list structure.
                        AlertStore.log(applicationContext, "${nowTag()} • row @${rect.centerX()},${rect.centerY()}: ${rowText.take(46)}")
                    }
                }
            }
            for (i in 0 until node.childCount) node.getChild(i)?.let { stack.addLast(it) }
        }
        return out.sortedBy { it.top }
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
