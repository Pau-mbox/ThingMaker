package dev.thingmaker.remote

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent

/** The app's two kinds of notification: something needs you, and the quiet one the connection keeps. */
object Notifier {
    private const val ATTENTION = "attention"
    const val CONNECTION = "connection"
    private var next = 100

    fun channels(context: Context) {
        val manager = context.getSystemService(NotificationManager::class.java)
        manager.createNotificationChannel(NotificationChannel(ATTENTION, context.getString(R.string.channel_attention), NotificationManager.IMPORTANCE_HIGH).apply {
            description = context.getString(R.string.channel_attention_about)
        })
        manager.createNotificationChannel(NotificationChannel(CONNECTION, context.getString(R.string.channel_connection), NotificationManager.IMPORTANCE_MIN).apply {
            description = context.getString(R.string.channel_connection_about)
        })
    }

    fun open(context: Context): PendingIntent = PendingIntent.getActivity(
        context, 0,
        Intent(context, MainActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_SINGLE_TOP),
        PendingIntent.FLAG_IMMUTABLE,
    )

    /** "Install Game.apk?", opening the install screen. */
    fun install(context: Context, offer: Offer, open: Intent) {
        channels(context)
        val tap = PendingIntent.getActivity(context, offer.id.hashCode(), open, PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT)
        val notification = Notification.Builder(context, ATTENTION)
            .setSmallIcon(android.R.drawable.stat_sys_download_done)
            .setContentTitle(context.getString(R.string.install_question, offer.name))
            .setContentText(context.getString(R.string.install_sent_by, offer.from, InstallActivity.size(offer.size)))
            .setContentIntent(tap)
            .setAutoCancel(true)
            .build()
        runCatching { context.getSystemService(NotificationManager::class.java).notify(offer.id.hashCode(), notification) }
    }

    fun attention(context: Context, title: String, body: String) {
        channels(context)
        val notification = Notification.Builder(context, ATTENTION)
            .setSmallIcon(android.R.drawable.stat_notify_chat)
            .setContentTitle(title)
            .setContentText(body)
            .setStyle(Notification.BigTextStyle().bigText(body))
            .setContentIntent(open(context))
            .setAutoCancel(true)
            .build()
        runCatching { context.getSystemService(NotificationManager::class.java).notify(next++, notification) }
    }
}
