package dev.thingmaker.remote

import android.app.Activity
import android.content.Context
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
import android.widget.RadioButton
import android.widget.RadioGroup
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
 * Pairing with a computer: scan the QR code its Settings → Phone shows, or
 * type how to reach it — through its Cloudflare relay or directly through the
 * user's tunnel — with the code and, if Access is on, its token. The computer
 * answers with this phone's own token.
 */
class PairActivity : Activity() {
    private lateinit var status: TextView
    private lateinit var address: EditText
    private lateinit var code: EditText
    private lateinit var accessId: EditText
    private lateinit var accessSecret: EditText
    private var mode = "relay"

    override fun attachBaseContext(newBase: Context) = super.attachBaseContext(AppSettings.localized(newBase))

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        val column = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            setPadding(dp(24), dp(48), dp(24), dp(24))
            setBackgroundColor(BACKGROUND)
        }
        column.addView(text(getString(R.string.pair_title), 24f, Color.WHITE))
        column.addView(text(getString(R.string.pair_intro), 15f, MUTED))
        column.addView(button(getString(R.string.pair_scan)) { scan() })
        column.addView(text(getString(R.string.pair_or_type), 13f, MUTED).apply { setPadding(0, dp(28), 0, dp(6)) })
        address = field(getString(R.string.pair_address_relay), InputType.TYPE_CLASS_TEXT or InputType.TYPE_TEXT_VARIATION_URI)
        code = field(getString(R.string.pair_code), InputType.TYPE_CLASS_TEXT or InputType.TYPE_TEXT_FLAG_CAP_CHARACTERS)
        accessId = field(getString(R.string.pair_access_id), InputType.TYPE_CLASS_TEXT or InputType.TYPE_TEXT_VARIATION_VISIBLE_PASSWORD)
        accessSecret = field(getString(R.string.pair_access_secret), InputType.TYPE_CLASS_TEXT or InputType.TYPE_TEXT_VARIATION_PASSWORD)
        val modes = RadioGroup(this).apply {
            orientation = RadioGroup.VERTICAL
            listOf("relay" to R.string.pair_mode_relay, "direct" to R.string.pair_mode_direct).forEachIndexed { index, (value, label) ->
                addView(RadioButton(this@PairActivity).apply {
                    id = index + 1
                    text = getString(label)
                    setTextColor(Color.WHITE)
                    isChecked = value == mode
                    setOnClickListener {
                        mode = value
                        address.hint = getString(if (value == "relay") R.string.pair_address_relay else R.string.pair_address_direct)
                    }
                })
            }
        }
        column.addView(modes)
        column.addView(address)
        column.addView(code)
        column.addView(accessId)
        column.addView(accessSecret)
        column.addView(button(getString(R.string.pair_button)) { typed() })
        status = text("", 14f, MUTED).apply { setPadding(0, dp(16), 0, 0) }
        column.addView(status)
        setContentView(ScrollView(this).apply { addView(column, MATCH_PARENT, WRAP_CONTENT); setBackgroundColor(BACKGROUND); fitsSystemWindows = true })
        intent.getStringExtra(MainActivity.DEV_OFFER)?.let(PairingOffer::parse)?.let(::pair)
    }

    private fun scan() {
        val options = GmsBarcodeScannerOptions.Builder().setBarcodeFormats(Barcode.FORMAT_QR_CODE).build()
        GmsBarcodeScanning.getClient(this, options).startScan()
            .addOnSuccessListener { barcode ->
                val offer = barcode.rawValue?.let(PairingOffer::parse)
                if (offer == null) say(getString(R.string.pair_not_a_code)) else pair(offer)
            }
            .addOnFailureListener { say(getString(R.string.pair_scanner_failed, it.message ?: "")) }
    }

    private fun typed() {
        var url = address.text.toString().trim().trimEnd('/')
        if (url.isNotEmpty() && "://" !in url) url = "https://$url"
        val value = code.text.toString().replace(" ", "").trim()
        if (url.isEmpty() || value.isEmpty()) return say(getString(R.string.pair_type_both))
        pair(PairingOffer(getString(R.string.computer), mode, url, value, accessId.text.toString().trim().ifEmpty { null }, accessSecret.text.toString().trim().ifEmpty { null }))
    }

    private fun pair(offer: PairingOffer) {
        say(getString(R.string.pair_reaching, offer.name))
        thread {
            val body = JSONObject().put("code", offer.code).put("deviceName", "${Build.MANUFACTURER} ${Build.MODEL}").toString()
            val draft = Pairing(offer.mode, offer.url, "", offer.name, "", offer.accessId, offer.accessSecret)
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
                        response.code == 503 -> getString(R.string.pair_relay_without_computer)
                        response.code in listOf(302, 401, 403) -> getString(R.string.pair_access_refused)
                        else -> getString(R.string.pair_answered, response.code)
                    }
                }
            } catch (error: Exception) {
                getString(R.string.pair_unreachable, error.message ?: "")
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
