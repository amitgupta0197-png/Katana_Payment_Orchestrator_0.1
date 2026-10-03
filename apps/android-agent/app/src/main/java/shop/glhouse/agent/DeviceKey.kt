package shop.glhouse.agent

import android.content.Context
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import android.util.Base64
import java.security.KeyFactory
import java.security.KeyPairGenerator
import java.security.KeyStore
import java.security.PrivateKey
import java.security.Signature
import java.security.spec.ECGenParameterSpec
import java.security.spec.PKCS8EncodedKeySpec

// This phone's own signing key.
//
// Every agent used to sign with one secret compiled into the APK, and the APK is a public
// download, so anyone who unpacked it could sign as any phone. From v3.11 each phone makes an
// EC P-256 key pair of its own, keeps the private half and enrols the public half with the
// server (AlertUploader.ensureEnrolled). A request signed with it can only have come from
// this phone.
//
// The key lives in the Android Keystore, where the app can use it and nothing can read it. A
// phone whose Keystore will not make or use the key falls back to one held in the app's own
// preferences: weaker, but still this phone's alone, and far better than the shared secret.
object DeviceKey {
    private const val ALIAS = "katana_agent_device_key"
    private const val KEYSTORE = "AndroidKeyStore"
    private const val PREF = "agent_key"

    private class Held(val private: PrivateKey, val publicB64: String, val inKeystore: Boolean)
    @Volatile private var held: Held? = null

    private fun load(ctx: Context): Held {
        held?.let { return it }
        synchronized(this) {
            held?.let { return it }
            // A phone that already fell back keeps that key: it is the one the server knows.
            val h = fromPrefs(ctx, create = false) ?: fromKeystore() ?: fromPrefs(ctx, create = true)!!
            held = h
            return h
        }
    }

    private fun fromKeystore(): Held? = try {
        val ks = KeyStore.getInstance(KEYSTORE).apply { load(null) }
        if (!ks.containsAlias(ALIAS)) {
            KeyPairGenerator.getInstance(KeyProperties.KEY_ALGORITHM_EC, KEYSTORE).apply {
                initialize(
                    KeyGenParameterSpec.Builder(ALIAS, KeyProperties.PURPOSE_SIGN)
                        .setAlgorithmParameterSpec(ECGenParameterSpec("secp256r1"))
                        .setDigests(KeyProperties.DIGEST_SHA256)
                        .build()
                )
            }.generateKeyPair()
        }
        val private = ks.getKey(ALIAS, null) as PrivateKey
        val public = ks.getCertificate(ALIAS).publicKey
        signWith(private, "probe")   // a Keystore that hands back a key it cannot use is no use
        Held(private, Base64.encodeToString(public.encoded, Base64.NO_WRAP), true)
    } catch (e: Exception) { null }

    private fun fromPrefs(ctx: Context, create: Boolean): Held? {
        val sp = ctx.getSharedPreferences(PREF, Context.MODE_PRIVATE)
        var stored = sp.getString("private", null)?.let { priv -> sp.getString("public", null)?.let { pub -> priv to pub } }
        if (stored == null) {
            if (!create) return null
            val pair = KeyPairGenerator.getInstance("EC").apply { initialize(ECGenParameterSpec("secp256r1")) }.generateKeyPair()
            stored = Base64.encodeToString(pair.private.encoded, Base64.NO_WRAP) to Base64.encodeToString(pair.public.encoded, Base64.NO_WRAP)
            sp.edit().putString("private", stored.first).putString("public", stored.second).apply()
        }
        val key = KeyFactory.getInstance("EC").generatePrivate(PKCS8EncodedKeySpec(Base64.decode(stored.first, Base64.NO_WRAP)))
        return Held(key, stored.second, false)
    }

    private fun signWith(key: PrivateKey, data: String): String {
        val sig = Signature.getInstance("SHA256withECDSA").apply {
            initSign(key)
            update(data.toByteArray(Charsets.UTF_8))
        }.sign()
        return Base64.encodeToString(sig, Base64.NO_WRAP)
    }

    /** Base64 of the public key (X.509 SubjectPublicKeyInfo): what the server is given. */
    fun publicKey(ctx: Context): String = load(ctx).publicB64

    fun inKeystore(ctx: Context): Boolean = load(ctx).inKeystore

    /** Base64 ECDSA signature of `data`, or null if this phone cannot sign (the caller then sends without). */
    fun sign(ctx: Context, data: String): String? = try { signWith(load(ctx).private, data) } catch (e: Exception) { null }
}
