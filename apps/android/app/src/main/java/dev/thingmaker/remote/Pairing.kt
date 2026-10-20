package dev.thingmaker.remote

import android.content.Context
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import android.util.Base64
import okhttp3.Request
import org.json.JSONObject
import java.security.KeyStore
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec

/**
 * The computer this phone is paired with: how it reaches it (its relay on
 * Cloudflare, or the user's own tunnel to it), the Cloudflare Access service
 * token in front of that address if there is one, and the token the
 * computer issued this phone.
 *
 * The secrets — this phone's token and the Access secret — are encrypted
 * with a key that never leaves the Android Keystore, and are read only by
 * native code: the screens never see them.
 */
data class Pairing(
    /** `relay` or `direct`; the phone treats both alike, only the words differ. */
    val mode: String,
    /** The HTTPS address the phone talks to. */
    val url: String,
    val token: String,
    val macName: String,
    val deviceId: String,
    val accessId: String?,
    val accessSecret: String?,
) {
    /** The address's WebSocket form for a path. */
    fun socketUrl(path: String): String = url.replaceFirst("https://", "wss://").replaceFirst("http://", "ws://") + path

    /** Cloudflare Access lets a request through only with these. */
    fun accessHeaders(): Map<String, String> =
        if (accessId.isNullOrBlank() || accessSecret.isNullOrBlank()) emptyMap() else mapOf("CF-Access-Client-Id" to accessId, "CF-Access-Client-Secret" to accessSecret)

    fun authorize(builder: Request.Builder): Request.Builder = builder.apply { accessHeaders().forEach { (name, value) -> header(name, value) } }

    /** The first frame on a socket: who this phone is. */
    fun hello(): String = JSONObject().put("t", "hello").put("token", token).put("client", "thingmaker-remote").toString()

    companion object {
        private const val PREFS = "pairing"

        fun load(context: Context): Pairing? {
            val prefs = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
            val url = prefs.getString("url", null) ?: return null
            val token = Vault.open(prefs.getString("token", null)) ?: return null
            return Pairing(
                mode = prefs.getString("mode", "relay")!!,
                url = url,
                token = token,
                macName = prefs.getString("name", "Computer")!!,
                deviceId = prefs.getString("device", "")!!,
                accessId = prefs.getString("accessId", null),
                accessSecret = Vault.open(prefs.getString("accessSecret", null)),
            )
        }

        fun save(context: Context, pairing: Pairing) {
            context.getSharedPreferences(PREFS, Context.MODE_PRIVATE).edit()
                .clear()
                .putString("mode", pairing.mode)
                .putString("url", pairing.url)
                .putString("token", Vault.seal(pairing.token))
                .putString("name", pairing.macName)
                .putString("device", pairing.deviceId)
                .putString("accessId", pairing.accessId)
                .putString("accessSecret", pairing.accessSecret?.let(Vault::seal))
                .apply()
        }

        fun clear(context: Context) {
            context.getSharedPreferences(PREFS, Context.MODE_PRIVATE).edit().clear().apply()
        }
    }
}

/** AES-GCM with a key kept in the Android Keystore; what it seals is useless without this phone. */
object Vault {
    private const val ALIAS = "thingmaker.pairing"

    private fun key(): SecretKey {
        val store = KeyStore.getInstance("AndroidKeyStore").apply { load(null) }
        (store.getKey(ALIAS, null) as? SecretKey)?.let { return it }
        return KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, "AndroidKeyStore").apply {
            init(
                KeyGenParameterSpec.Builder(ALIAS, KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT)
                    .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
                    .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
                    .build(),
            )
        }.generateKey()
    }

    fun seal(value: String): String {
        val cipher = Cipher.getInstance("AES/GCM/NoPadding").apply { init(Cipher.ENCRYPT_MODE, key()) }
        return Base64.encodeToString(cipher.iv + cipher.doFinal(value.toByteArray(Charsets.UTF_8)), Base64.NO_WRAP)
    }

    fun open(sealed: String?): String? = runCatching {
        val packed = Base64.decode(sealed ?: return null, Base64.NO_WRAP)
        val cipher = Cipher.getInstance("AES/GCM/NoPadding")
        cipher.init(Cipher.DECRYPT_MODE, key(), GCMParameterSpec(128, packed.copyOfRange(0, 12)))
        String(cipher.doFinal(packed.copyOfRange(12, packed.size)), Charsets.UTF_8)
    }.getOrNull()
}

/**
 * What the computer's QR code carries:
 * `thingmaker-pair:{"v":3,"name":…,"mode":…,"url":…,"code":…,"accessId":…,"accessSecret":…}`.
 * Version 2 (relay only, no mode) still reads.
 */
data class PairingOffer(val name: String, val mode: String, val url: String, val code: String, val accessId: String?, val accessSecret: String?) {
    companion object {
        fun parse(text: String): PairingOffer? = runCatching {
            val json = JSONObject(text.trim().removePrefix("thingmaker-pair:"))
            PairingOffer(
                name = json.optString("name", "Computer"),
                mode = json.optString("mode", "relay").ifBlank { "relay" },
                url = json.getString("url").trimEnd('/'),
                code = json.getString("code"),
                accessId = json.optString("accessId").takeIf { it.isNotBlank() && it != "null" },
                accessSecret = json.optString("accessSecret").takeIf { it.isNotBlank() && it != "null" },
            )
        }.getOrNull()
    }
}
