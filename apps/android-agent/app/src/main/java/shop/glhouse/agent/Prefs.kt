package shop.glhouse.agent

import android.content.Context
import android.os.Build
import android.provider.Settings
import java.util.UUID

// Simple SharedPreferences-backed settings store.
object Prefs {
    private const val PREF = "agent_prefs"
    const val DEFAULT_BASE_URL = "https://katanapay.co"
    // Pre-cutover default. Phones installed before the katanapay.co migration have this
    // saved verbatim; baseUrl() silently rewrites it to DEFAULT_BASE_URL on first read.
    private const val LEGACY_BASE_URL = "https://glhouse.shop"

    private fun sp(ctx: Context) = ctx.getSharedPreferences(PREF, Context.MODE_PRIVATE)

    fun baseUrl(ctx: Context): String {
        val stored = sp(ctx).getString("base_url", null)?.trim()?.trimEnd('/')
        // One-time migration to the official domain. A phone still pointing at the old
        // default is moved to the new one; a merchant who typed any other (custom) URL is
        // left untouched. glhouse.shop still serves as an alias, so this is a silent
        // upgrade — nothing was broken, we're just moving installs onto katanapay.co.
        if (stored == LEGACY_BASE_URL) {
            sp(ctx).edit().putString("base_url", DEFAULT_BASE_URL).apply()
            return DEFAULT_BASE_URL
        }
        return stored?.ifBlank { DEFAULT_BASE_URL } ?: DEFAULT_BASE_URL
    }

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

    // Payment apps this merchant receives money on. The accessibility engine only
    // engages the capture flow of the selected apps (Paytm = tap-copy, Airtel = list
    // read), so a Paytm-only phone never reacts to Airtel screens and vice versa.
    // Default: ALL supported apps on, so existing installs keep working unchanged.
    const val APP_PAYTM = "PAYTM"
    const val APP_AIRTEL = "AIRTEL"
    const val APP_GPAY = "GPAY"
    fun captureApps(ctx: Context): Set<String> =
        sp(ctx).getStringSet("capture_apps", null)?.toSet() ?: setOf(APP_PAYTM, APP_AIRTEL, APP_GPAY)
    fun captureAppOn(ctx: Context, app: String): Boolean = captureApps(ctx).contains(app)
    fun setCaptureApp(ctx: Context, app: String, on: Boolean) {
        val next = captureApps(ctx).toMutableSet().also { if (on) it.add(app) else it.remove(app) }
        sp(ctx).edit().putStringSet("capture_apps", next).apply()
    }

    // Keep the screen awake so the accessibility engine can keep reading the Paytm screen
    // on a dedicated capture phone (the screen must be on for on-device RRN capture).
    // Implemented via an invisible FLAG_KEEP_SCREEN_ON overlay ([ScreenAwake]); needs the
    // "Display over other apps" permission (same one auto-capture already requires).
    // Default off. Intended for a phone left plugged in as the capture device.
    fun keepAwake(ctx: Context): Boolean = sp(ctx).getBoolean("keep_awake", false)
    fun setKeepAwake(ctx: Context, v: Boolean) = sp(ctx).edit().putBoolean("keep_awake", v).apply()

    // Whether the last heartbeat actually reached the server. Surfaced in the UI so a
    // merchant whose phone can't reach the server sees "can't reach server" instead of
    // a silent, permanent "(save to verify)". Default false until the first success.
    fun reachable(ctx: Context): Boolean = sp(ctx).getBoolean("reachable", false)
    fun setReachable(ctx: Context, v: Boolean) = sp(ctx).edit().putBoolean("reachable", v).apply()

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
