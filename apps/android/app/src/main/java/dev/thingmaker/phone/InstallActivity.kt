package dev.thingmaker.phone

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
import java.util.concurrent.TimeUnit
import kotlin.concurrent.thread

/** An app the Mac offered: what to fetch and how to check it. */
data class Offer(val id: String, val name: String, val size: Long, val sha256: String, val from: String) {
    fun into(intent: Intent): Intent = intent.putExtra("id", id).putExtra("name", name).putExtra("size", size).putExtra("sha256", sha256).putExtra("from", from)

    companion object {
        fun from(intent: Intent): Offer? {
            val id = intent.getStringExtra("id") ?: return null
            return Offer(id, intent.getStringExtra("name") ?: "app.apk", intent.getLongExtra("size", 0), intent.getStringExtra("sha256") ?: "", intent.getStringExtra("from") ?: "the Mac")
        }
    }
}

/**
 * Installs an app the Mac sent: asks Android for permission to install apps
 * the first time, downloads it over the phone bridge, checks it is the file
 * the Mac offered, and hands it to Android's installer, which asks you to
 * confirm.
 */
class InstallActivity : Activity() {
    private lateinit var offer: Offer
    private lateinit var title: TextView
    private lateinit var status: TextView
    private lateinit var progress: ProgressBar
    private lateinit var action: Button
    private var started = false

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
        title.text = "Install ${offer.name}"
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
            say("Sent by ${offer.from} · ${size(offer.size)}\n\nAndroid needs your permission once for ThingMaker to install apps. Turn on “Allow from this source”, then come back.")
            button("Open settings") { startActivity(Intent(Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES, Uri.parse("package:$packageName"))) }
            return
        }
        started = true
        action.visibility = View.GONE
        progress.visibility = View.VISIBLE
        say("Downloading from ${offer.from}…")
        thread { download() }
    }

    private fun download() {
        val pairing = Pairing.load(this) ?: return fail("This phone is not paired.")
        val target = File(cacheDir, "apks").apply { mkdirs() }.resolve("${offer.id}.apk")
        val digest = MessageDigest.getInstance("SHA-256")
        var lastError = "No address of ${pairing.macName} answered."
        for (base in pairing.baseUrls()) {
            try {
                val request = Request.Builder().url("$base/v1/apk/${offer.id}").header("Authorization", "Bearer ${pairing.token}").build()
                HTTP.newCall(request).execute().use { response ->
                    if (!response.isSuccessful) {
                        lastError = response.body?.string()?.take(200) ?: "The Mac refused (${response.code})."
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
                                runOnUiThread { progress.progress = ((done * 1000) / total.coerceAtLeast(1)).toInt() }
                            }
                        }
                    }
                    val sha = digest.digest().joinToString("") { "%02x".format(it) }
                    if (!sha.equals(offer.sha256, ignoreCase = true)) {
                        target.delete()
                        return fail("The download does not match what ${offer.from} sent. Nothing was installed.")
                    }
                    return install(target)
                }
            } catch (error: Exception) {
                lastError = "Could not download: ${error.message}"
            }
        }
        fail(lastError)
    }

    private fun install(file: File) {
        runOnUiThread {
            progress.isIndeterminate = true
            say("Android will ask you to confirm.")
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
            fail("Android could not start the install: ${error.message}")
        }
    }

    /** What Android's installer decided, from [InstallReceiver]. */
    fun finished(ok: Boolean, message: String) {
        progress.visibility = View.INVISIBLE
        say(message)
        button(if (ok) "Done" else "Close") { finish() }
    }

    private fun fail(message: String) {
        BridgeService.report(this, offer.id, "failed", message)
        runOnUiThread { finished(false, message) }
    }

    private fun say(message: String) = runOnUiThread { status.text = message }

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
        private val HTTP = OkHttpClient.Builder().connectTimeout(5, TimeUnit.SECONDS).readTimeout(60, TimeUnit.SECONDS).build()

        fun size(bytes: Long): String = when {
            bytes >= 1024L * 1024 * 1024 -> "%.1f GB".format(bytes / (1024.0 * 1024 * 1024))
            bytes >= 1024L * 1024 -> "%.0f MB".format(bytes / (1024.0 * 1024))
            else -> "${bytes / 1024} KB"
        }
    }
}
