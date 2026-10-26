package dev.thingmaker.remote

import android.app.Activity
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.content.pm.PackageInstaller
import android.graphics.Color
import android.net.Uri
import android.os.Bundle
import android.provider.Settings
import android.view.Gravity
import android.view.View
import android.view.ViewGroup.LayoutParams.MATCH_PARENT
import android.view.ViewGroup.LayoutParams.WRAP_CONTENT
import android.widget.Button
import android.widget.LinearLayout
import android.widget.ProgressBar
import android.widget.TextView
import okhttp3.OkHttpClient
import okhttp3.Request
import java.io.File
import java.security.MessageDigest
import java.security.cert.CertificateException
import java.security.cert.X509Certificate
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.TimeUnit
import javax.net.ssl.SSLContext
import javax.net.ssl.X509TrustManager
import kotlin.concurrent.thread

/**
 * Where to fetch an offered app on the computer's own Wi-Fi: its address,
 * the key that opens this one offer, and the SHA-256 of the certificate it
 * is served with — the only one trusted there.
 */
data class Nearby(val url: String, val key: String, val cert: String)

/** An app the computer offered: what to fetch and how to check it. */
data class Offer(val id: String, val name: String, val size: Long, val sha256: String, val from: String, val nearby: Nearby? = null) {
    fun into(intent: Intent): Intent = intent.putExtra("id", id).putExtra("name", name).putExtra("size", size).putExtra("sha256", sha256).putExtra("from", from)
        .putExtra("nearbyUrl", nearby?.url).putExtra("nearbyKey", nearby?.key).putExtra("nearbyCert", nearby?.cert)

    companion object {
        fun from(intent: Intent): Offer? {
            val id = intent.getStringExtra("id") ?: return null
            val url = intent.getStringExtra("nearbyUrl")
            val key = intent.getStringExtra("nearbyKey")
            val cert = intent.getStringExtra("nearbyCert")
            val nearby = if (url != null && key != null && cert != null) Nearby(url, key, cert) else null
            return Offer(id, intent.getStringExtra("name") ?: "app.apk", intent.getLongExtra("size", 0), intent.getStringExtra("sha256") ?: "", intent.getStringExtra("from") ?: "", nearby)
        }
    }
}

/**
 * Installs an app the computer sent: asks Android for permission to install
 * apps the first time, downloads it — straight from the computer when this
 * phone is on its Wi-Fi, over the phone bridge otherwise — checks it is the
 * file the computer offered, and hands it to Android's installer, which asks
 * you to confirm.
 */
class InstallActivity : Activity() {
    private lateinit var offer: Offer
    private lateinit var title: TextView
    private lateinit var status: TextView
    private lateinit var progress: ProgressBar
    private lateinit var action: Button
    private var started = false

    override fun attachBaseContext(newBase: Context) = super.attachBaseContext(AppSettings.localized(newBase))

    /** Who sent it, in this phone's language when the computer gave no name. */
    private val sender get() = offer.from.ifBlank { getString(R.string.the_computer) }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        offer = Offer.from(intent) ?: return finish()
        title = text("", 22f, Color.WHITE)
        status = text("", 15f, PairActivity.MUTED)
        progress = ProgressBar(this, null, android.R.attr.progressBarStyleHorizontal).apply { max = 1000; visibility = View.INVISIBLE }
        action = Button(this).apply { isAllCaps = false; visibility = View.GONE }
        setContentView(LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            gravity = Gravity.CENTER_VERTICAL
            setPadding(dp(28), dp(28), dp(28), dp(28))
            setBackgroundColor(PairActivity.BACKGROUND)
            // Edge to edge: the bars add to the margin rather than replace it.
            setOnApplyWindowInsetsListener { view, insets ->
                val bars = insets.getInsets(android.view.WindowInsets.Type.systemBars())
                view.setPadding(dp(28) + bars.left, dp(28) + bars.top, dp(28) + bars.right, dp(28) + bars.bottom)
                insets
            }
            addView(title)
            addView(status)
            addView(progress, LinearLayout.LayoutParams(MATCH_PARENT, WRAP_CONTENT).apply { topMargin = dp(16) })
            addView(action, LinearLayout.LayoutParams(WRAP_CONTENT, WRAP_CONTENT).apply { topMargin = dp(20) })
        })
        title.text = getString(R.string.install_title, offer.name)
        current = this
    }

    override fun onResume() {
        super.onResume()
        // Back from Android's settings, or opened from the notification.
        if (!started) begin()
    }

    override fun onDestroy() {
        if (current === this) current = null
        super.onDestroy()
    }

    private fun begin() {
        if (!packageManager.canRequestPackageInstalls()) {
            say(getString(R.string.install_permission, sender, size(offer.size)))
            button(getString(R.string.install_open_settings)) { startActivity(Intent(Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES, Uri.parse("package:$packageName"))) }
            return
        }
        started = true
        action.visibility = View.GONE
        progress.visibility = View.VISIBLE
        say(getString(R.string.install_downloading, sender))
        // Opened again (from the notification, say) while it downloads: this
        // screen shows the download already under way rather than start another.
        if (!DOWNLOADING.add(offer.id)) return
        thread {
            try {
                download()
            } finally {
                DOWNLOADING.remove(offer.id)
            }
        }
    }

    private fun download() {
        val pairing = Pairing.load(this) ?: return fail(getString(R.string.install_not_paired))
        val target = File(cacheDir, "apks").apply { mkdirs() }.resolve("${offer.id}.apk")
        var lastError = getString(R.string.install_unreachable)
        // The computer's Wi-Fi first: a phone elsewhere fails to connect in
        // a moment and takes the bridge.
        val roads = buildList {
            offer.nearby?.let { nearby -> add(nearbyClient(nearby) to Request.Builder().url(nearby.url).header("Authorization", "Bearer ${nearby.key}").build()) }
            add(HTTP to pairing.authorize(Request.Builder().url("${pairing.url}/v1/apk/${offer.id}").header("Authorization", "Bearer ${pairing.token}")).build())
        }
        for ((client, request) in roads) {
            val digest = MessageDigest.getInstance("SHA-256")
            try {
                client.newCall(request).execute().use { response ->
                    if (!response.isSuccessful) {
                        lastError = response.body?.string()?.take(200) ?: getString(R.string.install_refused, response.code)
                        return@use
                    }
                    val body = response.body ?: return@use
                    val total = body.contentLength().takeIf { it > 0 } ?: offer.size
                    var read = 0L
                    target.outputStream().use { out ->
                        body.byteStream().use { input ->
                            val buffer = ByteArray(256 * 1024)
                            while (true) {
                                val count = input.read(buffer)
                                if (count < 0) break
                                out.write(buffer, 0, count)
                                digest.update(buffer, 0, count)
                                read += count
                                val done = read
                                ui { it.progress.progress = ((done * 1000) / total.coerceAtLeast(1)).toInt() }
                            }
                        }
                    }
                    val sha = digest.digest().joinToString("") { "%02x".format(it) }
                    if (!sha.equals(offer.sha256, ignoreCase = true)) {
                        target.delete()
                        return fail(getString(R.string.install_mismatch, sender))
                    }
                    return install(target)
                }
            } catch (error: Exception) {
                lastError = getString(R.string.install_download_failed, error.message ?: "")
            }
        }
        fail(lastError)
    }

    private fun install(file: File) {
        ui {
            it.progress.isIndeterminate = true
            it.status.text = getString(R.string.install_confirm)
        }
        // An update of this app ends this app: it reports back when it starts again.
        if (packageManager.getPackageArchiveInfo(file.path, 0)?.packageName == packageName) {
            getSharedPreferences("install", Context.MODE_PRIVATE).edit().putString("selfUpdate", offer.id).apply()
        }
        try {
            val installer = packageManager.packageInstaller
            val params = PackageInstaller.SessionParams(PackageInstaller.SessionParams.MODE_FULL_INSTALL).apply { setSize(file.length()) }
            val sessionId = installer.createSession(params)
            installer.openSession(sessionId).use { session ->
                session.openWrite("app", 0, file.length()).use { out ->
                    file.inputStream().use { it.copyTo(out, 256 * 1024) }
                    session.fsync(out)
                }
                val result = Intent(this, InstallReceiver::class.java).putExtra("id", offer.id).putExtra("name", offer.name).putExtra("file", file.path)
                val pending = PendingIntent.getBroadcast(this, sessionId, result, PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_MUTABLE)
                session.commit(pending.intentSender)
            }
            BridgeService.report(this, offer.id, "confirm", null)
        } catch (error: Exception) {
            file.delete()
            fail(getString(R.string.install_start_failed, error.message ?: ""))
        }
    }

    /** What Android's installer decided, from [InstallReceiver]. */
    fun finished(ok: Boolean, message: String) {
        progress.visibility = View.INVISIBLE
        say(message)
        button(getString(if (ok) R.string.done else R.string.close)) { finish() }
    }

    private fun fail(message: String) {
        BridgeService.report(this, offer.id, "failed", message)
        ui { it.finished(false, message) }
    }

    private fun say(message: String) = runOnUiThread { status.text = message }

    /** A change to the screen showing this download: this one, or the one opened since. */
    private fun ui(change: (InstallActivity) -> Unit) = runOnUiThread { change(current?.takeIf { it.offer.id == offer.id } ?: this) }

    /** A client that trusts the computer's own certificate, and nothing else, at its own address. */
    private fun nearbyClient(nearby: Nearby): OkHttpClient {
        val trust = object : X509TrustManager {
            override fun checkClientTrusted(chain: Array<X509Certificate>, authType: String) = throw CertificateException("not a server")
            override fun checkServerTrusted(chain: Array<X509Certificate>, authType: String) {
                val seen = MessageDigest.getInstance("SHA-256").digest(chain.first().encoded).joinToString("") { "%02x".format(it) }
                if (!seen.equals(nearby.cert, ignoreCase = true)) throw CertificateException("not the computer's certificate")
            }
            override fun getAcceptedIssuers(): Array<X509Certificate> = emptyArray()
        }
        val tls = SSLContext.getInstance("TLS").apply { init(null, arrayOf(trust), null) }
        val host = Uri.parse(nearby.url).host
        return HTTP.newBuilder()
            .connectTimeout(3, TimeUnit.SECONDS)
            .readTimeout(20, TimeUnit.SECONDS)
            .retryOnConnectionFailure(false)
            .sslSocketFactory(tls.socketFactory, trust)
            .hostnameVerifier { name, _ -> name == host }
            .build()
    }

    private fun button(label: String, onClick: () -> Unit) {
        action.text = label
        action.visibility = View.VISIBLE
        action.setOnClickListener { onClick() }
    }

    private fun text(value: String, size: Float, color: Int) = TextView(this).apply {
        text = value
        textSize = size
        setTextColor(color)
        setPadding(0, dp(8), 0, dp(8))
    }

    private fun dp(value: Int) = (value * resources.displayMetrics.density).toInt()

    companion object {
        @Volatile
        var current: InstallActivity? = null
        /** Offers being downloaded now, one download each. */
        private val DOWNLOADING: MutableSet<String> = ConcurrentHashMap.newKeySet()
        private val HTTP = OkHttpClient.Builder().connectTimeout(5, TimeUnit.SECONDS).readTimeout(60, TimeUnit.SECONDS).build()

        fun size(bytes: Long): String = when {
            bytes >= 1024L * 1024 * 1024 -> "%.1f GB".format(bytes / (1024.0 * 1024 * 1024))
            bytes >= 1024L * 1024 -> "%.0f MB".format(bytes / (1024.0 * 1024))
            else -> "${bytes / 1024} KB"
        }
    }
}
