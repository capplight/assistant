package expo.modules.alarms

import android.app.AlarmManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.net.Uri
import android.os.Build

/**
 * 3-engineering 6.6, Android:
 * - «Будильник»: `setAlarmClock` (exact, wakes from Doze, the clock icon in the status bar);
 * - «Уведомление»: `setExactAndAllowWhileIdle`;
 * - without SCHEDULE_EXACT_ALARM (Android 12+, denied by default on 14+): `setWindow` ±10 min —
 *   the reminder may be late by up to 10 minutes (the UI says so).
 */
object AlarmScheduler {
  const val ACTION_FIRE = "expo.modules.alarms.FIRE"
  const val EXTRA_ID = "alarm_id"
  private const val WINDOW_MS = 10 * 60_000L
  /** A ring missed while the phone was off still rings after boot if it is this fresh. */
  private const val LATE_RING_MS = 30 * 60_000L

  private fun alarmManager(c: Context): AlarmManager = c.getSystemService(Context.ALARM_SERVICE) as AlarmManager

  fun canExact(c: Context): Boolean =
    Build.VERSION.SDK_INT < Build.VERSION_CODES.S || alarmManager(c).canScheduleExactAlarms()

  private fun firePending(c: Context, id: String): PendingIntent {
    val intent = Intent(c, AlarmReceiver::class.java)
      .setAction(ACTION_FIRE)
      // The data URI makes every ring its own PendingIntent (extras do not count for equality).
      .setData(Uri.parse("assistant-alarm://fire/" + Uri.encode(id)))
      .putExtra(EXTRA_ID, id)
    return PendingIntent.getBroadcast(c, 0, intent, PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE)
  }

  private fun showPending(c: Context): PendingIntent? {
    val launch = c.packageManager.getLaunchIntentForPackage(c.packageName) ?: return null
    return PendingIntent.getActivity(c, 1, launch, PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE)
  }

  /** Sets one ring; returns the scheduler used: alarm_clock | exact | inexact | failed. */
  fun schedule(c: Context, spec: AlarmSpec): String {
    val am = alarmManager(c)
    val pi = firePending(c, spec.id)
    return try {
      if (canExact(c)) {
        if (spec.level == "alarm") {
          am.setAlarmClock(AlarmManager.AlarmClockInfo(spec.fireAt, showPending(c)), pi)
          "alarm_clock"
        } else {
          am.setExactAndAllowWhileIdle(AlarmManager.RTC_WAKEUP, spec.fireAt, pi)
          "exact"
        }
      } else {
        am.setWindow(AlarmManager.RTC_WAKEUP, spec.fireAt, WINDOW_MS, pi)
        "inexact"
      }
    } catch (_: SecurityException) {
      // The permission was taken away between the check and the call.
      try {
        am.setWindow(AlarmManager.RTC_WAKEUP, spec.fireAt, WINDOW_MS, pi)
        "inexact"
      } catch (_: Exception) {
        "failed"
      }
    } catch (_: Exception) {
      "failed"
    }
  }

  fun cancel(c: Context, id: String) {
    try {
      alarmManager(c).cancel(firePending(c, id))
    } catch (_: Exception) {
      // nothing to cancel
    }
  }

  /**
   * Replaces the whole plan with `specs` (JS always sends the full window). Rings that are no longer
   * in it are cancelled. Returns per-ring results for `scheduled_local` / `schedule_failed`.
   */
  fun replaceAll(c: Context, specs: List<AlarmSpec>): List<Map<String, Any?>> {
    val newIds = specs.map { it.id }.toSet()
    AlarmStore.specs(c).filter { it.id !in newIds }.forEach { cancel(c, it.id) }
    val now = System.currentTimeMillis()
    val results = mutableListOf<Map<String, Any?>>()
    val kept = mutableListOf<AlarmSpec>()
    for (spec in specs) {
      if (spec.fireAt <= now) {
        results.add(mapOf("id" to spec.id, "scheduler" to "failed", "error" to "past"))
        continue
      }
      val used = schedule(c, spec)
      if (used != "failed") kept.add(spec)
      results.add(mapOf("id" to spec.id, "scheduler" to used, "error" to if (used == "failed") "alarm_manager" else null))
    }
    AlarmStore.saveSpecs(c, kept)
    return results
  }

  /**
   * After a reboot, a time / time zone change, an app update or the exact-alarm permission changing:
   * every planned ring again. The times are UTC instants, so a time zone change does not move them;
   * a ring that was due while the phone was off rings now if it is at most 30 min late.
   */
  fun rescheduleAll(c: Context) {
    val now = System.currentTimeMillis()
    val kept = mutableListOf<AlarmSpec>()
    var lateQueued = false
    for (spec in AlarmStore.specs(c).sortedBy { it.fireAt }) {
      when {
        spec.fireAt > now -> {
          if (schedule(c, spec) != "failed") kept.add(spec)
        }
        now - spec.fireAt <= LATE_RING_MS && !lateQueued && spec.repeatN == 0 -> {
          // One late ring, a few seconds from now; its repeats keep their own times.
          val late = spec.copy(fireAt = now + 5_000L)
          if (schedule(c, late) != "failed") kept.add(late)
          lateQueued = true
        }
        else -> Unit // too old: the server marks it missed and shows it on «Сегодня»
      }
    }
    AlarmStore.saveSpecs(c, kept)
  }
}
