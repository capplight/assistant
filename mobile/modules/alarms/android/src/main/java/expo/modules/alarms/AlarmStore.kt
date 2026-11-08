package expo.modules.alarms

import android.content.Context
import android.content.SharedPreferences
import org.json.JSONArray
import org.json.JSONObject
import java.util.UUID

/**
 * One planned ring. `group` = one reminder fire (its main ring and the repeats +5/+10/+15 share it):
 * «Сделано» / «Отложить» act on the whole group. The JS side plans; this side only keeps what it was
 * given, so a reboot, a time change or an app update can put everything back without JS.
 */
data class AlarmSpec(
  val id: String,
  val group: String,
  val fireAt: Long,
  val title: String,
  /** "alarm" rings (S14 / heads-up); "notification" is the quiet second level. */
  val level: String,
  /** 0 = the main ring, 1..3 = repeats. */
  val repeatN: Int,
  /** "normal" | "test" (S15 «Проверить будильник»). */
  val kind: String,
  /** The original time of the fire, for the clock on S14 and «Завтра». */
  val dueAt: Long,
) {
  fun toJson(): JSONObject = JSONObject()
    .put("id", id)
    .put("group", group)
    .put("fireAt", fireAt)
    .put("title", title)
    .put("level", level)
    .put("repeatN", repeatN)
    .put("kind", kind)
    .put("dueAt", dueAt)

  companion object {
    fun fromJson(o: JSONObject): AlarmSpec = AlarmSpec(
      id = o.getString("id"),
      group = o.optString("group", o.getString("id")),
      fireAt = o.getLong("fireAt"),
      title = o.optString("title", ""),
      level = o.optString("level", "alarm"),
      repeatN = o.optInt("repeatN", 0),
      kind = o.optString("kind", "normal"),
      dueAt = o.optLong("dueAt", o.getLong("fireAt")),
    )

    /** From JS: numbers arrive as Double. Returns null for a row without id / time. */
    fun fromMap(m: Map<String, Any?>): AlarmSpec? {
      val id = m["id"] as? String ?: return null
      val fireAt = (m["fireAt"] as? Number)?.toLong() ?: return null
      return AlarmSpec(
        id = id,
        group = m["group"] as? String ?: id,
        fireAt = fireAt,
        title = m["title"] as? String ?: "",
        level = if (m["level"] == "notification") "notification" else "alarm",
        repeatN = (m["repeatN"] as? Number)?.toInt() ?: 0,
        kind = if (m["kind"] == "test") "test" else "normal",
        dueAt = (m["dueAt"] as? Number)?.toLong() ?: fireAt,
      )
    }
  }
}

/** SharedPreferences: planned rings, rings now on screen, events not yet read by JS, button labels. */
object AlarmStore {
  private const val PREFS = "assistant_alarms"
  private const val KEY_SPECS = "specs"
  private const val KEY_ACTIVE = "active"
  private const val KEY_EVENTS = "events"
  private const val KEY_LABELS = "labels"
  private const val MAX_EVENTS = 500
  private val lock = Any()

  private fun prefs(c: Context): SharedPreferences =
    c.applicationContext.getSharedPreferences(PREFS, Context.MODE_PRIVATE)

  private fun readArray(c: Context, key: String): JSONArray =
    try {
      JSONArray(prefs(c).getString(key, "[]") ?: "[]")
    } catch (_: Exception) {
      JSONArray()
    }

  private fun readSpecs(c: Context, key: String): MutableList<AlarmSpec> {
    val arr = readArray(c, key)
    val out = mutableListOf<AlarmSpec>()
    for (i in 0 until arr.length()) {
      try {
        out.add(AlarmSpec.fromJson(arr.getJSONObject(i)))
      } catch (_: Exception) {
        // a broken row is dropped
      }
    }
    return out
  }

  private fun writeSpecs(c: Context, key: String, list: List<AlarmSpec>) {
    val arr = JSONArray()
    list.forEach { arr.put(it.toJson()) }
    prefs(c).edit().putString(key, arr.toString()).commit()
  }

  fun specs(c: Context): List<AlarmSpec> = synchronized(lock) { readSpecs(c, KEY_SPECS) }

  fun saveSpecs(c: Context, list: List<AlarmSpec>) = synchronized(lock) { writeSpecs(c, KEY_SPECS, list) }

  fun add(c: Context, list: List<AlarmSpec>) = synchronized(lock) {
    val ids = list.map { it.id }.toSet()
    writeSpecs(c, KEY_SPECS, readSpecs(c, KEY_SPECS).filter { it.id !in ids } + list)
  }

  /** The planned ring with this id, removed from the plan (it is ringing now). */
  fun take(c: Context, id: String): AlarmSpec? = synchronized(lock) {
    val all = readSpecs(c, KEY_SPECS)
    val spec = all.firstOrNull { it.id == id } ?: return@synchronized null
    writeSpecs(c, KEY_SPECS, all.filter { it.id != id })
    spec
  }

  /** Drops the planned rings of a group; returns them. */
  fun removeGroup(c: Context, group: String): List<AlarmSpec> = synchronized(lock) {
    val all = readSpecs(c, KEY_SPECS)
    val (gone, keep) = all.partition { it.group == group }
    writeSpecs(c, KEY_SPECS, keep)
    gone
  }

  // --- rings on screen: what «Сделано» / «Отложить» need after the planned row is gone ---

  fun setActive(c: Context, spec: AlarmSpec) = synchronized(lock) {
    writeSpecs(c, KEY_ACTIVE, readSpecs(c, KEY_ACTIVE).filter { it.group != spec.group } + spec)
  }

  fun active(c: Context, group: String): AlarmSpec? = synchronized(lock) {
    readSpecs(c, KEY_ACTIVE).firstOrNull { it.group == group }
  }

  fun clearActive(c: Context, group: String) = synchronized(lock) {
    writeSpecs(c, KEY_ACTIVE, readSpecs(c, KEY_ACTIVE).filter { it.group != group })
  }

  // --- events for JS (and through it the server): fired, shown, acked, snoozed, dismissed ---

  fun addEvent(c: Context, event: String, spec: AlarmSpec?, group: String, extra: Map<String, Any?> = emptyMap()) {
    val o = JSONObject()
      .put("id", UUID.randomUUID().toString())
      .put("event", event)
      .put("group", group)
      .put("at", System.currentTimeMillis())
    if (spec != null) {
      o.put("alarmId", spec.id).put("repeatN", spec.repeatN).put("kind", spec.kind).put("fireAt", spec.fireAt)
    }
    extra.forEach { (k, v) -> o.put(k, v) }
    synchronized(lock) {
      val arr = readArray(c, KEY_EVENTS)
      arr.put(o)
      val start = maxOf(0, arr.length() - MAX_EVENTS)
      val kept = JSONArray()
      for (i in start until arr.length()) kept.put(arr.get(i))
      prefs(c).edit().putString(KEY_EVENTS, kept.toString()).commit()
    }
    AlarmEvents.emit()
  }

  fun drainEvents(c: Context): List<Map<String, Any?>> = synchronized(lock) {
    val arr = readArray(c, KEY_EVENTS)
    prefs(c).edit().putString(KEY_EVENTS, "[]").commit()
    val out = mutableListOf<Map<String, Any?>>()
    for (i in 0 until arr.length()) {
      val o = arr.optJSONObject(i) ?: continue
      val m = mutableMapOf<String, Any?>()
      o.keys().forEach { k -> m[k] = o.opt(k) }
      out.add(m)
    }
    out
  }

  // --- labels: the JS side sends them in the person's language (ru / kk) ---

  fun setLabels(c: Context, labels: Map<String, String>) {
    val o = JSONObject()
    labels.forEach { (k, v) -> o.put(k, v) }
    prefs(c).edit().putString(KEY_LABELS, o.toString()).apply()
  }

  fun label(c: Context, key: String): String {
    val saved = try {
      JSONObject(prefs(c).getString(KEY_LABELS, "{}") ?: "{}").optString(key, "")
    } catch (_: Exception) {
      ""
    }
    return saved.ifEmpty { DEFAULT_LABELS[key] ?: key }
  }

  /** Russian until JS has sent the labels once (e.g. right after an update, before the first launch). */
  private val DEFAULT_LABELS = mapOf(
    "heading" to "Будильник-напоминание",
    "done" to "Сделано",
    "snooze" to "Отложить на 10 минут",
    "other_time" to "Другое время",
    "in_5" to "Через 5 минут",
    "in_30" to "Через 30 минут",
    "in_60" to "Через час",
    "tomorrow" to "Завтра",
    "call" to "Позвонить",
    "channel_alarms" to "Будильники",
    "channel_reminders" to "Напоминания",
    "reminder" to "Напоминание",
  )
}

/** Wakes the JS side (if it is running) when an event was written. */
object AlarmEvents {
  @Volatile
  var listener: (() -> Unit)? = null

  fun emit() {
    try {
      listener?.invoke()
    } catch (_: Exception) {
      // JS not ready: it reads the queue at the next start
    }
  }
}
