package dev.thingmaker.remote

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.pm.PackageInstaller
import java.io.File

/** Android's installer reporting on an app the Mac sent: confirm, done, or not. */
class InstallReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        val id = intent.getStringExtra("id") ?: return
        val name = intent.getStringExtra("name") ?: "The app"
        val status = intent.getIntExtra(PackageInstaller.EXTRA_STATUS, PackageInstaller.STATUS_FAILURE)
        if (status == PackageInstaller.STATUS_PENDING_USER_ACTION) {
            @Suppress("DEPRECATION")
            val confirm = intent.getParcelableExtra<Intent>(Intent.EXTRA_INTENT) ?: return
            context.startActivity(confirm.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
            return
        }
        intent.getStringExtra("file")?.let { File(it).delete() }
        val (state, message) = when (status) {
            PackageInstaller.STATUS_SUCCESS -> "installed" to context.getString(R.string.install_done, name)
            PackageInstaller.STATUS_FAILURE_ABORTED -> "cancelled" to context.getString(R.string.install_cancelled)
            else -> "failed" to (intent.getStringExtra(PackageInstaller.EXTRA_STATUS_MESSAGE) ?: context.getString(R.string.install_not_installed))
        }
        // Delivered after an update of this app, it reaches the new app before its line to the computer is up.
        context.getSharedPreferences("install", Context.MODE_PRIVATE).edit().remove("selfUpdate").apply()
        BridgeService.report(context, id, state, if (state == "installed") null else message)
        val screen = InstallActivity.current
        if (screen != null) screen.runOnUiThread { screen.finished(state == "installed", message) } else if (state != "cancelled") Notifier.attention(context, name, message)
    }
}
