package dev.thingmaker.remote
import android.content.Context
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import android.util.Base64
import java.security.KeyStore
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec
import kotlinx.coroutines.*
import okhttp3.*
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.RequestBody.Companion.toRequestBody
import org.json.*
import java.util.concurrent.TimeUnit
private const val DEFAULT_URL = "https://thingmaker.jacksparrot.com"
internal class Vault(context: Context) {
    private val prefs = context.getSharedPreferences("connection", Context.MODE_PRIVATE)
    private fun key(): SecretKey {
        val store = KeyStore.getInstance("AndroidKeyStore").apply { load(null) }
        (store.getKey("thingmaker.remote", null) as? SecretKey)?.let { return it }
        return KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, "AndroidKeyStore").apply {
            init(KeyGenParameterSpec.Builder("thingmaker.remote", KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT).setBlockModes(KeyProperties.BLOCK_MODE_GCM).setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE).build())
        }.generateKey()
    }
    fun read(): Pair<String, String> = try {
        val packed = Base64.decode(prefs.getString("secret", ""), Base64.NO_WRAP)
        val cipher = Cipher.getInstance("AES/GCM/NoPadding")
        cipher.init(Cipher.DECRYPT_MODE, key(), GCMParameterSpec(128, packed.copyOfRange(0, 12)))
        Pair(prefs.getString("url", DEFAULT_URL)!!, String(cipher.doFinal(packed.copyOfRange(12, packed.size)), Charsets.UTF_8))
    } catch (_: Exception) { Pair(DEFAULT_URL, "") }
    fun save(url: String, secret: String) {
        val cipher = Cipher.getInstance("AES/GCM/NoPadding").apply { init(Cipher.ENCRYPT_MODE, key()) }
        prefs.edit().putString("url", url).putString("secret", Base64.encodeToString(cipher.iv + cipher.doFinal(secret.toByteArray(Charsets.UTF_8)), Base64.NO_WRAP)).apply()
    }
    fun clear() { prefs.edit().clear().apply() }
}
internal class Api(val url: String, val key: String) {
    private val http = OkHttpClient.Builder().callTimeout(30, TimeUnit.SECONDS).followRedirects(false).followSslRedirects(false).build()
    suspend fun call(operation: String, body: JSONObject = JSONObject()): Any = withContext(Dispatchers.IO) {
        val address = java.net.URI(url)
        require(address.scheme == "https" && address.host != null && address.userInfo == null && address.query == null && address.fragment == null) { "Usa una dirección HTTPS válida" }
        val request = Request.Builder().url("${url.trimEnd('/')}/v1/$operation").header("Authorization", "Bearer $key").post(body.toString().toRequestBody("application/json".toMediaType())).build()
        http.newCall(request).execute().use { response ->
            if (!response.isSuccessful) error(if (response.code == 401) "API key incorrecta o revocada" else "No se pudo conectar (${response.code}). Comprueba que el PC y ThingMaker estén encendidos.")
            JSONTokener(response.body?.string() ?: "null").nextValue()
        }
    }
}
