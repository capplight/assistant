package expo.modules.alarms

import android.content.Context
import android.os.Build
import expo.modules.kotlin.exception.Exceptions
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition

/**
 * JS API of the `alarms` module (src/alarms/native.ts mirrors it):
 * - getCapabilities(): what this phone allows (S15 steps, `devices.capabilities`);
 * - schedule(specs): replaces the whole plan, returns per-ring results;
 * - drainEvents(): rings / buttons since the last call (also those while the app was closed);
 * - act(group, action, minutes): «Сделано» / «Отложить» from the app's own screens;
 * - openSettings(target): exact | full_screen | battery | autostart | notifications | app;
 * - setLabels(map): button and channel texts in the person's language.
 * Event `onAlarmEvent` ({pending: true}) = there is something to drain.
 */
class AlarmsModule : Module() {
  private val context: Context
    get() = appContext.reactContext?.applicationContext ?: throw Exceptions.ReactContextLost()

  override fun definition() = ModuleDefinition {
    Name("Alarms")

    Events("onAlarmEvent")

    OnCreate {
      AlarmEvents.listener = {
        try {
          sendEvent("onAlarmEvent", mapOf("pending" to true))
        } catch (_: Exception) {
        }
      }
      try {
        AlarmNotifier.ensureChannels(context)
      } catch (_: Exception) {
      }
    }

    OnDestroy {
      AlarmEvents.listener = null
    }

    Function("getCapabilities") {
      val c = context
      mapOf(
        "backend" to "android",
        "osVersion" to Build.VERSION.SDK_INT,
        "manufacturer" to Build.MANUFACTURER,
        "model" to Build.MODEL,
        "vendor" to BatteryGuide.vendor(),
        "notificationsEnabled" to AlarmNotifier.notificationsEnabled(c),
        "alarmChannelOn" to AlarmNotifier.alarmChannelOn(c),
        "exactAlarms" to AlarmScheduler.canExact(c),
        "exactAlarmsAsked" to (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S),
        "fullScreen" to AlarmNotifier.canFullScreen(c),
        "fullScreenAsked" to (Build.VERSION.SDK_INT >= 34),
        "batteryUnrestricted" to BatteryGuide.ignoringOptimizations(c),
        "autostartStep" to BatteryGuide.hasAutostartStep(),
        "scheduled" to AlarmStore.specs(c).size,
      )
    }

    Function("schedule") { specs: List<Map<String, Any?>> ->
      val c = context
      AlarmNotifier.ensureChannels(c)
      AlarmScheduler.replaceAll(c, specs.mapNotNull { AlarmSpec.fromMap(it) })
    }

    Function("drainEvents") {
      AlarmStore.drainEvents(context)
    }

    Function("act") { group: String, action: String, minutes: Int ->
      val c = context
      when (action) {
        "done" -> AlarmActions.done(c, group)
        "snooze" -> AlarmActions.snooze(c, group, minutes)
        "dismiss" -> AlarmActions.dismissed(c, group)
      }
      true
    }

    Function("openSettings") { target: String ->
      BatteryGuide.open(context, target)
    }

    Function("setLabels") { labels: Map<String, String> ->
      AlarmStore.setLabels(context, labels)
      try {
        AlarmNotifier.ensureChannels(context) // channel names follow the language
      } catch (_: Exception) {
      }
    }
  }
}
