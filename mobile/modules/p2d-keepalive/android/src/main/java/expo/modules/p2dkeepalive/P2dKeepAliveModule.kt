package expo.modules.p2dkeepalive

import android.content.Intent
import android.os.Build
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
  }
}
