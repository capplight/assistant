package expo.modules.alarms

import android.content.ComponentName
import android.content.Context
import android.content.Intent
import android.net.Uri
import android.os.Build
import android.os.PowerManager
import android.provider.Settings

/**
 * `battery-guide` (3-engineering §2.1, S15): which maker, is the app exempt from battery
 * optimisation, and the settings screen for each step. Vendor screens move between firmware
 * versions, so every step has a list of candidates and falls back to the app's own settings page.
 * REQUEST_IGNORE_BATTERY_OPTIMIZATIONS is not used (Play policy): the person switches it themselves.
 */
object BatteryGuide {
  fun vendor(): String {
    val m = (Build.MANUFACTURER + " " + Build.BRAND).lowercase()
    return when {
      m.contains("xiaomi") || m.contains("redmi") || m.contains("poco") -> "xiaomi"
      m.contains("samsung") -> "samsung"
      m.contains("tecno") || m.contains("infinix") || m.contains("itel") -> "transsion"
      m.contains("huawei") || m.contains("honor") -> "huawei"
      m.contains("oppo") || m.contains("realme") || m.contains("oneplus") -> "oppo"
      m.contains("vivo") -> "vivo"
      else -> "other"
    }
  }

  fun ignoringOptimizations(c: Context): Boolean {
    val pm = c.getSystemService(Context.POWER_SERVICE) as? PowerManager ?: return false
    return pm.isIgnoringBatteryOptimizations(c.packageName)
  }

  /** Makers whose phones stop apps from starting by themselves unless the person allows it. */
  fun hasAutostartStep(): Boolean = vendor() in setOf("xiaomi", "transsion", "huawei", "oppo", "vivo")

  private fun component(pkg: String, cls: String) = Intent().setComponent(ComponentName(pkg, cls))

  private fun appDetails(c: Context) =
    Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS, Uri.parse("package:" + c.packageName))

  private fun autostart(): List<Intent> = when (vendor()) {
    "xiaomi" -> listOf(
      component("com.miui.securitycenter", "com.miui.permcenter.autostart.AutoStartManagementActivity"),
      component("com.miui.securitycenter", "com.miui.powercenter.PowerSettings"),
    )
    "transsion" -> listOf(
      component("com.transsion.phonemaster", "com.cyin.himgr.autostart.AutoStartActivity"),
      component("com.transsion.phonemaster", "com.cyin.himgr.widget.activity.MainSettingGpActivity"),
    )
    "huawei" -> listOf(
      component("com.huawei.systemmanager", "com.huawei.systemmanager.startupmgr.ui.StartupNormalAppListActivity"),
      component("com.huawei.systemmanager", "com.huawei.systemmanager.optimize.process.ProtectActivity"),
    )
    "oppo" -> listOf(
      component("com.coloros.safecenter", "com.coloros.safecenter.permission.startup.StartupAppListActivity"),
      component("com.oplus.safecenter", "com.oplus.safecenter.permission.startup.StartupAppListActivity"),
    )
    "vivo" -> listOf(
      component("com.vivo.permissionmanager", "com.vivo.permissionmanager.activity.BgStartUpManagerActivity"),
    )
    else -> emptyList()
  }

  private fun battery(c: Context): List<Intent> {
    val generic = listOf(Intent(Settings.ACTION_IGNORE_BATTERY_OPTIMIZATION_SETTINGS))
    return when (vendor()) {
      // HyperOS / MIUI «Контроль активности» → «Нет ограничений».
      "xiaomi" -> listOf(
        component("com.miui.powerkeeper", "com.miui.powerkeeper.ui.HiddenAppsConfigActivity")
          .putExtra("package_name", c.packageName)
          .putExtra("package_label", c.applicationInfo.loadLabel(c.packageManager).toString()),
      ) + generic
      // One UI: Батарея → «Без ограничений» is on the app's own page.
      "samsung" -> listOf(appDetails(c)) + generic
      else -> generic
    }
  }

  private fun exact(c: Context): List<Intent> =
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
      listOf(Intent(Settings.ACTION_REQUEST_SCHEDULE_EXACT_ALARM, Uri.parse("package:" + c.packageName)))
    } else {
      emptyList()
    }

  private fun fullScreen(c: Context): List<Intent> =
    if (Build.VERSION.SDK_INT >= 34) {
      listOf(Intent(Settings.ACTION_MANAGE_APP_USE_FULL_SCREEN_INTENT, Uri.parse("package:" + c.packageName)))
    } else {
      emptyList()
    }

  private fun notifications(c: Context): List<Intent> =
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
      listOf(Intent(Settings.ACTION_APP_NOTIFICATION_SETTINGS).putExtra(Settings.EXTRA_APP_PACKAGE, c.packageName))
    } else {
      emptyList()
    }

  /** Opens the screen for one S15 step. true = some screen opened (the app's own page counts). */
  fun open(c: Context, target: String): Boolean {
    val candidates = when (target) {
      "exact" -> exact(c)
      "full_screen" -> fullScreen(c)
      "battery" -> battery(c)
      "autostart" -> autostart()
      "notifications" -> notifications(c)
      else -> emptyList()
    } + appDetails(c)
    for (intent in candidates) {
      try {
        c.startActivity(intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
        return true
      } catch (_: Exception) {
        // not on this firmware: next one
      }
    }
    return false
  }
}
