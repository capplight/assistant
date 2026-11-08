package expo.modules.alarms

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.ContentResolver
import android.content.Context
import android.content.Intent
import android.media.AudioAttributes
import android.media.RingtoneManager
import android.net.Uri
import android.os.Build
import android.text.format.DateFormat
import androidx.core.app.NotificationCompat
import androidx.core.app.NotificationManagerCompat
import java.util.Date

/**
 * S14 variants A and B (2-design S14, R-10): one notification per ring group, category ALARM.
 * With the full-screen permission Android opens [AlarmActivity] over the lock screen (A); without it
 * (or while the phone is in use) the same notification shows as heads-up with «Сделано» ·
 * «Отложить на 10 минут» (B).
 */
object AlarmNotifier {
  /** The ring service plays the sound itself (volume ramp, 60 s): this channel is silent. */
  const val CHANNEL_ALARMS = "assistant_alarms_v1"
  /** Used when the ring service may not start: the channel plays the alarm sound, looping. */
  const val CHANNEL_ALARMS_SOUND = "assistant_alarms_sound_v1"
  const val CHANNEL_REMINDERS = "assistant_reminders_v1"

  const val ACTION_DONE = "expo.modules.alarms.DONE"
  const val ACTION_SNOOZE = "expo.modules.alarms.SNOOZE"
  const val ACTION_DISMISS = "expo.modules.alarms.DISMISS"
  const val EXTRA_GROUP = "alarm_group"
  const val EXTRA_MINUTES = "alarm_minutes"

  val VIBRATION = longArrayOf(0, 800, 400)

  fun idFor(group: String): Int = 0x41A0000 xor group.hashCode()

  fun soundUri(c: Context): Uri {
    val res = c.resources.getIdentifier("alarm_tones", "raw", c.packageName)
    return if (res != 0) {
      Uri.parse(ContentResolver.SCHEME_ANDROID_RESOURCE + "://" + c.packageName + "/" + res)
    } else {
      RingtoneManager.getDefaultUri(RingtoneManager.TYPE_ALARM)
        ?: RingtoneManager.getDefaultUri(RingtoneManager.TYPE_NOTIFICATION)
    }
  }

  private fun alarmAudio(): AudioAttributes = AudioAttributes.Builder()
    .setUsage(AudioAttributes.USAGE_ALARM)
    .setContentType(AudioAttributes.CONTENT_TYPE_SONIFICATION)
    .build()

  fun ensureChannels(c: Context) {
    if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return
    val nm = c.getSystemService(NotificationManager::class.java) ?: return
    val alarms = NotificationChannel(CHANNEL_ALARMS, AlarmStore.label(c, "channel_alarms"), NotificationManager.IMPORTANCE_HIGH).apply {
      setSound(null, null)
      enableVibration(false)
      lockscreenVisibility = Notification.VISIBILITY_PUBLIC
      setBypassDnd(true)
    }
    val sound = NotificationChannel(CHANNEL_ALARMS_SOUND, AlarmStore.label(c, "channel_alarms"), NotificationManager.IMPORTANCE_HIGH).apply {
      setSound(soundUri(c), alarmAudio())
      enableVibration(true)
      vibrationPattern = VIBRATION
      lockscreenVisibility = Notification.VISIBILITY_PUBLIC
      setBypassDnd(true)
    }
    val reminders = NotificationChannel(CHANNEL_REMINDERS, AlarmStore.label(c, "channel_reminders"), NotificationManager.IMPORTANCE_HIGH).apply {
      enableVibration(true)
    }
    nm.createNotificationChannels(listOf(alarms, sound, reminders))
  }

  fun notificationsEnabled(c: Context): Boolean = NotificationManagerCompat.from(c).areNotificationsEnabled()

  /** Android 14+: the person may switch full-screen alarms off for the app (granted by default only to clock apps). */
  fun canFullScreen(c: Context): Boolean {
    if (Build.VERSION.SDK_INT < 34) return true
    val nm = c.getSystemService(NotificationManager::class.java) ?: return false
    return nm.canUseFullScreenIntent()
  }

  /** The alarm channels are not switched off in the system settings. */
  fun alarmChannelOn(c: Context): Boolean {
    if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return true
    val nm = c.getSystemService(NotificationManager::class.java) ?: return false
    val ch = nm.getNotificationChannel(CHANNEL_ALARMS) ?: return true
    return ch.importance != NotificationManager.IMPORTANCE_NONE
  }

  fun timeText(c: Context, at: Long): String = DateFormat.getTimeFormat(c).format(Date(at))

  private fun broadcast(c: Context, action: String, group: String, minutes: Int = 10): PendingIntent {
    val intent = Intent(c, AlarmReceiver::class.java)
      .setAction(action)
      .setData(Uri.parse("assistant-alarm://" + action.substringAfterLast('.').lowercase() + "/" + Uri.encode(group)))
      .putExtra(EXTRA_GROUP, group)
      .putExtra(EXTRA_MINUTES, minutes)
    return PendingIntent.getBroadcast(c, 0, intent, PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE)
  }

  fun activityIntent(c: Context, spec: AlarmSpec): Intent =
    Intent(c, AlarmActivity::class.java)
      .setData(Uri.parse("assistant-alarm://show/" + Uri.encode(spec.group)))
      .putExtra(EXTRA_GROUP, spec.group)
      .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_NO_USER_ACTION)

  private fun appIntent(c: Context, spec: AlarmSpec): PendingIntent? {
    // The app's own S14 / reminder screen (expo-router deep link, scheme `assistant`).
    val intent = Intent(Intent.ACTION_VIEW, Uri.parse("assistant://alarm?group=" + Uri.encode(spec.group)))
      .setPackage(c.packageName)
      .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
    return PendingIntent.getActivity(c, 2, intent, PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE)
  }

  /**
   * `withSound`: the notification itself rings (the ring service could not start). Otherwise the
   * service plays the sound and this is its foreground notification.
   */
  fun build(c: Context, spec: AlarmSpec, withSound: Boolean): Notification {
    ensureChannels(c)
    val alarm = spec.level == "alarm"
    val channel = when {
      !alarm -> CHANNEL_REMINDERS
      withSound -> CHANNEL_ALARMS_SOUND
      else -> CHANNEL_ALARMS
    }
    val time = timeText(c, spec.dueAt)
    val title = spec.title.ifBlank { AlarmStore.label(c, "reminder") }
    val b = NotificationCompat.Builder(c, channel)
      .setSmallIcon(android.R.drawable.ic_lock_idle_alarm)
      .setContentTitle(title)
      .setContentText(if (alarm) AlarmStore.label(c, "heading") + " · " + time else time)
      .setCategory(if (alarm) NotificationCompat.CATEGORY_ALARM else NotificationCompat.CATEGORY_REMINDER)
      .setPriority(if (alarm) NotificationCompat.PRIORITY_MAX else NotificationCompat.PRIORITY_HIGH)
      .setVisibility(NotificationCompat.VISIBILITY_PUBLIC)
      .setWhen(spec.dueAt)
      .setShowWhen(true)
      .addAction(0, AlarmStore.label(c, "done"), broadcast(c, ACTION_DONE, spec.group))
      .addAction(0, AlarmStore.label(c, "snooze"), broadcast(c, ACTION_SNOOZE, spec.group, 10))
    if (alarm) {
      val full = PendingIntent.getActivity(c, 3, activityIntent(c, spec), PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE)
      b.setFullScreenIntent(full, true)
        .setContentIntent(full)
        .setOngoing(true) // «Выключение — только кнопкой» (2-design S14)
        .setAutoCancel(false)
      if (withSound) b.setSound(soundUri(c), android.media.AudioManager.STREAM_ALARM).setVibrate(VIBRATION)
    } else {
      b.setContentIntent(appIntent(c, spec))
        .setAutoCancel(true)
        .setDeleteIntent(broadcast(c, ACTION_DISMISS, spec.group))
    }
    val n = b.build()
    if (alarm && withSound) n.flags = n.flags or Notification.FLAG_INSISTENT
    return n
  }

  /** Posts the notification; returns the surface for `fired_local.meta`: fsi | heads_up | notification | blocked. */
  fun show(c: Context, spec: AlarmSpec, withSound: Boolean): String {
    if (!notificationsEnabled(c)) return "blocked"
    try {
      NotificationManagerCompat.from(c).notify(idFor(spec.group), build(c, spec, withSound))
    } catch (_: SecurityException) {
      return "blocked" // POST_NOTIFICATIONS was revoked
    }
    return surface(c, spec)
  }

  fun surface(c: Context, spec: AlarmSpec): String = when {
    !notificationsEnabled(c) -> "blocked"
    spec.level != "alarm" -> "notification"
    canFullScreen(c) -> "fsi"
    else -> "heads_up"
  }

  fun cancel(c: Context, group: String) {
    NotificationManagerCompat.from(c).cancel(idFor(group))
  }
}
