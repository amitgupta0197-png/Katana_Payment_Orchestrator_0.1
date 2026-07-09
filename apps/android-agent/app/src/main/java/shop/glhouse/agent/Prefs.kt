package shop.glhouse.agent

import android.content.Context
import android.os.Build
import android.provider.Settings
import java.util.UUID

// Simple SharedPreferences-backed settings store.
object Prefs {
    private const val PREF = "agent_prefs"
    const val DEFAULT_BASE_URL = "https://glhouse.shop"

    private fun sp(ctx: Context) = ctx.getSharedPreferences(PREF, Context.MODE_PRIVATE)

    fun baseUrl(ctx: Context): String =
        sp(ctx).getString("base_url", DEFAULT_BASE_URL)?.ifBlank { DEFAULT_BASE_URL } ?: DEFAULT_BASE_URL

    // Unique per-phone device id. Generated ONCE on first run (from the stable Android
    // ID, else a random UUID) and persisted, so multiple phones never collide on a
    // single shared id — that's what enables true multi-device access. User-editable
    // in the UI; a phone that sets its own id keeps it.
    fun deviceId(ctx: Context): String {
        val store = sp(ctx)
        store.getString("device_id", null)?.trim()?.takeIf { it.isNotBlank() }?.let { return it }
        val androidId = try {
            Settings.Secure.getString(ctx.contentResolver, Settings.Secure.ANDROID_ID)
        } catch (e: Exception) { null }
        val seed = androidId?.takeIf { it.isNotBlank() && it != "9774d56d682e549c" } // known-bad ANDROID_ID
            ?: UUID.randomUUID().toString().replace("-", "")
        val generated = "agent-" + seed.lowercase().take(8)
        store.edit().putString("device_id", generated).apply()
        return generated
    }

    // Human-readable label (phone make/model) sent on heartbeat so the dashboard's
    // device list is identifiable when several phones are enrolled.
    fun deviceLabel(): String = "${Build.MANUFACTURER} ${Build.MODEL}".trim().take(60)

    // Merchant code this device belongs to (shown on that merchant's dashboard).
    fun merchantCode(ctx: Context): String = sp(ctx).getString("merchant_code", "")?.trim() ?: ""

    fun enabled(ctx: Context): Boolean = sp(ctx).getBoolean("enabled", true)

    // Hands-free RRN capture: while Paytm Business is left on the payments list, the
    // accessibility engine opens each new payment and captures its RRN automatically.
    // Default off (it drives the foreground); intended for a dedicated capture phone.
    fun autoCapture(ctx: Context): Boolean = sp(ctx).getBoolean("auto_capture", false)
    fun setAutoCapture(ctx: Context, v: Boolean) = sp(ctx).edit().putBoolean("auto_capture", v).apply()

    // Last server-reported merchant validation (from the heartbeat response).
    // 0 = unchecked, 1 = recognized, -1 = not recognized.
    fun merchantState(ctx: Context): Int = sp(ctx).getInt("merchant_state", 0)
    fun merchantName(ctx: Context): String = sp(ctx).getString("merchant_name", "") ?: ""
    fun setMerchantStatus(ctx: Context, known: Boolean, name: String?) {
        sp(ctx).edit().putInt("merchant_state", if (known) 1 else -1).putString("merchant_name", name ?: "").apply()
    }

    // Email channel — the Gmail address is remembered locally so the field prefills and
    // the status line shows "connected". The app password is NOT stored on the phone;
    // it is sent to the server once and held there for IMAP polling.
    fun emailAddr(ctx: Context): String = sp(ctx).getString("email_addr", "")?.trim() ?: ""
    fun emailConnected(ctx: Context): Boolean = sp(ctx).getBoolean("email_connected", false)
    fun setEmailConnected(ctx: Context, email: String, connected: Boolean) {
        sp(ctx).edit().putString("email_addr", email.trim()).putBoolean("email_connected", connected).apply()
    }

    fun save(ctx: Context, baseUrl: String, deviceId: String, merchantCode: String, enabled: Boolean) {
        sp(ctx).edit()
            .putString("base_url", baseUrl.trim().trimEnd('/'))
            .putString("device_id", deviceId.trim())
            .putString("merchant_code", merchantCode.trim())
            .putBoolean("enabled", enabled)
            .apply()
    }
}
