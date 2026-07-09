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

        val txn = TxnParser.parse(content, sbn.packageName) ?: return

        val key = "${txn.amount}|${txn.utr ?: content.hashCode()}"
        if (!AlertStore.seenRecently(applicationContext, key)) {
            AlertUploader.send(applicationContext, txn, "NOTIFICATION", sbn.packageName)
        }
    }

    private fun nowTag(): String =
        java.text.SimpleDateFormat("HH:mm:ss", java.util.Locale.US).format(java.util.Date())
}
