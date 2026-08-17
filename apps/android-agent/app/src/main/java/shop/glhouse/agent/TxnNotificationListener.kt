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

        val isPaytm = sbn.packageName?.contains("paytm", ignoreCase = true) == true

        // DIAGNOSTIC: log what Paytm actually posts, so we can confirm whether payment
        // notifications reach us at all.
        if (isPaytm) {
            AlertStore.log(applicationContext, "${nowTag()} 🔔 paytm-notif: ${content.take(90)}")
        }

        Prefs.bump(applicationContext, "seen")

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

        // GPay pushes tell us a payment happened but usually NOT its RRN — the 12-digit UPI
        // transaction id lives only on the in-app detail screen. The accessibility engine can
        // read it, but only while GPay is actually on screen, so left alone it captures
        // nothing whenever the merchant has put the phone down.
        //
        // This is the bridge: the channel that never misses a payment triggers the one that
        // can read the RRN. Only when this push did not already carry a 12-digit reference,
        // so a payment whose RRN we already have never steals the foreground.
        val hasRrn = txn.utr?.let { Regex("^\\d{12}$").matches(it) } == true
        if (!hasRrn && sbn.packageName == RrnAccessibilityService.GPAY_PKG) {
            // Preferred route: fire the notification's OWN intent, which lands directly on
            // THIS payment's detail screen — where the RRN lives.
            //
            // This exists because the transactions list turned out to be unreachable on a
            // real device (2026-08-15): GPay's Home shows "Show all payments", but that
            // control cannot be activated at all — not by the accessibility engine, not by
            // adb input tap at its exact centre, and not by the merchant's own finger on a
            // freshly restarted app. Any design that has to walk Home -> list is therefore
            // dead on this build. The notification sidesteps the whole journey: it opens the
            // one screen we actually need, for the one payment we care about.
            // QUEUED, not fired immediately: there is one screen, so two payments arriving
            // together would otherwise interrupt each other mid-read. The queue drains them
            // back-to-back at roughly 2s each instead of dropping the second.
            RrnAccessibilityService.enqueueGpayCapture(
                applicationContext, sbn.notification?.contentIntent,
            )
        }
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
