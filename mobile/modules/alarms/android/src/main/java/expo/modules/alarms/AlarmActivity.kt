package expo.modules.alarms

import android.animation.ObjectAnimator
import android.animation.ValueAnimator
import android.app.Activity
import android.app.KeyguardManager
import android.content.Intent
import android.graphics.Color
import android.graphics.Typeface
import android.graphics.drawable.GradientDrawable
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.util.TypedValue
import android.view.Gravity
import android.view.View
import android.view.WindowManager
import android.widget.Button
import android.widget.LinearLayout
import android.widget.ScrollView
import android.widget.TextView
import java.lang.ref.WeakReference

/**
 * S14 variant A (2-design S14): over the lock screen, `color.alarm` #B4361E with white text (6.0:1)
 * in both themes. «Сделано» 72 dp, «Отложить на 10 минут» 64 dp, «Позвонить» when the text has a
 * phone number, «Другое время» (5 / 30 min / 1 hour / tomorrow). Goes away only by a button; the
 * screen reader starts on «Сделано» and reads the text at once (2-design §8). Native views, not
 * React Native: the ring must show even when the JS app is not running.
 */
class AlarmActivity : Activity() {
  private var group: String = ""
  private var pulse: ObjectAnimator? = null

  override fun onCreate(savedInstanceState: Bundle?) {
    super.onCreate(savedInstanceState)
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O_MR1) {
      setShowWhenLocked(true)
      setTurnScreenOn(true)
    } else {
      @Suppress("DEPRECATION")
      window.addFlags(WindowManager.LayoutParams.FLAG_SHOW_WHEN_LOCKED or WindowManager.LayoutParams.FLAG_TURN_SCREEN_ON)
    }
    window.addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
    bind(intent, first = savedInstanceState == null)
  }

  override fun onNewIntent(intent: Intent) {
    super.onNewIntent(intent)
    setIntent(intent)
    bind(intent, first = true)
  }

  private fun bind(intent: Intent, first: Boolean) {
    group = intent.getStringExtra(AlarmNotifier.EXTRA_GROUP) ?: ""
    val spec = AlarmStore.active(this, group)
    if (spec == null) {
      // Already answered (on the notification or another screen).
      finish()
      return
    }
    current = WeakReference(this)
    setContentView(layout(spec))
    if (first) AlarmActions.shown(this, group)
  }

  private fun dp(v: Int): Int = TypedValue.applyDimension(TypedValue.COMPLEX_UNIT_DIP, v.toFloat(), resources.displayMetrics).toInt()

  private fun text(value: String, sp: Float, bold: Boolean = false): TextView = TextView(this).apply {
    text = value
    setTextColor(Color.WHITE)
    setTextSize(TypedValue.COMPLEX_UNIT_SP, sp)
    gravity = Gravity.CENTER
    if (bold) typeface = Typeface.create(Typeface.DEFAULT, Typeface.BOLD)
  }

  private fun button(label: String, heightDp: Int, filled: Boolean, onTap: () -> Unit): Button = Button(this).apply {
    text = label
    isAllCaps = false
    setTextSize(TypedValue.COMPLEX_UNIT_SP, 22f)
    setTextColor(if (filled) ALARM else Color.WHITE)
    background = GradientDrawable().apply {
      cornerRadius = dp(14).toFloat()
      if (filled) setColor(Color.WHITE) else setStroke(dp(2), Color.WHITE)
    }
    minHeight = dp(heightDp)
    minimumHeight = dp(heightDp)
    setOnClickListener { onTap() }
    layoutParams = LinearLayout.LayoutParams(LinearLayout.LayoutParams.MATCH_PARENT, LinearLayout.LayoutParams.WRAP_CONTENT).apply {
      topMargin = dp(12)
    }
  }

  private fun layout(spec: AlarmSpec): View {
    val time = AlarmNotifier.timeText(this, spec.dueAt)
    val title = spec.title.ifBlank { AlarmStore.label(this, "reminder") }
    val heading = AlarmStore.label(this, "heading")
    val col = LinearLayout(this).apply {
      orientation = LinearLayout.VERTICAL
      gravity = Gravity.CENTER_HORIZONTAL
      setPadding(dp(24), dp(48), dp(24), dp(32))
    }
    col.addView(text(heading, 20f))
    col.addView(text(time, 72f, bold = true))
    col.addView(text(title, 28f).apply { setPadding(0, dp(8), 0, dp(24)) })

    val done = button(AlarmStore.label(this, "done"), 72, filled = true) {
      AlarmActions.done(this, group)
      finish()
    }
    col.addView(done)
    col.addView(button(AlarmStore.label(this, "snooze"), 64, filled = false) { snooze(10) })

    phoneIn(title)?.let { number ->
      col.addView(button(AlarmStore.label(this, "call") + " " + number, 56, filled = false) { call(number) })
    }

    val other = LinearLayout(this).apply {
      orientation = LinearLayout.VERTICAL
      visibility = View.GONE
    }
    other.addView(button(AlarmStore.label(this, "in_5"), 56, filled = false) { snooze(5) })
    other.addView(button(AlarmStore.label(this, "in_30"), 56, filled = false) { snooze(30) })
    other.addView(button(AlarmStore.label(this, "in_60"), 56, filled = false) { snooze(60) })
    other.addView(button(AlarmStore.label(this, "tomorrow"), 56, filled = false) {
      val target = spec.dueAt + DAY_MS
      snooze(((target - System.currentTimeMillis()) / 60_000L).toInt().coerceAtLeast(1))
    })
    val otherToggle = Button(this).apply {
      text = AlarmStore.label(this@AlarmActivity, "other_time")
      isAllCaps = false
      setTextSize(TypedValue.COMPLEX_UNIT_SP, 20f)
      setTextColor(Color.WHITE)
      setBackgroundColor(Color.TRANSPARENT)
      minHeight = dp(56)
      setOnClickListener {
        other.visibility = if (other.visibility == View.VISIBLE) View.GONE else View.VISIBLE
      }
    }
    col.addView(otherToggle)
    col.addView(other)

    val root = ScrollView(this).apply {
      setBackgroundColor(ALARM)
      isFillViewport = true
      addView(col)
    }
    root.post {
      done.isFocusableInTouchMode = true
      done.requestFocus()
      root.announceForAccessibility("$heading. $time. $title")
    }
    startPulse(done)
    return root
  }

  /** motion.alarm: a 1000 ms pulse on «Сделано», off when animations are off (Reduce Motion). */
  private fun startPulse(v: View) {
    pulse?.cancel()
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O && !ValueAnimator.areAnimatorsEnabled()) return
    pulse = ObjectAnimator.ofFloat(v, View.ALPHA, 1f, 0.82f).apply {
      duration = 1000
      repeatMode = ValueAnimator.REVERSE
      repeatCount = ValueAnimator.INFINITE
      start()
    }
  }

  private fun snooze(minutes: Int) {
    AlarmActions.snooze(this, group, minutes)
    finish()
  }

  private fun call(number: String) {
    // The dialer needs the phone unlocked; the alarm stays until «Сделано».
    val km = getSystemService(KeyguardManager::class.java)
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O && km != null && km.isKeyguardLocked) km.requestDismissKeyguard(this, null)
    try {
      startActivity(Intent(Intent.ACTION_DIAL, Uri.parse("tel:" + number.filter { it.isDigit() || it == '+' })))
    } catch (_: Exception) {
    }
  }

  @Deprecated("Back does not switch the alarm off: only a button does (2-design S14).")
  override fun onBackPressed() {
    // ignored on purpose
  }

  override fun onDestroy() {
    pulse?.cancel()
    if (current?.get() === this) current = null
    super.onDestroy()
  }

  companion object {
    private val ALARM = Color.parseColor("#B4361E")
    private const val DAY_MS = 24 * 60 * 60_000L
    private val PHONE = Regex("""(\+?\d[\d\s()\-]{8,}\d)""")
    private var current: WeakReference<AlarmActivity>? = null

    fun phoneIn(text: String): String? = PHONE.find(text)?.value?.trim()

    /** The ring was answered elsewhere (the notification button, the app): close S14. */
    fun finishFor(group: String) {
      val a = current?.get() ?: return
      if (a.group == group) a.runOnUiThread { a.finish() }
    }
  }
}
