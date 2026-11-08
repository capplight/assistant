import ExpoModulesCore
import UIKit

/// JS API of the `alarms` module on iOS (src/alarms/native.ts). Only the «Будильник» level on
/// iOS 26+ comes here (AlarmKit); «Уведомление» and iOS < 26 go through expo-notifications
/// (time-sensitive), because Apple gives no alarm API below 26 (3-engineering 6.6).
public class AlarmsModule: Module {
  public func definition() -> ModuleDefinition {
    Name("Alarms")

    Events("onAlarmEvent")

    OnCreate {
      AlarmEvents.listener = { [weak self] in
        self?.sendEvent("onAlarmEvent", ["pending": true])
      }
      #if canImport(AlarmKit)
      if #available(iOS 26.0, *) {
        AlarmKitScheduler.reconcile()
        AlarmKitScheduler.observe()
      }
      #endif
    }

    OnDestroy {
      AlarmEvents.listener = nil
    }

    Function("getCapabilities") { () -> [String: Any] in
      var caps: [String: Any] = [
        "backend": "none",
        "osVersion": UIDevice.current.systemVersion,
        "manufacturer": "Apple",
        "model": UIDevice.current.model,
        "vendor": "apple",
        "scheduled": AlarmStore.specs().count,
      ]
      #if canImport(AlarmKit)
      if #available(iOS 26.0, *) {
        caps["backend"] = "alarmkit"
        caps["alarmKit"] = AlarmKitScheduler.authorization
      }
      #endif
      return caps
    }

    AsyncFunction("requestAlarmKit") { () async -> String in
      #if canImport(AlarmKit)
      if #available(iOS 26.0, *) {
        return await AlarmKitScheduler.requestAuthorization()
      }
      #endif
      return "unavailable"
    }

    AsyncFunction("schedule") { (specs: [[String: Any]]) async -> [[String: Any]] in
      let list = specs.compactMap { AlarmSpecRecord.from($0) }.filter { $0.level == "alarm" }
      #if canImport(AlarmKit)
      if #available(iOS 26.0, *) {
        return await AlarmKitScheduler.replaceAll(list)
      }
      #endif
      return list.map { ["id": $0.id, "scheduler": "failed", "error": "unavailable"] }
    }

    Function("drainEvents") { () -> [[String: Any]] in
      AlarmStore.drainEvents()
    }

    AsyncFunction("act") { (group: String, action: String, minutes: Int) async -> Bool in
      #if canImport(AlarmKit)
      if #available(iOS 26.0, *) {
        if action == "done" { AlarmKitScheduler.done(group: group) }
        if action == "snooze" { await AlarmKitScheduler.snooze(group: group, minutes: minutes) }
        return true
      }
      #endif
      return false
    }

    Function("openSettings") { (_: String) -> Bool in
      guard let url = URL(string: UIApplication.openSettingsURLString) else { return false }
      DispatchQueue.main.async { UIApplication.shared.open(url) }
      return true
    }

    Function("setLabels") { (labels: [String: String]) in
      AlarmStore.setLabels(labels)
    }
  }
}
