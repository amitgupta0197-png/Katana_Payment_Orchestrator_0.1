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

    // ── Capture counters ─────────────────────────────────────────────────────
    // Sent on every heartbeat. Without these a deaf phone is indistinguishable from a
    // quiet one: a real ₹250 payment was dropped by the parser on 2026-08-05 and nothing
    // anywhere recorded that it had even been seen. "dropped" is the number that matters —
    // notifications that looked like money and could not be parsed.
    fun bump(ctx: Context, key: String, by: Int = 1) {
        val k = "ctr_$key"
        sp(ctx).edit().putInt(k, sp(ctx).getInt(k, 0) + by).apply()
    }
    fun counter(ctx: Context, key: String): Int = sp(ctx).getInt("ctr_$key", 0)
    fun countersSnapshot(ctx: Context): Map<String, Int> =
        listOf("seen", "parsed", "dropped", "uploaded", "capture_try", "capture_ok", "capture_fail",
               // Burst diagnostics: a payment whose capture ran out of time, and one that was
               // never opened at all because the queue was already full. Both mean "an RRN this
               // phone should have fetched and did not", which is otherwise invisible.
               "capture_timeout", "capture_drop",
               // The two silent losses, added 2026-08-21 after eighteen Paytm payments were taken
               // and one was captured with every existing counter except capture_try standing
               // still. `noclip` = the Copy tap fired and the clipboard never carried the
               // reference; `giveup` = four of those, after which the payment is abandoned for
               // good. Between them they are the difference between a quiet day and a lost one.
               "capture_noclip", "capture_giveup")
            .associateWith { counter(ctx, it) }

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

    /**
     * An identity the merchant cannot type, and therefore cannot duplicate.
     *
     * `deviceId` is user-editable, which is what allowed two different phones to both be named
     * "author 😎" on 2026-08-21: device_id is the primary key server-side, so they shared one
     * enrolment row and whichever heartbeat arrived last owned the banker binding. The other
     * banker went dark for a day while its dashboard still read "online · ready".
     *
     * This is derived once from ANDROID_ID and never exposed in the UI. It does not replace
     * device_id — renaming a phone must not re-enrol it — it just lets the server tell "the same
     * phone, renamed" apart from "a second phone claiming the same name", which is the one
     * distinction the heuristic in migration 0020 could only guess at.
     */
    fun installId(ctx: Context): String {
        val store = sp(ctx)
        store.getString("install_id", null)?.takeIf { it.isNotBlank() }?.let { return it }
        val androidId = try {
            Settings.Secure.getString(ctx.contentResolver, Settings.Secure.ANDROID_ID)
        } catch (e: Exception) { null }
        val seed = androidId?.takeIf { it.isNotBlank() && it != "9774d56d682e549c" }
            ?: UUID.randomUUID().toString().replace("-", "")
        val generated = seed.lowercase().take(16)
        store.edit().putString("install_id", generated).apply()
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
    //
    // Default ON since 2026-08-05. It was off, and that silently broke the whole on-demand
    // path: CommandPoller only re-sweeps `if (Prefs.autoCapture(ctx))`, so every dashboard
    // "Get RRN" request was received, logged, and then dropped — four in a row expired
    // unanswered on a phone that was otherwise correctly configured (TRUSTED, accessibility
    // on, Paytm selected). A capture agent that cannot answer a capture request is not a
    // useful default.
    //
    // This DRIVES THE FOREGROUND — it opens each payment and presses Back — so it assumes a
    // dedicated capture phone. Anyone using the phone for other things can turn it off in
    // the app; an explicit choice is stored and this default no longer applies to them.
    fun autoCapture(ctx: Context): Boolean = sp(ctx).getBoolean("auto_capture", true)
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
    //
    // DEFAULT ON since 2026-08-21. It was off, and that made capture depend on a USB cable:
    // with the phone plugged in, Android's "stay awake while charging" holds the display on and
    // everything works; unplug it and the screen sleeps, at which point takeScreenshot() returns
    // nothing, dispatchGesture() has no screen to tap, and ClipReaderActivity can never take
    // focus to read the clipboard. Capture does not degrade — it stops completely, and the
    // dashboard still showed the phone "online · ready" throughout.
    //
    // Same reasoning as autoCapture: this assumes a dedicated capture phone left on a charger.
    // Anyone using the phone for other things can turn it off, and that explicit choice is
    // stored, so this default no longer applies to them.
    fun keepAwake(ctx: Context): Boolean = sp(ctx).getBoolean("keep_awake", true)
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
