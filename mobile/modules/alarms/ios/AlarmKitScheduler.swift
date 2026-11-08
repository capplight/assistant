import Foundation

#if canImport(AlarmKit)
import AlarmKit
import AppIntents
import SwiftUI

/// Carried by every AlarmKit alarm: which ring group it belongs to (3-engineering 6.6 repeats).
@available(iOS 26.0, *)
struct AssistantAlarmMetadata: AlarmMetadata {
  var group: String
  var repeatN: Int
  var kind: String
}

/// iOS 26+ «Будильник» (S14 variant C): the system alarm screen, title = the reminder's text,
/// «Сделано» (stop) and «Отложить» (secondary, +10 min). Sounds through silent mode and Focus; the
/// volume does not ramp (system). Repeats +5/+10/+15 are separate AlarmKit alarms of the same group.
@available(iOS 26.0, *)
enum AlarmKitScheduler {
  static let snoozeMinutes = 10
  private static let repeatStep: TimeInterval = 5 * 60

  static func state(_ s: AlarmManager.AuthorizationState) -> String {
    switch s {
    case .authorized: return "authorized"
    case .denied: return "denied"
    case .notDetermined: return "notDetermined"
    @unknown default: return "notDetermined"
    }
  }

  static var authorization: String { state(AlarmManager.shared.authorizationState) }

  /// Asked in the context of the first alarm (3-engineering 6.6), from S15 or the first reminder.
  static func requestAuthorization() async -> String {
    do {
      return state(try await AlarmManager.shared.requestAuthorization())
    } catch {
      return "denied"
    }
  }

  private static func configuration(_ s: AlarmSpecRecord) -> AlarmManager.AlarmConfiguration<AssistantAlarmMetadata> {
    let title = s.title.isEmpty ? AlarmStore.label("reminder") : s.title
    let stop = AlarmButton(text: LocalizedStringResource(stringLiteral: AlarmStore.label("done")), textColor: .white, systemImageName: "checkmark")
    let snooze = AlarmButton(text: LocalizedStringResource(stringLiteral: AlarmStore.label("snooze_short")), textColor: .white, systemImageName: "zzz")
    let alert = AlarmPresentation.Alert(
      title: LocalizedStringResource(stringLiteral: title),
      stopButton: stop,
      secondaryButton: snooze,
      secondaryButtonBehavior: .custom
    )
    let attributes = AlarmAttributes<AssistantAlarmMetadata>(
      presentation: AlarmPresentation(alert: alert),
      metadata: AssistantAlarmMetadata(group: s.group, repeatN: s.repeatN, kind: s.kind),
      tintColor: Color(red: 0xB4 / 255, green: 0x36 / 255, blue: 0x1E / 255)
    )
    return AlarmManager.AlarmConfiguration<AssistantAlarmMetadata>(
      countdownDuration: nil,
      schedule: .fixed(Date(timeIntervalSince1970: s.fireAt / 1000)),
      attributes: attributes,
      stopIntent: AssistantAlarmDoneIntent(group: s.group),
      secondaryIntent: AssistantAlarmSnoozeIntent(group: s.group),
      sound: .default
    )
  }

  private static func cancel(_ s: AlarmSpecRecord) {
    guard let id = UUID(uuidString: s.uuid) else { return }
    try? AlarmManager.shared.cancel(id: id)
  }

  /// Replaces the whole plan. Returns per-ring results (`alarmkit` | `failed`).
  static func replaceAll(_ incoming: [AlarmSpecRecord]) async -> [[String: Any]] {
    let old = AlarmStore.specs()
    let byId = Dictionary(old.map { ($0.id, $0) }, uniquingKeysWith: { a, _ in a })
    var keep: [AlarmSpecRecord] = []
    var results: [[String: Any]] = []
    let now = Date().timeIntervalSince1970 * 1000
    let newIds = Set(incoming.map { $0.id })
    for s in old where !newIds.contains(s.id) { cancel(s) }
    for var s in incoming {
      if s.fireAt <= now {
        results.append(["id": s.id, "scheduler": "failed", "error": "past"])
        continue
      }
      if let prev = byId[s.id] {
        if prev.fireAt == s.fireAt && prev.title == s.title {
          keep.append(prev)
          results.append(["id": s.id, "scheduler": "alarmkit"])
          continue
        }
        cancel(prev)
      }
      s.uuid = UUID().uuidString
      do {
        _ = try await AlarmManager.shared.schedule(id: UUID(uuidString: s.uuid)!, configuration: configuration(s))
        keep.append(s)
        results.append(["id": s.id, "scheduler": "alarmkit"])
      } catch {
        results.append(["id": s.id, "scheduler": "failed", "error": String(describing: error)])
      }
    }
    AlarmStore.save(keep)
    return results
  }

  static func done(group: String) {
    let all = AlarmStore.specs()
    let spec = all.first { $0.group == group }
    for s in all where s.group == group { cancel(s) }
    AlarmStore.save(all.filter { $0.group != group })
    AlarmStore.addEvent("acked", group: group, spec: spec)
  }

  static func snooze(group: String, minutes: Int) async {
    let all = AlarmStore.specs()
    let base = all.first { $0.group == group }
    for s in all where s.group == group { cancel(s) }
    var keep = all.filter { $0.group != group }
    guard var b = base else {
      AlarmStore.save(keep)
      return
    }
    let at = Date().timeIntervalSince1970 * 1000 + Double(min(48 * 60, max(1, minutes))) * 60_000
    let tag = String(Int(at), radix: 36)
    for n in 0...3 {
      b.id = "\(group)~s\(tag)~\(n)"
      b.fireAt = at + Double(n) * repeatStep * 1000
      b.dueAt = at
      b.repeatN = n
      b.uuid = UUID().uuidString
      if (try? await AlarmManager.shared.schedule(id: UUID(uuidString: b.uuid)!, configuration: configuration(b))) != nil {
        keep.append(b)
      }
    }
    AlarmStore.save(keep)
    AlarmStore.addEvent("snoozed", group: group, spec: base, extra: ["until": at, "minutes": minutes])
  }

  /// While the app runs: a ring that is alerting now → `fired`. Without the app running AlarmKit
  /// does not wake it, so `fired` is then known only from a button (or the next launch).
  static func observe() {
    Task {
      var seen = Set<UUID>()
      for await alarms in AlarmManager.shared.alarmUpdates {
        let specs = AlarmStore.specs()
        for a in alarms where a.state == .alerting && !seen.contains(a.id) {
          seen.insert(a.id)
          if let s = specs.first(where: { $0.uuid == a.id.uuidString }) {
            AlarmStore.addEvent("fired", group: s.group, spec: s, extra: ["surface": "alarmkit"])
          }
        }
      }
    }
  }

  /// At launch: rings whose time passed and that AlarmKit no longer has were shown and stopped
  /// while the app was closed (the intents may not have run). Their repeats are dropped only when
  /// the stop intent said so; here they are reported `fired` once.
  static func reconcile() {
    let now = Date().timeIntervalSince1970 * 1000
    let live = Set(((try? AlarmManager.shared.alarms) ?? []).map { $0.id.uuidString })
    var keep: [AlarmSpecRecord] = []
    for s in AlarmStore.specs() {
      if s.fireAt <= now && !live.contains(s.uuid) {
        AlarmStore.addEvent("fired", group: s.group, spec: s, extra: ["surface": "alarmkit", "late_report": true])
      } else {
        keep.append(s)
      }
    }
    AlarmStore.save(keep)
  }
}

/// «Сделано» on the system alarm screen. Runs in the app's process (LiveActivityIntent).
@available(iOS 26.0, *)
struct AssistantAlarmDoneIntent: LiveActivityIntent {
  static let title: LocalizedStringResource = "Done"
  static let isDiscoverable = false

  @Parameter(title: "Group")
  var group: String

  init() { self.group = "" }
  init(group: String) { self.group = group }

  func perform() async throws -> some IntentResult {
    AlarmKitScheduler.done(group: group)
    return .result()
  }
}

/// «Отложить» on the system alarm screen: +10 min, repeats again from then.
@available(iOS 26.0, *)
struct AssistantAlarmSnoozeIntent: LiveActivityIntent {
  static let title: LocalizedStringResource = "Snooze"
  static let isDiscoverable = false

  @Parameter(title: "Group")
  var group: String

  init() { self.group = "" }
  init(group: String) { self.group = group }

  func perform() async throws -> some IntentResult {
    await AlarmKitScheduler.snooze(group: group, minutes: AlarmKitScheduler.snoozeMinutes)
    return .result()
  }
}
#endif
