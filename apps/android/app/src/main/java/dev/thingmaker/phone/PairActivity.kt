package dev.thingmaker.phone

import android.app.Activity
import android.content.Intent
import android.graphics.Color
import android.os.Build
import android.os.Bundle
import android.text.InputType
import android.view.Gravity
import android.view.ViewGroup.LayoutParams.MATCH_PARENT
import android.view.ViewGroup.LayoutParams.WRAP_CONTENT
import android.widget.Button
import android.widget.EditText
import android.widget.LinearLayout
import android.widget.ScrollView
import android.widget.TextView
import com.google.mlkit.vision.barcode.common.Barcode
import com.google.mlkit.vision.codescanner.GmsBarcodeScannerOptions
import com.google.mlkit.vision.codescanner.GmsBarcodeScanning
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import org.json.JSONObject
import java.util.concurrent.TimeUnit
import kotlin.concurrent.thread

/**
 * Pairing with a Mac: scan the QR code its Settings → Phone shows, or type
 * the relay's address, the code and the Access token. The Mac answers with this phone's own
 * token, which is all the app keeps.
 */
class PairActivity : Activity() {
    private lateinit var status: TextView
    private lateinit var address: EditText
    private lateinit var code: EditText
    private lateinit var accessId: EditText
    private lateinit var accessSecret: EditText

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        val column = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            setPadding(dp(24), dp(48), dp(24), dp(24))
            setBackgroundColor(BACKGROUND)
        }
        column.addView(text("Pair with a Mac", 24f, Color.WHITE))
        column.addView(
            text(
                "On the Mac, open ThingMaker → Settings → Phone, turn on phone access and press Pair a phone. " +
                    "The phone reaches the Mac through your relay on Cloudflare, from any network.",
                15f, MUTED,
            ),
        )
        column.addView(button("Scan the QR code") { scan() })
        column.addView(text("Or type them in", 13f, MUTED).apply { setPadding(0, dp(28), 0, dp(6)) })
        address = field("Relay address, e.g. https://thingmaker-relay.you.workers.dev", InputType.TYPE_CLASS_TEXT or InputType.TYPE_TEXT_VARIATION_URI)
        code = field("Code shown on the Mac", InputType.TYPE_CLASS_TEXT or InputType.TYPE_TEXT_FLAG_CAP_CHARACTERS)
        accessId = field("Cloudflare Access client ID (if Access is on)", InputType.TYPE_CLASS_TEXT or InputType.TYPE_TEXT_VARIATION_VISIBLE_PASSWORD)
        accessSecret = field("Cloudflare Access client secret", InputType.TYPE_CLASS_TEXT or InputType.TYPE_TEXT_VARIATION_PASSWORD)
        column.addView(address)
        column.addView(code)
        column.addView(accessId)
        column.addView(accessSecret)
        column.addView(button("Pair") { typed() })
        status = text("", 14f, MUTED).apply { setPadding(0, dp(16), 0, 0) }
        column.addView(status)
        setContentView(ScrollView(this).apply { addView(column, MATCH_PARENT, WRAP_CONTENT); setBackgroundColor(BACKGROUND); fitsSystemWindows = true })
    }

    private fun scan() {
        val options = GmsBarcodeScannerOptions.Builder().setBarcodeFormats(Barcode.FORMAT_QR_CODE).build()
        GmsBarcodeScanning.getClient(this, options).startScan()
            .addOnSuccessListener { barcode ->
                val offer = barcode.rawValue?.let(PairingOffer::parse)
                if (offer == null) say("That is not a ThingMaker pairing code.") else pair(offer)
            }
            .addOnFailureListener { say("The scanner did not start: ${it.message}. Type the address and code instead.") }
    }

    private fun typed() {
        var url = address.text.toString().trim().trimEnd('/')
        if (url.isNotEmpty() && "://" !in url) url = "https://$url"
        val value = code.text.toString().replace(" ", "").trim()
        if (url.isEmpty() || value.isEmpty()) return say("Type the relay's address and the code the Mac shows.")
        pair(PairingOffer("Mac", url, value, accessId.text.toString().trim().ifEmpty { null }, accessSecret.text.toString().trim().ifEmpty { null }))
    }

    private fun pair(offer: PairingOffer) {
        say("Reaching ${offer.name}…")
        thread {
            val body = JSONObject().put("code", offer.code).put("deviceName", "${Build.MANUFACTURER} ${Build.MODEL}").toString()
            val draft = Pairing(offer.url, "", offer.name, "", offer.accessId, offer.accessSecret)
            val message = try {
                val request = draft.authorize(Request.Builder().url("${offer.url}/v1/pair").post(body.toRequestBody(JSON))).build()
                HTTP.newCall(request).execute().use { response ->
                    val text = response.body?.string() ?: ""
                    val json = runCatching { JSONObject(text) }.getOrNull()
                    when {
                        response.isSuccessful && json != null -> {
                            Pairing.save(this, draft.copy(token = json.getString("token"), macName = json.optString("name", offer.name), deviceId = json.optString("deviceId")))
                            runOnUiThread {
                                startActivity(Intent(this, MainActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_CLEAR_TOP))
                                finish()
                            }
                            return@thread
                        }
                        json?.has("error") == true -> json.getString("error")
                        response.code == 503 -> "The relay is up but ThingMaker on the Mac is not connected to it."
                        response.code in listOf(302, 401, 403) -> "Cloudflare Access turned the phone away: check the Access client ID and secret."
                        else -> "The relay answered ${response.code}."
                    }
                }
            } catch (error: Exception) {
                "Could not reach the relay: ${error.message}"
            }
            runOnUiThread { say(message) }
        }
    }

    private fun say(message: String) {
        status.text = message
    }

    private fun dp(value: Int) = (value * resources.displayMetrics.density).toInt()

    private fun text(value: String, size: Float, color: Int) = TextView(this).apply {
        text = value
        textSize = size
        setTextColor(color)
        setPadding(0, dp(6), 0, dp(6))
    }

    private fun field(hint: String, type: Int) = EditText(this).apply {
        this.hint = hint
        inputType = type
        setTextColor(Color.WHITE)
        setHintTextColor(MUTED)
        isSingleLine = true
    }

    private fun button(label: String, onClick: () -> Unit) = Button(this).apply {
        text = label
        isAllCaps = false
        gravity = Gravity.CENTER
        setOnClickListener { onClick() }
        layoutParams = LinearLayout.LayoutParams(MATCH_PARENT, WRAP_CONTENT).apply { topMargin = dp(16) }
    }

    companion object {
        val BACKGROUND = Color.parseColor("#1C1C1C")
        val MUTED = Color.parseColor("#9A9A9A")
        private val JSON = "application/json".toMediaType()
        private val HTTP = OkHttpClient.Builder().connectTimeout(5, TimeUnit.SECONDS).readTimeout(10, TimeUnit.SECONDS).build()
    }
}
