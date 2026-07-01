package shop.glhouse.agent

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.provider.Telephony

// Fires on every incoming SMS — even when the app process is dead (the system starts
// it). Parses bank UPI-credit messages and forwards them. OTP/auth messages are
// dropped by the parser.
class SmsReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        if (intent.action != Telephony.Sms.Intents.SMS_RECEIVED_ACTION) return
        if (!Prefs.enabled(context)) return

        val msgs = Telephony.Sms.Intents.getMessagesFromIntent(intent) ?: return
        if (msgs.isEmpty()) return

        val sender = msgs.firstOrNull()?.displayOriginatingAddress
        val body = msgs.joinToString("") { it.messageBody ?: "" }   // re-join multipart SMS

        val txn = TxnParser.parse(body, sender) ?: return
        val key = "${txn.amount}|${txn.utr ?: body.hashCode()}"
        if (AlertStore.seenRecently(context, key)) return

        AlertUploader.send(context, txn, "SMS", sender)
    }
}
