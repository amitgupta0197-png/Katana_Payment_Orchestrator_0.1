package shop.glhouse.agent

import android.content.Context
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import android.util.Base64
import okhttp3.Call
import okhttp3.Callback
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import okhttp3.Response
import org.json.JSONArray
import org.json.JSONObject
import java.io.IOException
import java.security.KeyStore
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale
import java.util.UUID
import java.util.concurrent.TimeUnit
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.Mac
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec
import javax.crypto.spec.SecretKeySpec

/**
 * BharatPe credits → POST /api/v1/bharatpe/credit, signed with the BharatPe MID's own API key and
 * HMAC secret (staff make them on the banker page → "Pays UPI ID" → BharatPe; shown once).
 *
 *   x-bharatpe-key  bpk_live_… / bpk_test_…
 *   x-timestamp     ms since epoch (server allows ±5 min)
 *   x-signature     hex HMAC-SHA256(secret, "key.timestamp.body")
 *
 * A verified post is a channel-trusted BharatPe credit: the server confirms the banker's matching
 * open order by UTR / amount. A test key confirms test orders only.
 *
 * Without a key on the phone, a capture goes the ordinary way (/api/v1/txn-alert, by device key):
 * it is recorded and shown, but never trusted to confirm an order by itself.
 *
 * The secret is kept encrypted with a key that never leaves the phone's Android Keystore, and is
 * never shown again once saved. A post that fails (network, 5xx) waits in a small queue and is
 * re-signed when retried, because its timestamp would be stale by then.
 */
object BharatpeUploader {
    private const val PREF = "bharatpe"
    private const val K_KEY = "api_key"
    private const val K_SECRET = "secret_sealed"
    private const val K_QUEUE = "queue"
    private const val KS_ALIAS = "katana_bharatpe_secret"
    private const val QUEUE_MAX = 200

    private val client = OkHttpClient.Builder()
        .connectTimeout(10, TimeUnit.SECONDS).readTimeout(20, TimeUnit.SECONDS).build()
    private val json = "application/json".toMediaType()

    private fun sp(ctx: Context) = ctx.getSharedPreferences(PREF, Context.MODE_PRIVATE)

    // ── Credentials ─────────────────────────────────────────────────────────

    private val KEY_RX = Regex("^bpk_(live|test)_[A-Za-z0-9_-]{8,}$")

    fun apiKey(ctx: Context): String = sp(ctx).getString(K_KEY, "") ?: ""
    fun isLive(ctx: Context): Boolean = apiKey(ctx).startsWith("bpk_live_")
    fun configured(ctx: Context): Boolean = apiKey(ctx).isNotBlank() && secret(ctx) != null

    /** Save the MID's key + secret. Returns an error to show, or null when saved. */
    fun save(ctx: Context, key: String, secret: String): String? {
        val k = key.trim(); val s = secret.trim()
        if (!KEY_RX.matches(k)) return "The API key starts with bpk_live_ or bpk_test_"
        if (s.length < 16) return "Paste the whole secret"
        if (s == k) return "That is the API key, not the secret"
        val sealed = seal(s) ?: return "Could not store the secret on this phone"
        sp(ctx).edit().putString(K_KEY, k).putString(K_SECRET, sealed).apply()
        return null
    }

    fun clear(ctx: Context) { sp(ctx).edit().remove(K_KEY).remove(K_SECRET).apply() }

    /** "bpk_test_ab12…9f" — enough to tell which MID is on the phone. */
    fun keyHint(ctx: Context): String = apiKey(ctx).let { if (it.length > 14) it.take(13) + "…" + it.takeLast(2) else it }

    private fun secret(ctx: Context): String? = sp(ctx).getString(K_SECRET, null)?.let { open(it) }

    private fun keystoreKey(): SecretKey {
        val ks = KeyStore.getInstance("AndroidKeyStore").apply { load(null) }
        (ks.getKey(KS_ALIAS, null) as? SecretKey)?.let { return it }
        val gen = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, "AndroidKeyStore")
        gen.init(KeyGenParameterSpec.Builder(KS_ALIAS, KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT)
            .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
            .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
            .build())
        return gen.generateKey()
    }

    private fun seal(plain: String): String? = try {
        val c = Cipher.getInstance("AES/GCM/NoPadding").apply { init(Cipher.ENCRYPT_MODE, keystoreKey()) }
        val ct = c.doFinal(plain.toByteArray(Charsets.UTF_8))
        Base64.encodeToString(c.iv, Base64.NO_WRAP) + ":" + Base64.encodeToString(ct, Base64.NO_WRAP)
    } catch (e: Exception) { null }

    private fun open(sealed: String): String? = try {
        val (iv, ct) = sealed.split(":").let { Base64.decode(it[0], Base64.NO_WRAP) to Base64.decode(it[1], Base64.NO_WRAP) }
        val c = Cipher.getInstance("AES/GCM/NoPadding").apply { init(Cipher.DECRYPT_MODE, keystoreKey(), GCMParameterSpec(128, iv)) }
        String(c.doFinal(ct), Charsets.UTF_8)
    } catch (e: Exception) { null }

    // ── Upload ──────────────────────────────────────────────────────────────

    /**
     * Send one captured BharatPe payment. With no MID key on the phone it goes the ordinary way
     * (txn-alert), so it still shows up as captured.
     */
    fun send(ctx: Context, rec: RrnRecord, key: String? = null) {
        if (!Prefs.enabled(ctx)) return
        if (!configured(ctx)) { AlertUploader.sendCapture(ctx, rec); return }
        val body = JSONObject().apply {
            // The capture key of the push this payment was first posted from: the server adds
            // this UTR to that record instead of recording the payment twice.
            key?.let { put("bharatpe_txn_id", it) }
            put("amount", rec.amount.replace(Regex("[^0-9.]"), ""))
            put("utr", rec.rrn)
            rec.payer.takeIf { it.isNotBlank() }?.let { put("payer_name", it.take(140)) }
            rec.eventTime?.let { put("event_time", it) }
            put("narration", "BharatPe ${rec.paidAt}".trim().take(500))
            put("raw", listOf(rec.payer, rec.paidAt, rec.details?.entries?.joinToString(" · ") { "${it.key}: ${it.value}" })
                .filterNotNull().filter { it.isNotBlank() }.joinToString(" | ").take(2000))
            put("nonce", UUID.randomUUID().toString())
        }.toString()
        post(ctx, body, "₹${rec.amount} ${rec.rrn}")
    }

    /**
     * Post a payment the moment BharatPe announces it (push or in-app banner): amount, payer and
     * time, no UTR yet. A unique-amount order is confirmed at once; the UTR follows under the same
     * [key] once the engine has read the payment's page (send). Only with a MID key: without one
     * the payment is recorded once, when its UTR is read.
     */
    fun sendPush(ctx: Context, amount: Double, payer: String, key: String, at: Long): Boolean {
        if (!Prefs.enabled(ctx) || !configured(ctx)) return false
        val iso = SimpleDateFormat("yyyy-MM-dd'T'HH:mm:ssXXX", Locale.US).format(Date(at))
        val body = JSONObject().apply {
            put("amount", String.format(Locale.US, "%.2f", amount))
            if (payer.isNotBlank()) put("payer_name", payer.take(140))
            put("event_time", iso)
            put("bharatpe_txn_id", key)
            put("narration", "BharatPe: received from ${payer.take(80)}")
            put("raw", "BharatPe push $key ₹$amount from $payer")
            put("nonce", UUID.randomUUID().toString())
        }.toString()
        post(ctx, body, "₹$amount ${payer.take(20)} (push)")
        return true
    }

    private fun request(ctx: Context, body: String): Request? {
        val key = apiKey(ctx); val sec = secret(ctx) ?: return null
        val ts = System.currentTimeMillis().toString()
        val mac = Mac.getInstance("HmacSHA256").apply { init(SecretKeySpec(sec.toByteArray(Charsets.UTF_8), "HmacSHA256")) }
        val sig = mac.doFinal("$key.$ts.$body".toByteArray(Charsets.UTF_8)).joinToString("") { "%02x".format(it) }
        return Request.Builder()
            .url(Prefs.baseUrl(ctx).trimEnd('/') + "/api/v1/bharatpe/credit")
            .header("x-bharatpe-key", key)
            .header("x-timestamp", ts)
            .header("x-signature", sig)
            .post(body.toRequestBody(json))
            .build()
    }

    private fun post(ctx: Context, body: String, what: String) {
        val tag = "${SimpleDateFormat("HH:mm:ss", Locale.US).format(Date())} $what [BHARATPE${if (isLive(ctx)) "" else " TEST"}]"
        val req = request(ctx, body) ?: run { enqueue(ctx, body); AlertStore.log(ctx, "$tag ⏳ queued — secret unreadable"); return }
        client.newCall(req).enqueue(object : Callback {
            override fun onFailure(call: Call, e: IOException) {
                enqueue(ctx, body); AlertStore.log(ctx, "$tag ⏳ queued — ${e.message}")
            }
            override fun onResponse(call: Call, response: Response) {
                response.use {
                    val text = it.body?.string().orEmpty()
                    when {
                        it.isSuccessful -> {
                            val outcome = runCatching { JSONObject(text).optString("outcome", "?") }.getOrDefault("?")
                            AlertStore.log(ctx, "$tag ✓ → $outcome")
                            Prefs.bump(ctx, "uploaded")
                        }
                        it.code in 500..599 -> { enqueue(ctx, body); AlertStore.log(ctx, "$tag ⏳ queued — HTTP ${it.code}") }
                        // 401 / 403: the key was rotated or the MID paused. Kept, so nothing is lost
                        // while staff fix it, and said plainly on the phone.
                        it.code == 401 || it.code == 403 -> {
                            enqueue(ctx, body)
                            val why = runCatching { JSONObject(text).optString("error") }.getOrDefault("")
                            AlertStore.log(ctx, "$tag ✗ BharatPe key refused (${it.code}${if (why.isNotBlank()) ": $why" else ""}) — kept, check the key")
                        }
                        else -> AlertStore.log(ctx, "$tag ✗ HTTP ${it.code} ${text.take(80)}")
                    }
                }
            }
        })
    }

    @Synchronized
    private fun enqueue(ctx: Context, body: String) {
        val q = runCatching { JSONArray(sp(ctx).getString(K_QUEUE, "[]")) }.getOrDefault(JSONArray())
        q.put(body)
        while (q.length() > QUEUE_MAX) q.remove(0)
        sp(ctx).edit().putString(K_QUEUE, q.toString()).apply()
    }

    @Synchronized
    private fun drain(ctx: Context): List<String> {
        val q = runCatching { JSONArray(sp(ctx).getString(K_QUEUE, "[]")) }.getOrDefault(JSONArray())
        sp(ctx).edit().putString(K_QUEUE, "[]").apply()
        return (0 until q.length()).map { q.getString(it) }
    }

    fun queued(ctx: Context): Int = runCatching { JSONArray(sp(ctx).getString(K_QUEUE, "[]")).length() }.getOrDefault(0)

    /** Retry queued posts, blocking (worker thread). Each is signed afresh. */
    fun flush(ctx: Context) {
        if (!configured(ctx)) return
        for (body in drain(ctx)) {
            val req = request(ctx, body) ?: run { enqueue(ctx, body); return }
            val ok = try {
                client.newCall(req).execute().use { r -> r.isSuccessful || (r.code in 400..499 && r.code != 401 && r.code != 403) }
            } catch (e: IOException) { false }
            if (!ok) { enqueue(ctx, body); return }
        }
    }
}
