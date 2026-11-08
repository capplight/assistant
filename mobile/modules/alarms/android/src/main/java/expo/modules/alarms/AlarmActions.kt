package expo.modules.alarms

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent

/**
 * What happens at a ring and on the buttons, the same from the notification, from S14
 * ([AlarmActivity]) and from the app (JS `act`). Rule of repeats (3-engineering 6.6 п. 1): the
 * repeats +5/+10/+15 are already planned in the same group; «Сделано» drops them; «Отложить» drops
 * them and plans the group again from the new time.
 */
object AlarmActions {
  private const val REPEATS = 3
  private const val REPEAT_STEP_MS = 5 * 60_000L
  /** reminders.md: the server accepts `until` up to 48 h after the event. */
  private const val MAX_SNOOZE_MIN = 48 * 60

  fun fire(c: Context, id: String) {
    val spec = AlarmStore.take(c, id) ?: return
    AlarmStore.setActive(c, spec)
    val surface = if (spec.level == "alarm") {
      // The ring service posts the notification as its own (silent channel, it plays the sound).
      if (AlarmRingService.start(c, spec)) AlarmNotifier.surface(c, spec) else AlarmNotifier.show(c, spec, withSound = true)
    } else {
      AlarmNotifier.show(c, spec, withSound = false)
    }
    val exact = AlarmScheduler.canExact(c)
    AlarmStore.addEvent(
      c, "fired", spec, spec.group,
      mapOf("surface" to surface, "exact" to exact, "delayMs" to (System.currentTimeMillis() - spec.fireAt)),
    )
  }

  /** «Сделано». */
  fun done(c: Context, group: String) {
    val spec = AlarmStore.active(c, group)
    AlarmStore.removeGroup(c, group).forEach { AlarmScheduler.cancel(c, it.id) }
    stopRinging(c, group)
    AlarmStore.clearActive(c, group)
    AlarmStore.addEvent(c, "acked", spec, group)
  }

  /** «Отложить на 10 минут» and «Другое время» (5 / 30 / 60 min / tomorrow). */
  fun snooze(c: Context, group: String, minutes: Int) {
    val base = AlarmStore.active(c, group) ?: AlarmStore.specs(c).firstOrNull { it.group == group }
    AlarmStore.removeGroup(c, group).forEach { AlarmScheduler.cancel(c, it.id) }
    stopRinging(c, group)
    AlarmStore.clearActive(c, group)
    if (base == null) return
    val at = System.currentTimeMillis() + minutes.coerceIn(1, MAX_SNOOZE_MIN) * 60_000L
    val tag = at.toString(36)
    val count = if (base.level == "alarm") REPEATS else 0
    val again = (0..count).map { n ->
      base.copy(id = "${group}~s$tag~$n", fireAt = at + n * REPEAT_STEP_MS, repeatN = n, dueAt = at)
    }
    val kept = again.filter { AlarmScheduler.schedule(c, it) != "failed" }
    AlarmStore.add(c, kept)
    AlarmStore.addEvent(c, "snoozed", base, group, mapOf("until" to at, "minutes" to minutes))
  }

  /** A quiet «Уведомление» swiped away. Alarms are ongoing: they go only with a button. */
  fun dismissed(c: Context, group: String) {
    val spec = AlarmStore.active(c, group)
    AlarmStore.clearActive(c, group)
    AlarmStore.addEvent(c, "dismissed", spec, group)
  }

  fun shown(c: Context, group: String) {
    AlarmStore.addEvent(c, "shown", AlarmStore.active(c, group), group, mapOf("surface" to "fsi"))
  }

  private fun stopRinging(c: Context, group: String) {
    AlarmRingService.stop(c)
    AlarmNotifier.cancel(c, group)
    AlarmActivity.finishFor(group)
  }
}

/** Alarm times, notification buttons. */
class AlarmReceiver : BroadcastReceiver() {
  override fun onReceive(context: Context, intent: Intent) {
    val c = context.applicationContext
    when (intent.action) {
      AlarmScheduler.ACTION_FIRE -> intent.getStringExtra(AlarmScheduler.EXTRA_ID)?.let { AlarmActions.fire(c, it) }
      AlarmNotifier.ACTION_DONE -> intent.getStringExtra(AlarmNotifier.EXTRA_GROUP)?.let { AlarmActions.done(c, it) }
      AlarmNotifier.ACTION_SNOOZE -> intent.getStringExtra(AlarmNotifier.EXTRA_GROUP)?.let {
        AlarmActions.snooze(c, it, intent.getIntExtra(AlarmNotifier.EXTRA_MINUTES, 10))
      }
      AlarmNotifier.ACTION_DISMISS -> intent.getStringExtra(AlarmNotifier.EXTRA_GROUP)?.let { AlarmActions.dismissed(c, it) }
    }
  }
}

/** Reboot, time / time zone change, app update, exact-alarm permission granted or taken away. */
class BootReceiver : BroadcastReceiver() {
  override fun onReceive(context: Context, intent: Intent) {
    val c = context.applicationContext
    AlarmNotifier.ensureChannels(c)
    AlarmScheduler.rescheduleAll(c)
    AlarmStore.addEvent(c, "rescheduled", null, "", mapOf("reason" to (intent.action ?: "")))
  }
}
