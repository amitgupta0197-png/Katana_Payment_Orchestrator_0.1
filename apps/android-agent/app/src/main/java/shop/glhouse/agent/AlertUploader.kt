package shop.glhouse.agent

import android.content.Context
import okhttp3.Call
import okhttp3.Callback
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import okhttp3.Response
import org.json.JSONObject
import java.io.IOException
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale
import java.util.UUID
import java.util.concurrent.TimeUnit

// Uploads captured credit alerts + heartbeats to the orchestrator. Sandbox auth
// (x-sandbox header). Failed alert uploads are persisted to OutboxStore and retried,
// so a real bank credit is never lost to a transient network/server issue.
object AlertUploader {
    private val client = OkHttpClient.Builder()
        .callTimeout(20, TimeUnit.SECONDS)
        .build()
    private val JSON = "application/json; charset=utf-8".toMediaType()
    private val time = SimpleDateFormat("HH:mm:ss", Locale.US)
    private const val PARSER_VERSION = "1.0"

    private fun buildAlertBody(ctx: Context, txn: ParsedTxn, source: String, sender: String?): String =
        JSONObject().apply {
            put("source", source)
            put("device_id", Prefs.deviceId(ctx))
            Prefs.merchantCode(ctx).takeIf { it.isNotBlank() }?.let { put("merchant_id", it) }
            put("direction", "CREDIT")
            put("amount", txn.amount)
            put("nonce", UUID.randomUUID().toString())
            put("parser_version", PARSER_VERSION)
            sender?.let { put("sender", it) }
            txn.bank?.let { put("bank", it) }
            txn.utr?.let { put("utr", it) }
            txn.orderRef?.let { put("order_ref", it) }
            txn.payerVpa?.let { put("payer_vpa", it) }
            txn.payerName?.let { put("payer_name", it) }
            put("raw", txn.raw.take(2000))
        }.toString()

    // Capture-time send: async so it never blocks an SMS/notification callback. On
    // network failure the body is queued for retry.
    fun send(ctx: Context, txn: ParsedTxn, source: String, sender: String?) {
        if (!Prefs.enabled(ctx)) return
        val body = buildAlertBody(ctx, txn, source, sender)
        val url = Prefs.baseUrl(ctx).trimEnd('/') + "/api/v1/txn-alert"
        val tag = "${time.format(Date())} ${summary(txn, source)}"
        client.newCall(alertRequest(url, body)).enqueue(object : Callback {
            override fun onFailure(call: Call, e: IOException) {
                OutboxStore.enqueue(ctx, body)
                AlertStore.log(ctx, "$tag ⏳ queued — ${e.message}")
            }
            override fun onResponse(call: Call, response: Response) {
                response.use {
                    if (it.isSuccessful) {
                        val outcome = runCatching { JSONObject(it.body?.string() ?: "").optString("outcome", "?") }.getOrDefault("?")
                        AlertStore.log(ctx, "$tag ✓ → $outcome")
                    } else if (it.code in 500..599) {
                        OutboxStore.enqueue(ctx, body)
                        AlertStore.log(ctx, "$tag ⏳ queued — HTTP ${it.code}")
                    } else {
                        AlertStore.log(ctx, "$tag ✗ HTTP ${it.code}")
                    }
                }
            }
        })
    }

    // On-device RRN capture (accessibility engine) → same ingest pipe as a bank alert.
    // The captured 12-digit RRN rides in as `utr` so the reconciler can attach it to the
    // matching credit and close any open "Get RRN" request; tagged source=ACCESSIBILITY
    // and stamped with the merchant code so the RRN maps to the right merchant.
    fun sendCapture(ctx: Context, rec: RrnRecord) {
        if (!Prefs.enabled(ctx)) return
        val raw = listOf(rec.maskedRef, rec.paidAt).filter { it.isNotBlank() }.joinToString("  ·  ")
        val txn = ParsedTxn(
            amount = parseAmount(rec.amount),
            utr = rec.rrn,
            payerVpa = rec.upiId.ifBlank { null },
            payerName = rec.payer.ifBlank { null },
            bank = "PAYTM",
            raw = raw.ifBlank { rec.rrn },
        )
        send(ctx, txn, "ACCESSIBILITY", "PAYTM")
    }

    // "₹3,000" / "₹1,234.56" → 3000.0 / 1234.56; 0.0 when no number is present.
    private fun parseAmount(s: String): Double =
        s.replace(",", "").replace(Regex("[^0-9.]"), "").toDoubleOrNull() ?: 0.0

    private fun alertRequest(url: String, body: String): Request =
        Request.Builder().url(url).header("x-sandbox", "1").post(body.toRequestBody(JSON)).build()

    // A pending on-demand RRN capture request raised from the dashboard "Get RRN" button.
    data class CaptureCmd(val id: String, val amount: Double, val payerVpa: String?)

    // Poll the server for open capture requests for this device's merchant. Blocking;
    // called from the CommandPoller loop. Returns [] on any error (never throws). The
    // GET also atomically flips PENDING requests to SENT server-side.
    fun fetchCommands(ctx: Context): List<CaptureCmd> {
        val merchant = Prefs.merchantCode(ctx)
        if (merchant.isBlank()) return emptyList()
        val base = Prefs.baseUrl(ctx).trimEnd('/')
        val url = "$base/api/v1/capture-rrn?device_id=${enc(Prefs.deviceId(ctx))}&merchant_id=${enc(merchant)}"
        val req = Request.Builder().url(url).header("x-sandbox", "1").get().build()
        return try {
            client.newCall(req).execute().use { resp ->
                if (!resp.isSuccessful) return emptyList()
                val arr = JSONObject(resp.body?.string() ?: "").optJSONArray("commands") ?: return emptyList()
                (0 until arr.length()).mapNotNull { i ->
                    val o = arr.optJSONObject(i) ?: return@mapNotNull null
                    val id = o.optString("id", ""); if (id.isBlank()) return@mapNotNull null
                    CaptureCmd(id, o.optDouble("amount", 0.0), o.optString("payer_vpa", "").ifBlank { null })
                }
            }
        } catch (e: Exception) { emptyList() }
    }

    private fun enc(s: String): String = java.net.URLEncoder.encode(s, "UTF-8")

    // Blocking POST (for the background worker / outbox flush). Returns true on 2xx.
    private fun postSync(url: String, body: String): Boolean = try {
        client.newCall(alertRequest(url, body)).execute().use { it.isSuccessful }
    } catch (e: Exception) { false }

    // Retry queued alerts. Re-enqueues any that still fail. Safe to call from a
    // background thread (worker, app resume).
    fun flushOutbox(ctx: Context): Int {
        val url = Prefs.baseUrl(ctx).trimEnd('/') + "/api/v1/txn-alert"
        var sent = 0
        for (body in OutboxStore.drain(ctx)) {
            if (postSync(url, body)) sent++ else OutboxStore.enqueue(ctx, body)
        }
        if (sent > 0) AlertStore.log(ctx, "${time.format(Date())} ✓ flushed $sent queued")
        return sent
    }

    private fun heartbeatBody(ctx: Context, notifAccess: Boolean): String =
        JSONObject().apply {
            put("device_id", Prefs.deviceId(ctx))
            Prefs.merchantCode(ctx).takeIf { it.isNotBlank() }?.let { put("merchant_id", it) }
            put("label", Prefs.deviceLabel())
            put("app_version", PARSER_VERSION)
            put("notif_access", notifAccess)
            put("agent_enabled", Prefs.enabled(ctx))
        }.toString()

    fun heartbeat(ctx: Context, notifAccess: Boolean) {
        val url = Prefs.baseUrl(ctx).trimEnd('/') + "/api/v1/device/heartbeat"
        client.newCall(alertRequest(url, heartbeatBody(ctx, notifAccess))).enqueue(object : Callback {
            override fun onFailure(call: Call, e: IOException) {}
            override fun onResponse(call: Call, response: Response) {
                response.use { saveMerchantStatus(ctx, it) }
            }
        })
    }

    // Blocking heartbeat for the worker.
    fun heartbeatSync(ctx: Context, notifAccess: Boolean) {
        val url = Prefs.baseUrl(ctx).trimEnd('/') + "/api/v1/device/heartbeat"
        try { client.newCall(alertRequest(url, heartbeatBody(ctx, notifAccess))).execute().use { saveMerchantStatus(ctx, it) } }
        catch (e: Exception) { /* ignore */ }
    }

    private fun saveMerchantStatus(ctx: Context, resp: Response) {
        if (Prefs.merchantCode(ctx).isBlank()) return
        runCatching {
            val o = JSONObject(resp.body?.string() ?: "")
            Prefs.setMerchantStatus(ctx, o.optBoolean("merchant_known", false), o.optString("merchant_name", ""))
        }
    }

    // Connect the merchant's Gmail (for the server-side EMAIL capture channel). Sends
    // the address + app password to the server, which stores it and IMAP-polls it. The
    // callback reports whether the server could log in to the inbox.
    fun saveEmailConfig(ctx: Context, email: String, appPassword: String, cb: (Boolean, String) -> Unit) {
        val body = JSONObject().apply {
            put("device_id", Prefs.deviceId(ctx))
            Prefs.merchantCode(ctx).takeIf { it.isNotBlank() }?.let { put("merchant_id", it) }
            put("email", email.trim())
            if (appPassword.isNotBlank()) put("app_password", appPassword.trim())
        }.toString()
        val url = Prefs.baseUrl(ctx).trimEnd('/') + "/api/v1/device/email-config"
        client.newCall(alertRequest(url, body)).enqueue(object : Callback {
            override fun onFailure(call: Call, e: IOException) { cb(false, e.message ?: "network error") }
            override fun onResponse(call: Call, response: Response) {
                response.use {
                    val txt = it.body?.string() ?: ""
                    if (it.isSuccessful) {
                        val ok = runCatching { JSONObject(txt).optBoolean("ok", false) }.getOrDefault(false)
                        val status = runCatching { JSONObject(txt).optString(if (ok) "status" else "error", "") }.getOrDefault("")
                        cb(ok, status)
                    } else {
                        val err = runCatching { JSONObject(txt).optString("error", "HTTP ${it.code}") }.getOrDefault("HTTP ${it.code}")
                        cb(false, err)
                    }
                }
            }
        })
    }

    private fun summary(txn: ParsedTxn, source: String): String =
        "₹${txn.amount} ${txn.utr ?: "no-utr"} [$source]"
}
