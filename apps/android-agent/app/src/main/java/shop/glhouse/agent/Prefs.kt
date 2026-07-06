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

    // Auto-open the Paytm transaction screen on each payment so the screen-reader can
    // scrape the RRN with no manual navigation. Default off (it takes over the
    // foreground); intended for a dedicated capture device.
    fun autoOpen(ctx: Context): Boolean = sp(ctx).getBoolean("auto_open", false)
    fun setAutoOpen(ctx: Context, v: Boolean) = sp(ctx).edit().putBoolean("auto_open", v).apply()

    // Keep the screen awake so capture keeps working on a dedicated / charging device.
    fun keepAwake(ctx: Context): Boolean = sp(ctx).getBoolean("keep_awake", false)
    fun setKeepAwake(ctx: Context, v: Boolean) = sp(ctx).edit().putBoolean("keep_awake", v).apply()

    // Auto-capture row tap positions — vertical % of the screen where the Paytm payments
    // list draws its transaction rows. Configurable so a different phone/layout can be
    // tuned without a new build. Accepts "68,72,78,..." (percent) or "0.68,0.72,..".
    private const val DEFAULT_ROW_POS = "68,71,74,78,82,86,90"
    fun rowPositionsRaw(ctx: Context): String = sp(ctx).getString("row_pos", "")?.ifBlank { DEFAULT_ROW_POS } ?: DEFAULT_ROW_POS
    fun rowPositions(ctx: Context): List<Double> {
        val parsed = rowPositionsRaw(ctx).split(",")
            .mapNotNull { it.trim().toDoubleOrNull() }
            .map { if (it > 1.0) it / 100.0 else it }
            .filter { it in 0.05..0.98 }
        return parsed.ifEmpty { DEFAULT_ROW_POS.split(",").map { it.toDouble() / 100.0 } }
    }
    fun setRowPositions(ctx: Context, s: String) = sp(ctx).edit().putString("row_pos", s.trim()).apply()

    // Debug: when set to a future epoch-ms, the accessibility service uploads the full
    // node tree (text + view-id + class + bounds) of each distinct Paytm screen so the
    // real structure can be inspected server-side. Auto-expires.
    fun debugDumpUntil(ctx: Context): Long = sp(ctx).getLong("debug_until", 0L)
    fun setDebugDumpUntil(ctx: Context, until: Long) = sp(ctx).edit().putLong("debug_until", until).apply()

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

    // Capture-command ids already surfaced to the merchant, so the 15-second poll doesn't
    // re-notify for a request the server keeps returning (SENT) until its RRN lands. Capped.
    fun commandSeen(ctx: Context, id: String): Boolean = sp(ctx).getStringSet("cmd_seen", emptySet())?.contains(id) == true
    fun markCommandSeen(ctx: Context, id: String) {
        val cur = LinkedHashSet(sp(ctx).getStringSet("cmd_seen", emptySet()) ?: emptySet())
        cur.add(id)
        while (cur.size > 200) cur.remove(cur.iterator().next())
        sp(ctx).edit().putStringSet("cmd_seen", cur).apply()
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
