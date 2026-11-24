package expo.modules.p2dkeepalive

import android.content.Context
import android.content.Intent
import android.net.Uri
import android.os.Build
import android.os.PowerManager
import android.provider.Settings
import java.net.Inet4Address
import java.net.NetworkInterface
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition

/** 开始 / 更新 / 停止「保持连接」前台服务 */
class P2dKeepAliveModule : Module() {
  override fun definition() = ModuleDefinition {
    Name("P2dKeepAlive")

    /** 开始或更新通知文字；系统不允许（App 在后台等）时返回 false */
    Function("start") { title: String, text: String ->
      val ctx = appContext.reactContext ?: return@Function false
      val intent = Intent(ctx, KeepAliveService::class.java)
        .putExtra(KeepAliveService.EXTRA_TITLE, title)
        .putExtra(KeepAliveService.EXTRA_TEXT, text)
      try {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) ctx.startForegroundService(intent) else ctx.startService(intent)
        true
      } catch (e: Exception) {
        false
      }
    }

    Function("stop") {
      val ctx = appContext.reactContext ?: return@Function false
      ctx.stopService(Intent(ctx, KeepAliveService::class.java))
    }

    /**
     * 是否已允许后台运行（不受电池优化限制）。
     * ColorOS 等系统在 App 切到后台几秒后会主动关闭它的网络连接（即使有前台服务），只有用户允许后台运行才不关。
     */
    Function("isBackgroundAllowed") {
      val ctx = appContext.reactContext ?: return@Function true
      if (Build.VERSION.SDK_INT < Build.VERSION_CODES.M) return@Function true
      val pm = ctx.getSystemService(Context.POWER_SERVICE) as PowerManager
      pm.isIgnoringBatteryOptimizations(ctx.packageName)
    }

    /** 弹出系统的「允许后台运行」授权框（用户在系统界面里点允许）；打不开时进入本应用的系统设置页 */
    Function("requestBackground") {
      val activity = appContext.currentActivity ?: return@Function false
      if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) {
        try {
          activity.startActivity(
            Intent(Settings.ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS, Uri.parse("package:" + activity.packageName)),
          )
          return@Function true
        } catch (e: Exception) {
          // 部分系统没有这个页面
        }
      }
      try {
        activity.startActivity(Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS, Uri.parse("package:" + activity.packageName)))
        true
      } catch (e: Exception) {
        false
      }
    }

    /**
     * 手机所有网卡的 IPv4 地址（WiFi、热点、USB 共享、Tailscale、移动数据等），「附近的电脑」用来选择扫描哪个网段。
     * 每项：name 网卡名（wlan0、tun0、rmnet0…），ip，prefix 前缀长度
     */
    Function("localNetworks") {
      val out = ArrayList<Map<String, Any>>()
      try {
        val list = NetworkInterface.getNetworkInterfaces() ?: return@Function out
        for (ni in list) {
          if (!ni.isUp || ni.isLoopback) continue
          for (ia in ni.interfaceAddresses) {
            val a = ia.address as? Inet4Address ?: continue
            out.add(mapOf("name" to ni.name, "ip" to (a.hostAddress ?: continue), "prefix" to ia.networkPrefixLength.toInt()))
          }
        }
      } catch (e: Exception) {
        // 读不到时返回已有的部分
      }
      out
    }

    /** 打开本应用的系统设置页（手机厂商的「耗电管理 / 后台运行」开关在里面） */
    Function("openAppSettings") {
      val activity = appContext.currentActivity ?: return@Function false
      try {
        activity.startActivity(Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS, Uri.parse("package:" + activity.packageName)))
        true
      } catch (e: Exception) {
        false
      }
    }
  }
}
