package expo.modules.alarms

import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.media.AudioAttributes
import android.media.MediaPlayer
import android.os.Build
import android.os.Handler
import android.os.IBinder
import android.os.Looper
import android.os.VibrationAttributes
import android.os.VibrationEffect
import android.os.Vibrator
import android.os.VibratorManager
import org.json.JSONObject

/**
 * The ring of a «Будильник» (2-design 2.7, 2.8): the alarm stream, volume 40 → 100% over 20 s,
 * at most 60 s per ring, vibration 800 ms on / 400 ms off. After 60 s the notification stays
 * (with its buttons) and the next repeat rings at +5 min.
 *
 * Started from the alarm broadcast: `setAlarmClock` / exact alarms let an app start a foreground
 * service from the background. Without exact alarms (inexact window) Android may refuse; then
 * [AlarmActions.fire] lets the notification channel ring instead (no ramp, loops until a button).
 */
class AlarmRingService : Service() {
  private val handler = Handler(Looper.getMainLooper())
  private var player: MediaPlayer? = null
  private var vibrator: Vibrator? = null
  private var startedAt = 0L

  override fun onBind(intent: Intent?): IBinder? = null

  override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
    val raw = intent?.getStringExtra(EXTRA_SPEC)
    val spec = try {
      if (raw != null) AlarmSpec.fromJson(JSONObject(raw)) else null
    } catch (_: Exception) {
      null
    }
    if (spec == null) {
      stopSelf()
      return START_NOT_STICKY
    }
    val notification = AlarmNotifier.build(this, spec, withSound = false)
    val id = AlarmNotifier.idFor(spec.group)
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
      startForeground(id, notification, ServiceInfo.FOREGROUND_SERVICE_TYPE_MEDIA_PLAYBACK)
    } else {
      startForeground(id, notification)
    }
    stopSound()
    startSound()
    handler.removeCallbacksAndMessages(null)
    handler.postDelayed(ramp, RAMP_TICK_MS)
    handler.postDelayed({
      stopSound()
      // Keep the notification with «Сделано» / «Отложить»: only the sound ends.
      stopForeground(STOP_FOREGROUND_DETACH)
      stopSelf()
    }, MAX_RING_MS)
    return START_NOT_STICKY
  }

  private val ramp = object : Runnable {
    override fun run() {
      val p = player ?: return
      val f = ((System.currentTimeMillis() - startedAt).toFloat() / RAMP_MS).coerceIn(0f, 1f)
      val v = START_VOLUME + (1f - START_VOLUME) * f
      try {
        p.setVolume(v, v)
      } catch (_: Exception) {
        return
      }
      if (f < 1f) handler.postDelayed(this, RAMP_TICK_MS)
    }
  }

  private fun startSound() {
    startedAt = System.currentTimeMillis()
    try {
      player = MediaPlayer().apply {
        setAudioAttributes(
          AudioAttributes.Builder()
            .setUsage(AudioAttributes.USAGE_ALARM)
            .setContentType(AudioAttributes.CONTENT_TYPE_SONIFICATION)
            .build(),
        )
        setDataSource(this@AlarmRingService, AlarmNotifier.soundUri(this@AlarmRingService))
        isLooping = true
        setVolume(START_VOLUME, START_VOLUME)
        prepare()
        start()
      }
    } catch (_: Exception) {
      player = null
    }
    try {
      vibrator = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
        (getSystemService(Context.VIBRATOR_MANAGER_SERVICE) as VibratorManager).defaultVibrator
      } else {
        @Suppress("DEPRECATION")
        getSystemService(Context.VIBRATOR_SERVICE) as Vibrator
      }
      val alarmUsage = AudioAttributes.Builder().setUsage(AudioAttributes.USAGE_ALARM).build()
      when {
        Build.VERSION.SDK_INT >= 33 -> vibrator?.vibrate(
          VibrationEffect.createWaveform(AlarmNotifier.VIBRATION, 1),
          VibrationAttributes.createForUsage(VibrationAttributes.USAGE_ALARM),
        )
        Build.VERSION.SDK_INT >= Build.VERSION_CODES.O -> @Suppress("DEPRECATION") vibrator?.vibrate(
          VibrationEffect.createWaveform(AlarmNotifier.VIBRATION, 1),
          alarmUsage,
        )
        else -> @Suppress("DEPRECATION") vibrator?.vibrate(AlarmNotifier.VIBRATION, 1, alarmUsage)
      }
    } catch (_: Exception) {
      vibrator = null
    }
  }

  private fun stopSound() {
    handler.removeCallbacks(ramp)
    try {
      player?.stop()
    } catch (_: Exception) {
    }
    player?.release()
    player = null
    vibrator?.cancel()
    vibrator = null
  }

  override fun onDestroy() {
    handler.removeCallbacksAndMessages(null)
    stopSound()
    super.onDestroy()
  }

  companion object {
    private const val EXTRA_SPEC = "alarm_spec"
    private const val START_VOLUME = 0.4f
    private const val RAMP_MS = 20_000f
    private const val RAMP_TICK_MS = 1_000L
    private const val MAX_RING_MS = 60_000L

    /** false when Android refused a foreground service from the background. */
    fun start(c: Context, spec: AlarmSpec): Boolean {
      val intent = Intent(c, AlarmRingService::class.java).putExtra(EXTRA_SPEC, spec.toJson().toString())
      return try {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) c.startForegroundService(intent) else c.startService(intent)
        true
      } catch (_: Exception) {
        false
      }
    }

    fun stop(c: Context) {
      try {
        c.stopService(Intent(c, AlarmRingService::class.java))
      } catch (_: Exception) {
      }
    }
  }
}
