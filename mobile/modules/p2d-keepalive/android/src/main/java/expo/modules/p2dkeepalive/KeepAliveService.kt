package expo.modules.p2dkeepalive

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.net.wifi.WifiManager
import android.os.Build
import android.os.IBinder

/**
 * 连着电脑时运行的前台服务：通知栏常驻一条「已连接电脑」，App 切到后台时系统不会冻结进程，
 * 和电脑的 WebSocket 连接（心跳由系统网络库自动应答）就不会断。断开所有电脑时停止。
 */
class KeepAliveService : Service() {
  private var wifiLock: WifiManager.WifiLock? = null

  override fun onBind(intent: Intent?): IBinder? = null

  override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
    val title = intent?.getStringExtra(EXTRA_TITLE) ?: "已连接电脑"
    val text = intent?.getStringExtra(EXTRA_TEXT) ?: "切到后台也保持连接"
    val notification = buildNotification(title, text)
    try {
      if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
        startForeground(NOTIFICATION_ID, notification, ServiceInfo.FOREGROUND_SERVICE_TYPE_CONNECTED_DEVICE)
      } else {
        startForeground(NOTIFICATION_ID, notification)
      }
    } catch (e: Exception) {
      // 系统不允许（如在后台被启动）：放弃，下次回到前台再试
      stopSelf()
      return START_NOT_STICKY
    }
    acquireWifiLock()
    return START_NOT_STICKY
  }

  override fun onDestroy() {
    wifiLock?.let { if (it.isHeld) it.release() }
    wifiLock = null
    super.onDestroy()
  }

  private fun acquireWifiLock() {
    if (wifiLock?.isHeld == true) return
    val wm = applicationContext.getSystemService(Context.WIFI_SERVICE) as? WifiManager ?: return
    @Suppress("DEPRECATION")
    val mode = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) WifiManager.WIFI_MODE_FULL_LOW_LATENCY else WifiManager.WIFI_MODE_FULL_HIGH_PERF
    try {
      wifiLock = wm.createWifiLock(mode, "p2d:connection").apply {
        setReferenceCounted(false)
        acquire()
      }
    } catch (e: Exception) {
      wifiLock = null
    }
  }

  private fun buildNotification(title: String, text: String): Notification {
    val nm = getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O && nm.getNotificationChannel(CHANNEL_ID) == null) {
      nm.createNotificationChannel(
        NotificationChannel(CHANNEL_ID, "电脑连接", NotificationManager.IMPORTANCE_LOW).apply {
          description = "连着电脑时常驻，切到后台也保持连接"
          setShowBadge(false)
        },
      )
    }
    val launch = packageManager.getLaunchIntentForPackage(packageName)?.apply {
      flags = Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_RESET_TASK_IF_NEEDED
    }
    val pending = launch?.let {
      PendingIntent.getActivity(this, 0, it, PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT)
    }
    // 优先用 expo-notifications 生成的单色通知图标，没有就用应用图标
    val icon = resources.getIdentifier("notification_icon", "drawable", packageName).takeIf { it != 0 } ?: applicationInfo.icon
    val builder = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
      Notification.Builder(this, CHANNEL_ID)
    } else {
      @Suppress("DEPRECATION")
      Notification.Builder(this)
    }
    builder
      .setSmallIcon(icon)
      .setContentTitle(title)
      .setContentText(text)
      .setOngoing(true)
      .setShowWhen(false)
      .setCategory(Notification.CATEGORY_SERVICE)
    if (pending != null) builder.setContentIntent(pending)
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
      builder.setForegroundServiceBehavior(Notification.FOREGROUND_SERVICE_IMMEDIATE)
    }
    return builder.build()
  }

  companion object {
    const val CHANNEL_ID = "p2d_connection"
    const val NOTIFICATION_ID = 39272
    const val EXTRA_TITLE = "title"
    const val EXTRA_TEXT = "text"
  }
}
