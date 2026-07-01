package shop.glhouse.agent

import java.util.regex.Pattern

// Parsed UPI-credit transaction extracted from a bank SMS / notification.
data class ParsedTxn(
    val amount: Double,
    val utr: String?,
    val payerVpa: String?,
    val payerName: String?,
    val bank: String?,
    val raw: String,
)

// Heuristic parser for Indian bank UPI-credit alerts. Handles the common shapes
// across HDFC / SBI / ICICI / Axis / Kotak / PNB / etc. — different banks word it
// differently, so we match on credit keywords + an amount + (optional) UPI ref/VPA.
object TxnParser {
    private val CREDIT = Pattern.compile(
        "(credited|received|deposited|added to|\\bcr\\b|credit of)", Pattern.CASE_INSENSITIVE)
    private val DEBIT = Pattern.compile(
        "(debited|spent|withdrawn|paid to|\\bdr\\b|debit of)", Pattern.CASE_INSENSITIVE)
    // OTP / authentication messages must never be forwarded (architecture §1, §8).
    private val AUTH = Pattern.compile(
        "(otp|one[\\s-]?time\\s*password|verification code|login code|do not share|don'?t share|\\bpin\\b|password|passcode|cvv|secure code)",
        Pattern.CASE_INSENSITIVE)

    // Rs 123.45 / Rs.500 / INR 1,234 / ₹1,234.56
    private val AMOUNT = Pattern.compile(
        "(?:rs\\.?|inr|₹)\\s*([0-9][0-9,]*(?:\\.[0-9]{1,2})?)", Pattern.CASE_INSENSITIVE)
    // "Avl Bal Rs X" / "Available Balance INR X" — the account balance, NOT the credit.
    private val BALANCE = Pattern.compile(
        "(?:avl\\.?\\s*bal|available\\s*balance|bal(?:ance)?)[:\\s.]*(?:rs\\.?|inr|₹)?\\s*([0-9][0-9,]*(?:\\.[0-9]{1,2})?)",
        Pattern.CASE_INSENSITIVE)
    // Labelled reference: UPI Ref no 1234.., UTR 1234.., RRN 1234.., Ref 1234..
    private val UTR_LABEL = Pattern.compile(
        "(?:upi\\s*ref(?:\\s*no)?|utr|rrn|ref(?:erence)?\\s*(?:no|id)?)[:\\s.#-]*([0-9]{6,})",
        Pattern.CASE_INSENSITIVE)
    // Fallback: a bare 12-digit number (typical RRN length).
    private val UTR_12 = Pattern.compile("\\b([0-9]{12})\\b")
    // VPA: name@bank
    private val VPA = Pattern.compile("([a-zA-Z0-9._-]{2,}@[a-zA-Z]{2,})")
    // Payer name from a payment-app push: "₹300 Received from Mr KUSH DESAI",
    // "Payment of Rs 500 received from JOHN DOE". Business-merchant pushes (Paytm/
    // PhonePe for Business) carry no UTR/VPA, so the name is the only payer signal.
    // Lazy capture stops at end-of-text, punctuation, or a UPI/ref keyword.
    private val PAYER_NAME = Pattern.compile(
        "\\bfrom\\s+((?:mr|mrs|ms|dr|m/s)\\.?\\s+)?([a-zA-Z][a-zA-Z .&'-]{1,59}?)" +
            "(?=\\s*(?:$|[,.\\n·—|(]|\\bvia\\b|\\bon\\b|\\bupi\\b|\\bref\\b|\\butr\\b|\\brrn\\b|@))",
        Pattern.CASE_INSENSITIVE)

    private val BANKS = listOf(
        "HDFC", "SBI", "ICICI", "AXIS", "KOTAK", "PNB", "YESBANK", "IDFC",
        "BOB", "CANARA", "UNION", "INDUSIND", "PAYTM", "PHONEPE", "GPAY",
    )

    fun parse(text: String?, sender: String?): ParsedTxn? {
        val t = (text ?: "").trim()
        if (t.isEmpty()) return null

        // Never forward OTP / auth messages, even if they happen to contain a keyword.
        if (AUTH.matcher(t).find()) return null

        // Must look like a credit and not (only) a debit.
        if (!CREDIT.matcher(t).find()) return null
        if (DEBIT.matcher(t).find() && !t.contains("credited", true) && !t.contains("received", true)) {
            return null
        }

        // Amount selection (full-proof): pick the amount tied to the credit keyword
        // and NEVER an "available balance" figure. Among all "Rs X" matches we choose
        // the one nearest the credit word, skipping any value that is the balance.
        val creditIdx = CREDIT.matcher(t).let { if (it.find()) it.start() else -1 }
        val balanceVal = BALANCE.matcher(t).let { if (it.find()) it.group(1)?.replace(",", "")?.toDoubleOrNull() else null }
        var amount: Double? = null
        var bestScore = Int.MAX_VALUE
        val mAmt = AMOUNT.matcher(t)
        while (mAmt.find()) {
            val v = mAmt.group(1)?.replace(",", "")?.toDoubleOrNull() ?: continue
            if (v <= 0.0) continue
            if (balanceVal != null && v == balanceVal) continue        // skip the balance
            val dist = if (creditIdx < 0) mAmt.start() else kotlin.math.abs(mAmt.start() - creditIdx)
            // amounts that appear before the credit word are deprioritised
            val score = if (creditIdx >= 0 && mAmt.start() < creditIdx) dist + 100000 else dist
            if (score < bestScore) { bestScore = score; amount = v }
        }
        if (amount == null || amount!! <= 0.0) return null

        val utr = UTR_LABEL.matcher(t).let { if (it.find()) it.group(1) else null }
            ?: UTR_12.matcher(t).let { if (it.find()) it.group(1) else null }
        val vpa = VPA.matcher(t).let { if (it.find()) it.group(1) else null }
        val payerName = extractPayerName(t)
        val bank = guessBank(sender, t)

        return ParsedTxn(amount = amount!!, utr = utr, payerVpa = vpa, payerName = payerName, bank = bank, raw = t)
    }

    // Pull the payer name after a "from <name>" phrase. Drops VPA-like tokens and
    // collapses whitespace; returns null when nothing name-like is present.
    private fun extractPayerName(text: String): String? {
        val m = PAYER_NAME.matcher(text)
        if (!m.find()) return null
        val title = m.group(1)?.trim().orEmpty()
        val core = m.group(2)?.trim().orEmpty()
        if (core.isEmpty() || core.contains("@")) return null
        val name = (if (title.isNotEmpty()) "$title $core" else core)
            .replace(Regex("\\s+"), " ").trim()
        // Reject obvious non-names (a bare number, or a single 2-letter token).
        if (name.length < 3 || name.any { it.isDigit() }) return null
        return name.take(120)
    }

    private fun guessBank(sender: String?, text: String): String? {
        val hay = ((sender ?: "") + " " + text)
        for (b in BANKS) if (hay.contains(b, ignoreCase = true)) return b
        return null
    }
}
