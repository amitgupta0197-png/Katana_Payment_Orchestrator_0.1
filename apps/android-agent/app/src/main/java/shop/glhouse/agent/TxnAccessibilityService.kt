package shop.glhouse.agent

import android.accessibilityservice.AccessibilityService
import android.accessibilityservice.GestureDescription
import android.content.Intent
import android.graphics.Path
import android.graphics.Rect
import android.os.Handler
import android.os.Looper
import android.os.SystemClock
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

    // Notification-tap state (Android-14/15 bypass): when a Paytm credit push arrives,
    // TxnNotificationListener asks us to open the shade and TAP the notification — a REAL
    // tap fires its contentIntent → the exact receipt, which the OS forbids us to fire from
    // the background. See requestNotificationTap / clickNotification.
    @Volatile private var pendingTapHint: String? = null
    @Volatile private var pendingTapAt = 0L

    // Masked-RRN clipboard-capture session state (see captureMaskedRrn / maskedScanAndTap).
    @Volatile private var maskedRunning = false
    private var mAmount = 0.0
    private var mOrderRef: String? = null
    private var mPayer: String? = null
    private var mPkg: String? = null
    private var mHints: String? = null
    private var mStartAt = 0L
    private var mLastTapAt = 0L
    private var mLastScanAt = 0L
    private var mScrolls = 0
    private var mNextTap = 0
    private var mJit = 0

    // Auto-sweep state.
    private val seenRows = LinkedHashSet<String>()   // transaction rows already handled
    private var baselined = false                    // ignore the backlog present on first sight
    private var lastTapAt = 0L
    private var autoOpenedDetail = false             // we opened this detail (so we may go back)
    private var lastStatKey = ""                     // throttle the list-scan diagnostic
    private var lastScreen = "other"                 // other | list | detail — sweep state
    private var blindIndex = 0                       // next fixed position to blind-tap
    private var positions: List<Double> = emptyList() // tuned row tap positions (from Prefs)

    companion object {
        const val MIN_SCAN_GAP_MS = 600L
        const val TAP_COOLDOWN_MS = 2500L            // pace row taps so navigation settles
        const val MAX_NODES = 4000
        const val MAX_SEEN = 600

        // Live instance so TxnNotificationListener (notification-tap) and RrnClipboardActivity
        // (masked-RRN success signal) can drive the running service.
        @Volatile private var instance: TxnAccessibilityService? = null

        // Cross-process success signal: RrnClipboardActivity calls noteCaptured() the instant it
        // forwards a valid RRN, so the masked session stops retrying the moment we succeed.
        @Volatile var sMaskedCapturedAt = 0L
        fun noteCaptured() { sMaskedCapturedAt = SystemClock.uptimeMillis() }

        // Open the notification shade and tap the just-arrived credit notification — its real tap
        // fires the contentIntent → the exact Paytm receipt (blocked if we fire it ourselves on 14+).
        fun requestNotificationTap(hint: String?) { instance?.doRequestNotificationTap(hint) }

        // Small rotating offsets applied to each retried Copy tap, so if a button's real touch
        // target is a few px off from its reported centre, successive retries sweep it and one lands.
        val TAP_JITTER = arrayOf(intArrayOf(0, 0), intArrayOf(0, -14), intArrayOf(0, 14), intArrayOf(12, 0), intArrayOf(-12, 0))

        // A MASKED reference as Paytm Business shows it ("209…975768"): digits · ellipsis · digits.
        val MASKED_REF = Regex("[0-9]{2,4}\\s*[.·•…]{2,}\\s*[0-9]{4,8}")
        // Split a masked ref into visible leading + trailing digits, to fingerprint the full value.
        val MASK_SPLIT = Regex("([0-9]+)[.·•…]+([0-9]+)")

        val RRN_LABELLED = Regex("(?:rrn|utr|upi\\s*ref(?:\\s*no)?)[^0-9]{0,24}([0-9]{12})", RegexOption.IGNORE_CASE)
        val RRN_BARE = Regex("\\b([0-9]{12})\\b")
        // Marks a transaction-DETAIL screen. Kept in sync with what RRN_LABELLED can extract — the
        // old gate only matched "RRN"/"Transaction ID" and silently missed relabeled receipts that
        // say "UPI Ref No"/"Bank Ref"/"Reference ID".
        val DETAIL_MARKER = Regex("rrn|transaction\\s*id|upi\\s*ref|bank\\s*ref|reference\\s*(?:id|no)|\\butr\\b", RegexOption.IGNORE_CASE)
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

    override fun onServiceConnected() {
        super.onServiceConnected()
        instance = this
        AlertStore.log(applicationContext, "${nowTag()} 👁 screen-reader connected")
    }

    override fun onDestroy() {
        if (instance === this) instance = null
        super.onDestroy()
    }

    override fun onAccessibilityEvent(event: AccessibilityEvent?) {
        if (event == null) return
        if (!Prefs.enabled(applicationContext)) return
        val pkg = event.packageName?.toString() ?: return
        val type = event.eventType
        if (type != AccessibilityEvent.TYPE_WINDOW_STATE_CHANGED &&
            type != AccessibilityEvent.TYPE_WINDOW_CONTENT_CHANGED) return

        // PENDING NOTIFICATION TAP: a Paytm credit push just arrived and we opened the shade —
        // when systemui is showing, find + tap that credit notification. The real tap fires its
        // contentIntent → the exact Paytm receipt (which the scraper below then reads for the RRN).
        if (pendingTapAt > 0 && SystemClock.uptimeMillis() - pendingTapAt < 9000 &&
            pkg.contains("systemui")) {
            val sr = rootInActiveWindow
            if (sr != null && clickNotification(sr, pendingTapHint)) {
                pendingTapAt = 0
                AlertStore.log(applicationContext, "${nowTag()} 👆 tapped credit notif → opening receipt")
            }
            return
        }

        if (!pkg.contains("paytm", ignoreCase = true)) return

        // During a masked-RRN session THIS callback is the only place the reference "Copy" bounds
        // read as real coordinates (a timer read gets clamped). Scan+tap here on each event, then bail.
        if (maskedRunning) { maskedScanAndTap(); return }

        if (!loggedPkg) {
            loggedPkg = true
            AlertStore.log(applicationContext, "${nowTag()} 👁 screen-reader active on $pkg")
        }

        val now = System.currentTimeMillis()
        if (now - lastScanAt < MIN_SCAN_GAP_MS) return
        lastScanAt = now

        val root = rootInActiveWindow ?: return
        // Read EVERY window (like uiautomator) — Paytm renders the receipt in a window that
        // rootInActiveWindow can return empty for, but getWindows() sees. Falls back to the
        // active root when the multi-window read is sparse.
        val text = readAllWindows(pkg).ifBlank { dumpText(root) }

        // Debug: upload the full node tree of each distinct Paytm screen while armed.
        if (System.currentTimeMillis() < Prefs.debugDumpUntil(applicationContext)) maybeDumpTree(root, text)

        val isDetail = DETAIL_MARKER.containsMatchIn(text)

        if (isDetail) {
            // De-dup identical detail screens so we don't re-send on every content event.
            val h = text.hashCode()
            if (h != lastDetailHash) {
                lastDetailHash = h
                // SAFETY: never forward the merchant's OWN outgoing payment (debit/refund/sent) as
                // a credit RRN — the detail path reads a bare 12-digit number that could just as
                // easily sit on a debit receipt.
                if (isDebit(text)) {
                    AlertStore.log(applicationContext, "${nowTag()} ⤴ skipped outgoing/debit screen")
                } else if (!captureDetail(text, pkg)) {
                    // Plain RRN absent → if the receipt only shows a MASKED RRN ("209…975768"),
                    // start the clipboard sweep (tap its "Copy" → focused read).
                    maybeCaptureMasked(text, pkg)
                }
            }
            // If WE opened this via the sweep, return to the list to pick up the next row — but
            // NOT while a masked-RRN Copy sweep is still scrolling/tapping this very receipt.
            if (autoOpenedDetail && !maskedRunning && Prefs.autoOpen(applicationContext)) {
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

    // Read amount + a PLAIN (unmasked) RRN off a transaction-detail screen and forward it.
    // Returns true if it forwarded or already handled this screen; false when no plain 12-digit
    // RRN is present (→ the caller starts the masked clipboard sweep).
    private fun captureDetail(text: String, pkg: String): Boolean {
        val rrn = RRN_LABELLED.find(text)?.groupValues?.get(1)
            ?: RRN_BARE.find(text)?.groupValues?.get(1) ?: return false
        val amount = extractAmount(text)
        if (amount == null || amount <= 0.0) {
            AlertStore.log(applicationContext, "${nowTag()} 🔎 RRN $rrn but amount unreadable")
            return true
        }
        val key = "$amount|$rrn"
        if (AlertStore.seenRecently(applicationContext, key)) return true
        val payer = extractPayer(text)
        val orderRef = ORDER_ID.find(text)?.groupValues?.get(1)   // full Order ID (merge key), if readable
        val txn = ParsedTxn(amount = amount, utr = rrn, payerVpa = null, payerName = payer, bank = "PAYTM",
            raw = "PAYTM detail RRN=$rrn amt=$amount", orderRef = orderRef)
        AlertUploader.send(applicationContext, txn, "ACCESSIBILITY", pkg)
        return true
    }

    // True when the screen clearly shows the merchant's OWN outgoing money (debit / refund / sent),
    // never an incoming credit — so a 12-digit number on such a receipt is never mistaken for a
    // received-payment RRN. Only rejects CLEAR debits; it never requires positive credit wording
    // (which would drop legitimate credits whose receipt omits the word "received").
    private fun isDebit(text: String): Boolean {
        val s = text.lowercase()
        return s.contains("paid to") || s.contains("sent to") || s.contains("you paid") ||
            s.contains("debited") || s.contains("money sent") || s.contains("payment sent") ||
            s.contains("refund")
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

    // ─────────────────────────── Notification-tap auto-open ───────────────────────────
    // A background app on Android 14/15 may NOT fire someone else's contentIntent, so a
    // Paytm credit push can't be opened with contentIntent.send(). Instead we open the shade
    // and dispatch a REAL tap on the credit notification — that IS allowed, and it fires the
    // intent → the exact receipt, which the scraper above then reads for the RRN.

    private fun doRequestNotificationTap(hint: String?) {
        pendingTapHint = hint?.lowercase()
        pendingTapAt = SystemClock.uptimeMillis()
        main.post { try { performGlobalAction(GLOBAL_ACTION_NOTIFICATIONS) } catch (e: Exception) {} }
    }

    // In the shade, find the CREDIT notification (a clickable node with credit wording + a
    // rupee amount) and click it. Skips debit/marketing rows.
    private fun clickNotification(node: AccessibilityNodeInfo, hint: String?): Boolean {
        try {
            if (node.isClickable) {
                val t = subtreeText(node).lowercase()
                val credit = t.contains("received") || t.contains("credited") ||
                    t.contains("prapt") || t.contains("paid you")
                val hintHit = hint != null && hint.length > 10 &&
                    t.contains(hint.substring(0, minOf(20, hint.length)))
                val debit = t.contains("you paid") || t.contains("paid to") ||
                    t.contains("sent") || t.contains("debited")
                if ((credit || hintHit) && !debit && AMOUNT.containsMatchIn(t) && t.length < 300) {
                    return node.performAction(AccessibilityNodeInfo.ACTION_CLICK)
                }
            }
            for (i in 0 until node.childCount) {
                val c = node.getChild(i) ?: continue
                if (clickNotification(c, hint)) return true
            }
        } catch (e: Exception) {}
        return false
    }

    // ─────────────────────────── Full multi-window read ───────────────────────────
    // Read the node text of EVERY window belonging to the payment app (like uiautomator) —
    // Paytm renders receipt content in a window that rootInActiveWindow returns empty for,
    // but getWindows() sees. Requires flagRetrieveInteractiveWindows in the a11y config.
    private fun readAllWindows(pkg: String): String {
        val sb = StringBuilder()
        try {
            for (w in windows.orEmpty()) {
                val wr = w?.root ?: continue
                if (wr.packageName?.toString() == pkg) collectInto(wr, sb)
            }
        } catch (e: Exception) {}
        return sb.toString()
    }

    private fun collectInto(root: AccessibilityNodeInfo, sb: StringBuilder) {
        var count = 0
        val stack = ArrayDeque<AccessibilityNodeInfo>()
        stack.addLast(root)
        while (stack.isNotEmpty() && count < MAX_NODES) {
            val n = stack.removeLast(); count++
            n.text?.let { if (it.isNotBlank()) sb.append(it).append(' ') }
            n.contentDescription?.let { if (it.isNotBlank()) sb.append(it).append(' ') }
            for (i in 0 until n.childCount) n.getChild(i)?.let { stack.addLast(it) }
        }
    }

    // ─────────────────────────── Masked-RRN clipboard capture ───────────────────────────
    // Paytm Business masks the RRN on its receipt ("209…975768"); the full value is only
    // obtainable by tapping its "Copy" button (→ clipboard) and reading it from a focused app.
    // The Copy buttons often sit below the fold and their bounds read as real coordinates ONLY
    // inside an accessibility-event callback — so this is event-driven: a heartbeat scrolls the
    // reference block into view and keeps nudging so fresh events arrive; maskedScanAndTap (run
    // from onAccessibilityEvent) taps each Copy for real and launches RrnClipboardActivity, which
    // reads the clipboard and forwards through AlertUploader. Layout-agnostic — no field-order or
    // geometry assumptions; the trampoline keeps only a 12-digit value matching a mask fingerprint.

    private fun maybeCaptureMasked(text: String, pkg: String) {
        if (maskedRunning) return
        val amount = extractAmount(text) ?: return
        if (amount <= 0.0) return
        val hints = maskedHints(text)
        if (hints.isEmpty() || !text.contains("copy", ignoreCase = true)) return
        mAmount = amount
        mOrderRef = ORDER_ID.find(text)?.groupValues?.get(1)
        mPayer = extractPayer(text)
        mPkg = pkg
        mHints = hints
        mStartAt = SystemClock.uptimeMillis(); mLastTapAt = 0L; mLastScanAt = 0L
        mScrolls = 0; mNextTap = 0; mJit = 0
        sMaskedCapturedAt = 0L
        maskedRunning = true
        AlertStore.log(applicationContext, "${nowTag()} 🎯 masked-RRN sweep start hints=[$hints]")
        maskedTick()
    }

    // Heartbeat: scroll the reference block into view (until the first tap), then keep nudging so
    // fresh events keep arriving for maskedScanAndTap. Enforces timeout, early-exits on success.
    private fun maskedTick() {
        if (!maskedRunning) return
        if (sMaskedCapturedAt > mStartAt) { endMasked("captured"); return }
        val now = SystemClock.uptimeMillis()
        if (now - mStartAt > 22000) { endMasked("timeout"); return }
        val root = rootInActiveWindow
        if (root != null) {
            if (mLastTapAt == 0L) {
                if (mScrolls < 6) { scrollForward(root); mScrolls++ } else { nudge((mScrolls++ and 1) == 0) }
            } else if (now - mLastTapAt > 1600) {
                nudge((mScrolls++ and 1) == 0)
            }
        }
        val delay = if (mLastTapAt == 0L && mScrolls <= 6) 1100L else 700L
        main.postDelayed({ maskedTick() }, delay)
    }

    // Called from onAccessibilityEvent DURING a session — the one place node bounds are real.
    // Round-robin taps the reference Copies (one per event, spaced so the trampoline reads each
    // clipboard) and KEEPS cycling until RrnClipboardActivity confirms a valid RRN, or timeout.
    private fun maskedScanAndTap() {
        if (!maskedRunning) return
        if (sMaskedCapturedAt > mStartAt) { endMasked("captured"); return }
        val now = SystemClock.uptimeMillis()
        if (now - mLastTapAt < 1500) return   // let the trampoline read the previous copy first
        if (now - mLastScanAt < 150) return   // don't churn on rapid-fire events
        mLastScanAt = now
        val root = rootInActiveWindow ?: return
        val copies = ArrayList<AccessibilityNodeInfo>()
        val masks = ArrayList<String>()
        collectRefCopies(root, arrayOfNulls<String>(1), copies, masks)
        if (copies.isEmpty()) return
        for (k in copies.indices) {
            val i = (mNextTap + k) % copies.size
            val pt = realTapPoint(copies[i]) ?: continue
            mNextTap = i + 1; mLastTapAt = now
            val jt = TAP_JITTER[mJit++ % TAP_JITTER.size]
            val tx = pt[0] + jt[0]; val ty = pt[1] + jt[1]
            AlertStore.log(applicationContext, "${nowTag()} 📎 tap Copy #$i [${masks[i]}] @$tx,$ty")
            tapAt(tx, ty)
            main.postDelayed({ launchRrnCapture() }, 450)
            return
        }
    }

    private fun endMasked(why: String) {
        maskedRunning = false
        AlertStore.log(applicationContext, "${nowTag()} 🎯 masked-RRN sweep end — $why")
    }

    // DFS: collect every "Copy" node whose nearest preceding value is a numeric reference. No
    // geometry — Paytm's webview reports bogus bounds, so we rely on structure/order only.
    private fun collectRefCopies(
        node: AccessibilityNodeInfo?, lastRef: Array<String?>,
        copies: ArrayList<AccessibilityNodeInfo>, masks: ArrayList<String>,
    ) {
        if (node == null || copies.size >= 8) return
        try {
            val t = (node.text?.toString() ?: node.contentDescription?.toString() ?: "").trim()
            if (t.isNotEmpty()) {
                if (t.equals("copy", ignoreCase = true)) {
                    lastRef[0]?.let { copies.add(node); masks.add(it); lastRef[0] = null }
                } else if (looksLikeRef(t)) {
                    lastRef[0] = t.replace(Regex("\\s+"), "")
                }
            }
            for (i in 0 until node.childCount) collectRefCopies(node.getChild(i), lastRef, copies, masks)
        } catch (e: Exception) {}
    }

    // A masked ("209…975768") or mostly-digits reference — NOT an amount and NOT an order-id.
    private fun looksLikeRef(v: String): Boolean {
        if (v.length > 40) return false
        val low = v.lowercase()
        if (v.contains('₹') || low.contains("rs") || low.contains("inr")) return false
        if (MASKED_REF.containsMatchIn(v)) return true
        val digits = v.replace(Regex("[^0-9]"), "")
        return digits.length >= 8 && v.replace(Regex("[0-9\\s.·•…\\-]"), "").isEmpty()
    }

    // Real tap point for a Copy actually on screen: walk up to a button-sized box within the
    // visible content band; off-screen Copies (bounds clamped, height 0) return null.
    private fun realTapPoint(node: AccessibilityNodeInfo): IntArray? {
        val (w, h) = realSize()
        var n: AccessibilityNodeInfo? = node
        var g = 0
        val r = Rect()
        while (n != null && g++ < 4) {
            try { n.getBoundsInScreen(r) } catch (e: Exception) { break }
            if (r.width() > 0 && r.height() > 0 && r.width() < w * 0.7 &&
                r.centerY() > h * 0.08 && r.centerY() < h * 0.90) {
                return intArrayOf(r.centerX(), r.centerY())
            }
            n = n.parent
        }
        return null
    }

    // Tiny scroll to fire a fresh accessibility event without meaningfully moving the block.
    private fun nudge(down: Boolean) {
        try {
            val (w, h) = realSize()
            val cx = w / 2
            val d = maxOf(40, (h * 0.025).toInt())
            val y0 = (h * 0.45).toInt()
            val y1 = y0 + if (down) -d else d
            val p = Path().apply { moveTo(cx.toFloat(), y0.toFloat()); lineTo(cx.toFloat(), y1.toFloat()) }
            dispatchGesture(GestureDescription.Builder()
                .addStroke(GestureDescription.StrokeDescription(p, 0L, 90L)).build(), null, null)
        } catch (e: Exception) {}
    }

    // Scroll the receipt down: prefer ACTION_SCROLL_FORWARD, else a real drag from mid-content up.
    private fun scrollForward(root: AccessibilityNodeInfo) {
        findScrollAction(root)?.let {
            try { if (it.performAction(AccessibilityNodeInfo.ACTION_SCROLL_FORWARD)) return } catch (e: Exception) {}
        }
        try {
            val (w, h) = realSize()
            val cx = w / 2
            val p = Path().apply { moveTo(cx.toFloat(), h * 0.60f); lineTo(cx.toFloat(), h * 0.18f) }
            dispatchGesture(GestureDescription.Builder()
                .addStroke(GestureDescription.StrokeDescription(p, 0L, 280L)).build(), null, null)
        } catch (e: Exception) {}
    }

    private fun findScrollAction(node: AccessibilityNodeInfo?): AccessibilityNodeInfo? {
        if (node == null) return null
        try {
            if (node.actionList.any { it.id == AccessibilityNodeInfo.ACTION_SCROLL_FORWARD }) return node
            for (i in 0 until node.childCount) {
                val r = findScrollAction(node.getChild(i)); if (r != null) return r
            }
        } catch (e: Exception) {}
        return null
    }

    // Fingerprint every masked ref as "lead|trail" (e.g. "209|975768"), comma-joined. The
    // trampoline accepts a 12-digit clipboard value only if it starts/ends with one of these.
    private fun maskedHints(screen: String): String {
        val sb = StringBuilder()
        for (m in MASKED_REF.findAll(screen)) {
            val p = MASK_SPLIT.find(m.value.replace(Regex("\\s+"), "")) ?: continue
            if (sb.isNotEmpty()) sb.append(',')
            sb.append(p.groupValues[1]).append('|').append(p.groupValues[2])
        }
        return sb.toString()
    }

    // Launch the invisible focused trampoline to read the just-copied RRN off the clipboard.
    private fun launchRrnCapture() {
        try {
            val i = Intent(this, RrnClipboardActivity::class.java)
            i.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_NO_ANIMATION)
            i.putExtra("captureRrn", true)
            i.putExtra("amount", mAmount)
            i.putExtra("orderRef", mOrderRef)
            i.putExtra("pkg", mPkg)
            i.putExtra("payer", mPayer)
            i.putExtra("hints", mHints)
            startActivity(i)
        } catch (e: Exception) {}
    }

    private fun nowTag(): String =
        java.text.SimpleDateFormat("HH:mm:ss", java.util.Locale.US).format(java.util.Date())
}
