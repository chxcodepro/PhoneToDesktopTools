package expo.modules.p2daccessory

import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition

/** 免调试连接（配件模式）：把电脑发来的连接链接交给 JS */
class P2dAccessoryModule : Module() {
  override fun definition() = ModuleDefinition {
    Name("P2dAccessory")

    /** 收到电脑端的连接参数：{ url: "p2d://connect?…" } */
    Events("onConnect")

    OnCreate {
      AccessoryLink.listener = { url -> sendEvent("onConnect", mapOf("url" to url)) }
      // 冷启动：配件已经插着、之前授过权（如 App 被系统结束后重新打开）
      appContext.reactContext?.let { AccessoryLink.attach(it, null) }
    }

    OnDestroy {
      AccessoryLink.listener = null
    }

    OnActivityEntersForeground {
      appContext.reactContext?.let { AccessoryLink.attach(it, null) }
    }

    /** 取走还没处理的连接链接（JS 加载完成前电脑就发来了），没有时返回 null */
    Function("takePending") {
      val u = AccessoryLink.pendingUrl
      AccessoryLink.pendingUrl = null
      u
    }

    /** 配件链路是否打开着 */
    Function("isOpen") {
      AccessoryLink.isOpen()
    }

    /** 告诉电脑端手机端的版本（握手时带上） */
    Function("setAppVersion") { v: String ->
      AccessoryLink.appVersion = v
    }
  }
}
