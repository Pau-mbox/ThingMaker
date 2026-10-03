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
 * its Tailscale address and the code. The Mac answers with this phone's own
 * token, which is all the app keeps.
 */
class PairActivity : Activity() {
    private lateinit var status: TextView
    private lateinit var address: EditText
    private lateinit var code: EditText

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
                    "This phone and the Mac must both be signed in to Tailscale with the same account.",
                15f, MUTED,
            ),
        )
        column.addView(button("Scan the QR code") { scan() })
        column.addView(text("Or type them in", 13f, MUTED).apply { setPadding(0, dp(28), 0, dp(6)) })
        address = field("Mac's Tailscale address, e.g. 100.101.12.34", InputType.TYPE_CLASS_TEXT or InputType.TYPE_TEXT_VARIATION_URI)
        code = field("Code shown on the Mac", InputType.TYPE_CLASS_TEXT or InputType.TYPE_TEXT_FLAG_CAP_CHARACTERS)
        column.addView(address)
        column.addView(code)
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
        val host = address.text.toString().trim().removePrefix("http://").substringBefore('/')
        val (ip, port) = if (':' in host) host.substringBefore(':') to (host.substringAfter(':').toIntOrNull() ?: 47321) else host to 47321
        val value = code.text.toString().replace(" ", "").trim()
        if (ip.isEmpty() || value.isEmpty()) return say("Type the Mac's address and the code it shows.")
        pair(PairingOffer("Mac", listOf(ip), port, value))
    }

    private fun pair(offer: PairingOffer) {
        say("Reaching ${offer.name}…")
        thread {
            val body = JSONObject().put("code", offer.code).put("deviceName", "${Build.MANUFACTURER} ${Build.MODEL}").toString()
            var last = "No address answered. Is Tailscale on, on both devices?"
            for (host in offer.hosts) {
                try {
                    val request = Request.Builder().url("http://$host:${offer.port}/v1/pair").post(body.toRequestBody(JSON)).build()
                    HTTP.newCall(request).execute().use { response ->
                        val json = JSONObject(response.body?.string() ?: "{}")
                        if (!response.isSuccessful) {
                            last = json.optString("error", "The Mac refused the code.")
                            return@use
                        }
                        val pairing = Pairing(offer.hosts, offer.port, json.getString("token"), json.optString("name", offer.name), json.optString("deviceId"))
                        // The host that answered goes first next time.
                        Pairing.save(this, pairing.copy(hosts = listOf(host) + offer.hosts.filter { it != host }))
                        runOnUiThread {
                            startActivity(Intent(this, MainActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_CLEAR_TOP))
                            finish()
                        }
                        return@thread
                    }
                } catch (error: Exception) {
                    last = "Could not reach $host: ${error.message}"
                }
            }
            runOnUiThread { say(last) }
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
