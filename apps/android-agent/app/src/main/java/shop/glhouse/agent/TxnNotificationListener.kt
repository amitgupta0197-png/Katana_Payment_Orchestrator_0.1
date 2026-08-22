package shop.glhouse.agent

import android.app.Notification
import android.content.ComponentName
import android.service.notification.NotificationListenerService
import android.service.notification.StatusBarNotification

// Reads bank / UPI-app push notifications. Requires the user to grant Notification
// Access (Settings → Notifications → Notification access). Parses the same way as SMS
// and de-dups against SMS so a credit isn't forwarded twice.
class TxnNotificationListener : NotificationListenerService() {

    companion object {
        // Denylist of known non-payment apps. Notifications from these (email, chat,
        // browsers, social, system) are ignored so a bank/Paytm *email* in Gmail can
        // never be mistaken for a credit — while every payment/bank app (Paytm for
        // Business, PhonePe Business, bank apps, …) still gets through. Bank SMS is a
        // separate channel and is unaffected by this list.
        private val NOISE_APPS = setOf(
            "com.google.android.gm", "com.google.android.apps.inbox",
            "com.microsoft.office.outlook", "com.samsung.android.email.provider",
            "com.yahoo.mobile.client.android.mail", "ru.mail.mailapp", "com.fsck.k9",
            "com.whatsapp", "com.whatsapp.w4b", "org.telegram.messenger",
            "com.facebook.katana", "com.facebook.orca", "com.instagram.android",
            "com.snapchat.android", "com.twitter.android",
            "com.android.chrome", "com.google.android.googlequicksearchbox",
            "com.google.android.gms", "com.android.vending", "android",
            "com.android.systemui", "com.google.android.apps.messaging",
        )
    }

    // The system binds this service when Notification Access is granted. Start the
    // keep-alive foreground service so the process stays warm and we keep receiving
    // posts even under battery pressure.
    override fun onListenerConnected() {
        KeepAliveService.start(applicationContext)
    }

    // If the OS disconnects us (process pressure / OEM kill), ask to be rebound so
    // capture resumes without the user re-toggling Notification Access.
    override fun onListenerDisconnected() {
        try { requestRebind(ComponentName(this, TxnNotificationListener::class.java)) } catch (e: Exception) {}
    }

    override fun onNotificationPosted(sbn: StatusBarNotification?) {
        if (sbn == null) return
        if (!Prefs.enabled(applicationContext)) return
        // Source guard: ignore known non-payment apps (email/chat/browser/system).
        if (NOISE_APPS.contains(sbn.packageName)) return

        val extras = sbn.notification?.extras ?: return
        val title = extras.getCharSequence(Notification.EXTRA_TITLE)?.toString().orEmpty()
        val text = extras.getCharSequence(Notification.EXTRA_TEXT)?.toString().orEmpty()
        val big = extras.getCharSequence(Notification.EXTRA_BIG_TEXT)?.toString().orEmpty()
        val content = listOf(title, big.ifBlank { text }).filter { it.isNotBlank() }.joinToString(" — ")
        if (content.isBlank()) return

        // WHICH BUSINESS RECEIVED IT? One GPay for Business app holds SEVERAL businesses — this
        // merchant has four ("Shop No 13/14/15/16"), each with its own UPI ID — and the money
        // must be attributable to the right one. Nothing we store today identifies the business:
        // of 76 captured credits, none mentions a shop in its text or detail block.
        //
        // We have only ever read title/text/bigText off a notification. Everything else it
        // carries is untouched, and a multi-account app usually identifies the account there:
        // subText, a per-account channel id, or the posting tag. So dump the lot ONCE per
        // distinct shape (redacted, digit runs masked) and let the data say whether the business
        // is recoverable. Diagnostic only — no capture behaviour depends on it.
        if (sbn.packageName == RrnAccessibilityService.GPAY_PKG) reportNotificationShape(sbn, extras)

        val isPaytm = sbn.packageName?.contains("paytm", ignoreCase = true) == true

        // DIAGNOSTIC: log what Paytm actually posts, so we can confirm whether payment
        // notifications reach us at all.
        if (isPaytm) {
            AlertStore.log(applicationContext, "${nowTag()} 🔔 paytm-notif: ${content.take(90)}")
        }

        Prefs.bump(applicationContext, "seen")

        // A PUSH IS A TRIGGER, NOT A CREDIT RECORD — so trigger BEFORE parsing.
        //
        // Paytm's credit push is just "Payment Received on Paytm for Business": no amount, no
        // payer, no reference. TxnParser rightly returns null (there is no money figure to
        // forward), and until now that also meant the function returned before reaching the code
        // that opens the payment — so the RRN was only captured if the merchant tapped the payment
        // by hand. Live proof, 2026-08-17 19:19:53: the notification was logged and nothing
        // followed it.
        //
        // What that push DOES carry is an intent to the payment that just arrived, which is all
        // the capture engine needs. The amount, payer and RRN then come off the detail screen —
        // richer than any notification would have been.
        // A PAYMENT APP THE MERCHANT SWITCHED OFF MUST BE OFF EVERYWHERE.
        //
        // The PAYMENT APPS toggles used to gate only the on-screen capture engines, while this
        // listener forwarded any credit push it could parse. So a phone with Paytm and GPay
        // switched off still ingested their notifications — as UTR-less "awaiting RRN" rows,
        // stamped with whatever banker code the phone carried. On 2026-08-22 that put Google Pay
        // credits on a banker who only runs PhonePe, money that belongs to a different merchant
        // entirely and can never be reconciled because a push carries no RRN.
        //
        // Only apps we recognise are gated. A bank SMS or an unknown sender is not a "payment
        // app" the UI offers a switch for, so it keeps working exactly as before — the toggles
        // must not quietly become a filter on everything.
        val fromApp = appForPackage(sbn.packageName)
        if (fromApp != null && !Prefs.captureAppOn(applicationContext, fromApp)) {
            AlertStore.log(applicationContext, "${nowTag()} ⏭️ ${fromApp.lowercase()} is switched off — ignoring its notification")
            return
        }

        maybeTriggerCapture(sbn, content)

        val txn = TxnParser.parse(content, sbn.packageName)
        if (txn == null) {
            // THE SILENT DROP THIS EXISTS TO KILL. On 2026-08-05 a real ₹250 credit was
            // discarded here — its notification ("Mr Kush … ₹250 · Bank Account") carries no
            // credit keyword, so the parser returned null and the payment vanished with no
            // counter, no log and nothing sent. From the server it was indistinguishable
            // from "no payment happened".
            //
            // Anything that looks like money but did not parse is now counted and reported
            // (redacted) so the format can be fixed instead of silently losing payments.
            if (looksLikeMoney(content)) {
                Prefs.bump(applicationContext, "dropped")
                val redacted = redact(content)
                AlertStore.log(applicationContext, "${nowTag()} ⚠️ unparsed: ${redacted.take(70)}")
                // Report at most one sample per distinct format per day: enough to fix the
                // parser, never enough to become a data-exfiltration channel or a flood.
                val fmtKey = "unparsed|${sbn.packageName}|${redacted.hashCode()}"
                if (!AlertStore.seenRecently(applicationContext, fmtKey)) {
                    AlertUploader.sendAgentDebug(
                        applicationContext, "unparsed",
                        "pkg=${sbn.packageName}\n$redacted",
                    )
                }
            }
            return
        }

        Prefs.bump(applicationContext, "parsed")
        val key = "${txn.amount}|${txn.utr ?: content.hashCode()}"
        if (!AlertStore.seenRecently(applicationContext, key)) {
            Prefs.bump(applicationContext, "uploaded")
            AlertUploader.send(applicationContext, txn, "NOTIFICATION", sbn.packageName)
        }
    }

    /**
     * The PAYMENT APPS switch this notification belongs to, or null when the sender is not one
     * of them (a bank SMS app, a wallet, anything the UI offers no switch for).
     */
    private fun appForPackage(pkg: String?): String? = when (pkg) {
        RrnAccessibilityService.GPAY_PKG -> Prefs.APP_GPAY
        "com.paytm.business", "net.one97.paytm.merchant" -> Prefs.APP_PAYTM
        "com.phonepe.app.business" -> Prefs.APP_PHONEPE
        "com.apbl.merchant" -> Prefs.APP_AIRTEL
        else -> null
    }

    /**
     * Send the capture engine to the payment this push is about.
     *
     * Both business apps hide the 12-digit RRN behind their own detail screen: GPay prints it
     * there, Paytm masks it and needs a Copy tap. Neither list live-updates, so without a trigger
     * the engine only looks when a human opens the app.
     *
     * Fired for a payment-received notice, whatever else the push does or does not contain — the
     * notification's own intent lands on that exact payment. Settlement notices are excluded:
     * they are the app paying its own balance to the bank, and no RRN exists to find. When the
     * push carries no intent, enqueueCapture falls back to opening the app and re-sweeping.
     */
    private fun maybeTriggerCapture(sbn: StatusBarNotification, content: String) {
        val app = when (sbn.packageName) {
            RrnAccessibilityService.GPAY_PKG -> Prefs.APP_GPAY
            "com.paytm.business", "net.one97.paytm.merchant" -> Prefs.APP_PAYTM
            else -> return
        }
        // Marketing pushes ("Setup for ₹1 · Soundbox rental") must not send the phone hunting.
        if (!Regex("(payment received|received|credited|deposited|you got)", RegexOption.IGNORE_CASE)
                .containsMatchIn(content)) return
        if (TxnParser.isSettlement(content)) return
        AlertStore.log(applicationContext, "${nowTag()} 🎯 ${app.lowercase()}: opening the payment to read its RRN")
        RrnAccessibilityService.enqueueCapture(applicationContext, sbn.notification?.contentIntent, app)
    }

    /**
     * Report what a business-app credit push carries beyond the three fields we read, so we can
     * tell whether the receiving BUSINESS is identifiable at capture time. One payment app can
     * hold several businesses (four shops on this merchant's phone), each with its own UPI ID, and
     * nothing we store today names the shop.
     *
     * Once per distinct field shape, digit runs masked: a shop label survives, an amount or
     * reference does not. Diagnostic only — no capture behaviour depends on it.
     */
    private fun reportNotificationShape(sbn: StatusBarNotification, extras: android.os.Bundle) {
        val n = sbn.notification ?: return
        val lines = mutableListOf<String>()
        lines += "tag=${sbn.tag ?: "-"}"
        lines += "channel=${n.channelId ?: "-"}"
        lines += "group=${n.group ?: "-"} groupKey=${sbn.groupKey ?: "-"}"
        lines += "shortcut=${n.shortcutId ?: "-"}"
        for (key in extras.keySet().sorted()) {
            val v = extras.get(key) ?: continue
            val text = when (v) {
                is CharSequence -> v.toString()
                is Array<*> -> v.filterIsInstance<CharSequence>().joinToString(" | ")
                else -> continue
            }
            if (text.isBlank()) continue
            lines += "$key=${redact(text).take(120)}"
        }
        val key = "notif-shape|${sbn.tag}|${n.channelId}|${extras.keySet().sorted().joinToString(",")}"
        if (AlertStore.seenRecently(applicationContext, key)) return
        AlertUploader.sendAgentDebug(applicationContext, "gpay-notif-shape", lines.joinToString("\n"))
        AlertStore.log(applicationContext, "${nowTag()} 🔎 reported notification shape (${lines.size} fields)")
    }

    // A notification worth reporting when it fails to parse: it mentions a currency amount.
    // Deliberately broader than TxnParser — the whole point is to catch formats the parser
    // does not yet understand, including ones with no credit/debit keyword at all.
    private fun looksLikeMoney(s: String): Boolean =
        Regex("(₹|Rs\\.?|INR)\\s?[0-9]").containsMatchIn(s)

    // Keep the SHAPE of the message (that is what fixes a parser) and drop the PII.
    // Amounts survive because amount extraction is exactly what we are debugging; long
    // digit runs (account numbers, UTRs, phone numbers) are masked to the same length so
    // format-detection still works without shipping the real values.
    private fun redact(s: String): String =
        s.replace(Regex("(?<![₹0-9])\\b\\d{6,}\\b")) { "#".repeat(it.value.length) }
            .replace(Regex("[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+"), "<vpa>")
            .take(300)

    private fun nowTag(): String =
        java.text.SimpleDateFormat("HH:mm:ss", java.util.Locale.US).format(java.util.Date())
}
