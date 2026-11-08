import Foundation

/// One planned ring, as the JS side sends it (src/alarms/port.ts `AlarmSpec`).
struct AlarmSpecRecord: Codable, Equatable {
  var id: String
  var group: String
  var fireAt: Double  // ms since 1970
  var title: String
  var level: String
  var repeatN: Int
  var kind: String
  var dueAt: Double
  /// AlarmKit needs UUIDs: one per ring, kept so a cancel finds it again.
  var uuid: String

  static func from(_ m: [String: Any]) -> AlarmSpecRecord? {
    guard let id = m["id"] as? String, let fireAt = (m["fireAt"] as? NSNumber)?.doubleValue else { return nil }
    return AlarmSpecRecord(
      id: id,
      group: (m["group"] as? String) ?? id,
      fireAt: fireAt,
      title: (m["title"] as? String) ?? "",
      level: (m["level"] as? String) == "notification" ? "notification" : "alarm",
      repeatN: (m["repeatN"] as? NSNumber)?.intValue ?? 0,
      kind: (m["kind"] as? String) == "test" ? "test" : "normal",
      dueAt: (m["dueAt"] as? NSNumber)?.doubleValue ?? fireAt,
      uuid: UUID().uuidString
    )
  }
}

/// UserDefaults: planned rings, events not yet read by JS, labels. App Intents run in the app's
/// process, so the standard defaults are shared with them.
enum AlarmStore {
  private static let specsKey = "assistant.alarms.specs"
  private static let eventsKey = "assistant.alarms.events"
  private static let labelsKey = "assistant.alarms.labels"
  private static let lock = NSLock()
  private static var defaults: UserDefaults { UserDefaults.standard }

  static func specs() -> [AlarmSpecRecord] {
    lock.lock(); defer { lock.unlock() }
    guard let data = defaults.data(forKey: specsKey),
          let list = try? JSONDecoder().decode([AlarmSpecRecord].self, from: data) else { return [] }
    return list
  }

  static func save(_ list: [AlarmSpecRecord]) {
    lock.lock(); defer { lock.unlock() }
    if let data = try? JSONEncoder().encode(list) { defaults.set(data, forKey: specsKey) }
  }

  static func addEvent(_ event: String, group: String, spec: AlarmSpecRecord?, extra: [String: Any] = [:]) {
    var o: [String: Any] = [
      "id": UUID().uuidString,
      "event": event,
      "group": group,
      "at": Date().timeIntervalSince1970 * 1000,
    ]
    if let s = spec {
      o["alarmId"] = s.id
      o["repeatN"] = s.repeatN
      o["kind"] = s.kind
      o["fireAt"] = s.fireAt
    }
    for (k, v) in extra { o[k] = v }
    lock.lock()
    var list = (defaults.array(forKey: eventsKey) as? [[String: Any]]) ?? []
    list.append(o)
    if list.count > 500 { list.removeFirst(list.count - 500) }
    defaults.set(list, forKey: eventsKey)
    lock.unlock()
    AlarmEvents.emit()
  }

  static func drainEvents() -> [[String: Any]] {
    lock.lock(); defer { lock.unlock() }
    let list = (defaults.array(forKey: eventsKey) as? [[String: Any]]) ?? []
    defaults.set([[String: Any]](), forKey: eventsKey)
    return list
  }

  static func setLabels(_ labels: [String: String]) {
    defaults.set(labels, forKey: labelsKey)
  }

  static func label(_ key: String) -> String {
    let saved = (defaults.dictionary(forKey: labelsKey) as? [String: String])?[key]
    if let s = saved, !s.isEmpty { return s }
    return defaultLabels[key] ?? key
  }

  private static let defaultLabels: [String: String] = [
    "done": "Сделано",
    "snooze_short": "Отложить",
    "reminder": "Напоминание",
  ]
}

/// Wakes the JS side (when it runs) after an event was written.
enum AlarmEvents {
  static var listener: (() -> Void)?

  static func emit() {
    DispatchQueue.main.async { listener?() }
  }
}
